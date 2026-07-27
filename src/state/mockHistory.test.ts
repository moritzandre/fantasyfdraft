// mockHistory.test.ts — the mock-draft archive: round-trip, newest-first
// order, cap-20 drops the oldest, corrupt blobs, per-row delete, null
// storage safety.
// Run: node --test "src/state/*.test.ts"   (Node strip-types — erasable TS only)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOCK_HISTORY_CAP,
  MOCK_HISTORY_KEY,
  archiveMock,
  deleteMock,
  loadMockHistory,
} from './mockHistory.ts';
import type { HistoryStorageLike, MockRecord } from './mockHistory.ts';

function fakeStorage(): HistoryStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

function makeRecord(i: number, over: Partial<MockRecord> = {}): MockRecord {
  return {
    id: `${1000 + i}-${i}`,
    finishedAt: 1000 + i,
    league: { teams: 12, slot: 8, rounds: 16, snake: true, strategy: 'balanced' },
    seed: i,
    picks: [
      { n: 1, idx: 3 * i, source: 'sim' },
      { n: 8, idx: 3 * i + 1, source: 'manual' },
    ],
    summary: { myPicks: 1, matches: 1, evens: 0, totalDelta: 0 },
    ...over,
  };
}

test('mockHistory: archive → load round-trips, newest first, key dp:mock-history:v1', () => {
  const storage = fakeStorage();
  const a = makeRecord(1);
  const b = makeRecord(2, { seed: null, summary: null, id: '1002-x' });
  archiveMock(a, storage);
  const list = archiveMock(b, storage);
  assert.ok(storage.data.has(MOCK_HISTORY_KEY));
  assert.deepEqual(list, [b, a]); // archiveMock returns the new list…
  assert.deepEqual(loadMockHistory(storage), [b, a]); // …and load agrees
  // every field survives JSON, including seed:null and summary:null
  assert.equal(loadMockHistory(storage)[0].seed, null);
  assert.equal(loadMockHistory(storage)[0].summary, null);
  assert.deepEqual(loadMockHistory(storage)[1].picks, a.picks);
});

test('mockHistory: cap 20 drops the OLDEST record', () => {
  const storage = fakeStorage();
  for (let i = 1; i <= MOCK_HISTORY_CAP + 1; i++) archiveMock(makeRecord(i), storage);
  const list = loadMockHistory(storage);
  assert.equal(list.length, MOCK_HISTORY_CAP);
  assert.equal(list[0].id, makeRecord(21).id); // newest kept, first
  assert.equal(list[list.length - 1].id, makeRecord(2).id);
  assert.equal(list.some((r) => r.id === makeRecord(1).id), false); // oldest gone
});

test('mockHistory: re-archiving the SAME id replaces, never duplicates', () => {
  const storage = fakeStorage();
  archiveMock(makeRecord(1), storage);
  archiveMock(makeRecord(2), storage);
  const list = archiveMock(makeRecord(1, { seed: 99 }), storage);
  assert.equal(list.length, 2);
  assert.equal(list.filter((r) => r.id === makeRecord(1).id).length, 1);
  assert.equal(list.find((r) => r.id === makeRecord(1).id)?.seed, 99);
});

test('mockHistory: corrupt blob ⇒ [], invalid entries inside a list are dropped', () => {
  const storage = fakeStorage();
  storage.data.set(MOCK_HISTORY_KEY, '{not json');
  assert.deepEqual(loadMockHistory(storage), []);
  storage.data.set(MOCK_HISTORY_KEY, '{"a":1}'); // JSON but not a list
  assert.deepEqual(loadMockHistory(storage), []);
  storage.data.set(
    MOCK_HISTORY_KEY,
    JSON.stringify([makeRecord(1), null, 42, { id: 7 }, 'nope']),
  );
  assert.deepEqual(loadMockHistory(storage), [makeRecord(1)]);
  // archiving over a corrupt blob heals it
  storage.data.set(MOCK_HISTORY_KEY, '{not json');
  assert.deepEqual(archiveMock(makeRecord(3), storage), [makeRecord(3)]);
  assert.deepEqual(loadMockHistory(storage), [makeRecord(3)]);
});

test('mockHistory: deleteMock removes one record and persists', () => {
  const storage = fakeStorage();
  archiveMock(makeRecord(1), storage);
  archiveMock(makeRecord(2), storage);
  archiveMock(makeRecord(3), storage);
  const list = deleteMock(makeRecord(2).id, storage);
  assert.deepEqual(list.map((r) => r.id), [makeRecord(3).id, makeRecord(1).id]);
  assert.deepEqual(loadMockHistory(storage), list); // the delete was written
  assert.deepEqual(deleteMock('nope', storage), list); // unknown id is a no-op
});

test('mockHistory: null storage (private mode) is safe, never throws', () => {
  assert.deepEqual(loadMockHistory(null), []);
  assert.deepEqual(archiveMock(makeRecord(1), null), [makeRecord(1)]); // in-memory result
  assert.deepEqual(deleteMock('x', null), []);
});
