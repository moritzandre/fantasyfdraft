// seeds.mjs — deterministic seed derivation for the strategy-evaluation
// harness. PURE 32-bit integer math: no fs, no process, no Date.now().
//
// draftSeed(baseSeed, slot, simIndex) mixes its three inputs into one
// well-spread 32-bit seed for engine/mc.js xorshift128plus.
//
// THE STRATEGY IS DELIBERATELY NOT AN INPUT. Every strategy evaluated at the
// same (slot, simIndex) must share one opponent rng stream (common random
// numbers): forced self-play picks consume no rng (engine/opponent.js run
// pickFor), so with an identical seed the 11 opponents execute the identical
// script under every strategy and per-sim roster values are PAIRED. That
// pairing is what makes the Δ-vs-balanced comparison low-variance. Do not
// "fix" this by hashing the strategy name in — it would silently destroy
// the paired design while everything still appears to work.

/** splitmix32-style avalanche finalizer (same constants engine/mc.js uses
    to expand seeds — full 32-bit avalanche, cheap in JS via Math.imul). */
function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * One 32-bit seed per (baseSeed, slot, simIndex) draft.
 *
 * @param {number} baseSeed  any 32-bit integer (CLI --seed).
 * @param {number} slot      draft slot 1..N.
 * @param {number} simIndex  GLOBAL sim index — shard-absolute, so a shard
 *        covering [from, to) seeds sim k with simIndex from+k and any split
 *        into shards reproduces the exact same drafts.
 * @returns {number} unsigned 32-bit seed for xorshift128plus.
 */
export function draftSeed(baseSeed, slot, simIndex) {
  let h = (baseSeed | 0) >>> 0;
  h = mix32(h ^ Math.imul(slot | 0, 0x9e3779b9));    // golden-ratio odd const
  h = mix32(h ^ Math.imul(simIndex | 0, 0x85ebca6b)); // murmur3 fmix const
  return h;
}

/** FNV-1a 32-bit string hash — provenance fingerprints only (e.g. the
    shard-compatibility opponentParamsHash), never rng seeding. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
