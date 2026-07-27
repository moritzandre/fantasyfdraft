#!/usr/bin/env node
// simulate.mjs — real tiers + Monte Carlo + branch trees → public/data/mc.json
// (plan "Modules": Monte Carlo, Branch trees; slot-general per the AMENDMENT).
//
// RUN ORDER (the `npm run board` script chains exactly this):
//   1. python tools/build_board.py     — fetch + normalize + emit board.json
//                                        (provisional quantile tiers)
//   2. python tools/verify_board.py    — the 7-assertion hard gate, exit 0
//   3. node tools/simulate.mjs         — THIS FILE:
//        a. overwrite the provisional tiers with real Ckmeans tiers
//           (engine/tiers.js tierize, weights 1/σ_proj², TierSep merge) and
//           rewrite board.json in place;
//        b. 20,000 seeded complete 12-team 16-round drafts with the
//           opponents.json seat model → availability / best-avail
//           percentiles / tier survival at EVERY overall pick 1..192;
//        c. branch trees per slot 1..12 (k-medoids modal boards, live
//           engine recommend() unchanged, one conditional level deeper).
//   verify_board.py may be re-run afterwards — its checks are tier-agnostic
//   and must still exit 0 on the re-tiered board.
//
// CLI:  node tools/simulate.mjs [--seed 20260827] [--sims 20000]
//                               [--condSims 1500] [--quiet]
//
// Determinism: every random draw comes from engine/mc.js xorshift128+.
// Same seed ⇒ byte-identical mc.json modulo the two provenance fields
// (generatedAt, meta.wallTimeMs) — verified by diffing two runs.
//
// Opponent model (plan "Leaguemate tendency profiles"), per seat from
// public/data/opponents.json — ALL 12 seats are simulated (slot-general;
// there is no "me" in the offline pass):
//   • Picks are sampled Plackett-Luce: w_i = exp(−(μ_i − μ_min)/τ) over the
//     top-40 remaining by ADP — the SAME weight formula the live survival
//     model uses (engine/mc.js plWeights ≡ survival.js plackettLuceSurvival).
//   • τ = τ_local (mean adp.sigmaFinal of the top-24 window, exactly the
//     live engine's τ̂) × exp(2·(0.5 − adpDiscipline)) — discipline 0 (wild
//     reacher) ⇒ ×e ≈ 2.7 hotter, discipline 1 (strict ADP) ⇒ ×0.37 —
//     × a per-draft lognormal jitter exp(0.20·z) × 1.5 in reachRounds.
//   • positionBias multiplies w for that position; homerTeams boost ×1.2.
//   • ~30% of seats per draft are need-aware: while they still have unfilled
//     QB/RB/WR/TE starter slots (dedicated or flex), they mask every other
//     position; once skill starters are full the mask lifts (bench mode).
//     K/DST are never part of the mask — they resolve via ADP + the rule
//     below.
//   • Realism rails: nobody drafts a 2nd K/DST or a 4th QB/TE (caps
//     QB 3 / TE 3 / K 1 / DST 1); in the last two rounds a seat still
//     missing K or DST picks among the missing K/DST (mirrors the engine's
//     myPicks(league).slice(-2) hard-scheduling).
//
// Output size: byPick.pAvail is sparse (p > 0.02 only, 3 decimals). If the
// serialized file exceeds 2 MB, pAvail is pruned to the top-200 players per
// pick and meta.notes says so.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tierize } from '../engine/tiers.js';
import { recommend } from '../engine/index.js';
import { pickNumber, slotForPick } from '../engine/picks.js';
import {
  xorshift128plus, normal, signatureOf, signatureKey, parseSignature,
  signatureDistance, kMedoids,
} from '../engine/mc.js';
import { validateBoard } from '../shared/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD_PATH = path.join(ROOT, 'public', 'data', 'board.json');
const OPP_PATH = path.join(ROOT, 'public', 'data', 'opponents.json');
const LEAGUE_PATH = path.join(ROOT, 'config', 'league.json');
const MC_PATH = path.join(ROOT, 'public', 'data', 'mc.json');

const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
const POS_IDX = Object.fromEntries(POS.map((p, i) => [p, i]));
const CAPS = { QB: 3, RB: 9, WR: 9, TE: 3, K: 1, DST: 1 }; // realism rails
const WINDOW = 40;        // Plackett-Luce candidate window (top-N by ADP)
const TAU_WINDOW = 24;    // τ_local window — matches the live engine
const HOMER_BOOST = 1.2;
const REACH_TAU = 1.5;
const JITTER_SD = 0.20;
const NEED_AWARE_SHARE = 0.30;
const MAX_CLUSTER_ITEMS = 400; // unique-signature cap fed to k-medoids
const SIZE_BUDGET = 2 * 1024 * 1024;

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
const letterOf = (t) => String.fromCharCode(64 + Math.min(t, 8)); // cap at H

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argNum(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
}
const SEED = argNum('seed', 20260827);
const SIMS = argNum('sims', 20000);
const COND_SIMS = argNum('condSims', 1500);
const QUIET = args.includes('--quiet');
const log = (...xs) => { if (!QUIET) console.log(...xs); };

// ══ Phase A — real tiers ═══════════════════════════════════════════════════

/**
 * Overwrite the provisional quantile tiers with real Ckmeans tiers:
 * engine/tiers.js tierize() on (eff, σ_proj) per position, weights 1/σ_proj².
 *
 * SEP THRESHOLD CALIBRATION (measured on the real 2026-07-27 board, see the
 * report in the workstream log): σ_proj is season-OUTCOME RMSE (floor 55,
 * plan "50–80 pt RMSE band"), so TierSep = cliff/√(σ_a²+σ_b²) tops out at
 * 0.23 anywhere on the board — the plan's nominal 1.0 merge threshold would
 * collapse every position to ONE tier, destroying tierHoldProb, the branch
 * signatures and sheets S6–S9. The statistically relevant scale for "is
 * this break signal?" is the projection-ESTIMATE s.e. (≈ 0.2·σ_outcome);
 * we keep the mandated 1/σ_proj² weights (scale-invariant for the DP) and
 * set sepThreshold = 0.01 in outcome units (= 0.05 at estimate scale),
 * which merges only boundaries with essentially zero cliff and yields
 * draft-band tiers: RB 9 / WR 8 / TE 6 / QB 6 / K 4 / DST 4.
 * board.tiers[].tierSep stays in raw outcome units — nearly all < 1.0,
 * which sheets S6–S9 will render as "weak break" per the plan. Honest.
 *
 * Mutates players[].tier/tierLetter/posRank/overallRank and board.tiers.
 */
const SEP_THRESHOLD = 0.01;

function retier(board) {
  const notes = [];
  const oldTiers = board.tiers ?? [];
  const provisionalCount = oldTiers.filter((t) => t.provisional).length;
  if (provisionalCount === 0 && oldTiers.length > 0) {
    notes.push('tiers were already non-provisional (idempotent re-run) — overwriting anyway');
  } else if (provisionalCount !== oldTiers.length) {
    throw new Error(`retier: mixed provisional flags (${provisionalCount}/${oldTiers.length})`);
  }

  notes.push(`TierSep merge threshold ${SEP_THRESHOLD} in outcome-σ units `
    + '(σ_proj is season RMSE ≥55, max observed sep 0.23 — the nominal 1.0 '
    + 'would collapse every position to one tier); tierSep values are stored '
    + 'raw, so sheets S6-S9 will label nearly all breaks weak (<1.0)');

  const tiersOut = [];
  const tierCounts = {};
  for (const pos of POS) {
    const list = board.players
      .filter((p) => p.pos === pos)
      .sort((a, b) => b.eff - a.eff || a.idx - b.idx);
    if (list.length === 0) continue;
    const { assignments, segments, tierSeps } = tierize(
      list.map((p) => ({ mu: p.eff, sigma: p.sigmaProj ?? 1 })), // weights 1/σ² inside
      { sepThreshold: SEP_THRESHOLD }, // see calibration note above
    );
    list.forEach((p, i) => {
      p.tier = assignments[i];
      p.tierLetter = letterOf(assignments[i]);
      p.posRank = i + 1; // eff order ≡ halfPpr order within a position
    });
    segments.forEach((seg, t) => {
      const members = list.slice(seg.start, seg.end + 1).map((p) => p.idx);
      const next = segments[t + 1];
      // cliff = last of this tier − first of the next (the tiers.js boundary)
      const cliff = next ? r2(list[seg.end].eff - list[next.start].eff) : 0.0;
      const span = seg.end - seg.start;
      const meanGap = span > 0 ? r2((list[seg.start].eff - list[seg.end].eff) / span) : 0.0;
      tiersOut.push({
        pos, tier: t + 1, letter: letterOf(t + 1), members,
        cliffPoints: cliff, meanGap,
        tierSep: t < tierSeps.length ? r2(tierSeps[t]) : 0.0,
      });
    });
    tierCounts[pos] = segments.length;
    if (segments.length > 6) {
      notes.push(`${pos}: ${segments.length} tiers — print.css only styles `
        + 'tier channels a-f; letters capped at H (report only, css untouched)');
    }
  }

  // overallRank: same VBD-prior convention as build_board.py —
  // vbdPrior = halfPpr − halfPpr(replacement at the plan's fixed indices).
  const REPL_INDEX = { RB: 30, WR: 39, TE: 12, QB: 12, K: 12, DST: 12 };
  const replHalf = {};
  for (const pos of POS) {
    const ranked = board.players
      .filter((p) => p.pos === pos)
      .sort((a, b) => b.proj.halfPpr - a.proj.halfPpr);
    if (ranked.length) {
      replHalf[pos] = ranked[Math.min(REPL_INDEX[pos], ranked.length) - 1].proj.halfPpr;
    }
  }
  board.players
    .slice()
    .sort((a, b) =>
      (b.proj.halfPpr - replHalf[b.pos]) - (a.proj.halfPpr - replHalf[a.pos]) || a.idx - b.idx)
    .forEach((p, i) => { p.overallRank = i + 1; });

  board.tiers = tiersOut;

  // Assert: every provisional tier got replaced; no provisional flag remains.
  if (board.tiers.some((t) => 'provisional' in t)) {
    throw new Error('retier: provisional flag survived the rebuild');
  }
  for (const p of board.players) {
    if (p.tier == null || p.tierLetter == null) {
      throw new Error(`retier: player ${p.idx} ${p.name} left untiered`);
    }
  }
  return { notes, tierCounts };
}

// ══ Phase B/C machinery — the draft simulator ══════════════════════════════

/** Precompute everything the hot loop touches into flat typed arrays. */
function makeCtx(board, league, opponents) {
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
  // idx IS ADP order (build_board sorts by μ asc) — asserted, the window
  // scan depends on it.
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

  // Per-seat model from opponents.json (seat 1..12; [0] unused).
  const N = league.teams;
  const discFactor = new Float64Array(N + 1).fill(1);
  const reachRounds = Array.from({ length: N + 1 }, () => new Set());
  const seatBoost = Array.from({ length: N + 1 }, () => new Float64Array(n).fill(1));
  for (const seat of opponents.seats ?? []) {
    const s = seat.seat;
    if (!(s >= 1 && s <= N)) continue;
    const d = Math.min(1, Math.max(0, seat.adpDiscipline ?? 0.5));
    discFactor[s] = Math.exp(2 * (0.5 - d)); // wild ⇒ hot τ, strict ⇒ cold τ
    for (const r of seat.reachRounds ?? []) reachRounds[s].add(r);
    const bias = seat.positionBias ?? {};
    const homers = new Set(seat.homerTeams ?? []);
    for (const p of players) {
      let b = bias[p.pos] ?? 1;
      if (homers.has(p.team)) b *= HOMER_BOOST;
      if (b !== 1) seatBoost[s][p.idx] = b;
    }
  }

  const S = league.roster;
  const flexElig = new Set(league.flexEligible);
  const capsInt = POS.map((p) => CAPS[p]);
  const rosterCapInt = POS.map((p) => S[p] ?? 0);
  const skillMaskable = POS.map((p) => ['QB', 'RB', 'WR', 'TE'].includes(p));
  const flexEligInt = POS.map((p) => flexElig.has(p));

  return {
    players, n, mu, sigmaFinal, eff, posInt, posOrderEff, posOrderMu,
    discFactor, reachRounds, seatBoost,
    N, rounds: league.rounds, totalPicks: N * league.rounds,
    S, capsInt, rosterCapInt, skillMaskable, flexEligInt,
    flexSlots: S.FLEX ?? 0,
    kIdx: POS_IDX.K, dstIdx: POS_IDX.DST,
  };
}

/** Mutable draft state + the sampling core. One instance, reset per sim. */
function makeSim(ctx) {
  const { n, N } = ctx;
  const taken = new Uint8Array(n);
  const counts = new Int32Array((N + 1) * 6);
  const draftedAt = new Uint8Array(n);
  const jitter = new Float64Array(N + 1);
  const needAware = new Uint8Array(N + 1);
  const cand = new Int32Array(WINDOW + 8);
  const candW = new Float64Array(WINDOW + 8);
  let front = 0;

  function reset() {
    taken.fill(0); counts.fill(0); draftedAt.fill(0); front = 0;
  }

  /** Draw the per-draft seat randomness (τ jitter + need-aware flags). */
  function drawSeatState(rng) {
    for (let s = 1; s <= N; s++) jitter[s] = Math.exp(JITTER_SD * normal(rng));
    for (let s = 1; s <= N; s++) needAware[s] = rng.next() < NEED_AWARE_SHARE ? 1 : 0;
  }

  /** Force-apply a fixed pick prefix (picks 1..prefix.length). */
  function applyPicks(prefix) {
    for (let k = 0; k < prefix.length; k++) {
      const idx = prefix[k];
      taken[idx] = 1;
      draftedAt[idx] = k + 1;
      counts[slotForPick(k + 1, N, true) * 6 + ctx.posInt[idx]]++;
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

  /** Sample one pick for `seat` in `round`. Returns the player idx. */
  function samplePick(seat, round, rng) {
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
        return softmax(seat, round, m, tauSum / tauN, rng);
      }
    }

    const mask = needAware[seat] ? skillNeedMask(seat) : 0;
    for (let pass = 0; pass < 2 && m === 0; pass++) {
      const useMask = pass === 0 ? mask : 0; // masked window empty ⇒ drop mask
      m = 0; tauSum = 0; tauN = 0;
      for (let i = front; i < n && m < WINDOW; i++) {
        if (taken[i]) continue;
        const pi = ctx.posInt[i];
        if (counts[seat * 6 + pi] >= ctx.capsInt[pi]) continue;
        if (useMask !== 0 && !(useMask & (1 << pi))) continue;
        cand[m++] = i;
        if (tauN < TAU_WINDOW) { tauSum += ctx.sigmaFinal[i]; tauN++; }
      }
    }
    if (m === 0) { // caps exhausted the window (pathological) — take next free
      for (let i = front; i < n; i++) if (!taken[i]) return i;
      throw new Error('pool exhausted');
    }
    return softmax(seat, round, m, tauSum / Math.max(1, tauN), rng);
  }

  /** Plackett-Luce draw over cand[0..m): w = exp(−Δμ/τ)·bias. */
  function softmax(seat, round, m, tauLocal, rng) {
    let tau = Math.max(0.5, tauLocal) * ctx.discFactor[seat] * jitter[seat];
    if (ctx.reachRounds[seat].has(round)) tau *= REACH_TAU;
    const boost = ctx.seatBoost[seat];
    const mu0 = ctx.mu[cand[0]]; // candidates are μ-ascending
    let W = 0;
    for (let j = 0; j < m; j++) {
      const w = Math.exp(-(ctx.mu[cand[j]] - mu0) / tau) * boost[cand[j]];
      candW[j] = w; W += w;
    }
    let u = rng.next() * W;
    for (let j = 0; j < m; j++) {
      u -= candW[j];
      if (u <= 0) return cand[j];
    }
    return cand[m - 1];
  }

  /** Run picks pFrom..pTo inclusive. onPick(p) fires BEFORE the pick is
      sampled; record (if given) receives each sampled idx. */
  function run(pFrom, pTo, rng, { onPick = null, record = null } = {}) {
    for (let p = pFrom; p <= pTo; p++) {
      if (onPick) onPick(p);
      const seat = slotForPick(p, N, true);
      const round = Math.ceil(p / N);
      const idx = samplePick(seat, round, rng);
      taken[idx] = 1;
      draftedAt[idx] = Math.min(p, 255);
      counts[seat * 6 + ctx.posInt[idx]]++;
      if (record) record.push(idx);
    }
  }

  return { taken, counts, draftedAt, reset, drawSeatState, applyPicks, run };
}

// ══ Main ═══════════════════════════════════════════════════════════════════

const t0 = Date.now();
const board = JSON.parse(readFileSync(BOARD_PATH, 'utf8'));
const league = JSON.parse(readFileSync(LEAGUE_PATH, 'utf8'));
const opponents = JSON.parse(readFileSync(OPP_PATH, 'utf8'));

// ── Phase A: tiers ─────────────────────────────────────────────────────────
const { notes, tierCounts } = retier(board);
const schemaErrs = validateBoard(board);
if (schemaErrs.length) {
  console.error('validateBoard FAILED after retier:', schemaErrs);
  process.exit(1);
}
writeFileSync(BOARD_PATH, JSON.stringify(board), 'utf8');
const tTiers = Date.now();
log(`[tiers] real Ckmeans tiers written (${board.tiers.length} tiers): `
  + POS.map((p) => `${p} ${tierCounts[p] ?? 0}`).join(', '));
for (const note of notes) log(`[tiers] NOTE: ${note}`);

// ── Phase B: main Monte Carlo ──────────────────────────────────────────────
const ctx = makeCtx(board, league, opponents);
const { n, N, totalPicks, players } = ctx;
const sim = makeSim(ctx);
const rng = xorshift128plus(SEED);

const BINS = 400;
const bestHist = new Int32Array(totalPicks * 6 * BINS);
const availHist = new Int32Array(n * 194);       // [idx][draftedAt 1..192, 193=undrafted]
const nTiers = board.tiers.length;
const tierIdOf = new Int16Array(n);
board.tiers.forEach((t, ti) => { for (const idx of t.members) tierIdOf[idx] = ti; });
const at1Diff = new Int32Array(nTiers * 194);
const at2Diff = new Int32Array(nTiers * 194);
const firstPicks = new Uint16Array(SIMS * (N - 1)); // picks 1..11 per sim

const posPtr = new Int32Array(6);
const onPick = (p) => {
  const base = (p - 1) * 6 * BINS;
  for (let pi = 0; pi < 6; pi++) {
    const order = ctx.posOrderEff[pi];
    let ptr = posPtr[pi];
    while (ptr < order.length && sim.taken[order[ptr]]) ptr++;
    posPtr[pi] = ptr;
    const e = ptr < order.length ? ctx.eff[order[ptr]] : 0;
    bestHist[base + pi * BINS + Math.min(BINS - 1, Math.max(0, Math.round(e)))]++;
  }
};

for (let s = 0; s < SIMS; s++) {
  sim.reset();
  posPtr.fill(0);
  sim.drawSeatState(rng);
  const rec = [];
  sim.run(1, totalPicks, rng, { onPick, record: rec });
  for (let k = 0; k < N - 1; k++) firstPicks[s * (N - 1) + k] = rec[k];
  // availability histogram
  for (let i = 0; i < n; i++) availHist[i * 194 + (sim.draftedAt[i] || 193)]++;
  // tier ≥1 / ≥2 survivors via range diff arrays
  for (let ti = 0; ti < nTiers; ti++) {
    const members = board.tiers[ti].members;
    let m1 = 0, m2 = 0; // two largest draftedAt (193 = undrafted)
    for (const idx of members) {
      const d = sim.draftedAt[idx] || 193;
      if (d > m1) { m2 = m1; m1 = d; } else if (d > m2) m2 = d;
    }
    at1Diff[ti * 194 + 1]++;
    at1Diff[ti * 194 + Math.min(m1, totalPicks) + 1]--;
    if (members.length >= 2) {
      at2Diff[ti * 194 + 1]++;
      at2Diff[ti * 194 + Math.min(m2, totalPicks) + 1]--;
    }
  }
}
const tMain = Date.now();
log(`[mc] ${SIMS} drafts × ${totalPicks} picks in ${((tMain - tTiers) / 1000).toFixed(1)}s`);

// availCnt[idx][p-1] = #sims the player is still available when pick p is up
const availCnt = new Int32Array(n * totalPicks);
for (let i = 0; i < n; i++) {
  let takenSoFar = 0;
  for (let p = 1; p <= totalPicks; p++) {
    availCnt[i * totalPicks + (p - 1)] = SIMS - takenSoFar;
    takenSoFar += availHist[i * 194 + p];
  }
}
// tier cumulative counts
const at1Cnt = new Int32Array(nTiers * (totalPicks + 1));
const at2Cnt = new Int32Array(nTiers * (totalPicks + 1));
for (let ti = 0; ti < nTiers; ti++) {
  let a1 = 0, a2 = 0;
  for (let p = 1; p <= totalPicks; p++) {
    a1 += at1Diff[ti * 194 + p];
    a2 += at2Diff[ti * 194 + p];
    at1Cnt[ti * (totalPicks + 1) + p] = a1;
    at2Cnt[ti * (totalPicks + 1) + p] = a2;
  }
}

function quantileFromHist(base, q) {
  const target = q * SIMS;
  let cum = 0;
  for (let b = 0; b < BINS; b++) {
    cum += bestHist[base + b];
    if (cum >= target) return b;
  }
  return BINS - 1;
}

const byPick = {};
for (let p = 1; p <= totalPicks; p++) {
  const pAvail = {};
  for (let i = 0; i < n; i++) {
    const prob = availCnt[i * totalPicks + (p - 1)] / SIMS;
    if (prob > 0.02) pAvail[i] = r3(prob);
  }
  const bestAvailByPos = {};
  for (let pi = 0; pi < 6; pi++) {
    const base = (p - 1) * 6 * BINS + pi * BINS;
    bestAvailByPos[POS[pi]] = {
      p10: quantileFromHist(base, 0.10),
      p25: quantileFromHist(base, 0.25),
      p50: quantileFromHist(base, 0.50),
      p75: quantileFromHist(base, 0.75),
      p90: quantileFromHist(base, 0.90),
    };
  }
  const tierSurvival = [];
  for (let ti = 0; ti < nTiers; ti++) {
    const t = board.tiers[ti];
    const p1 = at1Cnt[ti * (totalPicks + 1) + p] / SIMS;
    if (p1 < 0.005) continue; // tier already gone — pruned for size
    const p2v = at2Cnt[ti * (totalPicks + 1) + p] / SIMS;
    let expected = 0;
    for (const idx of t.members) expected += availCnt[idx * totalPicks + (p - 1)];
    tierSurvival.push({
      pos: t.pos, tier: t.tier,
      pAtLeast1: r3(p1), pAtLeast2: r3(p2v), expected: r2(expected / SIMS),
    });
  }
  byPick[p] = { pAvail, bestAvailByPos, tierSurvival };
}

// ── Phase C: branch trees per slot ─────────────────────────────────────────

/** Cluster {key, weight, repSim/repPicks} entries: k-medoids on the top
    MAX_CLUSTER_ITEMS unique signatures, then reassign ALL entries to the
    nearest medoid for true masses + coverage. */
function clusterSignatures(entries, k, radius) {
  const total = entries.reduce((a, e) => a + e.weight, 0) || 1;
  const sorted = entries.slice().sort((a, b) => b.weight - a.weight);
  const head = sorted.slice(0, MAX_CLUSTER_ITEMS);
  const items = head.map((e) => ({ sig: parseSignature(e.key), weight: e.weight }));
  const clusters = kMedoids(items, k);
  const medoidSigs = clusters.map((c) => items[c.medoid].sig);
  const masses = new Float64Array(clusters.length);
  let covered = 0;
  for (const e of entries) {
    const sig = parseSignature(e.key);
    let bm = 0, bd = Infinity;
    for (let m = 0; m < medoidSigs.length; m++) {
      const d = signatureDistance(sig, medoidSigs[m]);
      if (d < bd) { bd = d; bm = m; }
    }
    masses[bm] += e.weight;
    if (bd <= radius) covered += e.weight;
  }
  const out = clusters.map((c, m) => ({
    entry: head[c.medoid], sig: medoidSigs[m], mass: masses[m] / total,
  }));
  out.sort((a, b) => b.mass - a.mass);
  return { clusters: out, coverage: covered / total };
}

function narrate(sig, pickNo, recName) {
  const keys = Object.keys(sig);
  if (keys.length === 0) return `Clean board at pick ${pickNo} — ${recName}.`;
  const byPos = {};
  const tierA = {};
  for (const k of keys) {
    const m = /^([A-Z]+)(\d+)$/.exec(k);
    const pos = m[1], tier = Number(m[2]);
    byPos[pos] = (byPos[pos] ?? 0) + sig[k];
    if (tier === 1) tierA[pos] = (tierA[pos] ?? 0) + sig[k];
  }
  const parts = POS.filter((p) => byPos[p]).map((p) =>
    `${byPos[p]} ${p}${tierA[p] ? ` (${tierA[p]}×A)` : ''}`);
  return `By pick ${pickNo}: ${parts.join(', ')} gone — ${recName}.`;
}

/** Live engine, unchanged, on a concrete simulated prefix. */
function recommendFor(slot, picks) {
  const res = recommend(board, { ...league, slot }, { picks: [...picks], strategy: 'balanced' });
  return res.recommendations.slice(0, 3);
}

const branchesBySlot = {};
const branchCoverage = {};
let condBudgetNote = null;
const tBranchStart = Date.now();
const BRANCH_BUDGET_MS = 5 * 60 * 1000 - (tBranchStart - t0); // leave the 5-min plan budget intact
let condSimsEffective = COND_SIMS;

for (let slot = 1; slot <= N; slot++) {
  const picksGone = slot - 1;
  const myPick = slot; // round-1 pick of this seat IS the slot number
  // unique signatures of the pre-first-pick board over all main sims
  const map = new Map();
  for (let s = 0; s < SIMS; s++) {
    const gone = [];
    for (let k = 0; k < picksGone; k++) {
      const idx = firstPicks[s * (N - 1) + k];
      gone.push({ pos: players[idx].pos, tier: players[idx].tier });
    }
    const key = signatureKey(signatureOf(gone));
    const e = map.get(key);
    if (e) e.weight++;
    else map.set(key, { key, weight: 1, repSim: s });
  }
  const radius = Math.max(3, Math.ceil(0.4 * picksGone));
  const { clusters, coverage } = clusterSignatures([...map.values()], 10, radius);
  branchCoverage[slot] = r3(coverage);

  // adaptive conditional budget (reduce cond sims, never byPick — plan 3)
  const elapsed = Date.now() - t0;
  if (elapsed > BRANCH_BUDGET_MS * 0.6 && condSimsEffective > 400) {
    condSimsEffective = Math.max(400, Math.floor(condSimsEffective / 2));
    condBudgetNote = `conditional sims reduced to ${condSimsEffective}/branch to stay inside the ~5 min budget (byPick untouched at ${SIMS})`;
  }

  const P2 = pickNumber(2, slot, N, true);
  const branches = [];
  for (const [ci, c] of clusters.entries()) {
    const prefix = [];
    for (let k = 0; k < picksGone; k++) prefix.push(firstPicks[c.entry.repSim * (N - 1) + k]);
    const top3 = recommendFor(slot, prefix);
    const recName = players[top3[0].idx].short;

    // children: condition on taking rec #1 at my first pick, then simulate
    // to my second pick and cluster the resulting boards.
    const basePicks = prefix.concat([top3[0].idx]);
    const childMap = new Map();
    const crng = xorshift128plus((SEED ^ 0x5f3759df) + slot * 1009 + ci * 13);
    for (let cc = 0; cc < condSimsEffective; cc++) {
      sim.reset();
      sim.applyPicks(basePicks);
      sim.drawSeatState(crng);
      const rec = [];
      sim.run(slot + 1, P2 - 1, crng, { record: rec });
      const gone = basePicks.concat(rec);
      const key = signatureKey(signatureOf(
        gone.map((idx) => ({ pos: players[idx].pos, tier: players[idx].tier }))));
      const e = childMap.get(key);
      if (e) e.weight++;
      else childMap.set(key, { key, weight: 1, repPicks: gone });
    }
    const childRadius = Math.max(3, Math.ceil(0.4 * (P2 - 1)));
    const childRes = clusterSignatures([...childMap.values()], 5, childRadius);
    const children = childRes.clusters.map((cc2) => {
      const cTop3 = recommendFor(slot, cc2.entry.repPicks);
      const cName = players[cTop3[0].idx].short;
      return {
        signature: cc2.sig,
        probability: r4(cc2.mass),
        recommend: cTop3, // engine output, UNCHANGED
        recNames: cTop3.map((r) => players[r.idx].short),
        narrative: narrate(cc2.sig, P2, cName),
      };
    });

    branches.push({
      signature: c.sig,
      probability: r4(c.mass),
      recommend: top3, // engine output, UNCHANGED
      recNames: top3.map((r) => players[r.idx].short),
      narrative: narrate(c.sig, myPick, recName),
      children,
    });
  }
  branchesBySlot[slot] = branches;
  log(`[branches] slot ${slot}: ${branches.length} modal boards, `
    + `coverage(r<=${radius}) ${(coverage * 100).toFixed(1)}%, `
    + `${condSimsEffective} cond sims/branch`);
}
const tBranches = Date.now();

// ── Emit mc.json ───────────────────────────────────────────────────────────
if (condBudgetNote) notes.push(condBudgetNote);
const mc = {
  schema: 1,
  buildHash: board.buildHash,
  seed: SEED,
  sims: SIMS,
  condSims: condSimsEffective,
  generatedAt: new Date().toISOString(),
  byPick,
  branchesBySlot,
  meta: {
    tierCounts,
    branchCoverage,
    notes,
    wallTimeMs: {
      tiers: tTiers - t0,
      mainSim: tMain - tTiers,
      branches: tBranches - tBranchStart,
      total: Date.now() - t0,
    },
  },
};

let json = JSON.stringify(mc);
if (json.length > SIZE_BUDGET) {
  // prune pAvail to the top-200 players per pick (plan fallback) and say so
  for (let p = 1; p <= totalPicks; p++) {
    const entries = Object.entries(byPick[p].pAvail);
    if (entries.length > 200) {
      entries.sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
      byPick[p].pAvail = Object.fromEntries(entries.slice(0, 200));
    }
  }
  mc.meta.notes = [...notes,
    'pAvail pruned to top-200 players per pick (file exceeded the 2 MB budget)'];
  json = JSON.stringify(mc);
}
writeFileSync(MC_PATH, json, 'utf8');

// ── Report ─────────────────────────────────────────────────────────────────
const sizeMB = (json.length / 1024 / 1024).toFixed(2);
log(`\n[done] mc.json ${sizeMB} MB, total ${((Date.now() - t0) / 1000).toFixed(1)}s `
  + `(tiers ${((tTiers - t0) / 1000).toFixed(1)}s, main ${((tMain - tTiers) / 1000).toFixed(1)}s, `
  + `branches ${((tBranches - tBranchStart) / 1000).toFixed(1)}s)`);

// Spot checks
const gibbs = players.find((p) => p.name === 'Jahmyr Gibbs');
if (gibbs) {
  const pAt8 = availCnt[gibbs.idx * totalPicks + 7] / SIMS;
  log(`[spot] P(${gibbs.name} available at pick 8) = ${pAt8.toFixed(4)}`);
}
const s8 = branchesBySlot[8]?.[0];
if (s8) {
  log(`[spot] slot 8 modal board (p=${s8.probability}): ${s8.narrative}`);
  log(`[spot] slot 8 top-3: ${s8.recNames.join(' / ')}`);
}
