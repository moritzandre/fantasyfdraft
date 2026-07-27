// week.js — weekly lineup math for the in-season platform (plan Phase A).
// PURE: no DOM, no fetch, no globals, no Date.now(). League shape (slots,
// flexEligible) is always an argument — nothing here reads config at runtime.
//
// Players are {pos, weekly: number[], ...} — `weekly` is the per-week points
// line (season.json overlay or board weeklyHalfPpr; the bye week is the 0.0
// entry). All lineup math reuses bestLineup (engine/lineup.js), which is
// exactly optimal because flex eligibility is NESTED — see that file's header.

import { bestLineup } from './lineup.js';

/** Points for `week` (1-based) from a weekly line: weekly[week-1] ?? 0.
    Missing weeks / non-numbers count 0 (bye, not-yet-published, off array). */
export function weekEff(weekly, week) {
  const v = Array.isArray(weekly) ? weekly[week - 1] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Best legal lineup for one week: bestLineup over {pos, eff: weekEff(p, week)}.
 * A player on bye (weekly 0) never outranks a positive bench alternative, so
 * byes drop out of the lineup for free.
 *
 * @param {{pos: string, weekly: number[]}[]} players  rostered players
 * @returns {{total: number, starters: object[]}}  starters are references to
 *          the ORIGINAL player objects, best-week order per bestLineup.
 */
export function weeklyLineup(players, week, slots, flexEligible) {
  const wrapped = players.map((p) => ({ pos: p.pos, eff: weekEff(p.weekly, week), ref: p }));
  const { total, starters } = bestLineup(wrapped, slots, flexEligible);
  return { total, starters: starters.map((s) => s.ref) };
}

/** Rest-of-season value: Σ weeklyLineup(players, w).total for w in
    fromWeek..endWeek (inclusive). */
export function rosValue(players, fromWeek, endWeek, slots, flexEligible) {
  let sum = 0;
  for (let w = fromWeek; w <= endWeek; w += 1) {
    sum += weeklyLineup(players, w, slots, flexEligible).total;
  }
  return sum;
}

/** Assign a slot label to each member of a starter SET for `week`: within a
    position, the top slots[pos] by week points hold the dedicated slot, the
    rest spill to FLEX — the same shape bestLineup produces. Internal. */
function assignSlots(players, week, slots) {
  const rows = players.map((p) => ({ ref: p, eff: weekEff(p.weekly, week), slot: 'FLEX' }));
  const byPos = {};
  for (const r of rows) (byPos[r.ref.pos] ??= []).push(r);
  for (const [pos, list] of Object.entries(byPos)) {
    list.sort((a, b) => b.eff - a.eff);
    const cap = slots[pos] ?? 0;
    list.forEach((r, i) => {
      r.slot = i < cap ? pos : 'FLEX';
    });
  }
  return rows;
}

/**
 * Start/sit advice: the optimal weekly lineup vs the CURRENT starters.
 *
 * @param {object[]} rosterPlayers      full roster ({pos, weekly, ...})
 * @param {string[]} currentStarterKeys keys (per keyOf) of current starters;
 *        keys that resolve to no roster player are ignored (Sleeper "0" =
 *        empty slot).
 * @param {(p: object) => string} keyOf stable id for a player
 * @returns {{optimalTotal: number, currentTotal: number, delta: number,
 *            swaps: {out: object|null, in: object, gain: number, slot: string}[]}}
 *   swaps = greedy pairing of (current starters not in the optimal lineup)
 *   with (optimal starters not currently started), same-slot pairs preferred;
 *   `out` is null when the incoming player fills a previously empty slot.
 */
export function startSit(rosterPlayers, currentStarterKeys, week, slots, flexEligible, keyOf) {
  const currentKeys = new Set(currentStarterKeys);
  const current = rosterPlayers.filter((p) => currentKeys.has(keyOf(p)));
  let currentTotal = 0;
  for (const p of current) currentTotal += weekEff(p.weekly, week);

  const optimal = weeklyLineup(rosterPlayers, week, slots, flexEligible);
  const optimalKeys = new Set(optimal.starters.map((p) => keyOf(p)));

  const outs = assignSlots(current, week, slots)
    .filter((r) => !optimalKeys.has(keyOf(r.ref)));
  const ins = assignSlots(optimal.starters, week, slots)
    .filter((r) => !currentKeys.has(keyOf(r.ref)))
    .sort((a, b) => b.eff - a.eff);

  const used = new Set();
  const swaps = [];
  for (const inn of ins) {
    let pick = null;
    for (const out of outs) { // same-slot preferred, lowest-eff same-slot first
      if (used.has(out) || out.slot !== inn.slot) continue;
      if (pick === null || out.eff < pick.eff) pick = out;
    }
    if (pick === null) {
      for (const out of outs) { // else the weakest remaining current starter
        if (used.has(out)) continue;
        if (pick === null || out.eff < pick.eff) pick = out;
      }
    }
    if (pick !== null) used.add(pick);
    swaps.push({
      out: pick ? pick.ref : null,
      in: inn.ref,
      gain: inn.eff - (pick ? pick.eff : 0),
      slot: inn.slot,
    });
  }

  return {
    optimalTotal: optimal.total,
    currentTotal,
    delta: optimal.total - currentTotal,
    swaps,
  };
}

/** Weekly σ from the season-scale σ_proj: σ_week = σ_proj / √17.
    DOCUMENTED APPROXIMATION: treats the 17 games as independent with equal
    variance (σ_season² = 17·σ_week²). Real weeks are positively correlated
    (role/injury regimes), so this UNDERSTATES weekly spread somewhat — good
    enough for floor/ceiling bands, never used in scoring. */
export function sigmaWeek(sigmaProj) {
  return sigmaProj / Math.sqrt(17);
}

/** Floor/ceiling band for one week: weekPts ± z·σ_week, floor clamped ≥ 0.
    Default z = 1.2816 — the two-sided 80% band (p10/p90). */
export function weekBand(weekPts, sigmaProj, z = 1.2816) {
  const s = sigmaWeek(sigmaProj);
  return {
    floor: Math.max(0, weekPts - z * s),
    ceiling: weekPts + z * s,
  };
}
