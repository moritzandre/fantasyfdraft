// picks.js — snake-draft pick enumeration and the slot-8 gap asymmetry.
// PURE: no DOM, no fetch, no globals, no Date.now(). Runs identically under
// `node --test` (offline pipeline) and Safari (live).
//
// General formulas for slot s in an N-team snake draft:
//   round r odd:  P(r) = (r-1)·N + s
//   round r even: P(r) = (r-1)·N + (N - s + 1)
//   gap after an odd-round pick:  g_short = 2·(N - s) + 1
//   gap after an even-round pick: g_long  = 2·s - 1
//   g_short + g_long = 2N always.
//
// For 12-team slot 8: picks 8,17,32,41,… gaps alternate 9,15,9,15,…
// THE operational rule of this seat: odd-round picks are followed by the SHORT
// gap (be BPA — you're back soon); even-round picks by the LONG gap (weight
// cost-of-waiting up — this is where tier cliffs actually cost you).

/** Pick number for `slot` in `round` (1-based) of an N-team snake draft. */
export function pickNumber(round, slot, teams, snake = true) {
  if (!snake || round % 2 === 1) return (round - 1) * teams + slot;
  return (round - 1) * teams + (teams - slot + 1);
}

/** All pick numbers for `slot` across `rounds`. */
export function myPicks({ teams, slot, rounds, snake = true }) {
  const out = [];
  for (let r = 1; r <= rounds; r++) out.push(pickNumber(r, slot, teams, snake));
  return out;
}

/** Gap after each pick, in the printed convention: the pick-number difference
    (12-team slot 8 → 9,15,9,15,…). Opponent picks intervening = gap - 1.
    Last pick has no "next", so gaps has length picks.length - 1. */
export function gapsAfter(picks) {
  const gaps = [];
  for (let i = 0; i < picks.length - 1; i++) gaps.push(picks[i + 1] - picks[i]);
  return gaps;
}

/** κ_r — cost-of-waiting weight for the pick in `round`, for ANY slot.
    General rule: the long-side wait is a gap that EXCEEDS N (the two gaps
    always sum to 2N, so at most one can). κ = kappaLongGap before a long-side
    wait, 1.0 otherwise. Reproduces slot 8's 9/15 ⇒ 1.0/1.3 exactly; gives
    turn slots (1/N) the right 1/2N−1 treatment; mid slots with near-equal
    gaps (e.g. slot 6 of 12: 13/11) get only the mild correct asymmetry.
    Getting the direction inverted makes the tool most cautious exactly when
    it should be most aggressive — see the unit test. */
export function kappaForRound(round, { slot, teams, rounds = 16, snake = true, kappaLongGap = 1.3 }) {
  if (!snake) return 1.0; // linear drafts: every gap is N — no asymmetry
  if (round >= rounds) return 1.0; // no next pick, CoW is moot
  const here = pickNumber(round, slot, teams, snake);
  const next = pickNumber(round + 1, slot, teams, snake);
  return next - here > teams ? kappaLongGap : 1.0;
}

/** Which team (1-based slot) owns overall pick `n`. */
export function slotForPick(n, teams, snake = true) {
  const round = Math.ceil(n / teams);
  const inRound = n - (round - 1) * teams;
  if (!snake || round % 2 === 1) return inRound;
  return teams - inRound + 1;
}

/** Round of overall pick `n`. */
export function roundForPick(n, teams) {
  return Math.ceil(n / teams);
}

/** Given the current overall pick, the next pick belonging to `slot` (or null
    if the draft is over). */
export function nextMyPick(currentPick, { teams, slot, rounds, snake = true }) {
  for (const p of myPicks({ teams, slot, rounds, snake })) {
    if (p >= currentPick) return p;
  }
  return null;
}
