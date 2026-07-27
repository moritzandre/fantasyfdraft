// context.test.ts — context namespacing (persist.ts), league profiles and
// the real/practice mode flag: the isolation core of the hub. Practice and
// other-profile contexts must NEVER touch the real draft's keys — the
// safety story of mock drafting the week before the real draft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.ts';
import {
  SNAPSHOT_KEY,
  PICKLOG_KEY,
  snapshotKey,
  picklogKey,
  createBrowserPersist,
  bootPersistedStore,
  clearPersisted,
  lastSaveInfo,
} from './persist.ts';
import type { PersistEnv, StorageLike } from './persist.ts';
import type { Board, LeagueConfig } from './store.ts';
import {
  DEFAULT_PROFILE_ID,
  loadProfiles,
  saveProfiles,
  upsertProfile,
  removeProfile,
  setActiveProfile,
  ctxFor,
  newProfileId,
  makeDefaultProfile,
} from './profiles.ts';
import { getMode, setMode, MODE_KEY } from './mode.ts';

function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

function makeBoard(n: number = 220): Board {
  return {
    buildHash: 'testhash',
    players: Array.from({ length: n }, (_, idx) => ({ idx, name: `P${idx}`, pos: 'RB' })),
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

// ---------------------------------------------------------------------------
// Key shapes
// ---------------------------------------------------------------------------

test('context keys: legacy for "", namespaced otherwise', () => {
  assert.equal(snapshotKey(), 'dp:state:v1');
  assert.equal(snapshotKey(''), SNAPSHOT_KEY);
  assert.equal(picklogKey(''), PICKLOG_KEY);
  assert.equal(snapshotKey('mock'), 'dp:state:mock:v1');
  assert.equal(picklogKey('mock'), 'dp:picklog:mock:v1');
  assert.equal(snapshotKey('p-work:mock'), 'dp:state:p-work:mock:v1');
});

test('ctxFor: default+real is the legacy context; others namespace', () => {
  assert.equal(ctxFor(DEFAULT_PROFILE_ID, false), '');
  assert.equal(ctxFor(DEFAULT_PROFILE_ID, true), 'mock');
  assert.equal(ctxFor('work', false), 'p-work');
  assert.equal(ctxFor('work', true), 'p-work:mock');
});

// ---------------------------------------------------------------------------
// Cross-contamination proofs
// ---------------------------------------------------------------------------

test('a mock-context store writes ONLY mock keys; real keys stay untouched', () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const bp = createBrowserPersist(env, 'mock')!;
  const store = createStore({
    board: makeBoard(),
    league: makeLeague(),
    persist: bp.adapter,
  });
  store.dispatch({ type: 'PICK_MADE', idx: 0, source: 'sim' });
  store.dispatch({ type: 'PICK_MADE', idx: 1, source: 'sim' });
  assert.ok(storage.map.has('dp:state:mock:v1'));
  assert.ok(storage.map.has('dp:picklog:mock:v1'));
  assert.ok(!storage.map.has(SNAPSHOT_KEY), 'real snapshot key must not exist');
  assert.ok(!storage.map.has(PICKLOG_KEY), 'real picklog key must not exist');
});

test('real boot never reads mock state and vice versa', async () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  // Build a real draft with 3 picks and a mock draft with 1 pick.
  const real = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env, '');
  real.dispatch({ type: 'PICK_MADE', idx: 10, source: 'manual' });
  real.dispatch({ type: 'PICK_MADE', idx: 11, source: 'manual' });
  real.dispatch({ type: 'PICK_MADE', idx: 12, source: 'manual' });
  const mock = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env, 'mock');
  mock.dispatch({ type: 'PICK_MADE', idx: 99, source: 'sim' });
  // Fresh boots see their own context only.
  const real2 = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env, '');
  const mock2 = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env, 'mock');
  assert.deepEqual(real2.getState().picks.map((p: any) => p.idx), [10, 11, 12]);
  assert.deepEqual(mock2.getState().picks.map((p: any) => p.idx), [99]);
});

test('clearPersisted is context-scoped', async () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const real = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env, '');
  real.dispatch({ type: 'PICK_MADE', idx: 1, source: 'manual' });
  const mock = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env, 'mock');
  mock.dispatch({ type: 'PICK_MADE', idx: 2, source: 'sim' });
  clearPersisted(env, 'mock');
  assert.ok(!storage.map.has('dp:state:mock:v1'));
  assert.ok(storage.map.has(SNAPSHOT_KEY), 'real state survives a mock wipe');
  clearPersisted(env, '');
  assert.ok(!storage.map.has(SNAPSHOT_KEY));
});

test('lastSaveInfo is context-scoped', async () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const mock = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env, 'mock');
  mock.dispatch({ type: 'PICK_MADE', idx: 2, source: 'sim' });
  assert.equal(lastSaveInfo(env, ''), null);
  assert.ok(lastSaveInfo(env, 'mock')!.rev >= 1);
});

// ---------------------------------------------------------------------------
// Profiles registry
// ---------------------------------------------------------------------------

test('loadProfiles: empty storage yields the default profile, active', () => {
  const storage = fakeStorage();
  const st = loadProfiles(makeLeague(), storage);
  assert.equal(st.profiles.length, 1);
  assert.equal(st.profiles[0].id, DEFAULT_PROFILE_ID);
  assert.equal(st.activeId, DEFAULT_PROFILE_ID);
});

test('profiles: upsert/save/load round-trip; default always first', () => {
  const storage = fakeStorage();
  let st = loadProfiles(makeLeague(), storage);
  st = upsertProfile(st, {
    id: 'work-league',
    name: 'Work league',
    league: { teams: 10, slot: 3 },
    board: 'board.json',
    sleeperLeagueId: '123',
    sleeperDraftId: null,
  });
  st = setActiveProfile(st, 'work-league');
  saveProfiles(st, storage);
  const back = loadProfiles(makeLeague(), storage);
  assert.equal(back.profiles.length, 2);
  assert.equal(back.profiles[0].id, DEFAULT_PROFILE_ID);
  assert.equal(back.profiles[1].name, 'Work league');
  assert.equal(back.profiles[1].league.teams, 10);
  assert.equal(back.activeId, 'work-league');
});

test('profiles: corrupt blob falls back to default; bad entries dropped', () => {
  const storage = fakeStorage();
  storage.setItem('dp:profiles:v1', '{not json');
  const st = loadProfiles(makeLeague(), storage);
  assert.equal(st.profiles.length, 1);
  storage.setItem('dp:profiles:v1', JSON.stringify({
    v: 1,
    profiles: [{ id: 'BAD ID', name: 'x' }, { id: 'ok', name: 'OK', league: {} }],
  }));
  const st2 = loadProfiles(makeLeague(), storage);
  assert.deepEqual(st2.profiles.map((p) => p.id), [DEFAULT_PROFILE_ID, 'ok']);
});

test('profiles: default cannot be removed; removing active falls back', () => {
  let st = loadProfiles(makeLeague(), null);
  st = upsertProfile(st, { ...makeDefaultProfile({}), id: 'x', name: 'X' });
  st = setActiveProfile(st, 'x');
  assert.equal(removeProfile(st, DEFAULT_PROFILE_ID), st);
  const after = removeProfile(st, 'x');
  assert.equal(after.profiles.length, 1);
  assert.equal(after.activeId, DEFAULT_PROFILE_ID);
});

test('newProfileId: slugs and dedupes', () => {
  const existing = [makeDefaultProfile({}), { ...makeDefaultProfile({}), id: 'dynasty-bros' }];
  assert.equal(newProfileId('Dynasty Bros!', existing), 'dynasty-bros-2');
  assert.equal(newProfileId('  ???  ', existing), 'league');
});

// ---------------------------------------------------------------------------
// Mode flag
// ---------------------------------------------------------------------------

test('mode: defaults to real, round-trips, absent key after reset to real', () => {
  const storage = fakeStorage();
  assert.equal(getMode(storage), 'real');
  setMode('practice', storage);
  assert.equal(getMode(storage), 'practice');
  assert.equal(storage.map.get(MODE_KEY), 'practice');
  setMode('real', storage);
  assert.equal(getMode(storage), 'real');
  assert.ok(!storage.map.has(MODE_KEY), 'real mode leaves no key behind');
  assert.equal(getMode(null), 'real');
});
