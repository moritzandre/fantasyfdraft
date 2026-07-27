import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binomialTail, positionShares, detectRuns, shiftedMu } from './runs.js';

const FIX = JSON.parse(
  readFileSync(new URL('../tests/fixtures/engineFixtures.json', import.meta.url), 'utf8'),
);

test('binomial tail: exact hand-computed values', () => {
  for (const c of FIX.binomialTail.cases) {
    assert.ok(Math.abs(binomialTail(c.K, c.c, c.pi) - c.p) < 1e-12, `K=${c.K} c=${c.c}`);
  }
  assert.equal(binomialTail(6, 0, 0.25), 1); // degenerate lower bound
});

test('flags 5-of-6 RB picks against π_RB=0.25, does not flag 2-of-6', () => {
  const shares = { RB: 0.25, WR: 0.5, TE: 0.25 };
  // 5 RB in the last 6: pval = 0.00464 < 0.05 and c ≥ 3 -> flag.
  const hot = detectRuns(['RB', 'RB', 'WR', 'RB', 'RB', 'RB'], shares);
  assert.equal(hot.flags.RB, true);
  assert.ok(hot.z.RB > 0);
  assert.equal(hot.flags.WR, undefined); // 1-of-6 WR is nothing

  // 2 RB in the last 6: pval = 0.466, and c < 3 anyway -> no flag anywhere.
  const cold = detectRuns(['RB', 'WR', 'WR', 'RB', 'WR', 'WR'], shares);
  assert.deepEqual(cold.flags, {});
});

test('position shares: Plackett-Luce softmax sums to 1, favors low ADP', () => {
  const pool = [
    { pos: 'RB', mu: 5 }, { pos: 'RB', mu: 8 },
    { pos: 'WR', mu: 20 }, { pos: 'TE', mu: 30 },
  ];
  const shares = positionShares(pool, 5);
  const total = Object.values(shares).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.ok(shares.RB > shares.WR && shares.WR > shares.TE);
});

test('ADP shift: κ=0.4, capped at 1.5σ, damped by remaining demand', () => {
  // z=2 -> 0.8σ shift at full demand.
  assert.ok(Math.abs(shiftedMu(100, 10, 2, 1) - 92) < 1e-12);
  // z huge -> capped at 1.5σ.
  assert.ok(Math.abs(shiftedMu(100, 10, 10, 1) - 85) < 1e-12);
  // Half the demand left -> half the shift.
  assert.ok(Math.abs(shiftedMu(100, 10, 2, 0.5) - 96) < 1e-12);
  // Negative z never shifts the other way — a cold position is not "late".
  assert.equal(shiftedMu(100, 10, -3, 1), 100);
});
