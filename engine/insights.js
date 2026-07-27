// insights.js — league-wide roster/needs reconstruction from the n-aware
// pick log: who has what, who still needs what, and which of those teams
// pick inside MY wait window. PURE: no DOM, no fetch, no globals, no
// Date.now(). Display-layer math only — nothing here feeds the score
// (urgency stays inside E[BestAvail]/VONA per the structural rule in
// index.js).
//
// Entries are the store's PickEntry shape [{n, idx}] — n-aware, immune to
// log holes (EDIT_PICK deletions, cursor skips, off-board sync picks);
// entries with a null/negative idx are ignored, matching
// selectors.rosterOf semantics.

import { slotForPick, roundForPick, nextMyPick, myPicks } from './picks.js';

const OPTIMIZED = ['QB', 'RB', 'WR', 'TE'];

/** Position counts per slot from an n-aware entry log. */
function countsBySlot(entries, league, players) {
  const N = league.teams;
  const counts = Array.from({ length: N + 1 }, () => ({}));
  const picksMade = new Array(N + 1).fill(0);
  for (const e of entries) {
    if (e.idx == null || e.idx < 0 || !players[e.idx]) continue;
    const slot = slotForPick(e.n, N, league.snake);
    const pos = players[e.idx].pos;
    counts[slot][pos] = (counts[slot][pos] ?? 0) + 1;
    picksMade[slot]++;
  }
  return { counts, picksMade };
}

/** Per-position dedicated starter needs + open flex for one team's counts. */
function needsOf(counts, S, flexEligible) {
  const dedicated = {};
  let dedTotal = 0;
  let surplus = 0;
  for (const [pos, cap] of Object.entries(S)) {
    if (pos === 'FLEX' || pos === 'BN') continue;
    const have = counts[pos] ?? 0;
    const need = Math.max(0, cap - have);
    if (need > 0) dedicated[pos] = need;
    dedTotal += need;
    if (flexEligible.includes(pos)) surplus += Math.max(0, have - cap);
  }
  const flex = Math.max(0, (S.FLEX ?? 0) - Math.min(S.FLEX ?? 0, surplus));
  return { dedicated, flex, total: dedTotal + flex };
}

/**
 * Per-team roster needs + league-wide remaining starter demand.
 *
 * @param {Array<{n: number, idx: number|null}>} entries
 * @param {object} league  config/league.json shape.
 * @param {Array<object>} players  board.players.
 * @param {number} [cursor]  next overall pick; defaults to highest n + 1.
 * @returns {{
 *   teams: Array<{slot: number, counts: Object<string, number>,
 *     unfilled: {dedicated: Object<string, number>, flex: number, total: number},
 *     picksMade: number, nextPickAt: number|null}>,
 *   demand: Object<string, number>, flexRemaining: number }}
 */
export function leagueNeeds(entries, league, players, cursor) {
  const N = league.teams;
  const S = league.roster;
  const totalPicks = N * league.rounds;
  const from = cursor ?? entries.reduce((a, e) => Math.max(a, e.n), 0) + 1;
  const { counts, picksMade } = countsBySlot(entries, league, players);

  const teams = [];
  const demand = {};
  for (const pos of OPTIMIZED) demand[pos] = 0;
  let flexRemaining = 0;
  for (let slot = 1; slot <= N; slot++) {
    const unfilled = needsOf(counts[slot], S, league.flexEligible);
    for (const pos of OPTIMIZED) demand[pos] += unfilled.dedicated[pos] ?? 0;
    flexRemaining += unfilled.flex;
    let nextPickAt = null;
    for (let p = Math.max(1, from); p <= totalPicks; p++) {
      if (slotForPick(p, N, league.snake) === slot) { nextPickAt = p; break; }
    }
    teams.push({ slot, counts: counts[slot], unfilled, picksMade: picksMade[slot], nextPickAt });
  }
  return { teams, demand, flexRemaining };
}

/**
 * The wait-window threat report: which seats pick between the cursor and my
 * next pick, and what they still need — the demand pressure specifically
 * inside my wait window ("8 picks until yours, 5 of them still need RB").
 *
 * A team "needs" a position when a dedicated starter slot for it is open;
 * flex-open teams are reported separately via flexOpenInWindow (a flex can
 * absorb anything, a weaker signal than a dedicated hole).
 *
 * @param {Array<{n: number, idx: number|null}>} entries
 * @param {object} league
 * @param {number} cursor  the next overall pick (store pickCursor).
 * @param {Array<object>} players  board.players.
 * @returns {{
 *   myNextPick: number|null,
 *   window: Array<{pick: number, slot: number, round: number}>,
 *   posPressure: Object<string, {teamsNeeding: number[], picksInWindow: number}>,
 *   flexOpenInWindow: number[] }}
 */
export function waitWindowThreats(entries, league, cursor, players) {
  const N = league.teams;
  const totalPicks = N * league.rounds;
  const mine = myPicks(league);
  if (cursor > totalPicks) {
    return { myNextPick: null, window: [], posPressure: {}, flexOpenInWindow: [] };
  }
  const onClock = mine.includes(cursor);
  const myNext = nextMyPick(cursor + (onClock ? 1 : 0), league);
  const windowEnd = myNext ?? totalPicks + 1;

  const window = [];
  for (let p = onClock ? cursor + 1 : cursor; p < windowEnd && p <= totalPicks; p++) {
    window.push({ pick: p, slot: slotForPick(p, N, league.snake), round: roundForPick(p, N) });
  }

  const { teams } = leagueNeeds(entries, league, players, cursor);
  const bySlot = new Map(teams.map((t) => [t.slot, t]));
  const windowSlots = [...new Set(window.map((w) => w.slot))];

  const posPressure = {};
  for (const pos of OPTIMIZED) {
    const teamsNeeding = windowSlots.filter(
      (slot) => (bySlot.get(slot)?.unfilled.dedicated[pos] ?? 0) > 0,
    );
    const needSet = new Set(teamsNeeding);
    posPressure[pos] = {
      teamsNeeding,
      picksInWindow: window.filter((w) => needSet.has(w.slot)).length,
    };
  }
  const flexOpenInWindow = windowSlots.filter((slot) => (bySlot.get(slot)?.unfilled.flex ?? 0) > 0);

  return { myNextPick: myNext, window, posPressure, flexOpenInWindow };
}
