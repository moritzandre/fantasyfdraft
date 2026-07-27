// seasonMerge.test.ts — pure board × season.json merge under node --test.
// Run: node --test "src/state/*.test.ts"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSeason } from './seasonMerge.ts';

// ---------------------------------------------------------------------------
// Fixtures — a 3-player board and a matching season overlay
// ---------------------------------------------------------------------------

const W = (n: number) => Array.from({ length: 18 }, () => n);

const board = {
  buildHash: 'abc1234',
  players: [
    {
      idx: 0, name: 'Alpha Runner', short: 'A. Runner', pos: 'RB', team: 'DET',
      bye: 6, injuryStatus: 'ACTIVE', weeklyHalfPpr: [...W(10).slice(0, 5), 0, ...W(10).slice(6)],
    },
    {
      idx: 1, name: 'Beta Wideout', short: 'B. Wideout', pos: 'WR', team: 'KC',
      bye: 9, injuryStatus: 'QUESTIONABLE', weeklyHalfPpr: W(8),
    },
    {
      idx: 2, name: 'Gamma End', short: 'G. End', pos: 'TE', team: 'SF',
      bye: 11, injuryStatus: 'ACTIVE', weeklyHalfPpr: W(6),
    },
  ],
  slimSleeperMap: { '100': 0, '101': 1 }, // idx 2 has no sleeper id
};

const season = {
  schema: 1,
  boardHash: 'abc1234',
  week: 3,
  players: [
    {
      idx: 0, weekly: W(12), ros: 180, injury: 'OUT',
      fc: { value: 9000, rank: 3 }, trend: { add: 500, drop: 2 },
    },
    // idx 1 has NO overlay row — board fallback per player
  ],
  extras: [
    {
      sleeper: '555', name: 'Waiver Hero', short: 'W. Hero', pos: 'RB', team: 'BUF',
      bye: 7, weekly: W(5), ros: 75, injury: null, fc: null, trend: null,
    },
  ],
};

// ---------------------------------------------------------------------------

test('matched hash: overlay applied, extras present, degraded false', () => {
  const m = mergeSeason(board, season);
  assert.equal(m.degraded, false);
  assert.equal(m.all.length, 4); // 3 board + 1 extra

  const p0 = m.resolve('100')!;
  assert.equal(p0.key, 'b0');
  assert.equal(p0.idx, 0);
  assert.equal(p0.sleeper, '100');
  assert.deepEqual(p0.weekly, W(12)); // overlay wins
  assert.equal(p0.ros, 180);
  assert.equal(p0.injury, 'OUT');
  assert.deepEqual(p0.fc, { value: 9000, rank: 3 });
  assert.deepEqual(p0.trend, { add: 500, drop: 2 });

  const hero = m.resolve('555')!;
  assert.equal(hero.key, 's555');
  assert.equal(hero.idx, null);
  assert.equal(hero.name, 'Waiver Hero');
  assert.equal(hero.ros, 75);
  assert.equal(hero.fc, null);
});

test('board player without an overlay row falls back to board data', () => {
  const m = mergeSeason(board, season);
  const p1 = m.resolve('101')!;
  assert.deepEqual(p1.weekly, W(8));
  assert.equal(p1.ros, 8 * 18);
  assert.equal(p1.injury, 'QUESTIONABLE'); // from board injuryStatus
  assert.equal(p1.fc, null);
});

test('resolve: unknown ids null; board player without sleeper id still in all', () => {
  const m = mergeSeason(board, season);
  assert.equal(m.resolve('999'), null);
  const gamma = m.all.find((p) => p.key === 'b2')!;
  assert.equal(gamma.sleeper, null);
  assert.equal(gamma.injury, null); // ACTIVE → null
});

test('boardHash mismatch ⇒ degraded board-only fallback, no extras', () => {
  const m = mergeSeason(board, { ...season, boardHash: 'zzz9999' });
  assert.equal(m.degraded, true);
  assert.equal(m.all.length, 3); // extras dropped
  const p0 = m.resolve('100')!;
  assert.equal(p0.weekly[5], 0); // board weeklyHalfPpr, bye week 6 = 0
  assert.equal(p0.ros, 10 * 17); // Σ weekly (17 non-bye weeks × 10)
  assert.equal(p0.injury, null); // ACTIVE
  assert.equal(p0.fc, null);
  assert.equal(m.resolve('555'), null);
});

test('season null ⇒ degraded board-only fallback', () => {
  const m = mergeSeason(board, null);
  assert.equal(m.degraded, true);
  assert.equal(m.all.length, 3);
  assert.equal(m.resolve('101')!.ros, 8 * 18);
});
