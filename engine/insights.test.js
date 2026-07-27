import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INFER_LEAN_MARGIN,
  INFER_STRONG_MARGIN,
  inferSeatStrategies,
  leagueNeeds,
  waitWindowThreats,
} from './insights.js';
import { STRATEGIES, defineStrategy } from './strategy.js';

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

// ── inferSeatStrategies ─────────────────────────────────────────────────────
// Seat 3 of 12 picks at n=3 (R1), 22 (R2: 13..24 map slots 12..1), 27 (R3),
// 46 (R4: 37..48 map slots 12..1) — hand-checked snake math.

const INFER_PLAYERS = [
  { idx: 0, pos: 'WR' }, { idx: 1, pos: 'WR' }, { idx: 2, pos: 'WR' },
  { idx: 3, pos: 'RB' }, { idx: 4, pos: 'RB' }, { idx: 5, pos: 'RB' },
  { idx: 6, pos: 'TE' }, { idx: 7, pos: 'QB' },
];

const WR_HEAVY = defineStrategy({
  name: 'wr_heavy',
  multipliers: { WR: [{ from: 1, to: 4, m: 1.4 }] },
  constraints: [{ pos: 'WR', type: 'min', by: 4, need: 3 }],
});
const REGISTRY = { ...STRATEGIES, wr_heavy: WR_HEAVY };

test('inferSeatStrategies: three early WRs read wr_heavy STRONG', () => {
  const entries = [{ n: 3, idx: 0 }, { n: 22, idx: 1 }, { n: 27, idx: 2 }];
  const reads = inferSeatStrategies(entries, FULL, INFER_PLAYERS, REGISTRY);
  assert.equal(reads.length, 12);
  const t3 = reads[2];
  assert.equal(t3.slot, 3);
  assert.deepEqual(t3.counts, { WR: 3 });
  // score = 3·ln 1.4 + 0.15 (min 3 WR by R4 already met) ≈ 1.16 ≥ 0.9
  assert.equal(t3.bestFit, 'wr_heavy');
  assert.equal(t3.confidence, 'strong');
  assert.ok(3 * Math.log(1.4) + 0.15 >= INFER_STRONG_MARGIN, 'fixture margin sanity');
  // Every other seat has zero picks → no read.
  for (const r of reads) {
    if (r.slot === 3) continue;
    assert.equal(r.bestFit, null);
    assert.equal(r.confidence, null);
  }
});

test('inferSeatStrategies: a balanced log stays null against every archetype', () => {
  // RB(R1), WR(R2), TE(R3), RB(R4): wr_heavy earns only ln 1.4 ≈ 0.34 < lean
  // margin; robust_rb/anchor_rb/zero_rb_mod all VIOLATE a constraint.
  const entries = [
    { n: 3, idx: 3 }, { n: 22, idx: 0 }, { n: 27, idx: 6 }, { n: 46, idx: 4 },
  ];
  const t3 = inferSeatStrategies(entries, FULL, INFER_PLAYERS, REGISTRY)[2];
  assert.deepEqual(t3.counts, { RB: 2, WR: 1, TE: 1 });
  assert.equal(t3.bestFit, null);
  assert.equal(t3.confidence, null);
  assert.ok(Math.log(1.4) < INFER_LEAN_MARGIN, 'fixture margin sanity');
});

test('inferSeatStrategies: three early RBs read robust_rb STRONG, anchor_rb penalized', () => {
  // 3·ln 1.25 + 0.15 (≥2 RB by R3 met) + 0.15 (≥3 by R5 met) ≈ 0.97 ≥ 0.9;
  // anchor_rb takes the R2/R3 dampeners AND violates max 1 RB through R4.
  const entries = [{ n: 3, idx: 3 }, { n: 22, idx: 4 }, { n: 27, idx: 5 }];
  const t3 = inferSeatStrategies(entries, FULL, INFER_PLAYERS, REGISTRY)[2];
  assert.equal(t3.bestFit, 'robust_rb');
  assert.equal(t3.confidence, 'strong');
});

test('inferSeatStrategies: fewer than 3 picks ⇒ no read, even when extreme', () => {
  const entries = [{ n: 3, idx: 0 }, { n: 22, idx: 1 }];
  const t3 = inferSeatStrategies(entries, FULL, INFER_PLAYERS, REGISTRY)[2];
  assert.deepEqual(t3.counts, { WR: 2 });
  assert.equal(t3.bestFit, null);
  assert.equal(t3.confidence, null);
});

test('inferSeatStrategies: a violated max drops the archetype below its multiplier fit', () => {
  // zero_rb_mod can never be the read once the seat drafts an early RB, and
  // holes (idx null) advance the deadline clock without counting as picks.
  const entries = [
    { n: 3, idx: 3 }, { n: 22, idx: 0 }, { n: 27, idx: 1 }, { n: 40, idx: null },
  ];
  const t3 = inferSeatStrategies(entries, FULL, INFER_PLAYERS, REGISTRY)[2];
  assert.notEqual(t3.bestFit, 'zero_rb_mod');
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
