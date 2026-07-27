import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStrategy, multiplierFor, isCompliant, STRATEGIES,
  validateStrategy, defineStrategy, resolveStrategy,
} from './strategy.js';

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

// ── Custom strategy specs ───────────────────────────────────────────────────

const GOOD_SPEC = {
  name: 'wr_heavy',
  label: 'WR Heavy',
  blurb: 'Bank the WR cliff early.',
  multipliers: {
    WR: [{ from: 1, to: 4, m: 1.2 }],
    RB: [{ from: 1, to: 3, m: 0.85 }],
  },
  constraints: [{ pos: 'WR', type: 'min', by: 5, need: 3 }],
  overrideDelta: 20,
};

test('validateStrategy: a well-formed spec passes', () => {
  assert.deepEqual(validateStrategy(GOOD_SPEC), []);
});

test('validateStrategy: whitelist rejects additive-term smuggling', () => {
  for (const key of ['bonus', 'cliffBonus', 'needMultiplier', 'additive']) {
    const errs = validateStrategy({ ...GOOD_SPEC, [key]: 5 });
    assert.ok(errs.some((e) => e.includes(`"${key}"`)), `expected error for ${key}`);
  }
});

test('validateStrategy: names, positions, ranges, m-bounds', () => {
  assert.ok(validateStrategy({ ...GOOD_SPEC, name: 'Bad Name' }).length > 0);
  assert.ok(validateStrategy({ ...GOOD_SPEC, name: 'balanced' })
    .some((e) => e.includes('reserved')));
  assert.ok(validateStrategy({ ...GOOD_SPEC, multipliers: { K: [{ from: 1, to: 2, m: 1.1 }] } })
    .some((e) => e.includes('K')));
  assert.ok(validateStrategy({ ...GOOD_SPEC, multipliers: { WR: [{ from: 3, to: 2, m: 1.1 }] } }).length > 0);
  assert.ok(validateStrategy({ ...GOOD_SPEC, multipliers: { WR: [{ from: 1, to: 17, m: 1.1 }] } }).length > 0);
  assert.ok(validateStrategy({ ...GOOD_SPEC, multipliers: { WR: [{ from: 1, to: 4, m: 0.1 }] } })
    .some((e) => e.includes('[0.25, 2.5]')));
  // overlapping ranges
  assert.ok(validateStrategy({
    ...GOOD_SPEC,
    multipliers: { WR: [{ from: 1, to: 4, m: 1.2 }, { from: 4, to: 6, m: 1.1 }] },
  }).some((e) => e.includes('overlap')));
});

test('validateStrategy: constraint feasibility cross-checks', () => {
  // min 3 by R4 under max 1 through R3 → attainable = 1 + (4−3) = 2 < 3.
  assert.ok(validateStrategy({
    name: 'x', constraints: [
      { pos: 'RB', type: 'max', through: 3, limit: 1 },
      { pos: 'RB', type: 'min', by: 4, need: 3 },
    ],
  }).some((e) => e.includes('infeasible')));
  // pigeonhole: 3 RB + 3 WR by round 5 → 6 > 5 picks.
  assert.ok(validateStrategy({
    name: 'x', constraints: [
      { pos: 'RB', type: 'min', by: 5, need: 3 },
      { pos: 'WR', type: 'min', by: 5, need: 3 },
    ],
  }).some((e) => e.includes('more than')));
  // need > by is impossible outright.
  assert.ok(validateStrategy({
    name: 'x', constraints: [{ pos: 'RB', type: 'min', by: 2, need: 3 }],
  }).length > 0);
});

test('defineStrategy: normalizes, freezes, defaults; throws on invalid', () => {
  const s = defineStrategy(GOOD_SPEC);
  assert.equal(s.name, 'wr_heavy');
  assert.equal(s.overrideDelta, 20);
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.multipliers) && Object.isFrozen(s.constraints));
  assert.equal(multiplierFor(s, 'WR', 2), 1.2);
  assert.equal(multiplierFor(s, 'WR', 5), 1.0);
  const minimal = defineStrategy({ name: 'plain' });
  assert.equal(minimal.overrideDelta, 20);
  assert.deepEqual(minimal.constraints, []);
  assert.throws(() => defineStrategy({ name: 'Bad Name' }));
});

test('resolveStrategy: built-ins, registry, throw preserved', () => {
  assert.equal(resolveStrategy('balanced').name, 'balanced');
  assert.equal(resolveStrategy(undefined).name, 'balanced');
  const reg = { wr_heavy: defineStrategy(GOOD_SPEC) };
  assert.equal(resolveStrategy('wr_heavy', reg).name, 'wr_heavy');
  assert.throws(() => resolveStrategy('wr_heavy'));        // no registry
  assert.throws(() => resolveStrategy('typo_name', reg));  // not in either
  // built-ins shadow the registry — a custom spec can never hijack a name
  // (validateStrategy rejects reserved names anyway; belt and suspenders).
  assert.equal(resolveStrategy('balanced', { balanced: reg.wr_heavy }).name, 'balanced');
});

test('defineStrategy output drives isCompliant like a built-in', () => {
  const s = defineStrategy(GOOD_SPEC);
  // 1 WR entering round 4: a non-WR pick leaves 1 pick (R5) for 2 WRs.
  assert.equal(isCompliant(s, { WR: 1 }, 4, 'RB', fptFrom(4)), false);
  assert.equal(isCompliant(s, { WR: 1 }, 4, 'WR', fptFrom(4)), true);
});
