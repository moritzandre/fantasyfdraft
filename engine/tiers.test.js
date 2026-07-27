import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optimalSegments, mergeWeakBoundaries, tierize } from './tiers.js';

const FIX = JSON.parse(
  readFileSync(new URL('../tests/fixtures/engineFixtures.json', import.meta.url), 'utf8'),
);

/** Weighted SSE of one segment, straight from the definition. */
function segSSE(values, weights, start, end) {
  let w = 0, wx = 0;
  for (let i = start; i <= end; i++) { w += weights[i]; wx += weights[i] * values[i]; }
  const mean = wx / w;
  let sse = 0;
  for (let i = start; i <= end; i++) sse += weights[i] * (values[i] - mean) ** 2;
  return sse;
}

/** Brute-force optimal k=3 segmentation: enumerate both boundaries. */
function bruteForceK3(values, weights) {
  const n = values.length;
  let best = Infinity;
  for (let b1 = 1; b1 < n - 1; b1++) {
    for (let b2 = b1 + 1; b2 < n; b2++) {
      const sse =
        segSSE(values, weights, 0, b1 - 1) +
        segSSE(values, weights, b1, b2 - 1) +
        segSSE(values, weights, b2, n - 1);
      if (sse < best) best = sse;
    }
  }
  return best;
}

test('DP equals brute-force optimal SSE on the 12-point array, k=3', () => {
  const f = FIX.tiers12;
  const weights = f.values.map(() => 1 / (f.sigma * f.sigma));
  const dp = optimalSegments(f.values, weights, 3);
  const brute = bruteForceK3(f.values, weights);
  assert.ok(Math.abs(dp.sse - brute) < 1e-9, `dp=${dp.sse} brute=${brute}`);
});

test('tierize finds the three obvious clusters (10% rule) and keeps them (TierSep)', () => {
  const f = FIX.tiers12;
  const players = f.values.map((mu) => ({ mu, sigma: f.sigma }));
  const res = tierize(players);
  assert.deepEqual(res.assignments, f.expectedAssignments);
  assert.equal(res.k, 3);
  for (const sep of res.tierSeps) assert.ok(sep >= 1.0);
});

test('determinism: identical input twice, identical output', () => {
  const f = FIX.tiers12;
  const players = f.values.map((mu) => ({ mu, sigma: f.sigma }));
  assert.deepEqual(tierize(players), tierize(players));
});

test('TierSep merge fires on a weak boundary, keeps a strong one', () => {
  const { weak, strong } = FIX.tierSepMerge;
  const segs = [{ start: 0, end: 0 }, { start: 1, end: 1 }];
  assert.equal(
    mergeWeakBoundaries(weak.values, weak.sigmas, segs).segments.length,
    weak.expectSegments,
  );
  assert.equal(
    mergeWeakBoundaries(strong.values, strong.sigmas, segs).segments.length,
    strong.expectSegments,
  );
});

test('max tier size 8 constrains the DP', () => {
  // 10 near-identical values: unconstrained best is one tier, but the size
  // cap forces at least two segments in the DP result.
  const values = Array.from({ length: 10 }, (_, i) => 100 - 0.01 * i);
  const weights = values.map(() => 1);
  assert.equal(optimalSegments(values, weights, 1, 8), null);
  const two = optimalSegments(values, weights, 2, 8);
  assert.ok(two && two.segments.every((s) => s.end - s.start + 1 <= 8));
});
