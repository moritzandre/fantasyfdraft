// portable.test.ts — export/import envelope: lossless round-trip, hard
// rejections on wrong version/shape, buildHash mismatch as a WARNING only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.ts';
import type { Board, LeagueConfig } from './store.ts';
import { exportState, exportJson, importEnvelope } from './portable.ts';

function makeBoard(): Board {
  return {
    buildHash: 'abc1234',
    players: Array.from({ length: 220 }, (_, idx) => ({ idx, name: `P${idx}`, pos: 'WR' })),
  };
}

function makeLeague(over: Partial<LeagueConfig> = {}): LeagueConfig {
  return {
    teams: 12,
    slot: 8,
    rounds: 16,
    snake: true,
    roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
    flexEligible: ['RB', 'WR', 'TE'],
    ...over,
  };
}

function populated() {
  const st = createStore({ board: makeBoard(), league: makeLeague({ slot: 4 }), now: () => 77 });
  for (let i = 0; i < 25; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: i % 3 ? 'manual' : 'sleeper' });
  st.dispatch({ type: 'SET_UI', ui: { posFilter: 'RB', lastScreen: 'live' } });
  return st;
}

test('envelope shape: v/exportedAt/buildHash/state', () => {
  const env = exportState(populated().getState(), '2026-08-24T15:30:00.000Z');
  assert.equal(env.v, 1);
  assert.equal(env.exportedAt, '2026-08-24T15:30:00.000Z');
  assert.equal(env.buildHash, 'abc1234');
  assert.equal(env.state.schemaVersion, 1);
  assert.equal(env.state.picks.length, 25);
});

test('round-trip through exportJson string is lossless', () => {
  const st = populated();
  const res = importEnvelope(exportJson(st.getState()), 'abc1234');
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.buildHashMismatch, false);
  assert.deepEqual(res.warnings, []);
  const s = st.getState();
  assert.deepEqual(res.state!.picks, s.picks);
  assert.deepEqual(res.state!.league, s.league);
  assert.equal(res.state!.pickCursor, s.pickCursor);
  assert.deepEqual(res.state!.ui, s.ui);
});

test('buildHash mismatch is a WARNING flag, never a rejection', () => {
  const env = exportState(populated().getState());
  const res = importEnvelope(env, 'DIFFERENT');
  assert.equal(res.ok, true, 'older-board prep imports on purpose');
  assert.equal(res.buildHashMismatch, true);
  assert.ok(res.warnings.some((w) => w.includes('buildHash mismatch')));
});

test('missing currentBuildHash → no mismatch claimed', () => {
  const res = importEnvelope(exportState(populated().getState()));
  assert.equal(res.ok, true);
  assert.equal(res.buildHashMismatch, false);
});

// ---------------------------------------------------------------------------
// Hard rejections
// ---------------------------------------------------------------------------

test('rejects invalid JSON', () => {
  const res = importEnvelope('{"v":1,');
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes('JSON'));
});

test('rejects non-object envelopes', () => {
  for (const bad of [null, 42, [], 'null']) {
    assert.equal(importEnvelope(bad as unknown).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('rejects wrong envelope version', () => {
  const env: any = exportState(populated().getState());
  env.v = 2;
  const res = importEnvelope(env);
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes('version'));
});

test('rejects wrong state schemaVersion', () => {
  const env: any = exportState(populated().getState());
  env.state.schemaVersion = 3;
  const res = importEnvelope(env);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('schemaVersion')));
});

test('rejects missing state / broken league / broken picks', () => {
  const base = () => JSON.parse(JSON.stringify(exportState(populated().getState())));

  let env: any = base();
  delete env.state;
  assert.equal(importEnvelope(env).ok, false);

  env = base();
  env.state.league.teams = 'twelve';
  assert.equal(importEnvelope(env).ok, false);

  env = base();
  env.state.league.slot = 99; // > teams
  assert.equal(importEnvelope(env).ok, false);

  env = base();
  env.state.picks = 'nope';
  assert.equal(importEnvelope(env).ok, false);

  env = base();
  env.state.picks[3] = { n: 'four', idx: 3, source: 'manual', ts: 0 };
  assert.equal(importEnvelope(env).ok, false);

  env = base();
  env.state.pickCursor = 0;
  assert.equal(importEnvelope(env).ok, false);
});

test('rejects duplicate pick numbers and twice-drafted players', () => {
  let env: any = JSON.parse(JSON.stringify(exportState(populated().getState())));
  env.state.picks[1].n = env.state.picks[0].n;
  let res = importEnvelope(env);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('duplicate pick number')));

  env = JSON.parse(JSON.stringify(exportState(populated().getState())));
  env.state.picks[1].idx = env.state.picks[0].idx;
  res = importEnvelope(env);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('drafted twice')));
});

// ---------------------------------------------------------------------------
// Forgiving normalization (still ok: true)
// ---------------------------------------------------------------------------

test('unknown pick source coerces to manual with a warning; picks re-sorted by n', () => {
  const env: any = JSON.parse(JSON.stringify(exportState(populated().getState())));
  env.state.picks[0].source = 'espn-sync';
  env.state.picks.reverse();
  const res = importEnvelope(env, 'abc1234');
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.includes('coerced')));
  const ns = res.state!.picks.map((p) => p.n);
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
});

test('missing ui keys are defaulted', () => {
  const env: any = JSON.parse(JSON.stringify(exportState(populated().getState())));
  env.state.ui = { posFilter: 'TE' };
  const res = importEnvelope(env, 'abc1234');
  assert.equal(res.ok, true);
  assert.equal(res.state!.ui.posFilter, 'TE');
  assert.equal(res.state!.ui.showFive, true);
  assert.equal(typeof res.state!.ui.searchText, 'string');
});
