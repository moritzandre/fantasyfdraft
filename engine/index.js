// index.js — recommend(board, league, state, opts): the decision engine
// (plan P4). PURE: no DOM, no fetch, no globals, no Date.now() — timing is
// caller-injected via opts.now.
//
// Pipeline, every call: replay picks → remaining pool → dynamic baselines →
// MV for candidates → run detection → survival (with μ' shifts) →
// E[BestAvail] per role at my next pick → CoW → Score.
//
//   CoW(i)   = (1 − s_i) · VONA(i) = (1 − s_i)·(MV(i) − E[BestAvail(role(i), P')])
//   Score(i) = MV(i) + κ_r·CoW(i) + Scarcity(i) − Bye(i) − Stack(i) − Risk(i)
//
// STRUCTURAL RULE: there is deliberately NO CliffBonus and NO NeedMultiplier.
// A correct VONA already contains tier-cliff urgency (the cliff IS the drop
// in E[BestAvail]) and replacement-padded MV already contains positional
// need. Adding either term double-counts and produces a tool that panics —
// a regression test asserts the score delta from an evaporating tier equals
// κ_r·ΔCoW exactly.
//
//   Scarcity — feasibility only. Slack = myRemainingPicks −
//     myUnfilledStarterSlots; Slack ≤ 1 hard-restricts candidates to unfilled
//     starter positions. Soft term η·max(0, u_p − A_p)·(PP_rem(p, r_p) −
//     PP_rem(p, r_p + N)), η = 0.5, where u_p = my unfilled dedicated slots
//     at p and A_p = (remaining above-baseline players at p)/N — my fair
//     share of what's left.
//   Bye      — tiebreak, capped 2% of MV, fires only on the 3rd+ STARTER
//     sharing a bye (two on the same bye is free).
//   Stack    — same-team RB/RB or WR2-behind-WR1, λ = 0.10 of MV. QB-stack
//     bonus defaults to 0 (variance effect, not mean) — opts.stackBonus.
//   Risk     — CE = eff − (ρ/2)σ²; ρ = 0 in R1–4, −0.003 (risk-SEEKING) from
//     R5 — bench players are call options.
//
// Hard rules bypassing the optimizer:
//   1. K/DST never surface before round 15; from R15 they are hard-scheduled
//      (picks 176/185 at slot 8) whenever still unfilled.
//   2. No RB with projected receptions < 45 in rounds 1–3.
//
// Survival used for CoW: Bayes-conditioned logistic S(P')/S(P0) on the
// run-shifted μ' — per-player independent so the cliff regression is exact.
// The Plackett-Luce competing-risk model calibrates π_p (run detection) and
// is exported from survival.js for the Monte Carlo.
//
// Strategy: multiplicative prior m_p(r) scales the WHOLE score (all terms
// scaled together so terms still sum to score); hard constraints filter the
// shortlist; a conflict > overrideDelta surfaces the off-strategy best with
// strategyCompliant:false instead of silently obeying.
//
// Hysteresis: margins under ε = 4 report isTie — rendered as a tie, never a
// ranking.

import { myPicks, roundForPick, kappaForRound, nextMyPick, slotForPick } from './picks.js';
import { computeBaselines, ppRem } from './baselines.js';
import { bestLineup, marginalValue } from './lineup.js';
import { tierize } from './tiers.js';
import { conditionedSurvival, tierSurvivalStats, orderedBestAvailExpectation } from './survival.js';
import { positionShares, detectRuns, shiftedMu } from './runs.js';
import { resolveStrategy, multiplierFor, isCompliant } from './strategy.js';

const OPTIMIZED = ['QB', 'RB', 'WR', 'TE'];
const HARD_SCHEDULED = ['K', 'DST'];
const P90 = 1.2816; // Φ⁻¹(0.90) — displayed ceiling = eff + 1.2816σ

/** Position counts of a roster list. */
function countByPos(roster) {
  const c = {};
  for (const p of roster) c[p.pos] = (c[p.pos] ?? 0) + 1;
  return c;
}

/** Unfilled starter slots (dedicated + flex) for one team's counts. */
function unfilledStarters(counts, slots, flexEligible) {
  let dedicated = 0;
  let surplus = 0;
  for (const [pos, cap] of Object.entries(slots)) {
    if (pos === 'FLEX' || pos === 'BN') continue;
    const have = counts[pos] ?? 0;
    dedicated += Math.max(0, cap - have);
    if (flexEligible.includes(pos)) surplus += Math.max(0, have - cap);
  }
  const flexUnfilled = Math.max(0, (slots.FLEX ?? 0) - Math.min(slots.FLEX ?? 0, surplus));
  return { dedicated, flex: flexUnfilled, total: dedicated + flexUnfilled };
}

/** One plain-English sentence per recommendation. */
function headline(rec, p, Pnext, compliant) {
  const pct = Math.round(rec.tierHoldProb * 100);
  const loss = Math.max(0, rec.evLossIfWait);
  if (HARD_SCHEDULED.includes(p.pos)) {
    return `Hard-scheduled ${p.pos} slot — never spend an earlier pick here.`;
  }
  if (!compliant) {
    return `Off-strategy but ${rec.strategyConflictPoints.toFixed(0)} pts better than the compliant best — your call.`;
  }
  if (rec.tierHoldProb < 0.5) {
    return `${p.pos} tier likely gone by pick ${Pnext} (${pct}% holds) — waiting costs ≈${loss.toFixed(1)} pts.`;
  }
  if (loss > 4) {
    return `Best ${p.pos} on the board — waiting to pick ${Pnext} costs ≈${loss.toFixed(1)} pts.`;
  }
  return `${p.pos} tier holds to pick ${Pnext} (${pct}%) — safe to wait if something better calls.`;
}

/**
 * The engine contract (plan "Engine contract"). ~20k flops, <5 ms at n=400.
 *
 * @param {object} board  board.json shape (see shared/schema.js). tiers on
 *        players are used if present, else computed once per call.
 * @param {object} league  config/league.json shape.
 * @param {{picks?: number[], entries?: Array<{n: number, idx: number|null}>,
 *          cursor?: number, strategy?: string}} state  Either the dense form
 *        (picks[k] = board idx taken at overall pick k+1) or the n-aware
 *        form: entries carry explicit overall pick numbers (the store's
 *        PickEntry shape) and stay correct under log holes (EDIT_PICK
 *        deletions, cursor skips, off-board sync picks); entries with a
 *        null/negative idx are ignored. cursor overrides the current
 *        overall pick (pass the store's pickCursor with entries).
 * @param {{candidateLimit?: number, stackBonus?: number, epsilon?: number,
 *          strategies?: Object<string, object>|null, includeIdxs?: number[],
 *          now?: () => number}} [opts]  now: injected clock for computeMs.
 *        strategies: registry of defineStrategy() outputs (custom strategies
 *        from strategies.json) consulted after the built-ins.
 *        includeIdxs: pool players to force-score through the identical
 *        pipeline even when the candidate filters exclude them — returned
 *        in scoredExtras, the shortlist is untouched.
 */
export function recommend(board, league, state, opts = {}) {
  const t0 = opts.now ? opts.now() : null;
  const {
    candidateLimit = 30,
    stackBonus = 0,
    epsilon = league.epsilonPoints ?? 4,
  } = opts;

  const N = league.teams;
  const S = league.roster;
  const flexEligible = league.flexEligible;
  const players = board.players;

  // ── Replay the pick log ──────────────────────────────────────────────────
  // Dense picks (position ⇒ pick number) or n-aware entries; with no holes
  // the two are exactly equivalent (regression-tested).
  const entries = state.entries ?? state.picks.map((idx, k) => ({ n: k + 1, idx }));
  const taken = new Set();
  for (const e of entries) if (e.idx != null && e.idx >= 0) taken.add(e.idx);
  let currentPick;
  if (state.cursor != null) currentPick = state.cursor;
  else if (state.entries) currentPick = entries.reduce((a, e) => Math.max(a, e.n), 0) + 1;
  else currentPick = state.picks.length + 1;
  const round = roundForPick(currentPick, N);
  const rosters = Array.from({ length: N + 1 }, () => []);
  for (const e of entries) {
    if (e.idx == null || e.idx < 0) continue;
    rosters[slotForPick(e.n, N, league.snake)].push(players[e.idx]);
  }
  const myRoster = rosters[league.slot];
  const myCounts = countByPos(myRoster);

  const mine = myPicks(league);
  const onClock = mine.includes(currentPick);
  const totalPicks = N * league.rounds;
  const Pnext = nextMyPick(currentPick + (onClock ? 1 : 0), league) ?? totalPicks + 1;
  const kappa = kappaForRound(round, league);

  // ── Remaining pool ───────────────────────────────────────────────────────
  const pool = [];
  for (const p of players) if (!taken.has(p.idx)) pool.push(p);
  const poolByPos = {};
  for (const p of pool) (poolByPos[p.pos] ??= []).push(p);
  for (const pos of Object.keys(poolByPos)) {
    poolByPos[pos].sort((a, b) => b.eff - a.eff);
  }
  const effByPos = {};
  for (const pos of Object.keys(poolByPos)) effByPos[pos] = poolByPos[pos].map((p) => p.eff);

  // ── Remaining league demand → dynamic baselines ─────────────────────────
  const demand = {};
  let flexRemaining = 0;
  for (const pos of OPTIMIZED) demand[pos] = 0;
  for (let slot = 1; slot <= N; slot++) {
    const counts = countByPos(rosters[slot]);
    for (const pos of OPTIMIZED) demand[pos] += Math.max(0, (S[pos] ?? 0) - (counts[pos] ?? 0));
    flexRemaining += unfilledStarters(counts, S, flexEligible).flex;
  }
  const { r, thetaStar, flexAlloc } = computeBaselines(effByPos, demand, flexRemaining, flexEligible);

  // Replacement levels for MV padding: PP_rem(p, r_p); FLEX at thetaStar.
  const replacement = { FLEX: thetaStar };
  for (const pos of OPTIMIZED) replacement[pos] = ppRem(effByPos[pos] ?? [], r[pos]);
  for (const pos of HARD_SCHEDULED) {
    replacement[pos] = ppRem(effByPos[pos] ?? [], Math.max(1, demandForPos(rosters, N, S, pos)));
  }

  // ── Tiers (frozen labels from the board when present) ────────────────────
  const tierOf = new Map();
  {
    const missing = players.some((p) => p.tier == null);
    if (!missing) {
      for (const p of players) tierOf.set(p.idx, p.tier);
    } else {
      const byPosAll = {};
      for (const p of players) (byPosAll[p.pos] ??= []).push(p);
      for (const list of Object.values(byPosAll)) {
        list.sort((a, b) => b.eff - a.eff);
        const { assignments } = tierize(
          list.map((p) => ({ mu: p.eff, sigma: p.sigmaProj ?? 1 })),
        );
        list.forEach((p, i) => tierOf.set(p.idx, assignments[i]));
      }
    }
  }

  // ── Run detection (feeds ONLY survival) ─────────────────────────────────
  const window = pool
    .slice()
    .sort((a, b) => a.adp.mu - b.adp.mu)
    .slice(0, 24);
  const tau = window.length
    ? window.reduce((a, p) => a + p.adp.sigmaFinal, 0) / window.length
    : 1;
  const shares = positionShares(pool.map((p) => ({ pos: p.pos, mu: p.adp.mu })), tau);
  const recent = entries
    .filter((e) => e.idx != null && e.idx >= 0)
    .sort((a, b) => a.n - b.n)
    .slice(-12)
    .map((e) => players[e.idx].pos);
  const { flags: runFlags, z: runZ } = detectRuns(recent, shares);

  // μ' per pool player: shifted only where a run is flagged, damped by
  // min(1, remainingDemand_p/(N·S_p)) — demand incl. the flex allocation.
  const muPrime = (p) => {
    if (!runFlags[p.pos]) return p.adp.mu;
    const remDemand = (demand[p.pos] ?? 0) + (flexAlloc[p.pos] ?? 0);
    const damp = remDemand / (N * (S[p.pos] ?? 1));
    return shiftedMu(p.adp.mu, p.adp.sigmaFinal, runZ[p.pos] ?? 0, damp);
  };
  const survivalOf = (p) => conditionedSurvival(Pnext, currentPick, muPrime(p), p.adp.sigmaFinal);

  // ── Slack + candidate set ───────────────────────────────────────────────
  const myRemainingPicks = mine.filter((p) => p >= currentPick).length;
  const myUnfilled = unfilledStarters(myCounts, S, flexEligible);
  const slack = myRemainingPicks - myUnfilled.total;

  const needPos = new Set();
  for (const pos of Object.keys(S)) {
    if (pos === 'FLEX' || pos === 'BN') continue;
    if ((myCounts[pos] ?? 0) < S[pos]) needPos.add(pos);
  }
  if (myUnfilled.flex > 0) for (const pos of flexEligible) needPos.add(pos);

  const kdstDue =
    round >= league.rounds - 1 &&
    HARD_SCHEDULED.some((pos) => (myCounts[pos] ?? 0) < (S[pos] ?? 0));

  let candidates;
  if (kdstDue) {
    // Hard-scheduled: from R15 an unfilled K/DST slot preempts the optimizer.
    candidates = [];
    for (const pos of HARD_SCHEDULED) {
      if ((myCounts[pos] ?? 0) < (S[pos] ?? 0)) candidates.push(...(poolByPos[pos] ?? []).slice(0, 3));
    }
  } else {
    candidates = pool
      .filter((p) => OPTIMIZED.includes(p.pos))
      .filter((p) => !(round <= 3 && p.pos === 'RB' && (p.proj?.rec ?? 0) < 45)) // hard rule 2
      .filter((p) => slack > 1 || needPos.has(p.pos)) // hard scarcity rule
      .sort((a, b) => b.eff - a.eff)
      .slice(0, candidateLimit);
  }

  // ── MV cache: candidates + top alternatives per position ────────────────
  const mvCache = new Map();
  const mv = (p) => {
    let v = mvCache.get(p.idx);
    if (v === undefined) {
      v = marginalValue(p, myRoster, S, flexEligible, replacement);
      mvCache.set(p.idx, v);
    }
    return v;
  };
  const ALT_DEPTH = 12; // alternatives beyond this can't matter within one wait
  const altsByPos = {};
  for (const pos of Object.keys(poolByPos)) {
    altsByPos[pos] = poolByPos[pos].slice(0, ALT_DEPTH).map((p) => ({
      idx: p.idx, value: mv(p), survival: survivalOf(p),
    }));
  }

  // ── Score every candidate ───────────────────────────────────────────────
  const strategy = resolveStrategy(state.strategy ?? league.strategy ?? 'balanced', opts.strategies ?? null);
  const overrideDelta = league.overrideDelta ?? strategy.overrideDelta;
  // My picks after the current one in rounds ≤ byRound (one pick per round).
  const futurePicksThrough = (byRound) => Math.max(0, Math.min(byRound, league.rounds) - round);
  const rho = round <= 4 ? 0 : -0.003;
  const myStarters = bestLineup(myRoster, S, flexEligible).starters;

  const scoreOne = (p) => {
    const value = mv(p);
    const s = survivalOf(p);

    // E[BestAvail] at my next pick, over the alternatives at p's role
    // EXCLUDING p himself (= what I hold if I pass on p and p is gone).
    const alts = (altsByPos[p.pos] ?? []).filter((a) => a.idx !== p.idx);
    const eBest = orderedBestAvailExpectation(alts, 0);
    const vona = value - eBest;
    const cow = (1 - s) * vona;

    // Scarcity (soft feasibility term, candidate's position only).
    const u = Math.max(0, (S[p.pos] ?? 0) - (myCounts[p.pos] ?? 0));
    const posPool = effByPos[p.pos] ?? [];
    const aboveBaseline = Math.min(r[p.pos] ?? 0, posPool.length);
    const scarcity =
      0.5 * Math.max(0, u - aboveBaseline / N) *
      (ppRem(posPool, r[p.pos] ?? 0) - ppRem(posPool, (r[p.pos] ?? 0) + N));

    // Bye: fires only when this would be the 3rd+ starter on that bye.
    const sameBye = p.bye == null ? 0 : myStarters.filter((q) => q.bye === p.bye).length;
    const bye = sameBye >= 2 ? 0.02 * Math.max(0, value) : 0;

    // Stack: same-team RB/RB touch cannibalization, or WR2 behind a rostered
    // same-team WR1. Optional QB-stack bonus (default 0) nets against it.
    let stack = 0;
    if (p.pos === 'RB' && myRoster.some((q) => q.pos === 'RB' && q.team === p.team)) {
      stack = 0.10 * Math.max(0, value);
    } else if (p.pos === 'WR' && myRoster.some((q) => q.pos === 'WR' && q.team === p.team && q.eff >= p.eff)) {
      stack = 0.10 * Math.max(0, value);
    }
    if (stackBonus > 0) {
      const qbStack =
        (['WR', 'TE'].includes(p.pos) && myRoster.some((q) => q.pos === 'QB' && q.team === p.team)) ||
        (p.pos === 'QB' && myRoster.some((q) => ['WR', 'TE'].includes(q.pos) && q.team === p.team));
      if (qbStack) stack -= stackBonus * Math.max(0, value);
    }

    // Risk: CE = eff − (ρ/2)σ² ⇒ Risk term = (ρ/2)σ² (negative ⇒ seeking).
    const sigma = p.sigmaProj ?? 0;
    const risk = (rho / 2) * sigma * sigma;

    const raw = value + kappa * cow + scarcity - bye - stack - risk;
    const m = multiplierFor(strategy, p.pos, round);
    // The prior scales the whole score; every term is scaled with it so that
    // terms always sum exactly to score (the decomposition bar never lies).
    const terms = {
      mv: m * value,
      cow: m * kappa * cow,
      scarcity: m * scarcity,
      bye: m * bye,
      stack: m * stack,
      risk: m * risk,
    };
    const score = m * raw;

    // Tier survival over remaining same-tier teammates at the position.
    const tier = tierOf.get(p.idx);
    const tierMates = (poolByPos[p.pos] ?? []).filter((q) => tierOf.get(q.idx) === tier);
    const tierStats = tierSurvivalStats(tierMates.map(survivalOf));

    const compliant = kdstDue ? true : isCompliant(strategy, myCounts, round, p.pos, futurePicksThrough);

    return {
      p, score, terms, compliant,
      survivalToNextPick: s,
      tierHoldProb: tierStats.pAtLeastOne,
      tierHoldTwoProb: tierStats.pAtLeastTwo,
      evLossIfWait: vona,
      ceiling: p.eff + P90 * sigma,
    };
  };
  const scored = candidates.map(scoreOne);

  // ── Rank, override, ties ────────────────────────────────────────────────
  scored.sort((a, b) => b.score - a.score);
  const compliantList = scored.filter((c) => c.compliant);
  const bestAny = scored[0];
  const bestCompliant = compliantList[0];
  const conflict =
    bestAny && bestCompliant && !bestAny.compliant
      ? bestAny.score - bestCompliant.score
      : 0;

  let shortlist = compliantList.slice(0, 5);
  if (conflict > overrideDelta) {
    // Surface the conflict — never silently obey.
    shortlist = [bestAny, ...compliantList.slice(0, 4)].sort((a, b) => b.score - a.score);
  }

  const top = shortlist[0]?.score ?? 0;
  const second = shortlist[1]?.score ?? -Infinity;
  const recommendations = shortlist.map((c, i) => {
    const rec = {
      idx: c.p.idx,
      rank: i + 1,
      score: c.score,
      terms: c.terms,
      survivalToNextPick: c.survivalToNextPick,
      tierHoldProb: c.tierHoldProb,
      tierHoldTwoProb: c.tierHoldTwoProb,
      evLossIfWait: c.evLossIfWait,
      ceiling: c.ceiling,
      strategyCompliant: c.compliant,
      strategyConflictPoints: c.compliant ? 0 : conflict,
      isTie: i === 0 ? top - second < epsilon : top - c.score < epsilon,
    };
    rec.headline = headline(rec, c.p, Pnext, c.compliant);
    return rec;
  });

  // ── Force-scored extras (opts.includeIdxs) ──────────────────────────────
  // Review/grading tooling needs "what would my actual pick have scored"
  // even when the candidate filters (hard rules, slack restriction,
  // candidateLimit) excluded that player. Scored through the exact same
  // pipeline; the shortlist above is untouched.
  const scoredExtras = [];
  for (const idx of opts.includeIdxs ?? []) {
    const p = players[idx];
    if (!p || taken.has(idx)) continue;
    const c = scoreOne(p);
    scoredExtras.push({
      idx,
      score: c.score,
      terms: c.terms,
      survivalToNextPick: c.survivalToNextPick,
      tierHoldProb: c.tierHoldProb,
      tierHoldTwoProb: c.tierHoldTwoProb,
      evLossIfWait: c.evLossIfWait,
      ceiling: c.ceiling,
      strategyCompliant: c.compliant,
      strategyConflictPoints: c.compliant ? 0 : conflict,
      forced: true,
    });
  }

  // ── Diagnostics + contract extras ───────────────────────────────────────
  const replacementIndices = {};
  for (const pos of OPTIMIZED) {
    replacementIndices[pos] = (poolByPos[pos] ?? [])[Math.max(0, (r[pos] ?? 1) - 1)]?.idx ?? null;
  }
  const tierCounts = {};
  for (const [pos, list] of Object.entries(poolByPos)) {
    tierCounts[pos] = {};
    for (const q of list) {
      const t = tierOf.get(q.idx);
      tierCounts[pos][t] = (tierCounts[pos][t] ?? 0) + 1;
    }
  }

  return {
    recommendations,
    scoredExtras,
    replacementIndices,
    thetaStar,
    tierCounts,
    runFlags,
    slack,
    diagnostics: {
      currentPick,
      round,
      onClock,
      myNextPick: Pnext,
      kappa,
      tau,
      baselines: r,
      flexAlloc,
      candidateCount: candidates.length,
      strategy: strategy.name,
      strategyConflictPoints: conflict,
      computeMs: t0 !== null ? opts.now() - t0 : null,
    },
  };
}

/** League-wide unfilled dedicated demand for one position (K/DST helper). */
function demandForPos(rosters, N, S, pos) {
  let d = 0;
  for (let slot = 1; slot <= N; slot++) {
    const have = rosters[slot].filter((p) => p.pos === pos).length;
    d += Math.max(0, (S[pos] ?? 0) - have);
  }
  return d;
}
