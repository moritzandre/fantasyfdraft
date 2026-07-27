// lineup.js — optimal legal lineup L(roster) and marginal value MV (plan P1).
// PURE: no DOM, no fetch, no globals, no Date.now().
//
//   L(roster) = Σ eff over the best legal starting lineup
//   MV(i)     = L(roster ∪ {i}) − L(roster)
//
// with the roster padded by virtual players at the DYNAMIC replacement level
// for every starter slot, so MV is "points over what a replacement-level
// body would have started" — this is what keeps MV comparable across
// positions and makes a filled position's MV collapse toward zero (most of
// "positional need" for free, with no NeedMultiplier).
//
// Greedy fill is exactly optimal for this roster because flex eligibility is
// NESTED: every flex-eligible player is eligible for its own dedicated slots
// plus FLEX, and FLEX is a superset. Filling dedicated slots by
// within-position rank first can never hurt — swapping a dedicated starter
// with a flex starter of the same position changes nothing, and no player is
// eligible for another position's dedicated slot.

/** Sort a shallow copy descending by eff. */
function byEffDesc(arr) {
  return arr.slice().sort((a, b) => b.eff - a.eff);
}

/**
 * Best legal lineup by greedy fill.
 *
 * @param {{pos: string, eff: number}[]} players  rostered players. pos 'FLEX'
 *        marks a flex-only virtual (used by the MV padding).
 * @param {Object<string, number>} slots  starter slots, e.g. {QB:1, RB:2,
 *        WR:2, TE:1, FLEX:2, K:1, DST:1}. BN is ignored.
 * @param {string[]} flexEligible  positions allowed in FLEX.
 * @returns {{total: number, starters: {pos: string, eff: number}[]}}
 */
export function bestLineup(players, slots, flexEligible) {
  const byPos = {};
  for (const p of players) (byPos[p.pos] ??= []).push(p);
  for (const pos of Object.keys(byPos)) byPos[pos] = byEffDesc(byPos[pos]);

  const starters = [];
  const leftovers = [];
  for (const [pos, list] of Object.entries(byPos)) {
    if (pos === 'FLEX') { leftovers.push(...list); continue; } // flex-only virtuals
    const cap = slots[pos] ?? 0;
    starters.push(...list.slice(0, cap));
    if (flexEligible.includes(pos)) leftovers.push(...list.slice(cap));
  }

  const flexCount = slots.FLEX ?? 0;
  const flex = byEffDesc(leftovers).slice(0, flexCount);
  starters.push(...flex);

  let total = 0;
  for (const s of starters) total += s.eff;
  return { total, starters };
}

/** Pad a roster with virtual replacement-level players: one per dedicated
    starter slot and per FLEX slot. Reals outrank virtuals wherever they are
    better, so the virtuals just fill whatever the roster leaves open. */
function padWithReplacement(roster, slots, replacement) {
  const out = roster.slice();
  for (const [pos, count] of Object.entries(slots)) {
    if (pos === 'BN') continue;
    const eff = pos === 'FLEX' ? (replacement.FLEX ?? 0) : (replacement[pos] ?? 0);
    for (let k = 0; k < count; k++) out.push({ pos, eff, virtual: true });
  }
  return out;
}

/**
 * MV(i) = L(roster ∪ {i}) − L(roster), both padded at the dynamic
 * replacement level (replacement[pos] = PP_rem(p, r_p) from baselines.js,
 * replacement.FLEX = thetaStar).
 *
 * @returns {number} marginal lineup value in season points.
 */
export function marginalValue(candidate, roster, slots, flexEligible, replacement) {
  const base = bestLineup(padWithReplacement(roster, slots, replacement), slots, flexEligible);
  const withC = bestLineup(
    padWithReplacement([...roster, candidate], slots, replacement),
    slots, flexEligible,
  );
  return withC.total - base.total;
}
