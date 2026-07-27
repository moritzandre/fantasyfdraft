// insights.js — league-wide roster/needs reconstruction from the n-aware
// pick log: who has what, who still needs what, which of those teams pick
// inside MY wait window, and which strategy archetype a seat's picks LOOK
// like (inferSeatStrategies). PURE: no DOM, no fetch, no globals, no
// Date.now(). Display-layer math only — nothing here feeds the score
// (urgency stays inside E[BestAvail]/VONA per the structural rule in
// index.js).
//
// Entries are the store's PickEntry shape [{n, idx}] — n-aware, immune to
// log holes (EDIT_PICK deletions, cursor skips, off-board sync picks);
// entries with a null/negative idx are ignored, matching
// selectors.rosterOf semantics.

import { slotForPick, roundForPick, nextMyPick, myPicks } from './picks.js';
import { multiplierFor } from './strategy.js';

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

// ── Seat-strategy inference ("plays like: …") ───────────────────────────────

export const INFER_MIN_PICKS = 3; // < this many observed picks ⇒ no read
export const INFER_LEAN_MARGIN = 0.45; // log-score margin over balanced for a 'lean'
export const INFER_STRONG_MARGIN = 0.9; // …and for a 'strong' read
const CON_SAT_BONUS = 0.15; // per constraint the log has satisfied
const CON_VIOL_PENALTY = 0.8; // per constraint the log has violated

/**
 * Infer which strategy ARCHETYPE each seat's observed picks look like.
 * Display-layer math only — nothing here ever feeds the score.
 *
 * Heuristic (log-likelihood-flavoured, against 'balanced' as the null):
 *   score(arch) = Σ_k log m_arch(pos_k, round_k)   over the seat's picks
 *     + CON_SAT_BONUS  per constraint the log has SATISFIED
 *         (min: `need` reached within its deadline — meeting it early counts;
 *          max: window fully elapsed with no violation)
 *     − CON_VIOL_PENALTY per constraint the log has VIOLATED
 *         (max: `limit` exceeded inside the window — the isCompliant rule;
 *          min: deadline passed with the need unmet)
 *   Pending constraints (deadline/window not yet reached, judged by the round
 *   of the highest n in `entries` — holes still advance that clock) score 0.
 *
 *   'balanced' is the identity (no multipliers, no constraints) and scores
 *   exactly 0 — it is the null hypothesis and is never reported as bestFit.
 *   bestFit = argmax over the other archetypes, reported only when its score
 *   beats balanced by ≥ INFER_LEAN_MARGIN; confidence is 'strong' at
 *   ≥ INFER_STRONG_MARGIN, else 'lean'. Seats with < INFER_MIN_PICKS observed
 *   picks always read {bestFit: null, confidence: null}.
 *
 * @param {Array<{n: number, idx: number|null}>} entries  n-aware pick log.
 * @param {object} league  config/league.json shape.
 * @param {Array<object>} players  board.players.
 * @param {Object<string, object>} archetypes  registry name → strategy
 *        (STRATEGIES built-ins and/or defineStrategy outputs).
 * @returns {Array<{slot: number, counts: Object<string, number>,
 *   bestFit: string|null, confidence: 'strong'|'lean'|null}>} seats 1..N.
 */
export function inferSeatStrategies(entries, league, players, archetypes) {
  const N = league.teams;
  const seatPicks = Array.from({ length: N + 1 }, () => []);
  const counts = Array.from({ length: N + 1 }, () => ({}));
  let maxN = 0;
  const sorted = [...entries].sort((a, b) => a.n - b.n);
  for (const e of sorted) {
    if (e.n > maxN) maxN = e.n; // holes still advance the draft clock
    if (e.idx == null || e.idx < 0 || !players[e.idx]) continue;
    const slot = slotForPick(e.n, N, league.snake);
    const pos = players[e.idx].pos;
    seatPicks[slot].push({ round: roundForPick(e.n, N), pos });
    counts[slot][pos] = (counts[slot][pos] ?? 0) + 1;
  }
  const currentRound = maxN > 0 ? roundForPick(maxN, N) : 0;

  const names = Object.keys(archetypes ?? {}).filter((nm) => nm !== 'balanced');
  const out = [];
  for (let slot = 1; slot <= N; slot++) {
    const picks = seatPicks[slot];
    if (picks.length < INFER_MIN_PICKS || names.length === 0) {
      out.push({ slot, counts: counts[slot], bestFit: null, confidence: null });
      continue;
    }
    let bestName = null;
    let bestScore = -Infinity;
    for (const nm of names) {
      const strat = archetypes[nm];
      let score = 0;
      for (const pk of picks) score += Math.log(multiplierFor(strat, pk.pos, pk.round));
      for (const c of strat.constraints ?? []) {
        if (c.type === 'max') {
          let have = 0;
          let violated = false;
          for (const pk of picks) {
            if (pk.pos !== c.pos || pk.round > c.through) continue;
            have += 1;
            if (have > c.limit) { violated = true; break; }
          }
          if (violated) score -= CON_VIOL_PENALTY;
          else if (currentRound > c.through) score += CON_SAT_BONUS;
        } else { // min
          let have = 0;
          for (const pk of picks) if (pk.pos === c.pos && pk.round <= c.by) have += 1;
          if (have >= c.need) score += CON_SAT_BONUS;
          else if (currentRound > c.by) score -= CON_VIOL_PENALTY;
        }
      }
      if (score > bestScore) { bestScore = score; bestName = nm; }
    }
    const bestFit = bestScore >= INFER_LEAN_MARGIN ? bestName : null; // margin vs balanced ≡ 0
    const confidence = bestFit === null ? null : bestScore >= INFER_STRONG_MARGIN ? 'strong' : 'lean';
    out.push({ slot, counts: counts[slot], bestFit, confidence });
  }
  return out;
}
