import { test } from 'node:test';
import assert from 'node:assert/strict';
import { myPicks, gapsAfter, kappaForRound, slotForPick, nextMyPick } from './picks.js';

const LEAGUE = { teams: 12, slot: 8, rounds: 16, snake: true, kappaLongGap: 1.3 };

test('12-team slot-8 pick ladder over 16 rounds', () => {
  assert.deepEqual(
    myPicks(LEAGUE),
    [8, 17, 32, 41, 56, 65, 80, 89, 104, 113, 128, 137, 152, 161, 176, 185],
  );
});

test('gaps alternate 9,15,… (odd-round pick → short gap)', () => {
  assert.deepEqual(
    gapsAfter(myPicks(LEAGUE)),
    [9, 15, 9, 15, 9, 15, 9, 15, 9, 15, 9, 15, 9, 15, 9],
  );
});

test('10-team slot-8 ladder — the mini-turn league', () => {
  const picks = myPicks({ teams: 10, slot: 8, rounds: 15, snake: true });
  assert.deepEqual(
    picks,
    [8, 13, 28, 33, 48, 53, 68, 73, 88, 93, 108, 113, 128, 133, 148],
  );
});

test('κ_r: even rounds carry the long-gap weight at slot 8 — NOT odd', () => {
  // The single most consequential sign in the engine. Odd-round picks are
  // followed by only 8 opponent picks (short); even-round by 14 (long).
  assert.equal(kappaForRound(1, LEAGUE), 1.0);
  assert.equal(kappaForRound(2, LEAGUE), 1.3);
  assert.equal(kappaForRound(3, LEAGUE), 1.0);
  assert.equal(kappaForRound(4, LEAGUE), 1.3);
});

test('slotForPick round-trips the full 192-pick draft', () => {
  const mine = new Set(myPicks(LEAGUE));
  for (let n = 1; n <= 192; n++) {
    assert.equal(slotForPick(n, 12) === 8, mine.has(n), `pick ${n}`);
  }
});

test('nextMyPick from mid-draft', () => {
  assert.equal(nextMyPick(9, LEAGUE), 17);
  assert.equal(nextMyPick(17, LEAGUE), 17); // on the clock counts
  assert.equal(nextMyPick(186, LEAGUE), null);
});
