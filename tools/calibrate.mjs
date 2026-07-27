#!/usr/bin/env node
// calibrate.mjs — opponent-model calibration against YOUR real Sleeper mock
// drafts (fetched by tools/fetch_mocks.py into data/mocks/).
//
// CLI:  node tools/calibrate.mjs [--mocks data/mocks] [--grid] [--apply]
//                                [--sims 5000] [--seed 20260827] [--quiet]
//
// What it reports (all math in tools/lib/calibrate_core.mjs — pure, tested):
//   A. Teacher-forced per-pick log-likelihood of the observed mock picks
//      under the NEUTRAL-seat opponent model at the CURRENT params
//      (opponents.json params cascade over engine defaults), plus two
//      baselines: uniform-over-window and pure-ADP (tauScale=1, share=0).
//   B. pAvail reliability: 5000 seeded sims under the FULL production model
//      (real opponents.json incl. archetypes) → P(available at pick p),
//      binned predicted-vs-observed with cluster-bootstrap CIs over mocks
//      + Brier score.
//   C. --grid: tauScale × needAwareShare × window held-one-mock-out CV.
//   D. Writes data/mocks/calibration.json. With --grid --apply it ALSO
//      rewrites public/data/opponents.json's "params" block with the best
//      cell — after which mc.json is stale until `node tools/simulate.mjs`
//      is re-run.
//
// This file is the thin CLI: fs + arg parsing + printing only, mirroring how
// tools/simulate.mjs wraps engine/*.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OPP_DEFAULT_PARAMS } from '../engine/opponent.js';
import { defineStrategy } from '../engine/strategy.js';
import {
  mapMock, makeNeutralCtxCache, evaluateParams, gridSearch,
  simulateAvailability, pAvailCalibration, GRID_DEFAULT,
} from './lib/calibrate_core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD_PATH = path.join(ROOT, 'public', 'data', 'board.json');
const OPP_PATH = path.join(ROOT, 'public', 'data', 'opponents.json');
const STRAT_PATH = path.join(ROOT, 'public', 'data', 'strategies.json');
const LEAGUE_PATH = path.join(ROOT, 'config', 'league.json');
const CALIB_NAME = 'calibration.json';

const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const fmt = (v, d = 3) => (v == null ? 'n/a' : v.toFixed(d));

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argStr(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}
function argNum(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
}
const MOCKS_DIR = path.isAbsolute(argStr('mocks', 'data/mocks'))
  ? argStr('mocks', 'data/mocks')
  : path.join(ROOT, argStr('mocks', 'data/mocks'));
const DO_GRID = args.includes('--grid');
const DO_APPLY = args.includes('--apply');
const SIMS = argNum('sims', 5000);
const SEED = argNum('seed', 20260827);
const QUIET = args.includes('--quiet');
const log = (...xs) => { if (!QUIET) console.log(...xs); };

// ── Load inputs ────────────────────────────────────────────────────────────
const board = JSON.parse(readFileSync(BOARD_PATH, 'utf8'));
const league = JSON.parse(readFileSync(LEAGUE_PATH, 'utf8'));
const opponents = JSON.parse(readFileSync(OPP_PATH, 'utf8'));

// Custom strategies feed part B's archetype mix. Unlike simulate.mjs (where
// a bad spec must never silently alter mc.json ⇒ fatal), calibration only
// READS the room model — an invalid spec is skipped with a warning.
let strategiesReg = null;
try {
  const rawStrats = JSON.parse(readFileSync(STRAT_PATH, 'utf8'));
  strategiesReg = {};
  for (const spec of rawStrats.strategies ?? []) {
    try {
      const s = defineStrategy(spec);
      strategiesReg[s.name] = s;
    } catch (e) {
      console.warn(`[calibrate] WARNING: skipping invalid strategy spec: ${e.message}`);
    }
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

// Mocks: every *.json in the dir except our own calibration.json output.
// Unparseable or shapeless files are skipped with a warning, never fatal.
const mockFiles = existsSync(MOCKS_DIR)
  ? readdirSync(MOCKS_DIR).filter((f) => f.endsWith('.json') && f !== CALIB_NAME).sort()
  : [];
const mocks = [];
for (const f of mockFiles) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path.join(MOCKS_DIR, f), 'utf8'));
  } catch (e) {
    console.warn(`[calibrate] WARNING: ${f} is not valid JSON — skipped`);
    continue;
  }
  if (!Array.isArray(raw?.picks) || raw.picks.length === 0) {
    console.warn(`[calibrate] WARNING: ${f} has no picks — skipped`);
    continue;
  }
  const m = mapMock(raw, board.slimSleeperMap, {
    defaultTeams: league.teams,
    defaultRounds: league.rounds,
    nPlayers: board.players.length,
  });
  mocks.push(m);
}

if (mocks.length === 0) {
  console.log('no mocks yet — run tools/fetch_mocks.py --user <name>');
  process.exit(0);
}

const t0 = Date.now();
const mapped = mocks.reduce((a, m) => a + m.picks.filter((p) => p.idx != null).length, 0);
const totalPicksIn = mocks.reduce((a, m) => a + m.picks.length, 0);
log(`[calibrate] ${mocks.length} mocks from ${path.relative(ROOT, MOCKS_DIR)} — `
  + `${totalPicksIn} picks, ${mapped} on-board (${(100 * mapped / totalPicksIn).toFixed(1)}% id-mapped)`);

// ── A: teacher-forced LL at the current params ────────────────────────────
const P = { ...OPP_DEFAULT_PARAMS, ...(opponents?.params ?? {}) };
const current = { tauScale: P.tauScale, needAwareShare: P.needAwareShare, window: P.window };
const ctxCache = makeNeutralCtxCache(board, league);

const cur = evaluateParams(board, league, mocks, current, ctxCache);
const pureAdp = evaluateParams(board, league, mocks,
  { tauScale: 1, needAwareShare: 0, window: current.window }, ctxCache);

log(`\n[A] teacher-forced LL, neutral seats, current params `
  + `(tauScale=${current.tauScale} share=${current.needAwareShare} window=${current.window})`);
log(`    mean LL ${fmt(cur.meanLL)} nats/pick   perplexity ${fmt(cur.perplexity, 1)}   `
  + `coverage ${(100 * cur.coverage.scoredPct).toFixed(1)}% `
  + `(offBoard ${cur.coverage.offBoard}, beyondWindow ${cur.coverage.beyondWindow}, `
  + `duplicates ${cur.coverage.duplicates})`);
log(`    by band: ${cur.byBand.map((b) => `${b.band} ${fmt(b.meanLL)} (n=${b.n})`).join(' | ')}`);
log(`    baselines: uniform-over-window ${fmt(cur.uniformMeanLL)} | `
  + `pure-ADP (tauScale=1, share=0) ${fmt(pureAdp.meanLL)}`);
log('    NOTE: off-board observed picks are not applied to the replay state — '
  + 'small documented bias (the sim room retains players the real room lost)');

// ── B: pAvail reliability under the FULL production model ─────────────────
const mocksB = mocks.filter((m) => m.teams === league.teams);
const skippedB = mocks.length - mocksB.length;
let pAvailReport = null;
if (mocksB.length > 0) {
  const tB = Date.now();
  const availRes = simulateAvailability(board, league, opponents, {
    sims: SIMS, seed: SEED, strategies: strategiesReg,
  });
  pAvailReport = pAvailCalibration(availRes, mocksB, { nBins: 5, resamples: 500, seed: SEED + 1 });
  log(`\n[B] pAvail reliability — ${SIMS} sims (seed ${SEED}, production opponents.json`
    + `${opponents?.archetypes?.mix ? ' incl. archetypes' : ''}), `
    + `${mocksB.length} mocks${skippedB ? ` (${skippedB} skipped: teams != ${league.teams})` : ''}, `
    + `${((Date.now() - tB) / 1000).toFixed(1)}s`);
  log(`    Brier ${fmt(pAvailReport.brier, 4)} over ${pAvailReport.nPairs} (player, pick) pairs`);
  for (const b of pAvailReport.bins) {
    const ci = b.ci95 ? `[${fmt(b.ci95[0])}, ${fmt(b.ci95[1])}]` : 'n/a';
    log(`    bin [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}${b.hi === 1 ? ']' : ')'}: `
      + `predicted ${fmt(b.predicted)}  observed ${fmt(b.observed)}  ci95 ${ci}  n=${b.n}`);
  }
} else {
  log(`\n[B] pAvail reliability skipped — no mocks with teams == ${league.teams}`);
}

// ── C: grid search ────────────────────────────────────────────────────────
let gridRes = null;
if (DO_GRID) {
  const tC = Date.now();
  gridRes = gridSearch(board, league, mocks, GRID_DEFAULT);
  log(`\n[C] grid — ${gridRes.grid.length} cells, held-one-mock-out CV over `
    + `${mocks.length} mocks, ${((Date.now() - tC) / 1000).toFixed(1)}s`);
  const top = gridRes.grid.slice(0, 10);
  top.forEach((c, i) => {
    log(`    #${String(i + 1).padStart(2)}  tauScale ${c.tauScale.toFixed(2)}  `
      + `share ${c.needAwareShare.toFixed(2)}  window ${c.window}  cvLL ${fmt(c.cvLL, 4)}`);
  });
  if (gridRes.foldSelection?.meanLL != null) {
    log(`    CV-of-selection (best-on-others, scored held-out): ${fmt(gridRes.foldSelection.meanLL, 4)}`);
  }
  log(`    NOTE: ${gridRes.note}`);
}

// ── D: calibration.json (+ optional --apply) ──────────────────────────────
const notes = [
  'off-board observed picks are excluded from the likelihood AND from the replay state '
    + '(board.json does not know them) — small bias: the simulated room retains players '
    + 'the real room had already lost',
  'teacher-forced LL uses NEUTRAL seats (a mock lobby is strangers); part B (pAvail) '
    + 'uses the full production opponents.json incl. archetypes',
];
if (gridRes) notes.push(gridRes.note);

const roundEval = (e) => ({
  params: e.params,
  meanLL: r4(e.meanLL),
  perplexity: r3(e.perplexity),
  coverage: { ...e.coverage, scoredPct: r4(e.coverage.scoredPct) },
  byBand: e.byBand.map((b) => ({ ...b, meanLL: r4(b.meanLL) })),
  perMock: e.perMock.map((m) => ({ ...m, meanLL: r4(m.meanLL) })),
});

const out = {
  generatedAt: new Date().toISOString(),
  nMocks: mocks.length,
  current: {
    ...roundEval(cur),
    pAvail: pAvailReport
      ? {
          sims: SIMS,
          seed: SEED,
          nMocksUsed: pAvailReport.nMocks,
          skippedWrongTeams: skippedB,
          resamples: pAvailReport.resamples,
          brier: r4(pAvailReport.brier),
          nPairs: pAvailReport.nPairs,
          bins: pAvailReport.bins.map((b) => ({
            lo: b.lo, hi: b.hi, n: b.n,
            predicted: r4(b.predicted),
            observed: r4(b.observed),
            ci95: b.ci95 ? b.ci95.map((v) => r4(v)) : null,
          })),
        }
      : null,
  },
  baselines: {
    uniformWindow: { meanLL: r4(cur.uniformMeanLL), perplexity: r3(cur.uniformMeanLL != null ? Math.exp(-cur.uniformMeanLL) : null) },
    pureAdp: { params: pureAdp.params, meanLL: r4(pureAdp.meanLL), perplexity: r3(pureAdp.perplexity) },
  },
  notes,
};
if (gridRes) {
  out.grid = gridRes.grid.map((c) => ({
    tauScale: c.tauScale, needAwareShare: c.needAwareShare, window: c.window,
    cvLL: Number.isFinite(c.cvLL) ? r4(c.cvLL) : null,
    perMockLL: c.perMockLL.map((v) => r4(v)),
  }));
  out.best = gridRes.best ? { ...gridRes.best, cvLL: r4(gridRes.best.cvLL) } : null;
  if (gridRes.foldSelection) {
    out.foldSelection = {
      meanLL: r4(gridRes.foldSelection.meanLL),
      chosen: gridRes.foldSelection.chosen,
    };
  }
}

const calibPath = path.join(MOCKS_DIR, CALIB_NAME);
writeFileSync(calibPath, JSON.stringify(out, null, 2), 'utf8');
log(`\n[D] wrote ${path.relative(ROOT, calibPath)} `
  + `(${((Date.now() - t0) / 1000).toFixed(1)}s total)`);

if (gridRes?.best) {
  const b = gridRes.best;
  const suggested = { tauScale: b.tauScale, needAwareShare: b.needAwareShare, window: b.window };
  if (DO_APPLY) {
    const oppOut = JSON.parse(readFileSync(OPP_PATH, 'utf8')); // re-read: preserve everything else
    oppOut.params = { ...(oppOut.params ?? {}), ...suggested };
    writeFileSync(OPP_PATH, JSON.stringify(oppOut, null, 2) + '\n', 'utf8');
    console.log('\n' + '!'.repeat(72));
    console.log(`!!! APPLIED best grid params to public/data/opponents.json "params":`);
    console.log(`!!!   ${JSON.stringify(suggested)}   (cvLL ${fmt(b.cvLL, 4)})`);
    console.log('!!! mc.json is now STALE — re-run:  node tools/simulate.mjs');
    console.log('!'.repeat(72));
  } else {
    log(`\nsuggested opponents.json params block (NOT applied — re-run with --grid --apply):`);
    log(`  "params": ${JSON.stringify(suggested)}`);
  }
} else if (DO_APPLY && !DO_GRID) {
  console.warn('[calibrate] WARNING: --apply requires --grid (nothing to apply) — ignored');
}
