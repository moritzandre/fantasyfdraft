// season.test.ts — the per-profile season store under node --test.
// Run: node --test "src/state/*.test.ts"   (Node strip-types — erasable TS)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TX_CAP,
  applySeasonAction,
  createSeasonStore,
  initialSeasonState,
  seasonKey,
  seasonSelectors,
} from './season.ts';
import type { SeasonState, SeasonSyncPayload } from './season.ts';
import type { StorageLike } from './persist.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const writes: Array<{ key: string; value: string }> = [];
  const storage: StorageLike = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
      writes.push({ key: k, value: v });
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
  return { storage, map, writes };
}

function payload(overrides: Partial<SeasonSyncPayload> = {}): SeasonSyncPayload {
  return {
    leagueId: 'L1',
    leagueName: 'Test League',
    week: 3,
    users: { u1: { name: 'Moritz', teamName: 'Team M' }, u2: { name: 'Rival', teamName: null } },
    rosters: [
      { rosterId: 1, ownerId: 'u1', players: ['100', '101'], starters: ['100'], wins: 2, losses: 1, ties: 0, fpts: 312.5 },
      { rosterId: 2, ownerId: 'u2', players: ['200'], starters: ['200'], wins: 1, losses: 2, ties: 0, fpts: 288.1 },
    ],
    matchups: [
      { rosterId: 1, matchupId: 7, points: 101.2, starters: ['100'] },
      { rosterId: 2, matchupId: 7, points: 98.7, starters: ['200'] },
    ],
    transactions: [
      { id: 't2', type: 'waiver', status: 'complete', week: 3, adds: { '300': 1 }, drops: null, created: 2000 },
      { id: 't1', type: 'free_agent', status: 'complete', week: 3, adds: null, drops: { '101': 1 }, created: 1000 },
    ],
    trending: { add: { '300': 5000 }, drop: { '101': 1200 } },
    syncedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

test('reducer purity: input state is never mutated', () => {
  const s = initialSeasonState();
  const frozen = JSON.parse(JSON.stringify(s)) as SeasonState;
  Object.freeze(frozen);
  Object.freeze(frozen.ui);
  Object.freeze(frozen.rosters);
  Object.freeze(frozen.transactions);
  const out = applySeasonAction(frozen, { type: 'SEASON_SYNCED', payload: payload() }, 5);
  assert.notEqual(out, frozen);
  assert.deepEqual(frozen, s); // untouched
  assert.equal(out.leagueId, 'L1');
});

test('SEASON_SYNCED maps the whole payload atomically', () => {
  const s = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: payload() }, 5);
  assert.equal(s.leagueId, 'L1');
  assert.equal(s.leagueName, 'Test League');
  assert.equal(s.week, 3);
  assert.equal(s.rosters.length, 2);
  assert.equal(s.matchups.length, 2);
  assert.deepEqual(s.transactions.map((t) => t.id), ['t2', 't1']); // newest-first
  assert.deepEqual(s.trending, { add: { '300': 5000 }, drop: { '101': 1200 }, at: 1_700_000_000_000 });
  assert.equal(s.syncedAt, 1_700_000_000_000);
});

test('SEASON_SYNCED idempotence: same payload twice ⇒ same state modulo rev', () => {
  const p = payload();
  const once = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: p }, 5);
  const twice = applySeasonAction(once, { type: 'SEASON_SYNCED', payload: p }, 6);
  assert.deepEqual({ ...twice, rev: 0 }, { ...once, rev: 0 });
});

test('SEASON_SYNCED: null best-effort fields keep previous values', () => {
  const first = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: payload() }, 5);
  const second = applySeasonAction(
    first,
    { type: 'SEASON_SYNCED', payload: payload({ matchups: null, transactions: null, trending: null, week: 4 }) },
    6,
  );
  assert.equal(second.week, 4);
  assert.equal(second.matchups.length, 2); // kept
  assert.deepEqual(second.transactions.map((t) => t.id), ['t2', 't1']); // kept
  assert.deepEqual(second.trending, first.trending); // kept
});

test('transactions: merged newest-first, deduped by id, capped at TX_CAP', () => {
  const first = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: payload() }, 5);
  const flood = Array.from({ length: 60 }, (_, i) => ({
    id: `n${i}`, type: 'waiver', status: 'complete', week: 4,
    adds: null, drops: null, created: 10_000 + i,
  }));
  const s = applySeasonAction(
    first,
    { type: 'SEASON_SYNCED', payload: payload({ transactions: flood, week: 4 }) },
    6,
  );
  assert.equal(s.transactions.length, TX_CAP);
  assert.equal(s.transactions[0].id, 'n59'); // newest first
  assert.ok(!s.transactions.some((t) => t.id === 't1')); // old ones aged out
});

test('SEASON_SYNCED clamps week into 1..18', () => {
  const s0 = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: payload({ week: 0 }) }, 5);
  assert.equal(s0.week, 1);
  const s19 = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: payload({ week: 42 }) }, 5);
  assert.equal(s19.week, 18);
});

test('SET_LEAGUE_ID / SET_MY_ROSTER / SET_WEEK_OVERRIDE / SET_SEASON_UI', () => {
  let s = initialSeasonState();
  s = applySeasonAction(s, { type: 'SET_LEAGUE_ID', leagueId: '  L9  ' }, 1);
  assert.equal(s.leagueId, 'L9');
  s = applySeasonAction(s, { type: 'SET_LEAGUE_ID', leagueId: null }, 2);
  assert.equal(s.leagueId, null);
  s = applySeasonAction(s, { type: 'SET_MY_ROSTER', rosterId: 4 }, 3);
  assert.equal(s.myRosterId, 4);
  s = applySeasonAction(s, { type: 'SET_MY_ROSTER', rosterId: null }, 4);
  assert.equal(s.myRosterId, null);
  s = applySeasonAction(s, { type: 'SET_WEEK_OVERRIDE', week: 25 }, 5);
  assert.equal(s.weekOverride, 18); // clamped
  s = applySeasonAction(s, { type: 'SET_WEEK_OVERRIDE', week: null }, 6);
  assert.equal(s.weekOverride, null);
  s = applySeasonAction(s, { type: 'SET_SEASON_UI', ui: { lastScreen: 'waivers', foo: 1 } }, 7);
  assert.equal(s.ui.lastScreen, 'waivers');
  assert.equal(s.ui.foo, 1);
});

test('RESET_SEASON returns the initial state', () => {
  let s = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: payload() }, 5);
  s = applySeasonAction(s, { type: 'RESET_SEASON' }, 6);
  assert.deepEqual({ ...s, rev: 0 }, { ...initialSeasonState(), rev: 0 });
});

// ---------------------------------------------------------------------------
// Store: persistence + boot
// ---------------------------------------------------------------------------

test('every dispatch writes storage synchronously under the profile key', () => {
  const { storage, writes } = makeStorage();
  const store = createSeasonStore({ profileId: 'default', storage, now: () => 42 });
  store.dispatch({ type: 'SET_LEAGUE_ID', leagueId: 'L1' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, seasonKey('default'));
  const persisted = JSON.parse(writes[0].value);
  assert.equal(persisted.rev, 1);
  assert.equal(persisted.leagueId, 'L1');

  store.dispatch({ type: 'SET_MY_ROSTER', rosterId: 2 });
  assert.equal(writes.length, 2); // one write per dispatch, no debounce
  assert.equal(JSON.parse(writes[1].value).rev, 2);
});

test('boot restores persisted state; rev continues', () => {
  const { storage } = makeStorage();
  const a = createSeasonStore({ profileId: 'default', storage, now: () => 1 });
  a.dispatch({ type: 'SEASON_SYNCED', payload: payload() });
  a.dispatch({ type: 'SET_MY_ROSTER', rosterId: 1 });

  const b = createSeasonStore({ profileId: 'default', storage, now: () => 2 });
  const s = b.getState();
  assert.equal(s.rev, 2);
  assert.equal(s.leagueId, 'L1');
  assert.equal(s.myRosterId, 1);
  assert.equal(s.rosters.length, 2);
});

test('corrupt persisted blob boots fresh', () => {
  for (const blob of ['not json{', '42', '{"schemaVersion":9,"rev":1}', '{"rev":-1}']) {
    const { storage } = makeStorage({ [seasonKey('default')]: blob });
    const store = createSeasonStore({ profileId: 'default', storage });
    assert.deepEqual(store.getState(), initialSeasonState());
  }
});

test('per-profile key isolation: two stores, two keys, no cross-talk', () => {
  const { storage, map } = makeStorage();
  const a = createSeasonStore({ profileId: 'default', storage, now: () => 1 });
  const b = createSeasonStore({ profileId: 'dynasty', storage, now: () => 1 });
  a.dispatch({ type: 'SET_LEAGUE_ID', leagueId: 'LA' });
  b.dispatch({ type: 'SET_LEAGUE_ID', leagueId: 'LB' });

  assert.equal(seasonKey('default'), 'dp:season:default:v1');
  assert.equal(seasonKey('dynasty'), 'dp:season:dynasty:v1');
  assert.equal(JSON.parse(map.get('dp:season:default:v1')!).leagueId, 'LA');
  assert.equal(JSON.parse(map.get('dp:season:dynasty:v1')!).leagueId, 'LB');

  // reboot each — no bleed
  const a2 = createSeasonStore({ profileId: 'default', storage });
  const b2 = createSeasonStore({ profileId: 'dynasty', storage });
  assert.equal(a2.getState().leagueId, 'LA');
  assert.equal(b2.getState().leagueId, 'LB');
});

test('storage failures never break dispatch', () => {
  const storage: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {},
  };
  const store = createSeasonStore({ profileId: 'default', storage });
  store.dispatch({ type: 'SET_LEAGUE_ID', leagueId: 'L1' });
  assert.equal(store.getState().leagueId, 'L1');
});

test('subscribe notifies after the synchronous write; unsubscribe works', () => {
  const { storage, writes } = makeStorage();
  const store = createSeasonStore({ profileId: 'default', storage });
  let seenRev = -1;
  let writesAtNotify = -1;
  const off = store.subscribe((s) => {
    seenRev = s.rev;
    writesAtNotify = writes.length;
  });
  store.dispatch({ type: 'SET_MY_ROSTER', rosterId: 3 });
  assert.equal(seenRev, 1);
  assert.equal(writesAtNotify, 1); // persisted BEFORE notify
  off();
  store.dispatch({ type: 'SET_MY_ROSTER', rosterId: 4 });
  assert.equal(seenRev, 1); // no longer notified
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

test('seasonSelectors.currentWeek: override wins, clamped', () => {
  let s = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: payload() }, 5);
  assert.equal(seasonSelectors.currentWeek(s), 3);
  s = applySeasonAction(s, { type: 'SET_WEEK_OVERRIDE', week: 7 }, 6);
  assert.equal(seasonSelectors.currentWeek(s), 7);
});

test('seasonSelectors.myRoster + myMatchup + faPoolIds', () => {
  let s = applySeasonAction(initialSeasonState(), { type: 'SEASON_SYNCED', payload: payload() }, 5);
  assert.equal(seasonSelectors.myRoster(s), null);
  assert.equal(seasonSelectors.myMatchup(s), null);

  s = applySeasonAction(s, { type: 'SET_MY_ROSTER', rosterId: 1 }, 6);
  assert.equal(seasonSelectors.myRoster(s)?.ownerId, 'u1');
  const m = seasonSelectors.myMatchup(s);
  assert.equal(m?.me.rosterId, 1);
  assert.equal(m?.opp?.rosterId, 2);

  assert.deepEqual(
    seasonSelectors.faPoolIds(s, ['100', '101', '200', '999']),
    ['999'], // everything rostered is filtered out
  );
});
