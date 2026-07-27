// persist.test.ts — three-tier persistence: sync localStorage snapshot,
// append-only picklog, boot reconciliation, torn-write recovery, lifecycle flush.
// All browser APIs are injected fakes — this runs under plain `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.ts';
import type { Board, DraftState, LeagueConfig } from './store.ts';
import {
  SNAPSHOT_KEY,
  PICKLOG_KEY,
  createBrowserPersist,
  bootRestore,
  bootPersistedStore,
  attachLifecycle,
  requestStoragePersist,
  requestStoragePersistNow,
  isStoragePersisted,
  clearPersisted,
} from './persist.ts';
import type { PersistEnv, StorageLike } from './persist.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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

function comparable(s: DraftState): unknown {
  return { league: s.league, picks: s.picks, pickCursor: s.pickCursor, ui: s.ui };
}

// ---------------------------------------------------------------------------
// Tier (a): synchronous writes on every dispatch
// ---------------------------------------------------------------------------

test('every dispatch writes snapshot AND picklog synchronously', () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const bp = createBrowserPersist(env)!;
  const st = createStore({ board: makeBoard(), league: makeLeague(), persist: bp.adapter, now: () => 9 });

  st.dispatch({ type: 'PICK_MADE', idx: 0, source: 'manual' });
  // both keys exist IMMEDIATELY after dispatch returns — nothing debounced
  const snap = JSON.parse(storage.map.get(SNAPSHOT_KEY)!);
  const log = JSON.parse(storage.map.get(PICKLOG_KEY)!);
  assert.equal(snap.rev, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].rev, 1);
  assert.equal(log[0].a.type, 'PICK_MADE');

  st.dispatch({ type: 'UNDO' });
  const log2 = JSON.parse(storage.map.get(PICKLOG_KEY)!);
  assert.equal(log2.length, 2, 'UNDO is appended to the picklog too');
  assert.equal(JSON.parse(storage.map.get(SNAPSHOT_KEY)!).rev, 2);
});

test('boot round-trip: persisted store restores identically (rev, undo log, state)', async () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const bp = createBrowserPersist(env)!;
  const a = createStore({ board: makeBoard(), league: makeLeague(), persist: bp.adapter, now: () => 9 });
  for (let i = 0; i < 20; i++) a.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  a.dispatch({ type: 'SET_UI', ui: { posFilter: 'WR' } });
  a.dispatch({ type: 'UNDO' });

  const restore = await bootRestore(env);
  assert.ok(restore?.snapshot);
  const b = createStore({ board: makeBoard(), league: makeLeague(), restore });
  assert.equal(b.getState().rev, 22);
  assert.deepEqual(comparable(b.getState()), comparable(a.getState()));
  assert.equal(b.undoDepth(), 10);
});

// ---------------------------------------------------------------------------
// Tier (c): torn-snapshot recovery — THE load-bearing test
// ---------------------------------------------------------------------------

test('torn snapshot: snapshot at rev 10 + picklog at rev 14 → boot yields rev 14', async () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const bp = createBrowserPersist(env)!;
  const st = createStore({ board: makeBoard(), league: makeLeague(), persist: bp.adapter, now: () => 9 });

  for (let i = 0; i < 10; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  const snapAtRev10 = storage.map.get(SNAPSHOT_KEY)!;

  for (let i = 10; i < 14; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  assert.equal(st.getState().rev, 14);

  // simulate the torn write: the snapshot reverted to rev 10, picklog intact
  storage.map.set(SNAPSHOT_KEY, snapAtRev10);

  const restore = await bootRestore(env);
  assert.equal(restore!.snapshot!.rev, 10);
  assert.equal(restore!.tail!.length, 4, 'the four newer picklog entries are the tail');

  const b = createStore({ board: makeBoard(), league: makeLeague(), restore });
  assert.equal(b.getState().rev, 14);
  assert.equal(b.getState().picks.length, 14);
  assert.deepEqual(comparable(b.getState()), comparable(st.getState()));
});

test('corrupt snapshot JSON: boot falls back to replaying the full picklog', async () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const bp = createBrowserPersist(env)!;
  const st = createStore({ board: makeBoard(), league: makeLeague(), persist: bp.adapter, now: () => 9 });
  for (let i = 0; i < 14; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });

  storage.map.set(SNAPSHOT_KEY, '{"v":1,"rev":14,"base"'); // torn mid-write

  const restore = await bootRestore(env);
  assert.equal(restore!.snapshot, null);
  assert.equal(restore!.tail!.length, 14);
  const b = createStore({ board: makeBoard(), league: makeLeague(), restore });
  assert.equal(b.getState().rev, 14);
  assert.deepEqual(comparable(b.getState()), comparable(st.getState()));
});

test('nothing persisted → bootRestore returns null (fresh draft)', async () => {
  const restore = await bootRestore({ storage: fakeStorage(), indexedDB: null });
  assert.equal(restore, null);
});

test('bootPersistedStore end-to-end with an injected env', async () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const a = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env);
  a.dispatch({ type: 'CATCHUP', idxs: [0, 1, 2, 3, 4] });
  a.dispatch({ type: 'SET_LEAGUE', league: { slot: 3 } });

  const b = await bootPersistedStore({ board: makeBoard(), league: makeLeague() }, env);
  assert.equal(b.getState().rev, 2);
  assert.deepEqual(comparable(b.getState()), comparable(a.getState()));
  assert.equal(b.getState().league.slot, 3);
});

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

test('a quota-throwing storage never breaks dispatch (draft continues in memory)', () => {
  const throwing: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  };
  const bp = createBrowserPersist({ storage: throwing, indexedDB: null })!;
  const st = createStore({ board: makeBoard(), league: makeLeague(), persist: bp.adapter });
  st.dispatch({ type: 'PICK_MADE', idx: 0, source: 'manual' });
  st.dispatch({ type: 'PICK_MADE', idx: 1, source: 'manual' });
  assert.equal(st.getState().picks.length, 2);
});

test('no storage and no indexedDB → createBrowserPersist is null (Node-safe no-op)', () => {
  assert.equal(createBrowserPersist({ storage: null, indexedDB: null }), null);
});

// ---------------------------------------------------------------------------
// Lifecycle: pagehide / hidden flush (NEVER beforeunload), storage.persist once
// ---------------------------------------------------------------------------

test('pagehide and visibilitychange→hidden re-write the last snapshot; no beforeunload', () => {
  const storage = fakeStorage();
  const winHandlers: Record<string, () => void> = {};
  const docHandlers: Record<string, () => void> = {};
  const doc: any = {
    visibilityState: 'visible',
    addEventListener: (t: string, fn: () => void) => {
      docHandlers[t] = fn;
    },
  };
  const env: PersistEnv = {
    storage,
    indexedDB: null,
    win: {
      addEventListener: (t: string, fn: () => void) => {
        winHandlers[t] = fn;
      },
    },
    doc,
  };
  const bp = createBrowserPersist(env)!;
  attachLifecycle(env, bp);
  assert.ok(winHandlers['pagehide'], 'pagehide hooked');
  assert.ok(docHandlers['visibilitychange'], 'visibilitychange hooked');
  assert.equal(winHandlers['beforeunload'], undefined, 'beforeunload must NOT be used');

  const st = createStore({ board: makeBoard(), league: makeLeague(), persist: bp.adapter, now: () => 9 });
  st.dispatch({ type: 'PICK_MADE', idx: 0, source: 'manual' });

  storage.map.delete(SNAPSHOT_KEY); // simulate an evicted value
  winHandlers['pagehide']();
  assert.equal(JSON.parse(storage.map.get(SNAPSHOT_KEY)!).rev, 1, 'pagehide flushed');

  storage.map.delete(SNAPSHOT_KEY);
  doc.visibilityState = 'hidden';
  docHandlers['visibilitychange']();
  assert.equal(JSON.parse(storage.map.get(SNAPSHOT_KEY)!).rev, 1, 'hidden flushed');
});

test('navigator.storage.persist() is requested exactly once', () => {
  const storage = fakeStorage();
  let asked = 0;
  const env: PersistEnv = {
    storage,
    indexedDB: null,
    nav: { storage: { persist: () => (asked++, Promise.resolve(true)) } },
  };
  requestStoragePersist(env);
  requestStoragePersist(env);
  assert.equal(asked, 1);
});

test('requestStoragePersistNow has NO ask-once guard and returns the browser answer', async () => {
  const storage = fakeStorage();
  let asked = 0;
  const answers = [false, true];
  const env: PersistEnv = {
    storage,
    indexedDB: null,
    nav: { storage: { persist: () => Promise.resolve(answers[asked++]) } },
  };
  // even with the boot-time ask-once marker already set, the tap still asks
  requestStoragePersist(env);
  assert.equal(asked, 1, 'boot ask consumed the guard');
  assert.equal(await requestStoragePersistNow(env), true, 'second call still asks (no guard)');
  assert.equal(asked, 2);
});

test('requestStoragePersistNow: unsupported nav / throwing persist → null', async () => {
  assert.equal(await requestStoragePersistNow({ nav: null }), null);
  assert.equal(await requestStoragePersistNow({ nav: {} }), null);
  assert.equal(await requestStoragePersistNow({ nav: { storage: {} } }), null);
  assert.equal(
    await requestStoragePersistNow({
      nav: { storage: { persist: () => Promise.reject(new Error('nope')) } },
    }),
    null,
  );
});

test('isStoragePersisted mirrors navigator.storage.persisted(), null when unsupported', async () => {
  assert.equal(
    await isStoragePersisted({ nav: { storage: { persisted: () => Promise.resolve(true) } } }),
    true,
  );
  assert.equal(
    await isStoragePersisted({ nav: { storage: { persisted: () => Promise.resolve(false) } } }),
    false,
  );
  assert.equal(await isStoragePersisted({ nav: null }), null);
  assert.equal(await isStoragePersisted({ nav: { storage: {} } }), null);
  assert.equal(
    await isStoragePersisted({
      nav: { storage: { persisted: () => Promise.reject(new Error('nope')) } },
    }),
    null,
  );
});

test('clearPersisted removes both localStorage keys', () => {
  const storage = fakeStorage();
  storage.setItem(SNAPSHOT_KEY, 'x');
  storage.setItem(PICKLOG_KEY, 'y');
  clearPersisted({ storage, indexedDB: null });
  assert.equal(storage.getItem(SNAPSHOT_KEY), null);
  assert.equal(storage.getItem(PICKLOG_KEY), null);
});

// ---------------------------------------------------------------------------
// Picklog hygiene
// ---------------------------------------------------------------------------

test('picklog is trimmed but entries newer than the snapshot are never dropped', () => {
  const storage = fakeStorage();
  const env: PersistEnv = { storage, indexedDB: null };
  const bp = createBrowserPersist(env)!;
  const st = createStore({ board: makeBoard(600), league: makeLeague({ rounds: 30, teams: 20 }), persist: bp.adapter, now: () => 9 });
  for (let i = 0; i < 450; i++) st.dispatch({ type: 'SET_UI', ui: { searchText: `q${i}` } });
  const log = JSON.parse(storage.map.get(PICKLOG_KEY)!);
  assert.ok(log.length <= 400, `picklog capped (got ${log.length})`);
  const snapRev = JSON.parse(storage.map.get(SNAPSHOT_KEY)!).rev;
  assert.equal(snapRev, 450);
  assert.equal(log[log.length - 1].rev, 450, 'newest entry retained');
});
