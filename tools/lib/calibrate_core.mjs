// calibrate_core.mjs — pure internals for tools/calibrate.mjs (opponent-model
// calibration against real Sleeper mock drafts). PURE in the engine sense:
// no fs, no process, no Date.now() — the CLI reads files and passes parsed
// JSON in; tools/calibrate.test.mjs imports these functions directly.
//
// Three jobs:
//
//   A. Teacher-forced replay (replayMock/scoreRecs/evaluateParams): walk a
//      mock's picks in pick_no order against engine/opponent.js and score
//      each observed pick under the per-pick mixture
//          P(pick) = share·P_masked + (1−share)·P_free
//      with P_* = pickDistribution(seat, round, {jitter: tauScale,
//      needMask: 'on'|'off'}). Seats are NEUTRAL — a mock lobby is
//      strangers, so per-seat tendencies and archetypes are OFF — and the
//      ctx is built with tauScale=1 so the jitter override IS the tauScale
//      being evaluated: τ enters computeWeights as (… · jitter ·
//      ctx.tauScale), making the two knobs algebraically interchangeable.
//      That is what lets ONE ctx per (window, teams, rounds) serve the whole
//      tauScale grid (the spec's "cache 3 ctxs" for the 3 window values).
//      Note the mixture is a per-PICK marginal of the true per-DRAFT
//      needAware flag — a deliberate, standard simplification.
//
//   B. pAvail calibration (simulateAvailability/pAvailCalibration): fresh
//      availability sim under the CURRENT production params (the real
//      opponents.json incl. archetypes + seat tendencies), then
//      predicted-vs-observed reliability bins over all (player, pick) pairs,
//      with a cluster bootstrap over MOCKS (the mock is the resample unit —
//      pairs within one draft are heavily correlated) and a Brier score.
//
//   C. Grid search (gridSearch): tauScale × needAwareShare × window,
//      held-one-mock-out CV mean LL. Teacher forcing has no per-fold fit,
//      so each fold's held-out LL is just that mock's mean LL at the cell;
//      cvLL is the unweighted mean over mocks (each mock = one fold).
//      foldSelection additionally reports the honest CV-of-selection number:
//      per fold, pick the best cell on the OTHER mocks, score the held-out.
//
// Known small bias, documented: observed picks that are off-board (players
// Sleeper knows but board.json doesn't) are NOT applied to the replay state
// — the simulated room looks one pick fuller in player supply than the real
// one from there on. They are counted in coverage.offBoard rather than
// ε-fudged into the likelihood.

import { makeOpponentCtx, makeDraftSim } from '../../engine/opponent.js';
import { slotForPick } from '../../engine/picks.js';
import { xorshift128plus } from '../../engine/mc.js';

export const ROUND_BANDS = Object.freeze([
  Object.freeze({ label: 'R1-3', from: 1, to: 3 }),
  Object.freeze({ label: 'R4-8', from: 4, to: 8 }),
  Object.freeze({ label: 'R9-13', from: 9, to: 13 }),
  Object.freeze({ label: 'R14-16', from: 14, to: Infinity }), // open-ended: >16-round mocks land here too
]);

export const GRID_DEFAULT = Object.freeze({
  tauScales: Object.freeze([0.7, 0.85, 1.0, 1.2, 1.5]),
  shares: Object.freeze([0, 0.15, 0.3, 0.5]),
  windows: Object.freeze([40, 60, 80]),
});

export const GRID_RESOLUTION_NOTE =
  'at n<10 mocks, cvLL differences under ~0.03 nats/pick are noise; '
  + 'a 5-value grid is the honest resolution — do not over-read the ranking';

export function bandOf(round) {
  for (const b of ROUND_BANDS) if (round >= b.from && round <= b.to) return b.label;
  return ROUND_BANDS[ROUND_BANDS.length - 1].label;
}

/** Neutral seat block for `teams` seats — a mock lobby is strangers, so no
    per-seat tendencies apply (and no archetypes key at all). */
export function neutralOpponents(teams) {
  return {
    seats: Array.from({ length: teams }, (_, i) => ({
      seat: i + 1, name: '', adpDiscipline: 0.5, positionBias: {}, homerTeams: [], reachRounds: [],
    })),
  };
}

/**
 * Normalize one raw mock file (tools/fetch_mocks.py output) into the replay
 * shape. Defensive: missing settings fall back to the league's, malformed
 * picks are dropped (counted), unknown/out-of-range player ids map to
 * idx null (off-board).
 *
 * @param {object} raw  {draft: {settings: {teams, rounds}, ...}, picks: [...]}
 * @param {Object<string, number>} slimSleeperMap  board.json slimSleeperMap.
 * @param {{defaultTeams?: number, defaultRounds?: number, nPlayers?: number}} [opts]
 * @returns {{draftId, teams, rounds, picks: [{pickNo, playerId, idx}], dropped}}
 */
export function mapMock(raw, slimSleeperMap, opts = {}) {
  const { defaultTeams = 12, defaultRounds = 16, nPlayers = Infinity } = opts;
  const draft = raw?.draft ?? {};
  const settings = draft.settings ?? {};
  const teams = Number.isInteger(settings.teams) && settings.teams >= 2
    ? settings.teams : defaultTeams;
  const rounds = Number.isInteger(settings.rounds) && settings.rounds >= 1
    ? settings.rounds : defaultRounds;
  const picks = [];
  let dropped = 0;
  const rawPicks = Array.isArray(raw?.picks) ? raw.picks : [];
  for (const p of rawPicks) {
    const pickNo = Number(p?.pick_no);
    if (!Number.isInteger(pickNo) || pickNo < 1 || pickNo > teams * rounds) { dropped++; continue; }
    const playerId = p?.player_id != null ? String(p.player_id) : '';
    let idx = slimSleeperMap != null && playerId !== '' && playerId in slimSleeperMap
      ? slimSleeperMap[playerId] : null;
    if (!(Number.isInteger(idx) && idx >= 0 && idx < nPlayers)) idx = null;
    picks.push({ pickNo, playerId, idx });
  }
  picks.sort((a, b) => a.pickNo - b.pickNo);
  return { draftId: String(draft.draft_id ?? 'unknown'), teams, rounds, picks, dropped };
}

/**
 * Ctx factory with a cache keyed by (window, teams, rounds) — the only
 * knobs that force a rebuild. Every ctx is NEUTRAL seats, no archetypes,
 * tauScale=1 (the jitter override carries the evaluated tauScale, see the
 * header). needAwareShare/jitterSd are irrelevant here: replay never calls
 * drawSeatState and forces needMask explicitly.
 */
export function makeNeutralCtxCache(board, league) {
  const cache = new Map();
  return function getCtx({ window, teams, rounds }) {
    const key = `${window}|${teams}|${rounds}`;
    let ctx = cache.get(key);
    if (!ctx) {
      ctx = makeOpponentCtx(board, { ...league, teams, rounds }, neutralOpponents(teams), {
        window, tauScale: 1, mix: null,
      });
      cache.set(key, ctx);
    }
    return ctx;
  };
}

/**
 * Teacher-forced replay of one mapped mock: before each observed on-board
 * pick, record P_masked and P_free for the observed idx (share-independent),
 * then apply the observed pick. Off-board picks are counted and NOT applied
 * (the board doesn't know them — see the header bias note); duplicate ids
 * (already-taken idx, malformed data) are counted and skipped too.
 *
 * @returns {{recs: [{round, pOn, pFree, mFree}], offBoard, duplicates, total}}
 */
export function replayMock(ctx, mock, tauScale) {
  const sim = makeDraftSim(ctx);
  sim.reset();
  const recs = [];
  let offBoard = 0;
  let duplicates = 0;
  for (const pk of mock.picks) {
    if (pk.idx == null) { offBoard++; continue; }
    if (sim.taken[pk.idx]) { duplicates++; continue; }
    const seat = slotForPick(pk.pickNo, mock.teams, true);
    const round = Math.ceil(pk.pickNo / mock.teams);
    const dOn = sim.pickDistribution(seat, round, { jitter: tauScale, needMask: 'on' });
    const dFree = sim.pickDistribution(seat, round, { jitter: tauScale, needMask: 'off' });
    let pOn = 0;
    for (const d of dOn) if (d.idx === pk.idx) { pOn = d.p; break; }
    let pFree = 0;
    for (const d of dFree) if (d.idx === pk.idx) { pFree = d.p; break; }
    recs.push({ round, pOn, pFree, mFree: dFree.length });
    sim.applyPick(pk.idx, pk.pickNo);
  }
  return { recs, offBoard, duplicates, total: mock.picks.length };
}

/**
 * Score one replay under a needAwareShare. Picks whose mixture probability
 * is 0 (absent from both windows — or from the free window at share 0) land
 * in beyondWindow and contribute no LL term. The uniform-over-window
 * baseline (−ln mFree) accumulates over the SAME scored set so the two mean
 * LLs are comparable.
 */
export function scoreRecs(recs, share) {
  const byBand = {};
  for (const b of ROUND_BANDS) byBand[b.label] = { sumLL: 0, n: 0 };
  let sumLL = 0;
  let n = 0;
  let beyondWindow = 0;
  let sumLLUniform = 0;
  for (const r of recs) {
    const p = share * r.pOn + (1 - share) * r.pFree;
    if (!(p > 0)) { beyondWindow++; continue; }
    const ll = Math.log(p);
    sumLL += ll;
    n++;
    sumLLUniform += -Math.log(r.mFree);
    const b = byBand[bandOf(r.round)];
    b.sumLL += ll;
    b.n++;
  }
  return { sumLL, n, beyondWindow, sumLLUniform, byBand };
}

/**
 * Part A aggregate: evaluate one (tauScale, needAwareShare, window) over all
 * mocks. `getCtx` (makeNeutralCtxCache output) may be shared across calls
 * to reuse ctxs between the current eval and the baselines.
 */
export function evaluateParams(board, league, mocks, { tauScale, needAwareShare, window }, getCtx = null) {
  const ctxOf = getCtx ?? makeNeutralCtxCache(board, league);
  const agg = { sumLL: 0, n: 0, offBoard: 0, beyondWindow: 0, duplicates: 0, totalPicks: 0, sumLLUniform: 0 };
  const byBand = {};
  for (const b of ROUND_BANDS) byBand[b.label] = { sumLL: 0, n: 0 };
  const perMock = [];
  for (const mock of mocks) {
    const ctx = ctxOf({ window, teams: mock.teams, rounds: mock.rounds });
    const { recs, offBoard, duplicates, total } = replayMock(ctx, mock, tauScale);
    const s = scoreRecs(recs, needAwareShare);
    agg.sumLL += s.sumLL;
    agg.n += s.n;
    agg.offBoard += offBoard;
    agg.beyondWindow += s.beyondWindow;
    agg.duplicates += duplicates;
    agg.totalPicks += total;
    agg.sumLLUniform += s.sumLLUniform;
    for (const b of ROUND_BANDS) {
      byBand[b.label].sumLL += s.byBand[b.label].sumLL;
      byBand[b.label].n += s.byBand[b.label].n;
    }
    perMock.push({
      draftId: mock.draftId,
      meanLL: s.n ? s.sumLL / s.n : null,
      n: s.n,
      offBoard,
      beyondWindow: s.beyondWindow,
    });
  }
  const meanLL = agg.n ? agg.sumLL / agg.n : null;
  return {
    params: { tauScale, needAwareShare, window },
    meanLL,
    perplexity: meanLL != null ? Math.exp(-meanLL) : null,
    uniformMeanLL: agg.n ? agg.sumLLUniform / agg.n : null,
    coverage: {
      totalPicks: agg.totalPicks,
      scored: agg.n,
      offBoard: agg.offBoard,
      beyondWindow: agg.beyondWindow,
      duplicates: agg.duplicates,
      scoredPct: agg.totalPicks ? agg.n / agg.totalPicks : 0,
    },
    byBand: ROUND_BANDS.map((b) => ({
      band: b.label,
      meanLL: byBand[b.label].n ? byBand[b.label].sumLL / byBand[b.label].n : null,
      n: byBand[b.label].n,
    })),
    perMock,
  };
}

/**
 * Part C: full grid, held-one-mock-out CV (see header). One replay per
 * (window, tauScale, mock); every share is scored from the same recs.
 *
 * @returns {{grid: [{tauScale, needAwareShare, window, cvLL, perMockLL}],
 *            best, foldSelection, note}}  grid sorted by cvLL desc.
 */
export function gridSearch(board, league, mocks, { tauScales, shares, windows } = GRID_DEFAULT) {
  const getCtx = makeNeutralCtxCache(board, league);
  const nM = mocks.length;
  const cells = [];
  for (const window of windows) {
    for (const tauScale of tauScales) {
      const replays = mocks.map((mock) => {
        const ctx = getCtx({ window, teams: mock.teams, rounds: mock.rounds });
        return replayMock(ctx, mock, tauScale);
      });
      for (const share of shares) {
        const perMockLL = replays.map(({ recs }) => {
          const s = scoreRecs(recs, share);
          return s.n ? s.sumLL / s.n : null;
        });
        const valid = perMockLL.filter((v) => v != null);
        const cvLL = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : -Infinity;
        cells.push({ tauScale, needAwareShare: share, window, cvLL, perMockLL });
      }
    }
  }
  const grid = cells.slice().sort((a, b) => b.cvLL - a.cvLL);

  // Honest CV-of-selection: per fold, the best cell on the other mocks,
  // scored on the held-out mock.
  let foldSelection = null;
  if (nM >= 2) {
    let sum = 0;
    let cnt = 0;
    const chosen = [];
    for (let f = 0; f < nM; f++) {
      let best = null;
      let bestLL = -Infinity;
      for (const c of cells) {
        let s = 0;
        let k = 0;
        for (let m = 0; m < nM; m++) {
          if (m === f || c.perMockLL[m] == null) continue;
          s += c.perMockLL[m];
          k++;
        }
        const v = k ? s / k : -Infinity;
        if (v > bestLL) { bestLL = v; best = c; }
      }
      if (best && best.perMockLL[f] != null) {
        sum += best.perMockLL[f];
        cnt++;
        chosen.push({ tauScale: best.tauScale, needAwareShare: best.needAwareShare, window: best.window });
      }
    }
    foldSelection = { meanLL: cnt ? sum / cnt : null, chosen };
  }

  const top = grid[0] ?? null;
  const best = top && Number.isFinite(top.cvLL)
    ? { tauScale: top.tauScale, needAwareShare: top.needAwareShare, window: top.window, cvLL: top.cvLL }
    : null;
  return { grid, best, foldSelection, note: GRID_RESOLUTION_NOTE };
}

/**
 * Part B step 1: P(player available at pick p) under the FULL production
 * model — real opponents.json (seat tendencies + archetype mix + params),
 * drawSeatState per draft. Seeded and allocation-light (histogram +
 * prefix sum, same trick as tools/simulate.mjs).
 *
 * @returns {{pAvail: Float64Array (n×totalPicks, [i*totalPicks+(p-1)]),
 *            n, totalPicks, sims, seed}}
 */
export function simulateAvailability(board, league, opponents, { sims = 5000, seed = 20260827, strategies = null } = {}) {
  const ctx = makeOpponentCtx(board, league, opponents, { strategies });
  const sim = makeDraftSim(ctx);
  const rng = xorshift128plus(seed);
  const { n, totalPicks } = ctx;
  if (totalPicks > 255) throw new Error('simulateAvailability: draftedAt is Uint8 — totalPicks must be ≤ 255');
  const hist = new Int32Array(n * (totalPicks + 2)); // draftedAt 1..totalPicks; totalPicks+1 = undrafted
  for (let s = 0; s < sims; s++) {
    sim.reset();
    sim.drawSeatState(rng);
    sim.run(1, totalPicks, rng, {});
    for (let i = 0; i < n; i++) hist[i * (totalPicks + 2) + (sim.draftedAt[i] || (totalPicks + 1))]++;
  }
  const pAvail = new Float64Array(n * totalPicks);
  for (let i = 0; i < n; i++) {
    let taken = 0;
    for (let p = 1; p <= totalPicks; p++) {
      pAvail[i * totalPicks + (p - 1)] = (sims - taken) / sims;
      taken += hist[i * (totalPicks + 2) + p];
    }
  }
  return { pAvail, n, totalPicks, sims, seed };
}

/** Which of nBins equal-width bins over [0,1] p falls in; the last bin is
    closed at 1 so the bins exactly partition [0,1]. */
export function binOf(p, nBins = 5) {
  return Math.min(nBins - 1, Math.max(0, Math.floor(p * nBins)));
}

function percentile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(q * (sortedAsc.length - 1))));
  return sortedAsc[i];
}

/**
 * Part B step 2: reliability bins predicted-vs-observed over ALL
 * (player, pick) pairs of every mock (players the mock never drafted count
 * as observed-available at every pick — real observations). CI95 per bin
 * from a cluster bootstrap over mocks. Only pass mocks whose teams match
 * the simulated league — availability at overall pick p is not comparable
 * across room sizes (the CLI filters; this function trusts its input).
 *
 * @param {ReturnType<typeof simulateAvailability>} availRes
 * @returns {{bins: [{lo, hi, n, predicted, observed, ci95}], brier, nPairs,
 *            nMocks, sims, resamples}}
 */
export function pAvailCalibration(availRes, mocks, { nBins = 5, resamples = 500, seed = 12345 } = {}) {
  const { pAvail, n, totalPicks, sims } = availRes;
  const perMock = [];
  let sqErr = 0;
  let nPairs = 0;
  for (const mock of mocks) {
    const draftedAt = new Float64Array(n).fill(Infinity);
    for (const pk of mock.picks) {
      if (pk.idx != null && pk.idx < n && pk.pickNo < draftedAt[pk.idx]) draftedAt[pk.idx] = pk.pickNo;
    }
    const pMax = Math.min(totalPicks, mock.teams * mock.rounds);
    const cnt = new Float64Array(nBins);
    const sumPred = new Float64Array(nBins);
    const sumObs = new Float64Array(nBins);
    for (let i = 0; i < n; i++) {
      const dAt = draftedAt[i];
      const base = i * totalPicks;
      for (let p = 1; p <= pMax; p++) {
        const pred = pAvail[base + (p - 1)];
        const obs = dAt >= p ? 1 : 0;
        const b = binOf(pred, nBins);
        cnt[b]++;
        sumPred[b] += pred;
        sumObs[b] += obs;
        const e = pred - obs;
        sqErr += e * e;
        nPairs++;
      }
    }
    perMock.push({ cnt, sumPred, sumObs });
  }

  // Cluster bootstrap: the mock is the resample unit.
  const rng = xorshift128plus(seed);
  const boot = Array.from({ length: nBins }, () => []);
  if (perMock.length > 0) {
    for (let r = 0; r < resamples; r++) {
      const cnt = new Float64Array(nBins);
      const sumObs = new Float64Array(nBins);
      for (let k = 0; k < perMock.length; k++) {
        const j = Math.floor(rng.next() * perMock.length);
        for (let b = 0; b < nBins; b++) {
          cnt[b] += perMock[j].cnt[b];
          sumObs[b] += perMock[j].sumObs[b];
        }
      }
      for (let b = 0; b < nBins; b++) if (cnt[b] > 0) boot[b].push(sumObs[b] / cnt[b]);
    }
  }

  const bins = [];
  for (let b = 0; b < nBins; b++) {
    let cnt = 0;
    let sumPred = 0;
    let sumObs = 0;
    for (const m of perMock) {
      cnt += m.cnt[b];
      sumPred += m.sumPred[b];
      sumObs += m.sumObs[b];
    }
    const bs = boot[b].slice().sort((x, y) => x - y);
    bins.push({
      lo: b / nBins,
      hi: (b + 1) / nBins,
      n: cnt,
      predicted: cnt ? sumPred / cnt : null,
      observed: cnt ? sumObs / cnt : null,
      ci95: bs.length ? [percentile(bs, 0.025), percentile(bs, 0.975)] : null,
    });
  }
  return {
    bins,
    brier: nPairs ? sqErr / nPairs : null,
    nPairs,
    nMocks: perMock.length,
    sims,
    resamples,
  };
}

/**
 * Synthetic mocks sampled FROM the neutral-seat model itself (test/self-
 * consistency harness): known (tauScale, needAwareShare, window), jitterSd
 * pinned to 0 so per-draft τ jitter can't blur the recovery. Returns mocks
 * already in the mapped shape evaluateParams/gridSearch consume.
 */
export function generateSyntheticMocks(board, league, { count, tauScale, needAwareShare, window, seed }) {
  const ctx = makeOpponentCtx(board, league, neutralOpponents(league.teams), {
    window, tauScale, needAwareShare, jitterSd: 0, mix: null,
  });
  const sim = makeDraftSim(ctx);
  const rng = xorshift128plus(seed);
  const mocks = [];
  for (let k = 0; k < count; k++) {
    sim.reset();
    sim.drawSeatState(rng); // jitter ≡ 1 (jitterSd 0); needAware flags at the true share
    const rec = [];
    sim.run(1, ctx.totalPicks, rng, { record: rec });
    mocks.push({
      draftId: `synthetic-${k}`,
      teams: league.teams,
      rounds: league.rounds,
      picks: rec.map((idx, i) => ({ pickNo: i + 1, playerId: String(idx), idx })),
      dropped: 0,
    });
  }
  return mocks;
}
