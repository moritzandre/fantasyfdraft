// baselines.js — dynamic, flex-adjusted last-starter baselines (plan P1).
// PURE: no DOM, no fetch, no globals, no Date.now().
//
// Greedy flex water-filling on REMAINING league demand, recomputed every pick:
//
//   n_p ← d_p                     # unfilled dedicated slots league-wide
//   repeat F_rem times:           # unfilled flex slots (starts at 12×2 = 24)
//       p* ← argmax_{p ∈ flexEligible} PP_rem(p, n_p + 1)
//       n_p* ← n_p* + 1
//   r_p ← n_p                     # r_p = index of the LAST STARTER (1-based)
//
// PP_rem(p, n) is the eff of the nth-best REMAINING player at p. Positions
// that never reach the flex (TE in this league, QB always) keep the LOWER
// baseline PP(p, N·S_p) — i.e. r_p stays at d_p. Do not normalize that
// asymmetry away: it is the mechanism that produces the elite-TE edge.
//
// The greedy is exactly optimal here because awarding a flex slot to the
// position with the highest next marginal player maximizes total started
// points — the classic water-filling argument (marginal values are
// non-increasing within each position).

/** PP_rem(p, n): eff points of the nth-best remaining player (1-based) in a
    descending-sorted pool. 0 beyond the pool — an empty slot starts nobody. */
export function ppRem(pool, n) {
  return n >= 1 && n <= pool.length ? pool[n - 1] : 0;
}

/**
 * Water-fill remaining flex demand over the remaining pool.
 *
 * @param {Object<string, number[]>} poolByPos  eff points per position,
 *        sorted DESCENDING (remaining players only).
 * @param {Object<string, number>} demand  d_p — unfilled dedicated starter
 *        slots league-wide per position (QB/RB/WR/TE at minimum).
 * @param {number} flexRemaining  F_rem — unfilled flex slots league-wide.
 * @param {string[]} flexEligible  e.g. ['RB','WR','TE']. Ties broken by this
 *        order (first wins) so the result is deterministic.
 * @returns {{r: Object<string, number>, thetaStar: number,
 *            flexAlloc: Object<string, number>}}
 *        r: last-starter index per position; thetaStar: eff of the LAST flex
 *        slot awarded (the water level; 0 if F_rem = 0); flexAlloc: flex
 *        slots awarded per flex-eligible position (Σ = F_rem always).
 */
export function computeBaselines(poolByPos, demand, flexRemaining, flexEligible) {
  const n = {};
  for (const pos of Object.keys(demand)) n[pos] = demand[pos];

  const flexAlloc = {};
  for (const pos of flexEligible) {
    if (!(pos in n)) n[pos] = 0;
    flexAlloc[pos] = 0;
  }

  let thetaStar = 0;
  for (let f = 0; f < flexRemaining; f++) {
    let best = null;
    let bestVal = -Infinity;
    for (const pos of flexEligible) {
      const v = ppRem(poolByPos[pos] ?? [], n[pos] + 1);
      if (v > bestVal) { bestVal = v; best = pos; } // strict > ⇒ first-listed wins ties
    }
    n[best] += 1;
    flexAlloc[best] += 1;
    thetaStar = bestVal;
  }

  return { r: n, thetaStar, flexAlloc };
}
