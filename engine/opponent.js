// opponent.js — THE opponent model: one shared draft-room simulator for the
// offline Monte Carlo (tools/simulate.mjs), the in-app mock-draft driver and
// the strategy-evaluation harness. PURE: no DOM, no fetch, no fs, no
// globals, no Date.now() — every random draw comes through an injected rng
// (engine/mc.js xorshift128plus).
//
// Extracted verbatim from tools/simulate.mjs (makeCtx/makeSim/samplePick/
// softmax). With default params and no archetype mix the sampled pick
// sequence for a given seed is BIT-IDENTICAL to the pre-extraction code —
// tools/simulate.mjs output is the regression anchor.
//
// Model per pick (see also the header of tools/simulate.mjs):
//   • Plackett-Luce over the top-`window` remaining by ADP:
//     w_i = exp(−(μ_i − μ_min)/τ) · seatBoost · archetypeMultiplier.
//   • τ = τ_local (mean adp.sigmaFinal of the first `tauWindow` collected)
//     × exp(discSpread·(0.5 − adpDiscipline)) × per-draft lognormal jitter
//     exp(jitterSd·z) × reachTau in reachRounds × tauScale (calibration).
//   • ~needAwareShare of seats per draft mask to unfilled skill starters.
//   • Realism caps (no 2nd K/DST, no 4th QB/TE …); last two rounds force
//     missing K/DST (mirrors myPicks(league).slice(-2)).
//
// ARCHETYPES (new): each seat may additionally draw a draft STRATEGY per
// draft from opponents.json `archetypes.mix` — e.g. {"balanced": 0.55,
// "robust_rb": 0.15, …}. Names resolve through engine/strategy.js
// resolveStrategy (built-ins + the custom strategies.json registry passed
// via params.strategies). The archetype's multipliers tilt the sampling
// weights; its constraints act as SOFT masks (max ⇒ position forbidden
// while binding, min ⇒ position required when the runway runs out), dropped
// — like the need mask — whenever they empty the candidate window. With no
// mix configured, zero extra rng draws happen and behavior is exactly
// legacy.
//
// REALISM KNOBS (additive — code defaults are exact legacy no-ops):
//   • archetypeGamma (default 1): archetype multipliers apply as
//     m**archetypeGamma, so a strategy tilt (e.g. WR ×1.2) can actually
//     LOOK like its archetype instead of barely nudging the softmax.
//     Applied when the per-round tables are built; gamma 1 keeps the exact
//     multiplier double (Math.pow(m, 1) is not guaranteed bit-identical).
//   • earlyTauThrough (default 0) + earlyTauScale (default 1): when
//     round ≤ earlyTauThrough, τ ×= earlyTauScale — real rooms draft
//     near-chalk in the first rounds. Guarded so the default fp path is
//     untouched.
//   • Per-seat FIXED archetype: a seat object may carry
//     `archetype: '<strategyName>'` — that seat SKIPS the mix draw and
//     always plays that strategy (resolved at ctx build, fail fast on
//     unknown names). rng accounting: with a mix configured a fixed seat
//     still draws (and discards) its mix uniform so the other seats' seeds
//     never shift; with NO mix, fixed seats assign without any draws.

import { slotForPick } from './picks.js';
import { normal } from './mc.js';
import { resolveStrategy, multiplierFor } from './strategy.js';

const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
const POS_IDX = Object.fromEntries(POS.map((p, i) => [p, i]));

export const OPP_DEFAULT_PARAMS = Object.freeze({
  window: 40,          // Plackett-Luce candidate window (top-N by ADP)
  tauWindow: 24,       // τ_local window — matches the live engine
  homerBoost: 1.2,
  reachTau: 1.5,
  jitterSd: 0.20,
  needAwareShare: 0.30,
  discSpread: 2.0,     // adpDiscipline → τ factor exp(discSpread·(0.5−d))
  tauScale: 1.0,       // global temperature knob (calibration)
  archetypeGamma: 1,   // archetype multiplier exponent (1 = legacy no-op)
  earlyTauThrough: 0,  // rounds 1..this get τ ×= earlyTauScale (0 = off)
  earlyTauScale: 1,    // early-round chalk factor (<1 ⇒ sharper)
  caps: Object.freeze({ QB: 3, RB: 9, WR: 9, TE: 3, K: 1, DST: 1 }), // realism rails
});

/**
 * Precompute everything the hot loop touches into flat typed arrays.
 *
 * @param {object} board  board.json shape; players MUST be in ADP order
 *        (build_board sorts by μ asc) — asserted, the window scan depends
 *        on it.
 * @param {object} league  config/league.json shape.
 * @param {object} opponents  opponents.json shape: {seats: [...],
 *        params?: {...overrides}, archetypes?: {mix: {name: weight}}}.
 *        A seat may carry archetype: '<strategyName>' — a FIXED per-seat
 *        strategy that bypasses the mix draw (see the header).
 * @param {object} [params]  overrides on top of opponents.params on top of
 *        OPP_DEFAULT_PARAMS. Two non-numeric extras ride here:
 *        params.strategies — custom-strategy registry for archetype names;
 *        params.mix — archetype mix override (null ⇒ force archetypes off).
 */
export function makeOpponentCtx(board, league, opponents, params = {}) {
  const P = { ...OPP_DEFAULT_PARAMS, ...(opponents?.params ?? {}), ...params };
  const players = board.players;
  const n = players.length;
  const mu = new Float64Array(n);
  const sigmaFinal = new Float64Array(n);
  const eff = new Float64Array(n);
  const posInt = new Uint8Array(n);
  for (const p of players) {
    mu[p.idx] = p.adp.mu;
    sigmaFinal[p.idx] = p.adp.sigmaFinal;
    eff[p.idx] = p.eff;
    posInt[p.idx] = POS_IDX[p.pos];
  }
  for (let i = 1; i < n; i++) {
    if (mu[i] < mu[i - 1] - 1e-9) throw new Error('players not in ADP order — window scan invalid');
  }
  // eff-descending order per position (best-available pointers)
  const posOrderEff = POS.map((_, pi) => {
    const list = [];
    for (let i = 0; i < n; i++) if (posInt[i] === pi) list.push(i);
    list.sort((a, b) => eff[b] - eff[a] || a - b);
    return Int32Array.from(list);
  });
  // μ-ascending order per position (forced K/DST completion)
  const posOrderMu = POS.map((_, pi) => {
    const list = [];
    for (let i = 0; i < n; i++) if (posInt[i] === pi) list.push(i);
    return Int32Array.from(list); // idx order = μ order
  });

  // Per-seat model from opponents.json (seat 1..N; [0] unused).
  const N = league.teams;
  const discFactor = new Float64Array(N + 1).fill(1);
  const reachRounds = Array.from({ length: N + 1 }, () => new Set());
  const seatBoost = Array.from({ length: N + 1 }, () => new Float64Array(n).fill(1));
  const fixedSeatArch = []; // [seat, strategyName] — per-seat FIXED archetypes
  for (const seat of opponents?.seats ?? []) {
    const s = seat.seat;
    if (!(s >= 1 && s <= N)) continue;
    if (typeof seat.archetype === 'string' && seat.archetype.length > 0) {
      fixedSeatArch.push([s, seat.archetype]);
    }
    const d = Math.min(1, Math.max(0, seat.adpDiscipline ?? 0.5));
    discFactor[s] = Math.exp(P.discSpread * (0.5 - d)); // wild ⇒ hot τ, strict ⇒ cold τ
    for (const r of seat.reachRounds ?? []) reachRounds[s].add(r);
    const bias = seat.positionBias ?? {};
    const homers = new Set(seat.homerTeams ?? []);
    for (const p of players) {
      let b = bias[p.pos] ?? 1;
      if (homers.has(p.team)) b *= P.homerBoost;
      if (b !== 1) seatBoost[s][p.idx] = b;
    }
  }

  const S = league.roster;
  const flexElig = new Set(league.flexEligible);
  const capsInt = POS.map((p) => P.caps[p]);
  const rosterCapInt = POS.map((p) => S[p] ?? 0);
  const skillMaskable = POS.map((p) => ['QB', 'RB', 'WR', 'TE'].includes(p));
  const flexEligInt = POS.map((p) => flexElig.has(p));

  // Archetypes: resolve the mix + fixed seat archetypes once, up front
  // (fail fast on unknown names). The table holds every referenced strategy:
  // mix names first (archCdf indexes into that prefix), then fixed-only
  // names appended — fixed seats may play strategies outside the mix.
  const rounds = league.rounds;
  const gamma = P.archetypeGamma;
  let archetypes = null;
  let archCdf = null;
  const seatFixedArch = new Int16Array(N + 1).fill(-1);
  const mixSrc = 'mix' in params ? params.mix : opponents?.archetypes?.mix ?? null;
  const hasMix = !!(mixSrc && Object.keys(mixSrc).length > 0);
  if (hasMix || fixedSeatArch.length > 0) {
    const names = hasMix ? Object.keys(mixSrc) : [];
    const weights = names.map((nm) => {
      const w = mixSrc[nm];
      if (!(typeof w === 'number' && w > 0)) throw new Error(`archetype mix: weight for "${nm}" must be > 0`);
      return w;
    });
    const tableNames = [...names];
    for (const [, nm] of fixedSeatArch) if (!tableNames.includes(nm)) tableNames.push(nm);
    archetypes = tableNames.map((nm) => {
      const strat = resolveStrategy(nm, params.strategies ?? null);
      let mult = null;
      if (Object.keys(strat.multipliers).length > 0) {
        mult = new Float64Array(6 * (rounds + 1)).fill(1);
        for (let pi = 0; pi < 6; pi++) {
          for (let r = 1; r <= rounds; r++) {
            const m = multiplierFor(strat, POS[pi], r);
            // gamma 1 must keep the exact double (Math.pow(m, 1) is not
            // guaranteed bit-identical to m) — the legacy golden gate.
            mult[pi * (rounds + 1) + r] = gamma === 1 ? m : Math.pow(m, gamma);
          }
        }
      }
      const cons = strat.constraints.map((c) => (c.type === 'max'
        ? { max: true, pi: POS_IDX[c.pos], through: c.through, limit: c.limit }
        : { max: false, pi: POS_IDX[c.pos], by: c.by, need: c.need }));
      return { name: strat.name, mult, cons: cons.length ? cons : null };
    });
    for (const [s, nm] of fixedSeatArch) seatFixedArch[s] = tableNames.indexOf(nm);
    if (hasMix) {
      const total = weights.reduce((a, b) => a + b, 0);
      archCdf = new Float64Array(names.length);
      let acc = 0;
      for (let k = 0; k < weights.length; k++) { acc += weights[k] / total; archCdf[k] = acc; }
      archCdf[archCdf.length - 1] = 1; // guard fp drift
    }
  }

  return {
    players, n, mu, sigmaFinal, eff, posInt, posOrderEff, posOrderMu,
    discFactor, reachRounds, seatBoost,
    N, rounds, totalPicks: N * rounds, snake: league.snake !== false,
    S, capsInt, rosterCapInt, skillMaskable, flexEligInt,
    flexSlots: S.FLEX ?? 0,
    kIdx: POS_IDX.K, dstIdx: POS_IDX.DST,
    window: P.window, tauWindow: P.tauWindow, reachTau: P.reachTau,
    jitterSd: P.jitterSd, needAwareShare: P.needAwareShare, tauScale: P.tauScale,
    earlyTauThrough: P.earlyTauThrough, earlyTauScale: P.earlyTauScale,
    params: P,
    archetypes, archCdf, seatFixedArch,
  };
}

/** Mutable draft-room state + the sampling core. One instance, reset per
    sim. All state is typed arrays — allocation-free in the hot loop. */
export function makeDraftSim(ctx) {
  const { n, N } = ctx;
  const taken = new Uint8Array(n);
  const counts = new Int32Array((N + 1) * 6);
  const draftedAt = new Uint8Array(n);
  const jitter = new Float64Array(N + 1).fill(1);
  const needAware = new Uint8Array(N + 1);
  const seatArch = new Int16Array(N + 1).fill(-1);
  const cand = new Int32Array(ctx.window + 8);
  const candW = new Float64Array(ctx.window + 8);
  let front = 0;

  function reset() {
    taken.fill(0); counts.fill(0); draftedAt.fill(0); front = 0;
  }

  /** Draw the per-draft seat randomness: τ jitter + need-aware flags +
      (only when a mix is configured) one archetype per seat. A seat with a
      FIXED archetype always plays it — with a mix it still consumes its
      draw (discarded, so the other seats' streams never shift); with no
      mix, fixed seats assign deterministically and NOTHING extra is drawn. */
  function drawSeatState(rng) {
    for (let s = 1; s <= N; s++) jitter[s] = Math.exp(ctx.jitterSd * normal(rng));
    for (let s = 1; s <= N; s++) needAware[s] = rng.next() < ctx.needAwareShare ? 1 : 0;
    if (ctx.archCdf) {
      for (let s = 1; s <= N; s++) {
        const u = rng.next();
        if (ctx.seatFixedArch[s] >= 0) { seatArch[s] = ctx.seatFixedArch[s]; continue; }
        let k = 0;
        while (k < ctx.archCdf.length - 1 && u >= ctx.archCdf[k]) k++;
        seatArch[s] = k;
      }
    } else if (ctx.archetypes) {
      for (let s = 1; s <= N; s++) seatArch[s] = ctx.seatFixedArch[s];
    } else {
      seatArch.fill(-1);
    }
  }

  /** Force-apply a fixed pick prefix (picks 1..prefix.length). */
  function applyPicks(prefix) {
    for (let k = 0; k < prefix.length; k++) applyPick(prefix[k], k + 1);
  }

  /** Apply one externally chosen pick (self-play policy, observed mock
      pick, n-aware replay). Safe with holes: pickNo is authoritative. */
  function applyPick(idx, pickNo) {
    taken[idx] = 1;
    draftedAt[idx] = Math.min(pickNo, 255);
    counts[slotForPick(pickNo, N, ctx.snake) * 6 + ctx.posInt[idx]]++;
  }

  /** Apply an n-aware entry log [{n, idx}] — the store's PickEntry shape.
      Entries with idx null/out-of-range are skipped (off-board picks). */
  function applyEntries(entries) {
    for (const e of entries) {
      if (e.idx == null || e.idx < 0 || e.idx >= n) continue;
      applyPick(e.idx, e.n);
    }
  }

  /** Need-aware skill mask: bitmask over QB/RB/WR/TE the seat still needs as
      a starter (dedicated or flex); 0 ⇒ no mask (bench mode). */
  function skillNeedMask(seat) {
    let mask = 0;
    let surplus = 0;
    for (let pi = 0; pi < 6; pi++) {
      if (!ctx.skillMaskable[pi]) continue;
      const have = counts[seat * 6 + pi];
      const cap = ctx.rosterCapInt[pi];
      if (have < cap) mask |= 1 << pi;
      if (ctx.flexEligInt[pi] && have > cap) surplus += have - cap;
    }
    if (ctx.flexSlots - Math.min(ctx.flexSlots, surplus) > 0) {
      for (let pi = 0; pi < 6; pi++) {
        if (ctx.flexEligInt[pi]) mask |= 1 << pi;
      }
    }
    return mask;
  }

  /**
   * Fill cand[0..m) for one pick by `seat` in `round`. Returns
   * {m, tauLocal, fallback}; fallback ≥ 0 ⇒ the pool pathologically
   * exhausted the window and that idx must be taken outright.
   * needMode: 0 = seat's own need-awareness, 1 = force mask on,
   * 2 = force mask off (calibration mixes the two).
   */
  function collect(seat, round, needMode) {
    while (front < n && taken[front]) front++;

    let m = 0;
    let tauSum = 0, tauN = 0;

    // Last two rounds: a seat still missing K or DST fills it (mirrors the
    // engine's myPicks(league).slice(-2) hard-scheduling).
    if (round >= ctx.rounds - 1) {
      for (const pi of [ctx.kIdx, ctx.dstIdx]) {
        if (counts[seat * 6 + pi] < ctx.rosterCapInt[pi]) {
          const order = ctx.posOrderMu[pi];
          let got = 0;
          for (let j = 0; j < order.length && got < 4; j++) {
            if (!taken[order[j]]) { cand[m++] = order[j]; got++; }
          }
        }
      }
      if (m > 0) {
        for (let j = 0; j < m; j++) { tauSum += ctx.sigmaFinal[cand[j]]; tauN++; }
        return { m, tauLocal: tauSum / tauN, fallback: -1 };
      }
    }

    const useNeed = needMode === 1 || (needMode === 0 && needAware[seat] === 1);
    const mask = useNeed ? skillNeedMask(seat) : 0;

    // Archetype constraints as soft masks (same drop-on-empty rule as the
    // need mask): max ⇒ forbid the position while the window is open and
    // the limit is reached; min ⇒ require the position when every remaining
    // pick through the deadline must be spent on it.
    let require = 0, forbid = 0;
    const ai = seatArch[seat];
    if (ai >= 0 && ctx.archetypes[ai].cons) {
      for (const c of ctx.archetypes[ai].cons) {
        const have = counts[seat * 6 + c.pi];
        if (c.max) {
          if (round <= c.through && have >= c.limit) forbid |= 1 << c.pi;
        } else if (round <= c.by) {
          const deficit = c.need - have;
          if (deficit > 0 && deficit >= c.by - round + 1) require |= 1 << c.pi;
        }
      }
    }

    for (let pass = 0; pass < 2 && m === 0; pass++) {
      const useMask = pass === 0 ? mask : 0; // masked window empty ⇒ drop masks
      const useReq = pass === 0 ? require : 0;
      const useForbid = pass === 0 ? forbid : 0;
      m = 0; tauSum = 0; tauN = 0;
      for (let i = front; i < n && m < ctx.window; i++) {
        if (taken[i]) continue;
        const pi = ctx.posInt[i];
        if (counts[seat * 6 + pi] >= ctx.capsInt[pi]) continue;
        if (useMask !== 0 && !(useMask & (1 << pi))) continue;
        if (useReq !== 0 && !(useReq & (1 << pi))) continue;
        if (useForbid !== 0 && (useForbid & (1 << pi))) continue;
        cand[m++] = i;
        if (tauN < ctx.tauWindow) { tauSum += ctx.sigmaFinal[i]; tauN++; }
      }
    }
    if (m === 0) { // caps exhausted the window (pathological) — take next free
      for (let i = front; i < n; i++) if (!taken[i]) return { m: 0, tauLocal: 0, fallback: i };
      throw new Error('pool exhausted');
    }
    return { m, tauLocal: tauSum / Math.max(1, tauN), fallback: -1 };
  }

  /** Plackett-Luce weights over cand[0..m) into candW; returns ΣW. */
  function computeWeights(seat, round, m, tauLocal, jitterVal) {
    let tau = Math.max(0.5, tauLocal) * ctx.discFactor[seat] * jitterVal * ctx.tauScale;
    // Early-round chalk — guarded so the default (0, 1) leaves the legacy
    // fp path bit-identical (no extra multiply).
    if (ctx.earlyTauThrough > 0 && round <= ctx.earlyTauThrough) tau *= ctx.earlyTauScale;
    if (ctx.reachRounds[seat].has(round)) tau *= ctx.reachTau;
    const boost = ctx.seatBoost[seat];
    const ai = seatArch[seat];
    const mt = ai >= 0 ? ctx.archetypes[ai].mult : null;
    const mu0 = ctx.mu[cand[0]]; // candidates are μ-ascending
    let W = 0;
    for (let j = 0; j < m; j++) {
      let w = Math.exp(-(ctx.mu[cand[j]] - mu0) / tau) * boost[cand[j]];
      if (mt) w *= mt[ctx.posInt[cand[j]] * (ctx.rounds + 1) + round];
      candW[j] = w; W += w;
    }
    return W;
  }

  /** Sample one pick for `seat` in `round`. Returns the player idx. */
  function samplePick(seat, round, rng) {
    const { m, tauLocal, fallback } = collect(seat, round, 0);
    if (fallback >= 0) return fallback;
    const W = computeWeights(seat, round, m, tauLocal, jitter[seat]);
    let u = rng.next() * W;
    for (let j = 0; j < m; j++) {
      u -= candW[j];
      if (u <= 0) return cand[j];
    }
    return cand[m - 1];
  }

  /**
   * Deterministic pick distribution for `seat` in `round` — the same
   * weights samplePick would draw from, reported instead of sampled.
   * Consumes NO rng. opts.jitter overrides the seat's per-draft jitter
   * (pass 1 for calibration); opts.needMask: 'auto' | 'on' | 'off'.
   * @returns {Array<{idx: number, p: number}>} sorted by p desc.
   */
  function pickDistribution(seat, round, opts = {}) {
    const needMode = opts.needMask === 'on' ? 1 : opts.needMask === 'off' ? 2 : 0;
    const { m, tauLocal, fallback } = collect(seat, round, needMode);
    if (fallback >= 0) return [{ idx: fallback, p: 1 }];
    const W = computeWeights(seat, round, m, tauLocal, opts.jitter ?? jitter[seat]);
    const out = [];
    for (let j = 0; j < m; j++) out.push({ idx: cand[j], p: candW[j] / W });
    out.sort((a, b) => b.p - a.p || a.idx - b.idx);
    return out;
  }

  /** The archetype drawn for a seat this draft, or null. */
  function seatArchetypeName(seat) {
    const ai = seatArch[seat];
    return ai >= 0 ? ctx.archetypes[ai].name : null;
  }

  /** Run picks pFrom..pTo inclusive. onPick(p) fires BEFORE the pick is
      sampled; record (if given) receives each idx. pickFor(p, seat) may
      return an idx to force (self-play policy) or null to sample — a
      forced pick consumes no rng. */
  function run(pFrom, pTo, rng, { onPick = null, record = null, pickFor = null } = {}) {
    for (let p = pFrom; p <= pTo; p++) {
      if (onPick) onPick(p);
      const seat = slotForPick(p, N, ctx.snake);
      const round = Math.ceil(p / N);
      let idx = pickFor ? pickFor(p, seat) : null;
      if (idx == null) idx = samplePick(seat, round, rng);
      taken[idx] = 1;
      draftedAt[idx] = Math.min(p, 255);
      counts[seat * 6 + ctx.posInt[idx]]++;
      if (record) record.push(idx);
    }
  }

  return {
    taken, counts, draftedAt,
    reset, drawSeatState, applyPicks, applyPick, applyEntries,
    samplePick, pickDistribution, seatArchetypeName, run,
  };
}
