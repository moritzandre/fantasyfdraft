// evaluate_core.mjs — strategy-evaluation core: the LIVE engine
// (engine/index.js recommend) self-plays one seat of the shared opponent
// room (engine/opponent.js) and the results aggregate into mergeable
// shards. PURE in the engine sense: NO fs, NO process, NO Date.now() —
// tools/evaluate_strategies.mjs does all I/O, timing and logging; this file
// receives everything as arguments.
//
// Paired design (the whole point):
//   • The per-sim rng seed is draftSeed(baseSeed, slot, simIndex) — the
//     STRATEGY IS NOT AN INPUT (tools/lib/seeds.mjs). Forced self-play picks
//     consume no rng (engine/opponent.js run pickFor), so for a given
//     (slot, simIndex) the 11 opponents execute the identical script under
//     every strategy: per-sim roster values are PAIRED across strategies and
//     the paired Δ-vs-balanced estimator cancels draft-room noise (common
//     random numbers).
//   • Shards are [from, to) sim ranges. Every simIndex reseeds from scratch,
//     so shards compute independently (workers, other machines) and
//     mergeShards() glues gap-free ranges back together. summarize() output
//     is EXACTLY invariant to the split: every reported number derives from
//     per-sim Float32 values (concatenated, summed in the same order),
//     integer histograms, or INTEGER running accumulators — float running
//     sums are banned in the shard because addition-order ULP drift at a
//     rounding boundary would make split and unsplit runs disagree (it did,
//     in testing: roundEffMean flipped by 0.01). Eff sums are accumulated
//     in centi-points (round(eff·100), exact integer adds ⇒ ≤ 0.005 pt/pick
//     quantization); all-play results as half-win counts (2·wins + ties).
//
// Metrics per cell (slot × strategy):
//   rosterValue    season bestLineup total (eff) of my 16 players — exact
//                  per-sim Float32 values + an Int32 histogram.
//   allPlayWinPct  mean over weeks 1..18 of the fraction of the other 11
//                  teams my weekly bestLineup (weeklyHalfPpr[w-1]) beats;
//                  ties count 1/2 (the all-play convention).
//   posByRound     position of MY pick, per round (counts over sims).
//   roundEffMean   eff of MY pick, per round.
//   conflictRate   recommendation #1 carried strategyCompliant:false —
//                  fraction of my picks.
//   fallbackRate   the engine shortlist came back empty (guard path) —
//                  fraction of my picks.
//
// Roster-value histogram binning: bin b covers
// [offset + b·width, offset + (b+1)·width), offset 0, width 2.0 season
// points, 3000 bins → 0..6000, comfortably covering any legal lineup total
// (real boards top out < 2500; the synthetic test board < 4000). Histogram
// quantiles report the bin MIDPOINT ⇒ ≤ ±1 pt discretization error;
// means/SEs use the exact per-sim values instead. All-play win% uses 100
// bins of width 0.01 over [0, 1], same midpoint convention.

import { recommend } from '../../engine/index.js';
import { makeOpponentCtx, makeDraftSim } from '../../engine/opponent.js';
import { bestLineup } from '../../engine/lineup.js';
import { xorshift128plus } from '../../engine/mc.js';
import { slotForPick } from '../../engine/picks.js';
import { resolveStrategy } from '../../engine/strategy.js';
import { draftSeed, fnv1a32 } from './seeds.mjs';

const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
const POS_IDX = Object.fromEntries(POS.map((p, i) => [p, i]));
const SKILL = ['QB', 'RB', 'WR', 'TE'];
const HARD_SCHEDULED = ['K', 'DST'];

/** Histogram spec — see the binning note in the header. */
export const RV_HIST = Object.freeze({ offset: 0, width: 2, bins: 3000 });
export const AP_BINS = 100;

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

// ── Self-play policy ───────────────────────────────────────────────────────

/** Best-eff available fallback for the pathological empty-shortlist case.
    Legality first: inside the engine's hard-scheduling window (round ≥
    rounds−1) an unfilled K/DST slot is filled before anything else, so the
    16-man roster always ends 1 K + 1 DST; otherwise best-eff skill player;
    a skill-empty pool (impossible on real boards) degrades to best-eff any. */
function fallbackPick(board, leagueAt, picks, pickNo) {
  const taken = new Set(picks);
  const snake = leagueAt.snake !== false;
  const round = Math.ceil(pickNo / leagueAt.teams);
  if (round >= leagueAt.rounds - 1) {
    const counts = {};
    picks.forEach((idx, k) => {
      if (slotForPick(k + 1, leagueAt.teams, snake) === leagueAt.slot) {
        const pos = board.players[idx].pos;
        counts[pos] = (counts[pos] ?? 0) + 1;
      }
    });
    for (const pos of HARD_SCHEDULED) {
      if ((counts[pos] ?? 0) < (leagueAt.roster[pos] ?? 0)) {
        let best = -1, bestEff = -Infinity;
        for (const p of board.players) {
          if (taken.has(p.idx) || p.pos !== pos) continue;
          if (p.eff > bestEff) { bestEff = p.eff; best = p.idx; }
        }
        if (best >= 0) return best;
      }
    }
  }
  let best = -1, bestEff = -Infinity;
  for (const p of board.players) {
    if (taken.has(p.idx) || !SKILL.includes(p.pos)) continue;
    if (p.eff > bestEff) { bestEff = p.eff; best = p.idx; }
  }
  if (best >= 0) return best;
  for (const p of board.players) if (!taken.has(p.idx)) return p.idx;
  throw new Error('fallbackPick: pool exhausted');
}

/** All-play weekly result for one finished draft: rosters from the dense
    1..totalPicks record, weekly bestLineup on weeklyHalfPpr[w-1] (bye week
    = 0 by construction), my beaten-count of the other N−1 summed over the
    weeks. Ties count 1/2, so the INTEGER numerator is 2·wins + ties out of
    a per-sim denominator of 2·(N−1)·weeks — integers merge exactly across
    shards, floats would not (see header). */
function allPlayResult(players, record, league, mySlot, weeks) {
  const N = league.teams;
  const snake = league.snake !== false;
  const rosters = Array.from({ length: N + 1 }, () => []);
  for (let k = 0; k < record.length; k++) {
    rosters[slotForPick(k + 1, N, snake)].push(players[record[k]]);
  }
  const totals = new Float64Array(N + 1);
  let num = 0; // Σ over weeks of (2·wins + ties)
  for (let w = 0; w < weeks; w++) {
    for (let s = 1; s <= N; s++) {
      const weekly = rosters[s].map((p) => ({ pos: p.pos, eff: p.weeklyHalfPpr[w] }));
      totals[s] = bestLineup(weekly, league.roster, league.flexEligible).total;
    }
    for (let s = 1; s <= N; s++) {
      if (s === mySlot) continue;
      if (totals[mySlot] > totals[s]) num += 2;
      else if (totals[mySlot] === totals[s]) num += 1;
    }
  }
  return { num, pct: num / (2 * (N - 1) * weeks) };
}

// ── Shard evaluation ───────────────────────────────────────────────────────

/**
 * Run [from, to) self-play drafts for every slot × strategyName cell.
 *
 * @param {object} cfg
 *   board          board.json shape (players in ADP order, dense idx,
 *                  weeklyHalfPpr present).
 *   league         config/league.json shape (slot is overridden per cell).
 *   opponents      opponents.json shape.
 *   strategies     custom-strategy registry (defineStrategy outputs) or
 *                  null. Serves BOTH recommend() and the opponent archetype
 *                  mix — must contain every custom name opponents.json
 *                  references, regardless of which strategyNames run.
 *   strategyNames  strategies to evaluate (built-ins and/or registry names).
 *   slots          draft slots to evaluate, each 1..teams.
 *   simRange       [from, to) — GLOBAL sim indices (seeds are absolute).
 *   baseSeed       CLI --seed.
 *   opponentParams optional sampler overrides (makeOpponentCtx params).
 *   policy         optional pick-policy override for experiments:
 *                  ({board, league, slot, strategyName, strategies, picks,
 *                  pickNo}) → player idx. Default: recommend()[0].
 *   onSimDone      optional inspection hook (tests): ({slot, strategy,
 *                  simIndex, myIdxs, record}) after each draft.
 * @returns {{meta: object, cells: object[]}} shard (typed arrays live).
 */
export function evaluateShard(cfg) {
  const {
    board, league, opponents, strategies = null, strategyNames, slots,
    simRange, baseSeed, opponentParams = null, policy = null, onSimDone = null,
  } = cfg;
  const [from, to] = simRange;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
    throw new Error(`evaluateShard: bad simRange [${from}, ${to})`);
  }
  for (const name of strategyNames) resolveStrategy(name, strategies); // fail fast on typos
  for (const slot of slots) {
    if (!Number.isInteger(slot) || slot < 1 || slot > league.teams) {
      throw new Error(`evaluateShard: slot ${slot} outside 1..${league.teams}`);
    }
  }
  const players = board.players;
  const weeks = players[0]?.weeklyHalfPpr?.length ?? 0;
  if (weeks === 0) throw new Error('evaluateShard: board players lack weeklyHalfPpr');

  const nSims = to - from;
  const rounds = league.rounds;
  const N = league.teams;
  const ctx = makeOpponentCtx(board, league, opponents, { ...(opponentParams ?? {}), strategies });
  const sim = makeDraftSim(ctx);

  // Compatibility fingerprint: two shards may merge only if the opponent
  // room was configured identically (params + archetype mix + overrides).
  const opponentParamsHash = fnv1a32(JSON.stringify({
    params: opponents?.params ?? null,
    mix: opponents?.archetypes?.mix ?? null,
    overrides: opponentParams ?? null,
  }));

  const cells = [];
  for (const slot of slots) {
    const leagueAt = { ...league, slot };
    for (const strategyName of strategyNames) {
      const cell = {
        slot,
        strategy: strategyName,
        sims: nSims,
        perSimRv: new Float32Array(nSims),
        rvHist: new Int32Array(RV_HIST.bins),
        apHist: new Int32Array(AP_BINS),
        apNum: 0, // integer Σ of per-sim all-play numerators (2·wins + ties)
        posByRound: new Int32Array(rounds * 6),
        roundEffSum: new Float64Array(rounds),   // integer CENTI-points (exact adds)
        roundEffSumsq: new Float64Array(rounds), // integer centi-points²
        conflictCount: 0,
        fallbackCount: 0,
      };

      for (let si = 0; si < nSims; si++) {
        const simIndex = from + si;
        const rng = xorshift128plus(draftSeed(baseSeed, slot, simIndex));
        sim.reset();
        sim.drawSeatState(rng);
        const record = [];
        const myIdxs = [];
        const pickFor = (p, seat) => {
          if (seat !== slot) return null; // opponents: sampled from the room model
          let idx;
          if (policy) {
            idx = policy({
              board, league: leagueAt, slot, strategyName, strategies,
              picks: record, pickNo: p,
            });
          } else {
            // record is dense (no holes) — recommend's picks form is exact.
            const res = recommend(board, leagueAt, { picks: record, strategy: strategyName }, { strategies });
            const top = res.recommendations[0];
            if (top) {
              if (top.strategyCompliant === false) cell.conflictCount++;
              idx = top.idx;
            } else {
              cell.fallbackCount++;
              idx = fallbackPick(board, leagueAt, record, p);
            }
          }
          const round = Math.ceil(p / N);
          const pl = players[idx];
          const effCenti = Math.round(pl.eff * 100); // exact-merge fixed point
          cell.posByRound[(round - 1) * 6 + POS_IDX[pl.pos]]++;
          cell.roundEffSum[round - 1] += effCenti;
          cell.roundEffSumsq[round - 1] += effCenti * effCenti;
          myIdxs.push(idx);
          return idx;
        };
        sim.run(1, ctx.totalPicks, rng, { record, pickFor });

        // Season roster value: best legal lineup over my 16 on season eff.
        const rv = bestLineup(myIdxs.map((i) => players[i]), league.roster, league.flexEligible).total;
        cell.perSimRv[si] = rv;
        const b = Math.min(RV_HIST.bins - 1, Math.max(0, Math.floor((rv - RV_HIST.offset) / RV_HIST.width)));
        cell.rvHist[b]++;

        const ap = allPlayResult(players, record, league, slot, weeks);
        cell.apNum += ap.num;
        cell.apHist[Math.min(AP_BINS - 1, Math.max(0, Math.floor(ap.pct * AP_BINS)))]++;

        if (onSimDone) onSimDone({ slot, strategy: strategyName, simIndex, myIdxs, record });
      }
      cells.push(cell);
    }
  }

  return {
    meta: {
      baseSeed,
      simRange: [from, to],
      slots: [...slots],
      strategyNames: [...strategyNames],
      buildHash: board.buildHash ?? null,
      opponentParamsHash,
      rounds,
      apDenomPerSim: 2 * (N - 1) * weeks, // per-sim all-play denominator
      hist: {
        rvOffset: RV_HIST.offset, rvWidth: RV_HIST.width,
        rvBins: RV_HIST.bins, apBins: AP_BINS,
      },
    },
    cells,
  };
}

// ── Merge ──────────────────────────────────────────────────────────────────

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Merge shards of the SAME evaluation: identical baseSeed / buildHash /
 * opponentParamsHash / slots / strategyNames / histogram spec, sim ranges
 * non-overlapping and gap-free. Histograms and counters add; perSimRv
 * concatenates in simIndex order. Throws on any incompatibility.
 */
export function mergeShards(shards) {
  if (!Array.isArray(shards) || shards.length === 0) throw new Error('mergeShards: no shards');
  const sorted = shards.slice().sort((a, b) => a.meta.simRange[0] - b.meta.simRange[0]);
  const m0 = sorted[0].meta;
  for (const s of sorted) {
    const m = s.meta;
    if (m.baseSeed !== m0.baseSeed) throw new Error(`mergeShards: baseSeed mismatch (${m.baseSeed} vs ${m0.baseSeed})`);
    if (m.buildHash !== m0.buildHash) throw new Error(`mergeShards: buildHash mismatch (${m.buildHash} vs ${m0.buildHash})`);
    if (m.opponentParamsHash !== m0.opponentParamsHash) throw new Error('mergeShards: opponentParamsHash mismatch — different opponent configs');
    if (m.rounds !== m0.rounds) throw new Error('mergeShards: rounds mismatch');
    if (m.apDenomPerSim !== m0.apDenomPerSim) throw new Error('mergeShards: all-play denominator mismatch (teams/weeks differ)');
    if (!sameList(m.slots, m0.slots)) throw new Error('mergeShards: slots mismatch');
    if (!sameList(m.strategyNames, m0.strategyNames)) throw new Error('mergeShards: strategyNames mismatch');
    if (JSON.stringify(m.hist) !== JSON.stringify(m0.hist)) throw new Error('mergeShards: histogram spec mismatch');
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].meta.simRange;
    const cur = sorted[i].meta.simRange;
    if (cur[0] < prev[1]) throw new Error(`mergeShards: sim ranges overlap ([${prev}) / [${cur}))`);
    if (cur[0] > prev[1]) throw new Error(`mergeShards: gap in sim ranges (${prev[1]}..${cur[0]} missing)`);
  }
  const from = sorted[0].meta.simRange[0];
  const to = sorted[sorted.length - 1].meta.simRange[1];
  const nSims = to - from;

  const cells = sorted[0].cells.map((c0, ci) => {
    const out = {
      slot: c0.slot,
      strategy: c0.strategy,
      sims: nSims,
      perSimRv: new Float32Array(nSims),
      rvHist: new Int32Array(m0.hist.rvBins),
      apHist: new Int32Array(m0.hist.apBins),
      apNum: 0,
      posByRound: new Int32Array(m0.rounds * 6),
      roundEffSum: new Float64Array(m0.rounds),
      roundEffSumsq: new Float64Array(m0.rounds),
      conflictCount: 0,
      fallbackCount: 0,
    };
    for (const s of sorted) {
      const c = s.cells[ci];
      if (!c || c.slot !== c0.slot || c.strategy !== c0.strategy) {
        throw new Error('mergeShards: cell order mismatch');
      }
      out.perSimRv.set(c.perSimRv, s.meta.simRange[0] - from);
      for (let b = 0; b < out.rvHist.length; b++) out.rvHist[b] += c.rvHist[b];
      for (let b = 0; b < out.apHist.length; b++) out.apHist[b] += c.apHist[b];
      for (let k = 0; k < out.posByRound.length; k++) out.posByRound[k] += c.posByRound[k];
      for (let r = 0; r < m0.rounds; r++) {
        out.roundEffSum[r] += c.roundEffSum[r];
        out.roundEffSumsq[r] += c.roundEffSumsq[r];
      }
      out.apNum += c.apNum;
      out.conflictCount += c.conflictCount;
      out.fallbackCount += c.fallbackCount;
    }
    return out;
  });

  return {
    meta: { ...m0, simRange: [from, to], slots: [...m0.slots], strategyNames: [...m0.strategyNames], hist: { ...m0.hist } },
    cells,
  };
}

// ── Summary ────────────────────────────────────────────────────────────────

/**
 * Quantile from an integer-count histogram: the MIDPOINT of the first bin
 * where the cumulative count reaches q·total; bin b spans
 * [offset + b·width, offset + (b+1)·width).
 */
export function histQuantile(hist, total, q, offset, width) {
  if (total <= 0) return NaN;
  const target = Math.max(q * total, 1e-12);
  let cum = 0;
  for (let b = 0; b < hist.length; b++) {
    cum += hist[b];
    if (cum >= target) return offset + (b + 0.5) * width;
  }
  return offset + (hist.length - 0.5) * width;
}

/** Mean + standard error of a numeric array (Bessel-corrected sd). */
function meanSe(arr) {
  const n = arr.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = arr[i] - mean; ss += d * d; }
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  return { mean, se: sd / Math.sqrt(n) };
}

/** Paired per-sim differences strategy − balanced: mean, se, all-play-style
    win rate (ties = 1/2). Exact zeros when the policies coincide. */
function pairedStats(rvS, rvB) {
  const n = rvS.length;
  const diffs = new Float64Array(n);
  let sum = 0, wins = 0, ties = 0;
  for (let i = 0; i < n; i++) {
    const d = rvS[i] - rvB[i];
    diffs[i] = d;
    sum += d;
    if (d > 0) wins++;
    else if (d === 0) ties++;
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = diffs[i] - mean; ss += d * d; }
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  return { meanDiff: mean, se: sd / Math.sqrt(n), winRate: (wins + 0.5 * ties) / n };
}

/**
 * Shard (usually merged) → the evaluation.json payload: per-cell stats plus
 * pairedVsBalanced. perSimRv is consumed here and NOT carried into the
 * artifact. pairedVsBalanced is null when 'balanced' was not evaluated.
 */
export function summarize(shard) {
  const { meta, cells } = shard;
  const { rvOffset, rvWidth, apBins } = meta.hist;
  const rounds = meta.rounds;

  const outCells = cells.map((c) => {
    const n = c.sims;
    const { mean, se } = meanSe(c.perSimRv);
    const rvQ = (q) => r2(histQuantile(c.rvHist, n, q, rvOffset, rvWidth));
    const apQ = (q) => r4(histQuantile(c.apHist, n, q, 0, 1 / apBins));
    const posByRound = [];
    for (let r = 0; r < rounds; r++) {
      posByRound.push(Array.from(c.posByRound.slice(r * 6, r * 6 + 6)));
    }
    return {
      slot: c.slot,
      strategy: c.strategy,
      sims: n,
      rosterValue: {
        mean: r2(mean), se: r2(se),
        p10: rvQ(0.10), p25: rvQ(0.25), p50: rvQ(0.50), p75: rvQ(0.75), p90: rvQ(0.90),
      },
      allPlayWinPct: {
        mean: r4(c.apNum / (meta.apDenomPerSim * n)),
        p10: apQ(0.10), p50: apQ(0.50), p90: apQ(0.90),
      },
      posByRound, // [round][QB,RB,WR,TE,K,DST] pick counts over `sims` drafts
      // roundEffSum is integer centi-points — /100 back to season points.
      roundEffMean: Array.from({ length: rounds }, (_, r) => r2(c.roundEffSum[r] / (100 * n))),
      conflictRate: r4(c.conflictCount / (n * rounds)),
      fallbackRate: r4(c.fallbackCount / (n * rounds)),
    };
  });

  // Paired Δ vs balanced, per slot per non-balanced strategy.
  let pairedVsBalanced = null;
  if (meta.strategyNames.includes('balanced')) {
    pairedVsBalanced = {};
    const cellOf = new Map(cells.map((c) => [`${c.slot} ${c.strategy}`, c]));
    for (const slot of meta.slots) {
      const base = cellOf.get(`${slot} balanced`);
      pairedVsBalanced[slot] = {};
      for (const name of meta.strategyNames) {
        if (name === 'balanced') continue;
        const s = pairedStats(cellOf.get(`${slot} ${name}`).perSimRv, base.perSimRv);
        pairedVsBalanced[slot][name] = {
          meanDiff: r2(s.meanDiff), se: r2(s.se), winRate: r4(s.winRate),
        };
      }
    }
  }

  return {
    buildHash: meta.buildHash,
    seed: meta.baseSeed,
    sims: meta.simRange[1] - meta.simRange[0],
    slots: [...meta.slots],
    strategies: [...meta.strategyNames],
    cells: outCells,
    pairedVsBalanced,
  };
}

// ── Shard (de)serialization — object transforms only, no fs ────────────────

const CELL_TYPED = Object.freeze({
  perSimRv: Float32Array,
  rvHist: Int32Array,
  apHist: Int32Array,
  posByRound: Int32Array,
  roundEffSum: Float64Array,
  roundEffSumsq: Float64Array,
});

/** Typed arrays → plain arrays for JSON shard files. */
export function shardToJSON(shard) {
  return {
    meta: { ...shard.meta },
    cells: shard.cells.map((c) => {
      const out = { ...c };
      for (const k of Object.keys(CELL_TYPED)) out[k] = Array.from(c[k]);
      return out;
    }),
  };
}

/** Plain-array shard file → live typed-array shard. */
export function shardFromJSON(obj) {
  if (!obj || !obj.meta || !Array.isArray(obj.cells)) {
    throw new Error('shardFromJSON: not a shard file (missing meta/cells)');
  }
  return {
    meta: { ...obj.meta },
    cells: obj.cells.map((c) => {
      const out = { ...c };
      for (const [k, T] of Object.entries(CELL_TYPED)) out[k] = T.from(c[k]);
      return out;
    }),
  };
}
