import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStrategy, multiplierFor, isCompliant, STRATEGIES } from './strategy.js';

// One pick per round -> picks remaining after the current one through byRound.
const fptFrom = (round, rounds = 16) => (byRound) =>
  Math.max(0, Math.min(byRound, rounds) - round);

test('getStrategy: known names resolve, typos throw', () => {
  assert.equal(getStrategy('balanced').name, 'balanced');
  assert.equal(getStrategy(undefined).name, 'balanced');
  assert.throws(() => getStrategy('hero_rb'));
});

test('multipliers match the plan parameters', () => {
  const a = STRATEGIES.anchor_rb;
  assert.equal(multiplierFor(a, 'RB', 1), 1.15);
  assert.equal(multiplierFor(a, 'RB', 3), 0.70);
  assert.equal(multiplierFor(a, 'RB', 7), 1.20);
  assert.equal(multiplierFor(a, 'RB', 10), 1.0);
  assert.equal(multiplierFor(a, 'WR', 3), 1.0);
  assert.equal(multiplierFor(STRATEGIES.robust_rb, 'RB', 2), 1.25);
  assert.equal(multiplierFor(STRATEGIES.robust_rb, 'RB', 4), 1.0);
  assert.equal(multiplierFor(STRATEGIES.balanced, 'RB', 1), 1.0);
});

test('anchor_rb hard constraint blocks a 2nd RB in round 3', () => {
  const a = STRATEGIES.anchor_rb;
  assert.equal(isCompliant(a, { RB: 1 }, 3, 'RB', fptFrom(3)), false);
  assert.equal(isCompliant(a, { RB: 1 }, 3, 'WR', fptFrom(3)), true);
  // But an anchorless round 1 must spend the pick on RB.
  assert.equal(isCompliant(a, {}, 1, 'WR', fptFrom(1)), false);
  assert.equal(isCompliant(a, {}, 1, 'RB', fptFrom(1)), true);
  // And the ≥3-by-R9 minimum binds when the runway runs out: 1 RB entering
  // round 8 -> a non-RB pick leaves 1 pick for 2 RBs.
  assert.equal(isCompliant(a, { RB: 1 }, 8, 'WR', fptFrom(8)), false);
  // Window R5-R9 allows RB again (the max ran through R4 only).
  assert.equal(isCompliant(a, { RB: 1 }, 5, 'RB', fptFrom(5)), true);
});

test('zero_rb_mod: no RB in rounds 1-3, free from round 4', () => {
  const z = STRATEGIES.zero_rb_mod;
  assert.equal(isCompliant(z, {}, 1, 'RB', fptFrom(1)), false);
  assert.equal(isCompliant(z, {}, 3, 'RB', fptFrom(3)), false);
  assert.equal(isCompliant(z, {}, 4, 'RB', fptFrom(4)), true);
  assert.equal(isCompliant(z, {}, 2, 'WR', fptFrom(2)), true);
});

test('robust_rb minimums: ≥2 RB by R3, ≥3 by R5', () => {
  const r = STRATEGIES.robust_rb;
  // 0 RB entering round 2: a non-RB pick strands 2-by-R3 (only R3 left).
  assert.equal(isCompliant(r, {}, 2, 'WR', fptFrom(2)), false);
  assert.equal(isCompliant(r, {}, 2, 'RB', fptFrom(2)), true);
  // 2 RB entering round 4: WR fine, R5 still covers the third RB.
  assert.equal(isCompliant(r, { RB: 2 }, 4, 'WR', fptFrom(4)), true);
  // 2 RB entering round 5: non-RB pick strands 3-by-R5.
  assert.equal(isCompliant(r, { RB: 2 }, 5, 'WR', fptFrom(5)), false);
});
