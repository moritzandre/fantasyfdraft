// calibrate.test.mjs — synthetic self-consistency tests for the calibration
// core (tools/lib/calibrate_core.mjs). Picked up by
// `node --test "tools/**/*.test.mjs"`. No fs, no network: everything runs on
// a synthetic board with mocks generated FROM the opponent model itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapMock, evaluateParams, gridSearch, generateSyntheticMocks,
  simulateAvailability, pAvailCalibration, binOf, neutralOpponents,
  ROUND_BANDS, GRID_DEFAULT,
} from './lib/calibrate_core.mjs';

// ── Synthetic board: same construction as engine/opponent.test.js ──────────
// (dense idx in ADP order, skill early, K/DST late).
function synthBoard() {
  const skill = [];
  for (let i = 0; i < 35; i++) skill.push('RB', 'WR', 'RB', 'WR', 'QB', 'TE');
  const posSeq = [...skill, ...Array(15).fill('K'), ...Array(15).fill('DST')];
  const teams = ['DAL', 'PHI', 'KC', 'DET', 'SF', 'BUF', 'MIA', 'GB'];
  const players = posSeq.map((pos, idx) => ({
    idx,
    id: String(idx),
    name: `P${idx}`,
    short: `P${idx}`,
    pos,
    team: teams[idx % teams.length],
    bye: 5 + (idx % 10),
    eff: 400 - idx,
    sigmaProj: 55,
    proj: { halfPpr: 400 - idx, rec: 60 },
    adp: { mu: idx + 1, sigmaFinal: 3 + idx * 0.05 },
  }));
  return { buildHash: 'testtest', players };
}

const LEAGUE = {
  teams: 12, slot: 8, rounds: 16, snake: true,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
  flexEligible: ['RB', 'WR', 'TE'],
};

const TRUE_PARAMS = { tauScale: 0.85, needAwareShare: 0.3, window: 40 };

// Shared fixture: 12 mocks sampled from the model at TRUE_PARAMS.
const board = synthBoard();
const syntheticMocks = generateSyntheticMocks(board, LEAGUE, {
  count: 12, ...TRUE_PARAMS, seed: 20260824,
});

test('calibrate: synthetic-recovery — CV grid ranks the true (tauScale, share) cell at or adjacent to the top', () => {
  // Window pinned at the truth (40) for speed; the claim under test is the
  // (tauScale, needAwareShare) axes.
  const tauScales = [...GRID_DEFAULT.tauScales];
  const shares = [...GRID_DEFAULT.shares];
  const res = gridSearch(board, LEAGUE, syntheticMocks, {
    tauScales, shares, windows: [TRUE_PARAMS.window],
  });
  assert.ok(res.best, 'grid produced a best cell');
  const iTau = tauScales.indexOf(res.best.tauScale);
  const iShare = shares.indexOf(res.best.needAwareShare);
  const iTauTrue = tauScales.indexOf(TRUE_PARAMS.tauScale);
  const iShareTrue = shares.indexOf(TRUE_PARAMS.needAwareShare);
  assert.ok(iTau >= 0 && iShare >= 0);
  assert.ok(Math.abs(iTau - iTauTrue) <= 1,
    `winning tauScale ${res.best.tauScale} not adjacent to true ${TRUE_PARAMS.tauScale}`);
  assert.ok(Math.abs(iShare - iShareTrue) <= 1,
    `winning share ${res.best.needAwareShare} not adjacent to true ${TRUE_PARAMS.needAwareShare}`);
  // The grid is ranked: cvLL must be non-increasing.
  for (let i = 1; i < res.grid.length; i++) {
    assert.ok(res.grid[i - 1].cvLL >= res.grid[i].cvLL, 'grid not sorted by cvLL desc');
  }
});

test('calibrate: off-board pick lands in coverage.offBoard, never crashes', () => {
  const slim = { 3: 3, 7: 7 }; // sparse map: only two known sleeper ids
  const raw = {
    draft: { draft_id: 'fabricated', settings: { teams: 12, rounds: 16 } },
    picks: [
      { pick_no: 1, player_id: 'zzz-unknown-9999', metadata: {} }, // off-board
      { pick_no: 2, player_id: '3' },                              // on-board
      { pick_no: 3, player_id: '999999' },                         // off-board (not in map)
      { pick_no: 4, player_id: '7' },                              // on-board
      { pick_no: null, player_id: '5' },                           // malformed → dropped
    ],
  };
  const mock = mapMock(raw, slim, { defaultTeams: 12, defaultRounds: 16, nPlayers: board.players.length });
  assert.equal(mock.picks.length, 4);
  assert.equal(mock.dropped, 1);
  assert.equal(mock.picks[0].idx, null);
  assert.equal(mock.picks[1].idx, 3);
  const res = evaluateParams(board, LEAGUE, [mock], TRUE_PARAMS);
  assert.equal(res.coverage.offBoard, 2);
  assert.equal(res.coverage.totalPicks, 4);
  assert.equal(res.coverage.scored + res.coverage.beyondWindow, 2); // the two on-board picks
  // Out-of-range map value is off-board too (defensive nPlayers guard).
  const bad = mapMock(
    { draft: { settings: { teams: 12, rounds: 16 } }, picks: [{ pick_no: 1, player_id: 'x' }] },
    { x: 99999 }, { nPlayers: board.players.length },
  );
  assert.equal(bad.picks[0].idx, null);
});

test('calibrate: true model out-scores a badly mis-specified one (tauScale 3.0) and the uniform baseline', () => {
  const truth = evaluateParams(board, LEAGUE, syntheticMocks, TRUE_PARAMS);
  const bad = evaluateParams(board, LEAGUE, syntheticMocks, { ...TRUE_PARAMS, tauScale: 3.0 });
  assert.ok(truth.meanLL != null && bad.meanLL != null);
  assert.ok(truth.meanLL > bad.meanLL,
    `true LL ${truth.meanLL.toFixed(4)} should beat tauScale=3.0 LL ${bad.meanLL.toFixed(4)}`);
  assert.ok(truth.meanLL > truth.uniformMeanLL,
    `true LL ${truth.meanLL.toFixed(4)} should beat uniform ${truth.uniformMeanLL.toFixed(4)}`);
  // Band bookkeeping: band ns sum to the scored total.
  const bandN = truth.byBand.reduce((a, b) => a + b.n, 0);
  assert.equal(bandN, truth.coverage.scored);
  assert.equal(truth.byBand.length, ROUND_BANDS.length);
});

test('calibrate: bin bookkeeping — 5 bins partition [0,1], counts add up', () => {
  // binOf edges: [0,.2) [.2,.4) [.4,.6) [.6,.8) [.8,1] — 1.0 closed.
  assert.equal(binOf(0), 0);
  assert.equal(binOf(0.1999), 0);
  assert.equal(binOf(0.2), 1);
  assert.equal(binOf(0.5999), 2);
  assert.equal(binOf(0.7999), 3);
  assert.equal(binOf(0.8), 4);
  assert.equal(binOf(0.9999), 4);
  assert.equal(binOf(1), 4);

  const availRes = simulateAvailability(board, LEAGUE, neutralOpponents(LEAGUE.teams), {
    sims: 200, seed: 7,
  });
  const twoMocks = syntheticMocks.slice(0, 2);
  const rep = pAvailCalibration(availRes, twoMocks, { nBins: 5, resamples: 50, seed: 11 });
  // Counts add up: every (player, pick) pair of both mocks in exactly one bin.
  const expectedPairs = 2 * board.players.length * (LEAGUE.teams * LEAGUE.rounds);
  const binN = rep.bins.reduce((a, b) => a + b.n, 0);
  assert.equal(rep.nPairs, expectedPairs);
  assert.equal(binN, expectedPairs);
  // Bins partition [0,1]: contiguous edges, first 0, last 1.
  assert.equal(rep.bins.length, 5);
  assert.equal(rep.bins[0].lo, 0);
  assert.equal(rep.bins[4].hi, 1);
  for (let b = 1; b < 5; b++) assert.equal(rep.bins[b].lo, rep.bins[b - 1].hi);
  for (const b of rep.bins) {
    if (b.n === 0) continue;
    assert.ok(b.predicted >= b.lo && b.predicted <= b.hi,
      `bin [${b.lo},${b.hi}] mean predicted ${b.predicted} outside its own bounds`);
    assert.ok(b.observed >= 0 && b.observed <= 1);
    if (b.ci95) assert.ok(b.ci95[0] <= b.ci95[1]);
  }
  assert.ok(rep.brier >= 0 && rep.brier <= 1);
});
