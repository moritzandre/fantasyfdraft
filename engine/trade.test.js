import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrade } from './trade.js';

const SLOTS = { RB: 2, WR: 1, FLEX: 1 };
const FLEX = ['RB', 'WR'];
const CTX = { fromWeek: 1, endWeek: 4, playoffWeeks: [3, 4], slots: SLOTS, flexEligible: FLEX };

function rb(name, weekly, extra = {}) {
  return { name, pos: 'RB', weekly, ...extra };
}
function wr(name, weekly, extra = {}) {
  return { name, pos: 'WR', weekly, ...extra };
}

function makeRosterA() {
  return [
    rb('a-rb1', [10, 10, 10, 10], { fc: { value: 30 } }),
    rb('a-rb2', [8, 8, 8, 8], { fc: { value: 20 } }),
    rb('a-rb3', [4, 4, 4, 4], { fc: { value: 5 } }),
    wr('a-wr1', [9, 9, 9, 9], { fc: { value: 25 } }),
    wr('a-wr2', [6, 6, 6, 6], { fc: { value: 10 } }),
  ];
}
function makeRosterB() {
  return [
    rb('b-rb1', [12, 12, 12, 12], { fc: { value: 40 } }),
    rb('b-rb2', [7, 7, 7, 7], { fc: { value: 15 } }),
    wr('b-wr1', [11, 11, 11, 11], { fc: { value: 35 } }),
    wr('b-wr2', [5, 5, 5, 5], { fc: { value: 8 } }),
  ];
}

test('empty trade: every metric zero, roster value unchanged', () => {
  const A = makeRosterA();
  const B = makeRosterB();
  const { a, b } = evaluateTrade({ roster: A, sends: [] }, { roster: B, sends: [] }, CTX);
  for (const side of [a, b]) {
    assert.equal(side.rosDelta, 0);
    assert.equal(side.rosBefore, side.rosAfter);
    assert.equal(side.playoffDelta, 0);
    assert.equal(side.weekDelta, 0);
    assert.deepEqual(side.byeExposure, []);
    assert.equal(side.marketDelta, 0);
    for (const v of Object.values(side.depthDelta)) assert.equal(v, 0);
  }
});

test('hand-computed 1-for-1: ros/playoff/week deltas', () => {
  // 1 RB slot, no flex, 2 weeks, playoffs = week 2 only.
  const ctx = { fromWeek: 1, endWeek: 2, playoffWeeks: [2], slots: { RB: 1 }, flexEligible: [] };
  const rb1 = rb('rb1', [10, 10]);
  const rb2 = rb('rb2', [4, 4]);
  const rb3 = rb('rb3', [8, 8]);
  const { a, b } = evaluateTrade(
    { roster: [rb1, rb2], sends: [rb1] },
    { roster: [rb3], sends: [rb3] },
    ctx,
  );
  // A before: 10+10 = 20; after [rb2, rb3]: 8+8 = 16.
  assert.equal(a.rosBefore, 20);
  assert.equal(a.rosAfter, 16);
  assert.equal(a.rosDelta, -4);
  assert.equal(a.playoffDelta, -2); // week 2 only
  assert.equal(a.weekDelta, -2); // fromWeek only
  // B before: 8+8 = 16; after [rb1]: 20.
  assert.equal(b.rosDelta, 4);
  assert.equal(b.playoffDelta, 2);
  assert.equal(b.weekDelta, 2);
});

test('symmetry: evaluateTrade(A,B).a mirrors evaluateTrade(B,A).b', () => {
  const A = makeRosterA();
  const B = makeRosterB();
  const sideA = { roster: A, sends: [A[0], A[4]] }; // a-rb1 + a-wr2
  const sideB = { roster: B, sends: [B[2]] }; // b-wr1
  const fwd = evaluateTrade(sideA, sideB, CTX);
  const rev = evaluateTrade(sideB, sideA, CTX);
  assert.deepEqual(fwd.a, rev.b);
  assert.deepEqual(fwd.b, rev.a);
});

test('2-for-1: roster-size change visible in depthDelta', () => {
  const A = makeRosterA();
  const B = makeRosterB();
  const { a, b } = evaluateTrade(
    { roster: A, sends: [A[1], A[2]] }, // sends 2 RBs
    { roster: B, sends: [B[0]] }, // receives 1 RB
    CTX,
  );
  assert.equal(a.depthDelta.RB, -1);
  assert.equal(b.depthDelta.RB, 1);
  assert.equal(a.depthDelta.WR ?? 0, 0);
});

test('bye collision: acquiring a starter sharing my starters\' bye fires byeExposure', () => {
  const ctx = { fromWeek: 1, endWeek: 4, playoffWeeks: [], slots: { RB: 2 }, flexEligible: [] };
  const rb1 = rb('rb1', [10, 0, 10, 10], { bye: 2 });
  const rb2 = rb('rb2', [9, 9, 0, 9], { bye: 3 });
  const rb3 = rb('rb3', [2, 2, 2, 2], { bye: 3 }); // bench body
  const rbx = rb('rbx', [12, 0, 12, 12], { bye: 2 }); // incoming, same bye as rb1
  const rby = rb('rby', [1, 1, 1, 1], { bye: 4 });
  const { a } = evaluateTrade(
    { roster: [rb1, rb2, rb3], sends: [rb2] },
    { roster: [rbx, rby], sends: [rbx] },
    ctx,
  );
  // before starters {rb1 bye2, rb2 bye3}; after starters {rbx bye2, rb1 bye2}
  // → week 2 collisions 1 → 2 (fires); week 3 collisions 1 → 0 (does not).
  assert.deepEqual(a.byeExposure, [2]);
});

test('marketDelta: summed fc values; null when any involved fc is missing', () => {
  const A = makeRosterA();
  const B = makeRosterB();
  const ok = evaluateTrade(
    { roster: A, sends: [A[1]] }, // fc 20 out
    { roster: B, sends: [B[0]] }, // fc 40 in
    CTX,
  );
  assert.equal(ok.a.marketDelta, 20);
  assert.equal(ok.b.marketDelta, -20);

  const noFc = rb('nofc', [8, 8, 8, 8], { fc: null });
  const bad = evaluateTrade(
    { roster: [...A, noFc], sends: [noFc] },
    { roster: B, sends: [B[0]] },
    CTX,
  );
  assert.equal(bad.a.marketDelta, null);
  assert.equal(bad.b.marketDelta, null);
  // players NOT in the trade never affect null-ness
  const cleanSide = evaluateTrade(
    { roster: [...A, noFc], sends: [A[1]] },
    { roster: B, sends: [B[0]] },
    CTX,
  );
  assert.equal(cleanSide.a.marketDelta, 20);
});
