import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leagueNeeds, waitWindowThreats } from './insights.js';

// Tiny hand-checkable league: 3 teams, 4 rounds, snake.
// Pick order: R1 1,2,3 → R2 3,2,1 → R3 1,2,3 → R4 3,2,1.
const MINI = {
  teams: 3, slot: 2, rounds: 4, snake: true,
  roster: { QB: 1, RB: 1, FLEX: 1, BN: 1 },
  flexEligible: ['RB', 'WR'],
};

const MINI_PLAYERS = [
  { idx: 0, pos: 'RB' }, { idx: 1, pos: 'RB' }, { idx: 2, pos: 'WR' },
  { idx: 3, pos: 'QB' }, { idx: 4, pos: 'RB' }, { idx: 5, pos: 'WR' },
];

const FULL = {
  teams: 12, slot: 8, rounds: 16, snake: true,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
  flexEligible: ['RB', 'WR', 'TE'],
};

test('leagueNeeds: hand-computed 3-team fixture with a hole', () => {
  // n=1 (T1) RB0, n=2 (T2) RB1, n=3 hole, n=4 (R2 → T3) QB3.
  const entries = [
    { n: 1, idx: 0 }, { n: 2, idx: 1 }, { n: 3, idx: null }, { n: 4, idx: 3 },
  ];
  const { teams, demand, flexRemaining } = leagueNeeds(entries, MINI, MINI_PLAYERS, 5);

  const t1 = teams[0];
  assert.deepEqual(t1.counts, { RB: 1 });
  assert.deepEqual(t1.unfilled.dedicated, { QB: 1 });   // RB starter filled
  assert.equal(t1.unfilled.flex, 1);
  assert.equal(t1.unfilled.total, 2);
  assert.equal(t1.picksMade, 1);
  assert.equal(t1.nextPickAt, 6);                        // R2 order is 3,2,1

  const t3 = teams[2];
  assert.deepEqual(t3.counts, { QB: 1 });                // the hole gave T3 nothing at n=3
  assert.deepEqual(t3.unfilled.dedicated, { RB: 1 });
  assert.equal(t3.nextPickAt, 9);                        // R3 order 1,2,3 → T3 at pick 9

  assert.equal(demand.QB, 2);                            // T1 and T2 still need QB
  assert.equal(demand.RB, 1);                            // only T3
  assert.equal(flexRemaining, 3);
});

test('leagueNeeds: surplus flex-eligible starters absorb the flex', () => {
  // T1 drafts RB, RB (n=1, n=6): 1 starter + 1 surplus RB → flex absorbed.
  const entries = [{ n: 1, idx: 0 }, { n: 6, idx: 1 }];
  const { teams } = leagueNeeds(entries, MINI, MINI_PLAYERS, 7);
  const t1 = teams[0];
  assert.equal(t1.unfilled.flex, 0);
  assert.deepEqual(t1.unfilled.dedicated, { QB: 1 });
  assert.equal(t1.unfilled.total, 1);
});

test('leagueNeeds: default cursor is highest n + 1', () => {
  const entries = [{ n: 1, idx: 0 }, { n: 4, idx: 3 }];
  const { teams } = leagueNeeds(entries, MINI, MINI_PLAYERS);
  assert.equal(teams[0].nextPickAt, 6); // cursor 5 → T1 next picks at 6? no: R2 is 4,5,6 → T1 at 6
});

test('waitWindowThreats: snake turn window from my round-1 pick at slot 8', () => {
  // Empty board, cursor 8 (me on the clock). My next rung is 17; the window
  // is picks 9..16 → slots 9,10,11,12 then 12,11,10,9.
  const players = Array.from({ length: 400 }, (_, i) => ({ idx: i, pos: 'RB' }));
  const res = waitWindowThreats([], FULL, 8, players);
  assert.equal(res.myNextPick, 17);
  assert.deepEqual(res.window.map((w) => w.pick), [9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(res.window.map((w) => w.slot), [9, 10, 11, 12, 12, 11, 10, 9]);
  assert.deepEqual(res.window.map((w) => w.round), [1, 1, 1, 1, 2, 2, 2, 2]);
  // Everyone still needs everything: 4 unique teams, each picking twice.
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    assert.deepEqual(res.posPressure[pos].teamsNeeding, [9, 10, 11, 12]);
    assert.equal(res.posPressure[pos].picksInWindow, 8);
  }
  assert.deepEqual(res.flexOpenInWindow, [9, 10, 11, 12]);
});

test('waitWindowThreats: filled positions drop out of the pressure report', () => {
  // Slots 9 and 10 each already have 2 RB (their R1/R2 picks — n chosen so
  // slotForPick maps there): slot 9 picks at 9,16; slot 10 at 10,15.
  const players = [
    { idx: 0, pos: 'RB' }, { idx: 1, pos: 'RB' }, { idx: 2, pos: 'RB' }, { idx: 3, pos: 'RB' },
  ];
  const entries = [
    { n: 9, idx: 0 }, { n: 16, idx: 1 },   // slot 9: RB, RB
    { n: 10, idx: 2 }, { n: 15, idx: 3 },  // slot 10: RB, RB
  ];
  // Cursor 32 = my R3 pick (slot 8) → window 33..40 → slots 9..12,12..9? R3
  // is 25..36 (order 1..12), R4 is 37..48 (order 12..1). Picks 33-36 →
  // slots 9,10,11,12; picks 37-40 → slots 12,11,10,9.
  const res = waitWindowThreats(entries, FULL, 32, players);
  assert.equal(res.myNextPick, 41);
  assert.deepEqual(res.posPressure.RB.teamsNeeding, [11, 12]);
  assert.equal(res.posPressure.RB.picksInWindow, 4);
  // QB: all four window teams still need one.
  assert.deepEqual(res.posPressure.QB.teamsNeeding, [9, 10, 11, 12]);
});

test('waitWindowThreats: draft over / no next pick', () => {
  const players = [{ idx: 0, pos: 'RB' }];
  const over = waitWindowThreats([], FULL, 193, players);
  assert.equal(over.myNextPick, null);
  assert.deepEqual(over.window, []);
  // Cursor past my last pick (185): window runs to the end of the draft.
  const tail = waitWindowThreats([], FULL, 186, players);
  assert.equal(tail.myNextPick, null);
  assert.deepEqual(tail.window.map((w) => w.pick), [186, 187, 188, 189, 190, 191, 192]);
});
