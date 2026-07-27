// survival.js — availability model (plan P3).
// PURE: no DOM, no fetch, no globals, no Date.now().
//
//   logistic        S_i(P) = 1/(1 + exp((P − μ_i)/s_i)),   s_i = 0.5513·σ_i
//                   (0.5513 = √3/π: matches the logistic sd to the normal σ)
//   Bayes           S_i(P' | alive at P0) = S_i(P') / S_i(P0)
//                   — the single line that says "a guy already 20 picks past
//                   his ADP will keep falling".
//   competing risk  Plackett-Luce w_i = exp(−μ'_i/τ), τ = local σ̂;
//                   s_i = Π_{g=0..G−1} (1 − w_i/W_g) with W_g the
//                   SURVIVAL-WEIGHTED total Σ_j s_j(g)·w_j, so each of the G
//                   opponent picks removes exactly one expected player:
//                   Σ_i (1 − s_i) = G. Uncalibrated independent survival
//                   systematically OVERSTATES the chance a whole tier holds.
//   tier survival   Poisson-binomial exact DP over member survivals:
//                   P(K≥1) "will it hold", P(K≥2) "can I get two", E[K].

export const LOGISTIC_S = 0.5513; // √3/π

/** Unconditional survival: P(player still on the board at pick P). */
export function survivalAt(P, mu, sigma) {
  const s = LOGISTIC_S * Math.max(sigma, 1e-9);
  return 1 / (1 + Math.exp((P - mu) / s));
}

/** Bayes-conditioned survival to pick Pnext given alive at pick Pnow:
    S(Pnext)/S(Pnow), clamped into [0, 1]. */
export function conditionedSurvival(Pnext, Pnow, mu, sigma) {
  const s0 = survivalAt(Pnow, mu, sigma);
  if (s0 <= 0) return 0;
  return Math.min(1, survivalAt(Pnext, mu, sigma) / s0);
}

/**
 * Plackett-Luce competing-risk survival over G opponent picks.
 * Self-calibrating: Σ_i (1 − s_i) = G exactly (up to the clamp when a single
 * weight exceeds the remaining total).
 *
 * @param {number[]} mus  (run-shifted) ADP means μ' of the remaining pool.
 * @param {number} tau  softmax temperature — the local σ̂ of the window.
 * @param {number} G  opponent picks between now and the target pick.
 * @returns {number[]} survival probability per pool player.
 */
export function plackettLuceSurvival(mus, tau, G) {
  const t = Math.max(tau, 1e-9);
  const muMin = Math.min(...mus); // shift for overflow safety; w-ratios unchanged
  const w = mus.map((mu) => Math.exp(-(mu - muMin) / t));
  const s = mus.map(() => 1);
  for (let g = 0; g < G; g++) {
    let W = 0;
    for (let i = 0; i < w.length; i++) W += s[i] * w[i];
    if (W <= 0) break;
    for (let i = 0; i < w.length; i++) s[i] = Math.max(0, s[i] * (1 - w[i] / W));
  }
  return s;
}

/** Exact Poisson-binomial PMF by DP: pmf[k] = P(exactly k of the independent
    events happen). O(n²), n is a tier — tiny. */
export function poissonBinomialPMF(ps) {
  let pmf = [1];
  for (const p of ps) {
    const next = new Array(pmf.length + 1).fill(0);
    for (let k = 0; k < pmf.length; k++) {
      next[k] += pmf[k] * (1 - p);
      next[k + 1] += pmf[k] * p;
    }
    pmf = next;
  }
  return pmf;
}

/** Tier survival stats from member survival probabilities. */
export function tierSurvivalStats(survivals) {
  const pmf = poissonBinomialPMF(survivals);
  const p0 = pmf[0] ?? 1;
  const p1 = pmf[1] ?? 0;
  let expected = 0;
  for (const s of survivals) expected += s;
  return {
    pAtLeastOne: Math.max(0, 1 - p0),
    pAtLeastTwo: Math.max(0, 1 - p0 - p1),
    expected,
  };
}

/**
 * E[best available] at a future pick over an ordered candidate list:
 *
 *   E = Σ_k V(j_k)·s_k·Π_{l<k}(1−s_l)  +  Π_all(1−s)·V_floor
 *
 * — you get the best survivor; if nobody survives you get the floor
 * (replacement level, MV ≈ 0).
 *
 * @param {{value: number, survival: number}[]} candidates  sorted by value
 *        desc (re-sorted defensively — the formula requires it).
 * @param {number} [floorValue=0]
 */
export function orderedBestAvailExpectation(candidates, floorValue = 0) {
  const sorted = candidates.slice().sort((a, b) => b.value - a.value);
  let ev = 0;
  let noneAbove = 1; // Π_{l<k} (1 − s_l)
  for (const c of sorted) {
    ev += c.value * c.survival * noneAbove;
    noneAbove *= 1 - c.survival;
  }
  return ev + noneAbove * floorValue;
}
