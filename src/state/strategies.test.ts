// strategies.test.ts — the strategy-registry loader: local editor storage
// (dp:strategies-local:v1) round-trip + corrupt-data safety, the file⊕local
// merge (local wins, invalid dropped), cache invalidation after a save.
// Run: node --test "src/state/*.test.ts"   (Node strip-types — erasable TS only)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_STRATEGIES_KEY,
  invalidateStrategies,
  loadLocalStrategies,
  loadStrategies,
  saveLocalStrategies,
  strategyList,
} from './strategies.ts';
import type { StrategiesStorageLike } from './strategies.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeStorage(): StrategiesStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

/** fetch stub serving a strategies.json body (or an HTTP failure). */
function fakeFetch(body: unknown, ok = true): (url: string) => Promise<Response> {
  return () =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      json: () => Promise.resolve(body),
    } as unknown as Response);
}

const FILE_SPEC = {
  name: 'wr_heavy',
  label: 'WR Heavy (file)',
  multipliers: { WR: [{ from: 1, to: 4, m: 1.2 }] },
  constraints: [],
};

// ---------------------------------------------------------------------------
// Local storage round-trip
// ---------------------------------------------------------------------------

test('strategies: local save/load round-trips raw specs; corrupt data is empty', () => {
  const st = fakeStorage();
  assert.deepEqual(loadLocalStrategies(st), [], 'empty storage ⇒ empty list');

  const specs = [{ name: 'my_strat', multipliers: {}, constraints: [] }];
  saveLocalStrategies(specs, st);
  assert.ok(st.data.has(LOCAL_STRATEGIES_KEY), 'writes the versioned key');
  assert.deepEqual(loadLocalStrategies(st), specs, 'round-trip');

  st.data.set(LOCAL_STRATEGIES_KEY, '{not json');
  assert.deepEqual(loadLocalStrategies(st), [], 'corrupt JSON ⇒ empty, never a throw');
  st.data.set(LOCAL_STRATEGIES_KEY, JSON.stringify([1, 'x', null, { name: 'ok' }]));
  assert.deepEqual(loadLocalStrategies(st), [{ name: 'ok' }], 'non-object entries dropped');

  assert.deepEqual(loadLocalStrategies(null), [], 'no storage (Node) ⇒ empty');
  saveLocalStrategies(specs, null); // must not throw
});

// ---------------------------------------------------------------------------
// Merge: file registry ⊕ local specs
// ---------------------------------------------------------------------------

test('strategies: loadStrategies merges local over file — local wins, invalid dropped', async () => {
  invalidateStrategies();
  const st = fakeStorage();
  saveLocalStrategies(
    [
      // collision with the file spec — the LOCAL label must win
      { name: 'wr_heavy', label: 'WR Heavy (local)', multipliers: {}, constraints: [] },
      // a valid local-only spec
      { name: 'te_punt', label: 'TE Punt', multipliers: {}, constraints: [{ pos: 'TE', type: 'max', through: 8, limit: 0 }] },
      // invalid: reserved built-in name — dropped with a warning
      { name: 'balanced', multipliers: {}, constraints: [] },
      // invalid: bad multiplier — dropped with a warning
      { name: 'broken', multipliers: { RB: [{ from: 1, to: 3, m: 99 }] }, constraints: [] },
    ],
    st,
  );

  const reg = await loadStrategies(fakeFetch({ strategies: [FILE_SPEC] }), '/', st);
  assert.deepEqual(Object.keys(reg).sort(), ['te_punt', 'wr_heavy']);
  assert.equal((reg.wr_heavy as any).label, 'WR Heavy (local)', 'local spec wins the collision');
  assert.equal((reg.te_punt as any).constraints.length, 1);

  // strategyList carries the merged customs after the 4 built-ins.
  const list = strategyList(reg);
  assert.equal(list.length, 4 + 2);
  assert.ok(list.filter((m) => m.custom).every((m) => ['wr_heavy', 'te_punt'].includes(m.name)));
  invalidateStrategies();
});

test('strategies: local specs survive a failed strategies.json fetch', async () => {
  invalidateStrategies();
  const st = fakeStorage();
  saveLocalStrategies([{ name: 'solo_local', multipliers: {}, constraints: [] }], st);
  const reg = await loadStrategies(fakeFetch(null, false), '/', st);
  assert.deepEqual(Object.keys(reg), ['solo_local'], 'file failure still yields the local registry');
  invalidateStrategies();
});

// ---------------------------------------------------------------------------
// Cache invalidation (the editor-save contract)
// ---------------------------------------------------------------------------

test('strategies: invalidateStrategies makes the next load see a fresh save', async () => {
  invalidateStrategies();
  const st = fakeStorage();
  const fetchFn = fakeFetch({ strategies: [] });

  const before = await loadStrategies(fetchFn, '/', st);
  assert.deepEqual(Object.keys(before), []);

  saveLocalStrategies([{ name: 'added_later', multipliers: {}, constraints: [] }], st);
  const cached = await loadStrategies(fetchFn, '/', st);
  assert.deepEqual(Object.keys(cached), [], 'without invalidation the session cache is served');

  invalidateStrategies();
  const after = await loadStrategies(fetchFn, '/', st);
  assert.deepEqual(Object.keys(after), ['added_later'], 'invalidate ⇒ re-merge picks up the save');
  invalidateStrategies();
});
