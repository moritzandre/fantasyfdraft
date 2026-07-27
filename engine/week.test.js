import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekEff,
  weeklyLineup,
  rosValue,
  startSit,
  sigmaWeek,
  weekBand,
} from './week.js';

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ---------------------------------------------------------------------------
// weekEff
// ---------------------------------------------------------------------------

test('weekEff: 1-based indexing, missing/short/NaN weeks are 0', () => {
  assert.equal(weekEff([10, 0, 7.5], 1), 10);
  assert.equal(weekEff([10, 0, 7.5], 2), 0); // bye
  assert.equal(weekEff([10, 0, 7.5], 3), 7.5);
  assert.equal(weekEff([10, 0, 7.5], 4), 0); // off the array
  assert.equal(weekEff(undefined, 1), 0);
  assert.equal(weekEff([NaN], 1), 0);
});

// ---------------------------------------------------------------------------
// weeklyLineup
// ---------------------------------------------------------------------------

const byeRoster = [
  { pos: 'RB', name: 'A', weekly: [10, 0] }, // bye week 2
  { pos: 'RB', name: 'B', weekly: [8, 7] },
  { pos: 'RB', name: 'C', weekly: [5, 6] },
];
const byeSlots = { RB: 1, FLEX: 1 };

test('weeklyLineup: bye week (weekly 0) drops the player out of that week', () => {
  const w1 = weeklyLineup(byeRoster, 1, byeSlots, ['RB']);
  assert.equal(w1.total, 18); // A(10) RB + B(8) FLEX
  assert.ok(w1.starters.includes(byeRoster[0]));

  const w2 = weeklyLineup(byeRoster, 2, byeSlots, ['RB']);
  assert.equal(w2.total, 13); // B(7) RB + C(6) FLEX — A on bye sits
  assert.ok(!w2.starters.includes(byeRoster[0]));
  assert.ok(w2.starters.includes(byeRoster[2]));
});

test('weeklyLineup: starters are references to the original player objects', () => {
  const { starters } = weeklyLineup(byeRoster, 1, byeSlots, ['RB']);
  for (const s of starters) assert.ok(byeRoster.includes(s));
});

test('weeklyLineup: FLEX nesting on weeklies (mirrors bestLineup fixture)', () => {
  const roster = [
    { pos: 'RB', weekly: [50] }, { pos: 'RB', weekly: [40] }, { pos: 'RB', weekly: [35] },
    { pos: 'WR', weekly: [45] }, { pos: 'WR', weekly: [30] }, { pos: 'WR', weekly: [28] },
    { pos: 'TE', weekly: [33] }, { pos: 'TE', weekly: [32] },
  ];
  const slots = { RB: 2, WR: 2, TE: 1, FLEX: 2 };
  // Dedicated: 50+40 + 45+30 + 33 = 198; flex best leftovers 35+32.
  assert.equal(weeklyLineup(roster, 1, slots, ['RB', 'WR', 'TE']).total, 265);
});

// ---------------------------------------------------------------------------
// rosValue
// ---------------------------------------------------------------------------

test('rosValue: 2 synthetic weeks, hand-computed', () => {
  // week 1: A(10)+B(8) = 18; week 2 (A bye): B(7)+C(6) = 13 → 31
  assert.equal(rosValue(byeRoster, 1, 2, byeSlots, ['RB']), 31);
  // single-week windows agree with weeklyLineup
  assert.equal(rosValue(byeRoster, 2, 2, byeSlots, ['RB']), 13);
  // empty window is 0
  assert.equal(rosValue(byeRoster, 3, 2, byeSlots, ['RB']), 0);
});

// ---------------------------------------------------------------------------
// startSit
// ---------------------------------------------------------------------------

const keyOf = (p) => p.k;

test('startSit: same-slot swap, gain and totals hand-computed', () => {
  const roster = [
    { k: 'a', pos: 'RB', weekly: [20] },
    { k: 'b', pos: 'RB', weekly: [5] },
    { k: 'w', pos: 'WR', weekly: [9] },
  ];
  const r = startSit(roster, ['b', 'w'], 1, { RB: 1, WR: 1 }, [], keyOf);
  assert.equal(r.optimalTotal, 29); // a(20) + w(9)
  assert.equal(r.currentTotal, 14); // b(5) + w(9)
  assert.equal(r.delta, 15);
  assert.equal(r.swaps.length, 1);
  assert.equal(r.swaps[0].out.k, 'b');
  assert.equal(r.swaps[0].in.k, 'a');
  assert.equal(r.swaps[0].gain, 15);
  assert.equal(r.swaps[0].slot, 'RB');
});

test('startSit: two swaps pair same-slot, never crossed', () => {
  const roster = [
    { k: 'rbGood', pos: 'RB', weekly: [20] },
    { k: 'rbBad', pos: 'RB', weekly: [4] },
    { k: 'wrGood', pos: 'WR', weekly: [15] },
    { k: 'wrBad', pos: 'WR', weekly: [3] },
  ];
  const r = startSit(roster, ['rbBad', 'wrBad'], 1, { RB: 1, WR: 1 }, [], keyOf);
  assert.equal(r.swaps.length, 2);
  const bySlot = Object.fromEntries(r.swaps.map((s) => [s.slot, s]));
  assert.equal(bySlot.RB.out.k, 'rbBad');
  assert.equal(bySlot.RB.in.k, 'rbGood');
  assert.equal(bySlot.WR.out.k, 'wrBad');
  assert.equal(bySlot.WR.in.k, 'wrGood');
});

test('startSit: cross-flex swap — RB in flex replaced by a better WR', () => {
  const roster = [
    { k: 'rb1', pos: 'RB', weekly: [12] },
    { k: 'rb2', pos: 'RB', weekly: [9] },
    { k: 'wr1', pos: 'WR', weekly: [11] },
    { k: 'wr2', pos: 'WR', weekly: [10] },
  ];
  const slots = { RB: 1, WR: 1, FLEX: 1 };
  const r = startSit(roster, ['rb1', 'wr1', 'rb2'], 1, slots, ['RB', 'WR'], keyOf);
  // optimal: rb1 (RB) + wr1 (WR) + wr2 (FLEX) = 33; current 32
  assert.equal(r.optimalTotal, 33);
  assert.equal(r.currentTotal, 32);
  assert.equal(r.delta, 1);
  assert.equal(r.swaps.length, 1);
  assert.equal(r.swaps[0].out.k, 'rb2'); // flex spill on both sides
  assert.equal(r.swaps[0].in.k, 'wr2');
  assert.equal(r.swaps[0].slot, 'FLEX');
  assert.equal(r.swaps[0].gain, 1);
});

test('startSit: unresolvable starter keys (empty slots) → out: null swap', () => {
  const roster = [
    { k: 'a', pos: 'RB', weekly: [20] },
    { k: 'w', pos: 'WR', weekly: [9] },
  ];
  // Sleeper pads empty slots with "0" — the RB slot is empty.
  const r = startSit(roster, ['0', 'w'], 1, { RB: 1, WR: 1 }, [], keyOf);
  assert.equal(r.currentTotal, 9);
  assert.equal(r.optimalTotal, 29);
  assert.equal(r.swaps.length, 1);
  assert.equal(r.swaps[0].out, null);
  assert.equal(r.swaps[0].in.k, 'a');
  assert.equal(r.swaps[0].gain, 20);
});

test('startSit: already optimal → no swaps, delta 0', () => {
  const roster = [
    { k: 'a', pos: 'RB', weekly: [20] },
    { k: 'b', pos: 'RB', weekly: [5] },
  ];
  const r = startSit(roster, ['a'], 1, { RB: 1 }, [], keyOf);
  assert.equal(r.delta, 0);
  assert.deepEqual(r.swaps, []);
});

// ---------------------------------------------------------------------------
// sigmaWeek / weekBand
// ---------------------------------------------------------------------------

test('sigmaWeek: σ_proj / √17', () => {
  approx(sigmaWeek(Math.sqrt(17)), 1);
  approx(sigmaWeek(66.2), 66.2 / Math.sqrt(17));
});

test('weekBand: ±z·σ_week, default z = 1.2816', () => {
  const b = weekBand(10, Math.sqrt(17)); // σ_week exactly 1
  approx(b.floor, 10 - 1.2816);
  approx(b.ceiling, 10 + 1.2816);
  const c = weekBand(10, Math.sqrt(17), 2);
  approx(c.floor, 8);
  approx(c.ceiling, 12);
});

test('weekBand: floor clamped ≥ 0', () => {
  const b = weekBand(0.5, 10 * Math.sqrt(17)); // σ_week 10 → raw floor −12.316
  assert.equal(b.floor, 0);
  approx(b.ceiling, 0.5 + 12.816);
});
