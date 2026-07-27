// intent.test.ts — likely-pick prediction: shape/determinism, taken players
// excluded, and a strong inferred archetype actually tilting the mass.
// Run: node --test "src/state/*.test.ts"   (Node strip-types — erasable TS only)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _resetIntentCache, inferSeats, likelyPicks } from './intent.ts';
import type { Board, LeagueConfig } from './store.ts';
import { defineStrategy } from '../../engine/strategy.js';

// Synthetic board in ADP order — the mock.test.ts fixture pattern.
function synthBoard(): Board {
  const skill: string[] = [];
  for (let i = 0; i < 35; i++) skill.push('RB', 'WR', 'RB', 'WR', 'QB', 'TE');
  const posSeq = [...skill, ...Array(15).fill('K'), ...Array(15).fill('DST')];
  const posRank: Record<string, number> = {};
  const players = posSeq.map((pos, idx) => {
    posRank[pos] = (posRank[pos] ?? 0) + 1;
    return {
      idx,
      id: String(idx),
      name: `P${idx}`,
      pos,
      posRank: posRank[pos],
      team: 'DAL',
      bye: 5,
      eff: 400 - idx,
      proj: { halfPpr: 400 - idx },
      adp: { mu: idx + 1, sigmaFinal: 3 + idx * 0.05 },
    };
  });
  return { buildHash: 'testtest', players };
}

const LEAGUE: LeagueConfig = {
  teams: 12,
  slot: 8,
  rounds: 16,
  snake: true,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
  flexEligible: ['RB', 'WR', 'TE'],
};

const NEUTRAL_OPP = {
  seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, adpDiscipline: 0.5 })),
};

// Seat 3's picks at n=3 (R1), 22 (R2), 27 (R3) — all WRs (idx 1, 3, 7 are WR
// in the synth pattern); its next pick is n=46 (R4).
const WR_ENTRIES = [
  { n: 3, idx: 1 },
  { n: 22, idx: 3 },
  { n: 27, idx: 7 },
];

const WR_HEAVY = defineStrategy({
  name: 'wr_heavy',
  multipliers: { WR: [{ from: 1, to: 8, m: 2.0 }] },
  constraints: [{ pos: 'WR', type: 'min', by: 4, need: 3 }],
});

function wrMass(board: Board, picks: Array<{ idx: number; p: number }>): number {
  return picks.reduce((a, x) => a + (board.players[x.idx].pos === 'WR' ? x.p : 0), 0);
}

test('intent: likelyPicks returns sorted probabilities over untaken players only', () => {
  _resetIntentCache();
  const board = synthBoard();
  const out = likelyPicks(board, LEAGUE, NEUTRAL_OPP, null, WR_ENTRIES, 3, 4, 5);
  assert.equal(out.length, 5);
  const taken = new Set(WR_ENTRIES.map((e) => e.idx));
  let prev = Infinity;
  let sum = 0;
  for (const x of out) {
    assert.ok(!taken.has(x.idx), 'a taken player can never be likely');
    assert.ok(x.p > 0 && x.p <= 1);
    assert.ok(x.p <= prev, 'sorted by p desc');
    prev = x.p;
    sum += x.p;
  }
  assert.ok(sum <= 1 + 1e-9);
  // Deterministic: the same call (same session-stable refs) repeats exactly.
  assert.deepEqual(likelyPicks(board, LEAGUE, NEUTRAL_OPP, null, WR_ENTRIES, 3, 4, 5), out);
});

test('intent: a STRONG wr_heavy read tilts the seat toward WR vs no registry', () => {
  _resetIntentCache();
  const board = synthBoard();
  const registry = { wr_heavy: WR_HEAVY };
  // Sanity: the read really is strong under this registry.
  const reads = inferSeats(board, LEAGUE, registry, WR_ENTRIES);
  assert.equal(reads[2].bestFit, 'wr_heavy');
  assert.equal(reads[2].confidence, 'strong');
  // With no custom registry there is nothing to read → neutral seat.
  assert.equal(inferSeats(board, LEAGUE, null, WR_ENTRIES)[2].bestFit, null);

  const withArch = likelyPicks(board, LEAGUE, NEUTRAL_OPP, registry, WR_ENTRIES, 3, 4, 60);
  _resetIntentCache();
  const neutral = likelyPicks(board, LEAGUE, NEUTRAL_OPP, null, WR_ENTRIES, 3, 4, 60);
  // A ×2 WR multiplier roughly doubles the (renormalized) WR mass.
  assert.ok(
    wrMass(board, withArch) > 1.5 * wrMass(board, neutral),
    `WR mass must rise under the ×2 archetype (${wrMass(board, withArch)} vs ${wrMass(board, neutral)})`,
  );
});

test('intent: user-fixed seat archetype wins over the inferred one', () => {
  _resetIntentCache();
  const board = synthBoard();
  const registry = { wr_heavy: WR_HEAVY };
  const fixedOpp = {
    seats: NEUTRAL_OPP.seats.map((s) =>
      s.seat === 3 ? { ...s, archetype: 'zero_rb_mod' } : s,
    ),
  };
  // Seat 3 reads wr_heavy strong, but the user pinned zero_rb_mod: in R2 (max
  // RB through R3 binding after 0 RBs... constraint masks RB only once the
  // limit is hit — limit 0 means RB is forbidden outright through R3).
  const out = likelyPicks(board, LEAGUE, fixedOpp, registry, WR_ENTRIES, 3, 2, 200);
  const rbMass = out.reduce((a, x) => a + (board.players[x.idx].pos === 'RB' ? x.p : 0), 0);
  assert.equal(rbMass, 0, 'pinned zero_rb_mod forbids RB inside its window');
});
