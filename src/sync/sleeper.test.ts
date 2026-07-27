// sleeper.test.ts — the Sleeper sync poll loop under node --test with a fully
// injectable environment: fetch mock, fake timers, fixed clock, fixed RNG.
// Run: node --test src/sync/sleeper.test.ts   (Node 24 strip-types — erasable TS)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../state/store.ts';
import type { Board, LeagueConfig, Store } from '../state/store.ts';
import {
  MAX_BACKOFF_MS,
  POLL_MS,
  SLEEPER_API,
  createSleeperSync,
  pickActiveDraft,
} from './sleeper.ts';
import type { SyncInfo } from './sleeper.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const board = {
  buildHash: 'testhash',
  players: [0, 1, 2, 3, 4].map((i) => ({ idx: i, id: `e${i}`, name: `P${i}`, pos: 'RB' })),
  slimSleeperMap: { '100': 0, '101': 1, '102': 2, '103': 3, '104': 4 },
} as unknown as Board;

function makeStore(): Store {
  return createStore({
    board,
    league: { teams: 12, slot: 8, rounds: 16 } as unknown as LeagueConfig,
  });
}

/** Fake timers: log every scheduled delay, hold callbacks until runNext(). */
function makeTimers() {
  const delays: number[] = [];
  const pending = new Map<number, () => void>();
  let nextId = 0;
  return {
    delays,
    size: () => pending.size,
    setTimeoutFn(fn: () => void, ms: number): unknown {
      delays.push(ms);
      nextId += 1;
      pending.set(nextId, fn);
      return nextId;
    },
    clearTimeoutFn(id: unknown): void {
      pending.delete(id as number);
    },
    runNext(): void {
      const first = pending.entries().next();
      if (first.done) return;
      pending.delete(first.value[0]);
      first.value[1]();
    },
  };
}

function resOk(json: unknown) {
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}
function resErr(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

/** Recording fetch mock delegating to a handler. */
function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle(n = 12): Promise<void> {
  for (let i = 0; i < n; i += 1) await tick();
}

function baseOpts(timers: ReturnType<typeof makeTimers>, statuses?: SyncInfo[]) {
  return {
    draftId: 'd1',
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => 1_000_000,
    random: () => 0.5, // jitter factor exactly 1.0 → deterministic delays
    onStatus: statuses ? (i: SyncInfo) => statuses.push(i) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('new picks dispatch through the reducer in pick_no order (response order shuffled)', async () => {
  const timers = makeTimers();
  const { fn, calls } = fetchMock(() =>
    resOk([
      { pick_no: 3, player_id: '102' },
      { pick_no: 1, player_id: '100' },
      { pick_no: 2, player_id: '101' },
    ]),
  );
  const store = makeStore();
  const sync = createSleeperSync(store, board, { ...baseOpts(timers), fetchFn: fn });
  await settle();

  assert.equal(calls[0].url, `${SLEEPER_API}/draft/d1/picks`);
  const s = store.getState();
  assert.deepEqual(
    s.picks.map((p) => [p.n, p.idx, p.source]),
    [
      [1, 0, 'sleeper'],
      [2, 1, 'sleeper'],
      [3, 2, 'sleeper'],
    ],
  );
  assert.equal(s.pickCursor, 4);
  assert.equal(sync.info().status, 'live');
  assert.equal(sync.info().pickCount, 3);
  assert.equal(sync.info().lastPollAt, 1_000_000);
  assert.equal(timers.delays[0], POLL_MS); // healthy cadence, jitter factor 1.0
  sync.stop();
  assert.equal(timers.size(), 0);
});

test('already-recorded picks are skipped; re-polling the same list is idempotent', async () => {
  const timers = makeTimers();
  const { fn, calls } = fetchMock(() =>
    resOk([
      { pick_no: 1, player_id: '100' },
      { pick_no: 2, player_id: '101' },
      { pick_no: 3, player_id: '102' },
    ]),
  );
  const store = makeStore();
  store.dispatch({ type: 'PICK_MADE', idx: 0, source: 'manual' }); // pick 1 entered by hand
  const sync = createSleeperSync(store, board, { ...baseOpts(timers), fetchFn: fn });
  await settle();

  let s = store.getState();
  assert.deepEqual(
    s.picks.map((p) => [p.n, p.idx, p.source]),
    [
      [1, 0, 'manual'], // untouched — sync never overwrites a recorded pick
      [2, 1, 'sleeper'],
      [3, 2, 'sleeper'],
    ],
  );
  assert.equal(sync.info().pickCount, 2);

  // second poll, identical payload → replay-safe no-op
  timers.runNext();
  await settle();
  s = store.getState();
  assert.equal(calls.length, 2);
  assert.equal(s.picks.length, 3);
  assert.equal(s.pickCursor, 4);
  assert.equal(sync.info().pickCount, 2);
  assert.equal(sync.info().status, 'live');
  sync.stop();
});

test('429 backs off exponentially with a 30s cap, and success resets to 3s', async () => {
  const timers = makeTimers();
  let failing = true;
  const { fn } = fetchMock(() => (failing ? resErr(429) : resOk([])));
  const store = makeStore();
  const sync = createSleeperSync(store, board, { ...baseOpts(timers), fetchFn: fn });

  await settle(); // poll 1 → 429
  assert.equal(sync.info().status, 'error');
  assert.equal(sync.info().error, 'HTTP 429');
  for (let i = 0; i < 4; i += 1) {
    timers.runNext();
    await settle();
  }
  // random()=0.5 → jitter factor exactly 1.0, so delays are the raw backoff
  assert.deepEqual(timers.delays, [6000, 12000, 24000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  assert.equal(sync.info().backoffMs, MAX_BACKOFF_MS);

  failing = false;
  timers.runNext();
  await settle();
  assert.equal(sync.info().status, 'live');
  assert.equal(sync.info().error, null);
  assert.equal(sync.info().backoffMs, POLL_MS);
  assert.equal(timers.delays[timers.delays.length - 1], POLL_MS);
  sync.stop();
});

test('unresolvable player_id pauses sync without advancing the cursor past it', async () => {
  const timers = makeTimers();
  const statuses: SyncInfo[] = [];
  const { fn } = fetchMock(() =>
    resOk([
      { pick_no: 1, player_id: '100' },
      { pick_no: 2, player_id: '999' }, // not in slimSleeperMap
      { pick_no: 3, player_id: '102' },
    ]),
  );
  const store = makeStore();
  const sync = createSleeperSync(store, board, { ...baseOpts(timers, statuses), fetchFn: fn });
  await settle();

  const s = store.getState();
  assert.deepEqual(
    s.picks.map((p) => [p.n, p.idx]),
    [[1, 0]], // pick 1 landed; pick 3 must NOT leapfrog the unresolved pick 2
  );
  assert.equal(s.pickCursor, 2); // cursor NOT advanced for the unresolved pick
  const i = sync.info();
  assert.equal(i.status, 'error');
  assert.equal(i.paused, true);
  assert.equal(i.unresolved, '999');
  assert.match(String(i.error), /999/); // banner names the Sleeper player_id
  assert.equal(timers.size(), 0); // loop paused — no further poll scheduled
  assert.equal(statuses[statuses.length - 1].paused, true);
  sync.stop();
  assert.equal(sync.info().status, 'stopped');
});

test('stop() aborts the in-flight fetch and schedules nothing more', async () => {
  const timers = makeTimers();
  const statuses: SyncInfo[] = [];
  let aborted = false;
  const fn = (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });
  const store = makeStore();
  const sync = createSleeperSync(store, board, { ...baseOpts(timers, statuses), fetchFn: fn });
  assert.equal(aborted, false);
  sync.stop();
  await settle();

  assert.equal(aborted, true); // in-flight request cancelled
  assert.equal(sync.info().status, 'stopped');
  assert.equal(timers.size(), 0);
  // the rejected fetch after stop() must never flip the status to 'error'
  assert.ok(statuses.every((st) => st.status !== 'error'));
  assert.equal(store.getState().picks.length, 0);
});

test('pickActiveDraft prefers drafting > paused > pre_draft > complete, newest wins ties', () => {
  assert.equal(
    pickActiveDraft([
      { draft_id: 'a', status: 'complete', created: 50 },
      { draft_id: 'b', status: 'pre_draft', created: 10 },
      { draft_id: 'c', status: 'drafting', created: 1 },
    ]),
    'c',
  );
  assert.equal(
    pickActiveDraft([
      { draft_id: 'x', status: 'pre_draft', created: 1 },
      { draft_id: 'y', status: 'pre_draft', created: 9 },
    ]),
    'y',
  );
  assert.equal(pickActiveDraft([]), null);
  assert.equal(pickActiveDraft([{ status: 'drafting' }]), null); // no draft_id → invalid
});
