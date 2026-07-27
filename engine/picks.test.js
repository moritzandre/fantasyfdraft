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
  // followed by a 9-gap (short); even-round by a 15-gap (long).
  assert.equal(kappaForRound(1, LEAGUE), 1.0);
  assert.equal(kappaForRound(2, LEAGUE), 1.3);
  assert.equal(kappaForRound(3, LEAGUE), 1.0);
  assert.equal(kappaForRound(4, LEAGUE), 1.3);
});

test('κ_r generalizes to every slot: turn, front, mid', () => {
  // Slot 1: R1 pick 1 → R2 pick 24 is a 23-gap (long); R2 24 → R3 25 is 1 (short).
  const slot1 = { teams: 12, slot: 1, rounds: 16, kappaLongGap: 1.3 };
  assert.equal(kappaForRound(1, slot1), 1.3);
  assert.equal(kappaForRound(2, slot1), 1.0);
  // Slot 12 (the other turn): 12 → 13 is 1 (short); 13 → 36 is 23 (long).
  const slot12 = { teams: 12, slot: 12, rounds: 16, kappaLongGap: 1.3 };
  assert.equal(kappaForRound(1, slot12), 1.0);
  assert.equal(kappaForRound(2, slot12), 1.3);
  // Slot 6 (mid): gaps 13/11 — 13 > 12 is the (mildly) long side.
  const slot6 = { teams: 12, slot: 6, rounds: 16, kappaLongGap: 1.3 };
  assert.equal(kappaForRound(1, slot6), 1.3); // 6 → 19: gap 13
  assert.equal(kappaForRound(2, slot6), 1.0); // 19 → 30: gap 11
  // Last round: no next pick, κ is moot.
  assert.equal(kappaForRound(16, LEAGUE), 1.0);
  // Linear draft: every gap is exactly N — no asymmetry anywhere.
  assert.equal(kappaForRound(2, { ...LEAGUE, snake: false }), 1.0);
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
