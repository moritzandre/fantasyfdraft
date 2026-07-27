// mc.js — pure helpers shared by tools/simulate.mjs (offline Monte Carlo)
// and, later, the Ladder tab. PURE: no DOM, no fetch, no fs, no globals,
// no Date.now(). Everything deterministic given its inputs.
//
//   1. xorshift128+ PRNG — the canonical Vigna shift triple (23, 17, 26),
//      implemented on 32-bit lanes (hi/lo pairs) so it runs at full speed in
//      JS without BigInt. Seeded via splitmix32 so any integer seed yields a
//      well-mixed non-zero 128-bit state. Same seed ⇒ same stream, tested.
//   2. Board-state signatures — a simulated pre-pick board is discretized to
//      counts-gone per (position, tier): {"RB1": 3, "WR2": 1, ...}. Distance
//      between two board states is L1 over the union of keys — "how many
//      picks would you have to move to turn one board into the other".
//   3. Weighted k-medoids over signatures — deterministic PAM-lite:
//      weighted-farthest-first init, then alternate nearest-medoid
//      assignment / weighted-medoid update until stable. Used to reduce
//      20k simulated boards to ~10 modal states (plan "Branch trees").
//
// Plackett-Luce note: the MC samples opponent picks from the SAME weight
// formula the live survival model uses (survival.js plackettLuceSurvival):
// w_i = exp(−(μ_i − μ_min)/τ). plWeights() below is that formula, exported
// so simulate.mjs and survival.js can never disagree about the math.

/** splitmix32 — used only to expand a seed into PRNG state words. */
function splitmix32(a) {
  return function next() {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/**
 * xorshift128+ seeded PRNG.
 *
 * @param {number} seed  any finite number; hashed through splitmix32.
 * @returns {{next: () => number, nextU32: () => number}}
 *          next() ∈ [0, 1) using the top 53 bits of the 64-bit sum;
 *          nextU32() the high 32 bits of the same draw.
 */
export function xorshift128plus(seed) {
  const sm = splitmix32(seed | 0);
  let s0h = sm(), s0l = sm(), s1h = sm(), s1l = sm();
  if ((s0h | s0l | s1h | s1l) === 0) s0l = 1; // the all-zero state is absorbing

  let rh = 0, rl = 0; // result registers for the current draw
  function step() {
    // result = s0 + s1 (64-bit add on 32-bit lanes)
    const lo = s0l + s1l;
    rl = lo >>> 0;
    rh = (s0h + s1h + (lo >= 0x100000000 ? 1 : 0)) >>> 0;

    // t = s0 ^ (s0 << 23)
    let th = (((s0h << 23) | (s0l >>> 9)) ^ s0h) >>> 0;
    let tl = ((s0l << 23) ^ s0l) >>> 0;
    // t ^= t >> 17
    th = (th ^ (th >>> 17)) >>> 0;
    tl = (tl ^ ((tl >>> 17) | (th << 15))) >>> 0;
    // t ^= s1 ^ (s1 >> 26)
    th = (th ^ s1h ^ (s1h >>> 26)) >>> 0;
    tl = (tl ^ s1l ^ ((s1l >>> 26) | (s1h << 6))) >>> 0;

    s0h = s1h; s0l = s1l; // s0 ← old s1
    s1h = th; s1l = tl;   // s1 ← t
  }
  return {
    next() {
      step();
      // top 53 bits → [0, 1): rh contributes 32, rl its top 21.
      return (rh * 2097152 + (rl >>> 11)) / 9007199254740992;
    },
    nextU32() {
      step();
      return rh;
    },
  };
}

/** Standard normal draw (Box-Muller, one value per call — deterministic
    stream shape: exactly two uniforms consumed per call). */
export function normal(rng) {
  let u = rng.next();
  if (u <= 0) u = 5e-324; // log(0) guard
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Plackett-Luce sampling weights — IDENTICAL math to survival.js
    plackettLuceSurvival: w_i = exp(−(μ_i − μ_min)/τ). */
export function plWeights(mus, tau) {
  const t = Math.max(tau, 1e-9);
  let muMin = Infinity;
  for (const mu of mus) if (mu < muMin) muMin = mu;
  return mus.map((mu) => Math.exp(-(mu - muMin) / t));
}

// ── Signatures ─────────────────────────────────────────────────────────────

/**
 * Signature of a board state: counts-gone per (position, tier).
 *
 * @param {{pos: string, tier: number}[]} gonePlayers  drafted players.
 * @returns {Object<string, number>}  e.g. {"RB1": 3, "WR1": 2}.
 */
export function signatureOf(gonePlayers) {
  const sig = {};
  for (const p of gonePlayers) {
    const key = p.pos + p.tier;
    sig[key] = (sig[key] ?? 0) + 1;
  }
  return sig;
}

/** Canonical string form — keys sorted, "POS<tier>:count|…". Insertion
    order never matters; "" for the empty (clean-board) signature. */
export function signatureKey(sig) {
  return Object.keys(sig)
    .sort()
    .map((k) => `${k}:${sig[k]}`)
    .join('|');
}

/** Parse a canonical signature string back to the object form. */
export function parseSignature(key) {
  const sig = {};
  if (!key) return sig;
  for (const part of key.split('|')) {
    const i = part.lastIndexOf(':');
    sig[part.slice(0, i)] = Number(part.slice(i + 1));
  }
  return sig;
}

/** L1 distance between two signatures over the union of keys — the number
    of picks you would have to relabel to turn one board into the other. */
export function signatureDistance(a, b) {
  let d = 0;
  for (const k of Object.keys(a)) d += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  for (const k of Object.keys(b)) if (!(k in a)) d += b[k];
  return d;
}

// ── Weighted k-medoids (PAM-lite, deterministic) ───────────────────────────

/**
 * Cluster weighted signatures into k modal states.
 *
 * Deterministic: init = heaviest item, then weighted farthest-first
 * (argmax weight·minDistToMedoids, ties → lowest index); refinement
 * alternates nearest-medoid assignment (ties → earliest medoid) and
 * weighted medoid update (ties → lowest index) until medoids are stable.
 *
 * @param {{sig: Object<string, number>, weight: number}[]} items
 * @param {number} k
 * @param {{maxIter?: number}} [opts]
 * @returns {{medoid: number, mass: number, members: number[]}[]}
 *          clusters sorted by mass DESC; medoid/members are item indices;
 *          mass is the weight fraction of the cluster (Σ = 1).
 */
export function kMedoids(items, k, opts = {}) {
  const { maxIter = 30 } = opts;
  const n = items.length;
  if (n === 0) return [];
  const kk = Math.min(k, n);
  const totalW = items.reduce((a, it) => a + it.weight, 0) || 1;

  // Distance cache (n ≤ a few thousand unique signatures; symmetric).
  const dist = (i, j) => signatureDistance(items[i].sig, items[j].sig);

  // Init: heaviest first, then weighted farthest-first.
  let heaviest = 0;
  for (let i = 1; i < n; i++) if (items[i].weight > items[heaviest].weight) heaviest = i;
  const medoids = [heaviest];
  const minD = new Float64Array(n);
  for (let i = 0; i < n; i++) minD[i] = dist(i, heaviest);
  while (medoids.length < kk) {
    let best = -1, bestScore = -1;
    for (let i = 0; i < n; i++) {
      if (medoids.includes(i)) continue;
      const score = items[i].weight * minD[i];
      if (score > bestScore) { bestScore = score; best = i; }
    }
    medoids.push(best);
    for (let i = 0; i < n; i++) {
      const d = dist(i, best);
      if (d < minD[i]) minD[i] = d;
    }
  }

  // Refine.
  let assign = new Int32Array(n);
  for (let iter = 0; iter < maxIter; iter++) {
    // Assignment: nearest medoid, ties → earliest in medoid list.
    for (let i = 0; i < n; i++) {
      let bm = 0, bd = Infinity;
      for (let m = 0; m < medoids.length; m++) {
        const d = dist(i, medoids[m]);
        if (d < bd) { bd = d; bm = m; }
      }
      assign[i] = bm;
    }
    // Update: per cluster, the member minimizing Σ weight·dist.
    let changed = false;
    for (let m = 0; m < medoids.length; m++) {
      const members = [];
      for (let i = 0; i < n; i++) if (assign[i] === m) members.push(i);
      if (members.length === 0) continue;
      let best = medoids[m], bestCost = Infinity;
      for (const cand of members) {
        let cost = 0;
        for (const i of members) cost += items[i].weight * dist(i, cand);
        if (cost < bestCost) { bestCost = cost; best = cand; }
      }
      if (best !== medoids[m]) { medoids[m] = best; changed = true; }
    }
    if (!changed) break;
  }

  // Final assignment + clusters.
  const clusters = medoids.map((medoid) => ({ medoid, mass: 0, members: [] }));
  for (let i = 0; i < n; i++) {
    let bm = 0, bd = Infinity;
    for (let m = 0; m < medoids.length; m++) {
      const d = dist(i, medoids[m]);
      if (d < bd) { bd = d; bm = m; }
    }
    clusters[bm].members.push(i);
    clusters[bm].mass += items[i].weight / totalW;
  }
  return clusters
    .filter((c) => c.members.length > 0)
    .sort((a, b) => b.mass - a.mass || a.medoid - b.medoid);
}

/**
 * Coverage: fraction of total weight lying within `radius` (L1 signature
 * distance) of its cluster's medoid — the ">85% of probability mass"
 * criterion for the modal states (plan "Branch trees").
 */
export function medoidCoverage(items, clusters, radius) {
  const totalW = items.reduce((a, it) => a + it.weight, 0) || 1;
  let covered = 0;
  for (const c of clusters) {
    for (const i of c.members) {
      if (signatureDistance(items[i].sig, items[c.medoid].sig) <= radius) {
        covered += items[i].weight;
      }
    }
  }
  return covered / totalW;
}
