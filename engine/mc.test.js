import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  xorshift128plus,
  normal,
  plWeights,
  signatureOf,
  signatureKey,
  parseSignature,
  signatureDistance,
  kMedoids,
  medoidCoverage,
} from './mc.js';

// ── PRNG ───────────────────────────────────────────────────────────────────

test('xorshift128+ determinism: same seed ⇒ same 100 draws', () => {
  const a = xorshift128plus(20260827);
  const b = xorshift128plus(20260827);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('xorshift128+ different seeds diverge', () => {
  const a = xorshift128plus(1);
  const b = xorshift128plus(2);
  const drawsA = Array.from({ length: 10 }, () => a.next());
  const drawsB = Array.from({ length: 10 }, () => b.next());
  assert.notDeepEqual(drawsA, drawsB);
});

test('xorshift128+ draws are in [0, 1) and not degenerate', () => {
  const rng = xorshift128plus(42);
  const draws = Array.from({ length: 1000 }, () => rng.next());
  for (const d of draws) assert.ok(d >= 0 && d < 1, `out of range: ${d}`);
  const mean = draws.reduce((x, y) => x + y, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean} far from 0.5`);
  assert.ok(new Set(draws).size > 990, 'draws suspiciously repetitive');
});

test('normal() is deterministic and roughly standard', () => {
  const a = xorshift128plus(7);
  const b = xorshift128plus(7);
  for (let i = 0; i < 20; i++) assert.equal(normal(a), normal(b));
  const rng = xorshift128plus(99);
  const zs = Array.from({ length: 2000 }, () => normal(rng));
  const mean = zs.reduce((x, y) => x + y, 0) / zs.length;
  const varc = zs.reduce((x, y) => x + (y - mean) ** 2, 0) / zs.length;
  assert.ok(Math.abs(mean) < 0.1, `normal mean ${mean}`);
  assert.ok(Math.abs(varc - 1) < 0.15, `normal var ${varc}`);
});

test('plWeights matches the survival.js Plackett-Luce weight formula', () => {
  const mus = [10, 12, 20];
  const tau = 4;
  const w = plWeights(mus, tau);
  // w_i = exp(−(μ_i − μ_min)/τ), μ_min = 10
  assert.equal(w[0], 1);
  assert.ok(Math.abs(w[1] - Math.exp(-2 / 4)) < 1e-12);
  assert.ok(Math.abs(w[2] - Math.exp(-10 / 4)) < 1e-12);
});

// ── Signatures ─────────────────────────────────────────────────────────────

test('signature stability: insertion order never changes the key', () => {
  const a = signatureOf([
    { pos: 'RB', tier: 1 }, { pos: 'WR', tier: 1 },
    { pos: 'RB', tier: 1 }, { pos: 'TE', tier: 2 },
  ]);
  const b = signatureOf([
    { pos: 'TE', tier: 2 }, { pos: 'RB', tier: 1 },
    { pos: 'WR', tier: 1 }, { pos: 'RB', tier: 1 },
  ]);
  assert.equal(signatureKey(a), signatureKey(b));
  assert.equal(signatureKey(a), 'RB1:2|TE2:1|WR1:1');
});

test('signature round-trip: parse(key(sig)) == sig, empty included', () => {
  const sig = { RB1: 3, WR2: 1, DST10: 2 };
  assert.deepEqual(parseSignature(signatureKey(sig)), sig);
  assert.deepEqual(parseSignature(signatureKey({})), {});
});

test('signature distance: identity, symmetry, hand-computed L1', () => {
  const a = { RB1: 3, WR1: 2 };
  const b = { RB1: 1, WR1: 2, TE1: 1 };
  assert.equal(signatureDistance(a, a), 0);
  assert.equal(signatureDistance(a, b), signatureDistance(b, a));
  assert.equal(signatureDistance(a, b), 3); // |3−1| + |2−2| + |0−1|
});

// ── k-medoids ──────────────────────────────────────────────────────────────

/** Three well-separated synthetic clusters of board signatures: each item is
    a small perturbation (L1 ≤ 2) of its center; centers are ≥ 8 apart. */
function syntheticClusters() {
  const centers = [
    { RB1: 4, WR1: 2, QB1: 1 },
    { WR1: 5, TE1: 2 },
    { RB2: 3, WR2: 3, RB1: 1 },
  ];
  const items = [];
  for (const [ci, center] of centers.entries()) {
    // the center itself, heavy
    items.push({ sig: { ...center }, weight: 10, cluster: ci });
    // perturbations: one count up or down on a single key
    for (const [ki, key] of Object.keys(center).entries()) {
      const up = { ...center, [key]: center[key] + 1 };
      items.push({ sig: up, weight: 3 - (ki % 2), cluster: ci });
      const down = { ...center };
      if (down[key] > 1) down[key] -= 1; else delete down[key];
      items.push({ sig: down, weight: 2, cluster: ci });
    }
  }
  return { centers, items };
}

test('kMedoids recovers the three synthetic modes; coverage ≥ 0.85', () => {
  const { centers, items } = syntheticClusters();
  const clusters = kMedoids(items, 3);
  assert.equal(clusters.length, 3);

  // Masses sum to 1 and every item is assigned exactly once.
  const massSum = clusters.reduce((a, c) => a + c.mass, 0);
  assert.ok(Math.abs(massSum - 1) < 1e-9, `mass sum ${massSum}`);
  const seen = clusters.flatMap((c) => c.members).sort((a, b) => a - b);
  assert.deepEqual(seen, items.map((_, i) => i));

  // Each medoid sits at (or within 2 of) a distinct true center.
  const matched = new Set();
  for (const c of clusters) {
    const med = items[c.medoid].sig;
    const ci = centers.findIndex((ctr) => signatureDistance(med, ctr) <= 2);
    assert.ok(ci >= 0, `medoid ${signatureKey(med)} near no center`);
    matched.add(ci);
  }
  assert.equal(matched.size, 3);

  // The plan's mass criterion: modal states cover ≥ 85% within radius 3.
  assert.ok(medoidCoverage(items, clusters, 3) >= 0.85);
});

test('kMedoids is deterministic and handles k ≥ n and n = 0', () => {
  const { items } = syntheticClusters();
  assert.deepEqual(kMedoids(items, 3), kMedoids(items, 3));

  const tiny = items.slice(0, 2);
  const cs = kMedoids(tiny, 10);
  assert.equal(cs.length, 2); // k clamped to n
  assert.deepEqual(kMedoids([], 5), []);
});

test('kMedoids: cluster masses reflect item weights', () => {
  const items = [
    { sig: { RB1: 5 }, weight: 90 },
    { sig: { WR1: 5 }, weight: 10 },
  ];
  const cs = kMedoids(items, 2);
  assert.ok(Math.abs(cs[0].mass - 0.9) < 1e-9);
  assert.equal(signatureKey(items[cs[0].medoid].sig), 'RB1:5');
});
