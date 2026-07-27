import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateShard, mergeShards, summarize, histQuantile,
  shardToJSON, shardFromJSON,
} from './evaluate_core.mjs';
import { defineStrategy } from '../../engine/strategy.js';

// ── Synthetic board (engine/opponent.test.js pattern) ──────────────────────
// Dense idx in ADP order, mu ascending, K/DST late. Additions for the
// harness: weeklyHalfPpr = eff/17 for 17 weeks + one zero bye week, RB rec
// ≥ 45 (the engine's early-RB hard rule would starve a tiny board), and
// pre-assigned tiers (skips per-call tierize — irrelevant to pick choice).
const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

function synthBoard() {
  const skill = [];
  for (let i = 0; i < 35; i++) skill.push('RB', 'WR', 'RB', 'WR', 'QB', 'TE');
  const posSeq = [...skill, ...Array(15).fill('K'), ...Array(15).fill('DST')];
  const teams = ['DAL', 'PHI', 'KC', 'DET', 'SF', 'BUF', 'MIA', 'GB'];
  const players = posSeq.map((pos, idx) => {
    const eff = 400 - idx;
    const bye = 5 + (idx % 10);
    return {
      idx,
      id: String(idx),
      name: `P${idx}`,
      short: `P${idx}`,
      pos,
      team: teams[idx % teams.length],
      bye,
      eff,
      sigmaProj: 55,
      proj: { halfPpr: eff, rec: 60 },
      adp: { mu: idx + 1, sigmaFinal: 3 + idx * 0.05 },
      weeklyHalfPpr: Array.from({ length: 18 }, (_, w) => (w === bye - 1 ? 0 : eff / 17)),
    };
  });
  const byPos = {};
  for (const p of players) (byPos[p.pos] ??= []).push(p);
  for (const list of Object.values(byPos)) {
    list.forEach((p, i) => { p.tier = 1 + Math.floor(i / 6); });
  }
  return { buildHash: 'testtest', players };
}

const LEAGUE = {
  teams: 12, slot: 8, rounds: 16, snake: true,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
  flexEligible: ['RB', 'WR', 'TE'],
};

const NEUTRAL_OPP = {
  seats: Array.from({ length: 12 }, (_, i) => ({
    seat: i + 1, name: '', adpDiscipline: 0.5, positionBias: {}, homerTeams: [], reachRounds: [],
  })),
};

const baseCfg = (over = {}) => ({
  board: synthBoard(),
  league: LEAGUE,
  opponents: NEUTRAL_OPP,
  strategies: null,
  strategyNames: ['balanced', 'robust_rb'],
  slots: [8],
  simRange: [0, 4],
  baseSeed: 42,
  ...over,
});

test('evaluate: same args ⇒ deep-equal summaries (determinism)', () => {
  const s1 = summarize(evaluateShard(baseCfg()));
  const s2 = summarize(evaluateShard(baseCfg()));
  assert.deepEqual(s1, s2);
});

test('evaluate: merge(shard(0..6), shard(6..12)) ≡ shard(0..12)', () => {
  const cfg = (range) => baseCfg({ strategyNames: ['balanced'], simRange: range, baseSeed: 11 });
  const a = evaluateShard(cfg([0, 6]));
  const b = evaluateShard(cfg([6, 12]));
  const full = evaluateShard(cfg([0, 12]));
  assert.deepEqual(summarize(mergeShards([a, b])), summarize(full));
  // Serialization round-trip is lossless too (shard files ≡ live shards).
  assert.deepEqual(summarize(shardFromJSON(shardToJSON(full))), summarize(full));
  // Overlaps and gaps hard-fail.
  assert.throws(() => mergeShards([evaluateShard(cfg([0, 6])), evaluateShard(cfg([5, 12]))]),
    /overlap/);
  assert.throws(() => mergeShards([evaluateShard(cfg([0, 6])), evaluateShard(cfg([7, 12]))]),
    /gap/);
});

test('evaluate: strategy vs itself pairs to exactly zero (common random numbers)', () => {
  // balanced_twin has identity multipliers and no constraints — the same
  // policy as balanced under another name. Since draftSeed ignores the
  // strategy and forced picks consume no rng, the two cells must produce
  // bit-identical per-sim roster values ⇒ paired diff exactly 0.
  const twin = defineStrategy({ name: 'balanced_twin' });
  const shard = evaluateShard(baseCfg({
    strategies: { balanced_twin: twin },
    strategyNames: ['balanced', 'balanced_twin'],
    simRange: [0, 5],
    baseSeed: 7,
  }));
  const pb = summarize(shard).pairedVsBalanced[8].balanced_twin;
  assert.equal(pb.meanDiff, 0);
  assert.equal(pb.se, 0);
  assert.equal(pb.winRate, 0.5);
});

test('evaluate: final rosters are always legal (16 players, exactly 1 K + 1 DST)', () => {
  const board = synthBoard();
  const seen = [];
  evaluateShard(baseCfg({
    board,
    strategyNames: ['balanced'],
    slots: [1, 8], // turn seat + the real seat
    simRange: [0, 4],
    baseSeed: 3,
    onSimDone: ({ myIdxs }) => seen.push(myIdxs),
  }));
  assert.equal(seen.length, 2 * 4);
  for (const idxs of seen) {
    assert.equal(idxs.length, 16, 'one pick per round');
    assert.equal(new Set(idxs).size, 16, 'no duplicate players');
    const count = (pos) => idxs.filter((i) => board.players[i].pos === pos).length;
    assert.equal(count('K'), 1, 'exactly one K');
    assert.equal(count('DST'), 1, 'exactly one DST');
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      assert.ok(count(pos) >= LEAGUE.roster[pos], `${pos} starters coverable`);
    }
  }
});

test('evaluate: histogram quantiles match naive sort on a hand-made hist', () => {
  // Integer values binned with offset −0.5, width 1 ⇒ bin midpoint = value.
  const values = [1, 2, 2, 3, 3, 3, 4, 4, 7, 10];
  const offset = -0.5, width = 1;
  const hist = new Int32Array(12);
  for (const v of values) hist[Math.floor((v - offset) / width)]++;
  const sorted = values.slice().sort((a, b) => a - b);
  const naive = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  for (const q of [0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
    assert.equal(histQuantile(hist, values.length, q, offset, width), naive(q), `q=${q}`);
  }
});
