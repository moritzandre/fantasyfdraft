// trade.js — trade evaluation for the in-season platform (plan Phase C,
// pulled forward with the CORE build). PURE: no DOM, no fetch, no globals,
// no Date.now(). League shape (slots/flexEligible) rides in via ctx.
//
// Both sides are evaluated by the SAME function with the arguments swapped,
// so evaluateTrade(A, B).a ≡ evaluateTrade(B, A).b by construction.
//
// marketDelta uses FantasyCalc values — ADVISORY ONLY, never blended into
// any points math; null whenever any involved player lacks an fc value.

import { bestLineup } from './lineup.js';
import { rosValue, weeklyLineup } from './week.js';

/** Mean of a player's weekly line over the finite entries (0 for empty). */
function weeklyAvg(p) {
  const w = Array.isArray(p.weekly) ? p.weekly : [];
  let sum = 0;
  let n = 0;
  for (const v of w) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Startable bodies per position: players whose weekly average is above 0. */
function startableCounts(roster) {
  const counts = {};
  for (const p of roster) {
    if (weeklyAvg(p) > 0) counts[p.pos] = (counts[p.pos] ?? 0) + 1;
  }
  return counts;
}

/** Bye-collision baseline: the would-be starters if byes did not exist —
    bestLineup over each player's weekly AVERAGE. Counting these starters'
    byes per week measures how many core pieces sit in week w. */
function byeCountsByWeek(roster, slots, flexEligible, fromWeek, endWeek) {
  const wrapped = roster.map((p) => ({ pos: p.pos, eff: weeklyAvg(p), ref: p }));
  const starters = bestLineup(wrapped, slots, flexEligible).starters;
  const counts = new Map();
  for (const s of starters) {
    const bye = s.ref.bye;
    if (Number.isInteger(bye) && bye >= fromWeek && bye <= endWeek) {
      counts.set(bye, (counts.get(bye) ?? 0) + 1);
    }
  }
  return counts;
}

function sumWeeks(roster, weeks, slots, flexEligible) {
  let sum = 0;
  for (const w of weeks) sum += weeklyLineup(roster, w, slots, flexEligible).total;
  return sum;
}

/** One side's result; `side` sends side.sends, receives other.sends. */
function sideResult(side, other, ctx, playoffWeeks) {
  const { fromWeek, endWeek, slots, flexEligible } = ctx;
  const sends = side.sends ?? [];
  const gets = other.sends ?? [];
  const before = side.roster;
  const after = [...before.filter((p) => !sends.includes(p)), ...gets];

  const rosBefore = rosValue(before, fromWeek, endWeek, slots, flexEligible);
  const rosAfter = rosValue(after, fromWeek, endWeek, slots, flexEligible);

  // playoff weeks outside the fromWeek..endWeek window are already played
  // (or past the horizon) — excluded from the delta.
  const pw = playoffWeeks.filter((w) => w >= fromWeek && w <= endWeek);
  const playoffDelta =
    sumWeeks(after, pw, slots, flexEligible) - sumWeeks(before, pw, slots, flexEligible);

  const weekDelta =
    weeklyLineup(after, fromWeek, slots, flexEligible).total -
    weeklyLineup(before, fromWeek, slots, flexEligible).total;

  const cb = startableCounts(before);
  const ca = startableCounts(after);
  const depthDelta = {};
  for (const pos of new Set([...Object.keys(cb), ...Object.keys(ca)])) {
    depthDelta[pos] = (ca[pos] ?? 0) - (cb[pos] ?? 0);
  }

  const bb = byeCountsByWeek(before, slots, flexEligible, fromWeek, endWeek);
  const ba = byeCountsByWeek(after, slots, flexEligible, fromWeek, endWeek);
  const byeExposure = [...ba.keys()]
    .filter((w) => ba.get(w) > (bb.get(w) ?? 0))
    .sort((x, y) => x - y);

  let marketDelta = 0;
  for (const p of [...sends, ...gets]) {
    if (!p.fc || typeof p.fc.value !== 'number') {
      marketDelta = null;
      break;
    }
  }
  if (marketDelta !== null) {
    for (const p of gets) marketDelta += p.fc.value;
    for (const p of sends) marketDelta -= p.fc.value;
  }

  return {
    rosBefore,
    rosAfter,
    rosDelta: rosAfter - rosBefore,
    playoffDelta,
    weekDelta,
    depthDelta,
    byeExposure,
    marketDelta,
  };
}

/**
 * Evaluate a trade between two rosters.
 *
 * @param {{roster: object[], sends: object[]}} sideA
 * @param {{roster: object[], sends: object[]}} sideB
 *        Player: {pos, weekly: number[], fc?: {value}|null, bye?: number}.
 *        sends entries must be the SAME references as in the roster array
 *        (removal is by identity).
 * @param {{fromWeek: number, endWeek: number, playoffWeeks?: number[],
 *          slots: Object<string, number>, flexEligible: string[]}} ctx
 *        playoffWeeks default [15, 16, 17].
 * @returns {{a: object, b: object}} SideResult per side:
 *   rosBefore/rosAfter/rosDelta — Σ weeklyLineup totals fromWeek..endWeek;
 *   playoffDelta — same Σ over playoffWeeks only; weekDelta — fromWeek only;
 *   depthDelta — startable-count change per pos (weekly avg > 0);
 *   byeExposure — weeks where # baseline starters lost to byes INCREASES;
 *   marketDelta — Σ fc.value received − sent, null when any fc is missing.
 */
export function evaluateTrade(sideA, sideB, ctx) {
  const playoffWeeks = ctx.playoffWeeks ?? [15, 16, 17];
  return {
    a: sideResult(sideA, sideB, ctx, playoffWeeks),
    b: sideResult(sideB, sideA, ctx, playoffWeeks),
  };
}
