// runs.js — positional run detection (plan P3, "Run detection").
// PURE: no DOM, no fetch, no globals, no Date.now().
//
//   exact binomial tail   P(Bin(K, π_p) ≥ c_p) < 0.05  AND  c_p ≥ 3
//   windows               K = 6 and K = 12 recent picks
//   π_p                   Plackett-Luce expected share of the next pick over
//                         the remaining pool: Σ_{i∈p} w_i / W, w_i = exp(−μ_i/τ)
//   ADP shift             μ' = μ − min(κ·max(0,z), 1.5)·σ · damp,  κ = 0.4,
//                         damp = min(1, remainingDemand_p/(N·S_p))
//   z                     (c − K·π)/√(K·π(1−π)) — normal approx, reporting only;
//                         the FLAG uses the exact tail.
//
// A run feeds ONLY survival — it never touches value. A player does not get
// better because opponents are panicking; he just gets less available. And a
// WR run simultaneously RAISES RB/TE survival — "join the run" is frequently
// backwards; the lookahead computes the net sign.

/** Binomial coefficient C(n, k) — exact for the tiny n used here. */
function binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Exact upper tail P(Bin(K, pi) ≥ c). */
export function binomialTail(K, c, pi) {
  if (c <= 0) return 1;
  let sum = 0;
  for (let k = c; k <= K; k++) sum += binom(K, k) * pi ** k * (1 - pi) ** (K - k);
  return Math.min(1, sum);
}

/**
 * Plackett-Luce expected pick share per position over the remaining pool.
 *
 * @param {{pos: string, mu: number}[]} pool  remaining players (ADP mean μ).
 * @param {number} tau  local σ̂ (softmax temperature).
 * @returns {Object<string, number>} π_p, Σ = 1.
 */
export function positionShares(pool, tau) {
  const t = Math.max(tau, 1e-9);
  if (pool.length === 0) return {};
  let muMin = Infinity;
  for (const p of pool) if (p.mu < muMin) muMin = p.mu;
  const byPos = {};
  let W = 0;
  for (const p of pool) {
    const w = Math.exp(-(p.mu - muMin) / t);
    byPos[p.pos] = (byPos[p.pos] ?? 0) + w;
    W += w;
  }
  for (const pos of Object.keys(byPos)) byPos[pos] /= W;
  return byPos;
}

/**
 * Detect runs over the recent pick history.
 *
 * @param {string[]} recentPositions  positions of recent picks, OLDEST FIRST.
 * @param {Object<string, number>} shares  π_p from positionShares().
 * @param {{windows?: number[], alpha?: number, minCount?: number}} [opts]
 * @returns {{flags: Object<string, boolean>, z: Object<string, number>,
 *            detail: {pos:string, window:number, count:number, pval:number, z:number}[]}}
 *          z per position = the largest positive z among flagged windows.
 */
export function detectRuns(recentPositions, shares, opts = {}) {
  const { windows = [6, 12], alpha = 0.05, minCount = 3 } = opts;
  const flags = {};
  const z = {};
  const detail = [];
  for (const K0 of windows) {
    const K = Math.min(K0, recentPositions.length);
    if (K < minCount) continue;
    const slice = recentPositions.slice(recentPositions.length - K);
    const counts = {};
    for (const pos of slice) counts[pos] = (counts[pos] ?? 0) + 1;
    for (const [pos, c] of Object.entries(counts)) {
      const pi = shares[pos] ?? 0;
      if (!(pi > 0) || pi >= 1) continue;
      const pval = binomialTail(K, c, pi);
      const zz = (c - K * pi) / Math.sqrt(K * pi * (1 - pi));
      detail.push({ pos, window: K, count: c, pval, z: zz });
      if (pval < alpha && c >= minCount) {
        flags[pos] = true;
        z[pos] = Math.max(z[pos] ?? 0, zz);
      }
    }
  }
  return { flags, z, detail };
}

/**
 * Run-shifted ADP mean: μ' = μ − min(κ·max(0,z), cap)·σ·damp.
 * damp = min(1, remainingDemand_p/(N·S_p)) — a run at a position the league
 * has mostly finished starting cannot keep accelerating.
 */
export function shiftedMu(mu, sigma, zPos, damp, opts = {}) {
  const { kappa = 0.4, capSigmas = 1.5 } = opts;
  const shiftSd = Math.min(kappa * Math.max(0, zPos), capSigmas);
  return mu - shiftSd * sigma * Math.min(1, Math.max(0, damp));
}
