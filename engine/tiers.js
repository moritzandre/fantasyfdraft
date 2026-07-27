// tiers.js — exact 1-D weighted k-means by dynamic programming (plan P2).
// PURE: no DOM, no fetch, no globals, no Date.now(). Deterministic.
//
// Ckmeans.1d.dp: in one dimension the globally optimal weighted k-means
// clusters are contiguous in sorted order — exactly the "tiers respect rank
// order" property — so an O(k·n²) DP over segment boundaries is exact.
//
//   weights   w_i = 1/σ_proj,i²
//   cost(i,j) = Σ w x² − (Σ w x)² / Σ w        (weighted SSE, O(1) via prefix sums)
//   D[k][j]   = min_i  D[k−1][i−1] + cost(i,j)   with segment size ≤ maxTierSize
//
//   k* = min{ k : D[k][n] ≤ ratio · D1[n] },   ratio = 0.10,
//        D1 = UNconstrained 1-cluster SSE (the size cap would make it ∞)
//
// Then merge any boundary whose separation is projection noise:
//
//   TierSep = cliff / √(σ_last² + σ_first²)  < 1.0  ⇒  merge
//
// (cliff = last value of the upper tier − first value of the lower tier).
// Computed once offline per position; labels are then FROZEN — re-tiering
// mid-draft renumbers everything and destroys trust.

/** Weighted SSE prefix machinery. values in rank order (descending is fine —
    contiguity in sorted order is all the DP needs). */
function prefixes(values, weights) {
  const n = values.length;
  const W = new Float64Array(n + 1);
  const WX = new Float64Array(n + 1);
  const WX2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    W[i + 1] = W[i] + weights[i];
    WX[i + 1] = WX[i] + weights[i] * values[i];
    WX2[i + 1] = WX2[i] + weights[i] * values[i] * values[i];
  }
  // cost of segment [i..j] inclusive, 0-based
  return (i, j) => {
    const w = W[j + 1] - W[i];
    if (w <= 0) return 0;
    const wx = WX[j + 1] - WX[i];
    const wx2 = WX2[j + 1] - WX2[i];
    const sse = wx2 - (wx * wx) / w;
    return sse > 0 ? sse : 0; // guard float negatives
  };
}

/**
 * Exact optimal segmentation of `values` into `k` contiguous segments.
 *
 * @param {number[]} values  sorted (descending by convention here).
 * @param {number[]} weights 1/σ² per value.
 * @param {number} k
 * @param {number} [maxSize=Infinity]  hard cap on segment length.
 * @returns {{sse: number, segments: {start: number, end: number}[]}|null}
 *          null when infeasible (k·maxSize < n). Ties broken toward the
 *          SMALLEST feasible start index — deterministic.
 */
export function optimalSegments(values, weights, k, maxSize = Infinity) {
  const n = values.length;
  if (k * maxSize < n || k < 1 || k > n) return null;
  const cost = prefixes(values, weights);

  // D[j] for current k; choice[k][j] = start index of the last segment.
  let D = new Float64Array(n);
  const choice = [];
  for (let j = 0; j < n; j++) D[j] = j + 1 <= maxSize ? cost(0, j) : Infinity;

  for (let kk = 2; kk <= k; kk++) {
    const Dnext = new Float64Array(n).fill(Infinity);
    const ch = new Int32Array(n).fill(-1);
    for (let j = kk - 1; j < n; j++) {
      const iMin = Math.max(kk - 1, j - maxSize + 1);
      for (let i = iMin; i <= j; i++) {
        const c = D[i - 1] + cost(i, j);
        if (c < Dnext[j]) { Dnext[j] = c; ch[j] = i; } // strict < ⇒ smallest i wins
      }
    }
    D = Dnext;
    choice[kk] = ch;
  }
  if (!Number.isFinite(D[n - 1])) return null;

  // Backtrack.
  const segments = [];
  let end = n - 1;
  for (let kk = k; kk >= 2; kk--) {
    const start = choice[kk][end];
    segments.unshift({ start, end });
    end = start - 1;
  }
  segments.unshift({ start: 0, end });
  return { sse: D[n - 1], segments };
}

/**
 * Merge boundaries where TierSep = cliff/√(σ_a²+σ_b²) < threshold — that
 * break is projection noise, not signal. Single left-to-right pass (TierSep
 * depends only on the two boundary-adjacent players, so merges don't change
 * later separations). Merged tiers may exceed maxTierSize — by design: the
 * size cap shapes the DP, but a statistically absent boundary stays absent.
 *
 * @returns {{segments: {start:number,end:number}[], tierSeps: number[]}}
 *          tierSeps = separation of each SURVIVING boundary.
 */
export function mergeWeakBoundaries(values, sigmas, segments, threshold = 1.0) {
  const merged = [{ ...segments[0] }];
  const tierSeps = [];
  for (let s = 1; s < segments.length; s++) {
    const prev = merged[merged.length - 1];
    const cur = segments[s];
    const a = prev.end;        // last of upper tier
    const b = cur.start;       // first of lower tier
    const cliff = values[a] - values[b];
    const sep = cliff / Math.sqrt(sigmas[a] ** 2 + sigmas[b] ** 2);
    if (sep < threshold) {
      prev.end = cur.end;      // merge
    } else {
      tierSeps.push(sep);
      merged.push({ ...cur });
    }
  }
  return { segments: merged, tierSeps };
}

/**
 * Tier one position. players sorted DESCENDING by mu.
 *
 * @param {{mu: number, sigma: number}[]} players
 * @param {{maxTierSize?: number, ratio?: number, sepThreshold?: number}} [opts]
 * @returns {{assignments: number[], segments: {start:number,end:number}[],
 *            k: number, tierSeps: number[]}}  assignments are 1-based tiers.
 */
export function tierize(players, opts = {}) {
  const { maxTierSize = 8, ratio = 0.10, sepThreshold = 1.0 } = opts;
  const n = players.length;
  if (n === 0) return { assignments: [], segments: [], k: 0, tierSeps: [] };

  const values = players.map((p) => p.mu);
  const sigmas = players.map((p) => Math.max(p.sigma, 1e-9));
  const weights = sigmas.map((s) => 1 / (s * s));

  // D1 must be UNconstrained: with the size cap a single cluster is usually
  // infeasible and the 10% rule would have nothing to compare against.
  const d1 = optimalSegments(values, weights, 1)?.sse ?? 0;

  let best = null;
  for (let k = 1; k <= n; k++) {
    const res = optimalSegments(values, weights, k, maxTierSize);
    if (!res) continue;                      // k too small for the size cap
    best = res;
    if (d1 === 0 || res.sse <= ratio * d1) break; // k* = first k under 10% of D1
  }

  const { segments, tierSeps } = mergeWeakBoundaries(values, sigmas, best.segments, sepThreshold);
  const assignments = new Array(n);
  segments.forEach((seg, t) => {
    for (let i = seg.start; i <= seg.end; i++) assignments[i] = t + 1;
  });
  return { assignments, segments, k: segments.length, tierSeps };
}
