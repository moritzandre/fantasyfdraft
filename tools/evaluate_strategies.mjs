#!/usr/bin/env node
// evaluate_strategies.mjs — strategy-evaluation harness CLI (self-play).
//
// Drafts the LIVE engine (engine/index.js recommend) at one or more slots
// against the shared opponent room (engine/opponent.js) for each candidate
// strategy, with COMMON RANDOM NUMBERS across strategies (tools/lib/seeds.mjs
// — the per-sim seed never depends on the strategy, and forced self-play
// picks consume no rng), then writes public/data/evaluation.json and prints
// a ranked table per slot. All math lives in tools/lib/evaluate_core.mjs
// (pure, fs-free); this file does I/O, workers, timing and formatting only.
//
// CLI:
//   node tools/evaluate_strategies.mjs
//     [--strategies all|a,b,c]  default all = 4 built-ins + every valid
//                               strategies.json spec (invalid specs are
//                               skipped with a console warning)
//     [--slots 8|1-12|3,5]      default: league.slot (config/league.json)
//     [--sims 20000]            sims per (slot × strategy) cell
//     [--seed 20260827]
//     [--workers N]             worker_threads fan-out over the sim range
//     [--sim-range A..B]        emit a SHARD file (typed arrays as plain
//                               arrays) instead of the final artifact —
//                               for splitting a big run across machines
//     [--out path]              default public/data/evaluation.json
//                               (shard mode: shard-A-B.json in cwd)
//     [--quiet]
//
// Merge shards later with:
//   node tools/merge_evaluation.mjs shard-*.json --out public/data/evaluation.json

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { STRATEGIES, defineStrategy } from '../engine/strategy.js';
import { evaluateShard, mergeShards, summarize, shardToJSON } from './lib/evaluate_core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(ROOT, 'tools', 'evaluate_worker.mjs');
const BOARD_PATH = path.join(ROOT, 'public', 'data', 'board.json');
const OPP_PATH = path.join(ROOT, 'public', 'data', 'opponents.json');
const STRAT_PATH = path.join(ROOT, 'public', 'data', 'strategies.json');
const LEAGUE_PATH = path.join(ROOT, 'config', 'league.json');
const DEFAULT_OUT = path.join(ROOT, 'public', 'data', 'evaluation.json');

// ── CLI args (simulate.mjs conventions) ────────────────────────────────────
const args = process.argv.slice(2);
function argStr(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}
function argNum(name, dflt) {
  const v = argStr(name, null);
  return v === null ? dflt : Number(v);
}
const SEED = argNum('seed', 20260827);
const SIMS = argNum('sims', 20000);
const WORKERS = Math.max(1, argNum('workers', 1));
const QUIET = args.includes('--quiet');
const log = (...xs) => { if (!QUIET) console.log(...xs); };

/** "8" | "1-12" | "3,5,7" | "1-3,8" → sorted unique slot list. */
function parseSlots(spec, teams, dflt) {
  if (!spec) return dflt;
  const out = new Set();
  for (const part of spec.split(',')) {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (m) {
      for (let v = Number(m[1]); v <= Number(m[2]); v++) out.add(v);
    } else {
      const v = Number(part);
      if (!Number.isInteger(v)) throw new Error(`--slots: cannot parse "${part}"`);
      out.add(v);
    }
  }
  const slots = [...out].sort((a, b) => a - b);
  for (const s of slots) {
    if (s < 1 || s > teams) throw new Error(`--slots: slot ${s} outside 1..${teams}`);
  }
  return slots;
}

// ── Load inputs ────────────────────────────────────────────────────────────
const board = JSON.parse(readFileSync(BOARD_PATH, 'utf8'));
const league = JSON.parse(readFileSync(LEAGUE_PATH, 'utf8'));
const opponents = JSON.parse(readFileSync(OPP_PATH, 'utf8'));

// strategies.json: validate each spec, SKIP invalid ones with a warning
// (harness semantics — unlike simulate.mjs, a bad custom spec must not
// block evaluating the built-ins). Valid specs also feed the opponent
// archetype mix, so the registry always carries ALL of them.
let strategySpecs = [];
let registry = null;
const customNames = [];
try {
  const raw = JSON.parse(readFileSync(STRAT_PATH, 'utf8'));
  registry = {};
  for (const spec of raw.strategies ?? []) {
    try {
      const s = defineStrategy(spec);
      registry[s.name] = s;
      customNames.push(s.name);
      strategySpecs.push(spec);
    } catch (e) {
      console.warn(`[strategies] skipping invalid spec${spec?.name ? ` "${spec.name}"` : ''}: ${e.message}`);
    }
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

const SLOTS = parseSlots(argStr('slots', null), league.teams, [league.slot]);
const stratArg = argStr('strategies', 'all');
let strategyNames;
if (stratArg === 'all') {
  strategyNames = [...Object.keys(STRATEGIES), ...customNames];
} else {
  strategyNames = stratArg.split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of strategyNames) {
    if (!STRATEGIES[name] && !(registry && registry[name])) {
      throw new Error(`--strategies: unknown strategy "${name}" (built-ins: ${Object.keys(STRATEGIES).join(', ')}; custom: ${customNames.join(', ') || 'none'})`);
    }
  }
}

// ── Workers ────────────────────────────────────────────────────────────────

/** Run one shard in a worker thread; resolves to the shard object. */
function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_PATH, { workerData });
    let settled = false;
    w.once('message', (msg) => {
      settled = true;
      if (msg.error) reject(new Error(`worker failed:\n${msg.error}`));
      else resolve(msg.shard);
    });
    w.once('error', (e) => { settled = true; reject(e); });
    w.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

// ── Table ──────────────────────────────────────────────────────────────────

/** Ranked per-slot table: mean / p10 / p90 / paired Δ vs balanced ± 2se. */
function printTables(summary) {
  if (QUIET) return;
  const wName = Math.max(10, ...summary.strategies.map((s) => s.length)) + 2;
  for (const slot of summary.slots) {
    const rows = summary.cells
      .filter((c) => c.slot === slot)
      .sort((a, b) => b.rosterValue.mean - a.rosterValue.mean);
    console.log(`\n── slot ${slot} — ${summary.sims} sims, seed ${summary.seed} ${'─'.repeat(24)}`);
    console.log(
      'strategy'.padEnd(wName) + 'mean'.padStart(9) + 'p10'.padStart(9)
      + 'p90'.padStart(9) + '  Δ vs balanced (±2se)' + '   win%'.padStart(8),
    );
    for (const c of rows) {
      const pb = summary.pairedVsBalanced?.[slot]?.[c.strategy];
      let delta;
      if (c.strategy === 'balanced') delta = 'baseline';
      else if (!pb) delta = '—';
      else {
        const band = 2 * pb.se;
        delta = `${pb.meanDiff >= 0 ? '+' : ''}${pb.meanDiff.toFixed(1)} ± ${band.toFixed(1)}`
          + (Math.abs(pb.meanDiff) < band ? '  ≈ noise' : '');
      }
      console.log(
        c.strategy.padEnd(wName)
        + c.rosterValue.mean.toFixed(1).padStart(9)
        + c.rosterValue.p10.toFixed(1).padStart(9)
        + c.rosterValue.p90.toFixed(1).padStart(9)
        + '  ' + delta.padEnd(22)
        + (100 * c.allPlayWinPct.mean).toFixed(1).padStart(6),
      );
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const t0 = Date.now();
const opponentParams = null; // no CLI override knob yet — recorded as null

async function main() {
  log(`[eval] strategies: ${strategyNames.join(', ')}`);
  log(`[eval] slots: ${SLOTS.join(', ')} | sims/cell: ${SIMS} | seed: ${SEED} | workers: ${WORKERS}`);

  // Shard mode: compute one [A, B) range in-process, emit a shard file.
  const rangeArg = argStr('sim-range', null);
  if (rangeArg !== null) {
    const m = /^(\d+)\.\.(\d+)$/.exec(rangeArg);
    if (!m) throw new Error(`--sim-range: expected A..B, got "${rangeArg}"`);
    const simRange = [Number(m[1]), Number(m[2])];
    const outPath = path.resolve(argStr('out', `shard-${simRange[0]}-${simRange[1]}.json`));
    const shard = evaluateShard({
      board, league, opponents, strategies: registry, strategyNames,
      slots: SLOTS, simRange, baseSeed: SEED, opponentParams,
    });
    const json = shardToJSON(shard);
    // Merge-tool provenance (core stays process-free, so added here).
    json.meta.nodeVersion = process.version;
    json.meta.opponentParams = opponents?.params ?? null;
    writeFileSync(outPath, JSON.stringify(json), 'utf8');
    log(`[eval] shard [${simRange[0]}, ${simRange[1]}) → ${outPath} `
      + `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  }

  // Full mode: split the sim range across workers (or run in-process).
  let shards;
  if (WORKERS > 1) {
    const per = Math.ceil(SIMS / WORKERS);
    const jobs = [];
    for (let w = 0; w < WORKERS; w++) {
      const a = w * per;
      const b = Math.min(SIMS, a + per);
      if (a >= b) break;
      jobs.push(runWorker({
        board, league, opponents, strategySpecs, strategyNames,
        slots: SLOTS, simRange: [a, b], baseSeed: SEED, opponentParams,
      }));
    }
    log(`[eval] ${jobs.length} workers × ~${per} sims`);
    shards = await Promise.all(jobs);
  } else {
    shards = [evaluateShard({
      board, league, opponents, strategies: registry, strategyNames,
      slots: SLOTS, simRange: [0, SIMS], baseSeed: SEED, opponentParams,
    })];
  }

  const merged = shards.length > 1 ? mergeShards(shards) : shards[0];
  const summary = summarize(merged);
  const artifact = {
    schema: 1,
    buildHash: summary.buildHash,
    seed: summary.seed,
    sims: summary.sims,
    generatedAt: new Date().toISOString(),
    opponentParams: opponents?.params ?? null,
    slots: summary.slots,
    strategies: summary.strategies,
    cells: summary.cells,
    pairedVsBalanced: summary.pairedVsBalanced,
    meta: {
      wallTimeMs: Date.now() - t0,
      workers: WORKERS,
      shards: shards.length,
      nodeVersion: process.version,
    },
  };
  const outPath = path.resolve(argStr('out', DEFAULT_OUT));
  writeFileSync(outPath, JSON.stringify(artifact), 'utf8');

  printTables(summary);
  log(`\n[done] ${outPath} — ${SLOTS.length} slot(s) × ${strategyNames.length} `
    + `strategies × ${SIMS} sims in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
