// league.test.ts — Sleeper league sync under node --test with an injectable
// fetch and fixed clock. Run: node --test "src/sync/*.test.ts"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeasonStore } from '../state/season.ts';
import type { SeasonStore } from '../state/season.ts';
import { SLEEPER_API } from './sleeper.ts';
import { createLeagueSync, fetchSeasonSnapshot } from './league.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function resOk(json: unknown) {
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}
function resErr(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

const FIX: Record<string, unknown> = {
  [`${SLEEPER_API}/state/nfl`]: { week: 3, season_type: 'regular', season: '2026' },
  [`${SLEEPER_API}/league/L1`]: {
    league_id: 'L1',
    name: 'Test League',
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'K', 'DEF'],
  },
  [`${SLEEPER_API}/league/L1/users`]: [
    { user_id: 'u1', display_name: 'moritz', metadata: { team_name: 'Team M' } },
    { user_id: 'u2', display_name: 'rival', metadata: {} },
  ],
  [`${SLEEPER_API}/league/L1/rosters`]: [
    {
      roster_id: 1, owner_id: 'u1', players: ['100', '101'], starters: ['100'],
      settings: { wins: 2, losses: 1, ties: 0, fpts: 312, fpts_decimal: 50 },
    },
    {
      roster_id: 2, owner_id: 'u2', players: ['200'], starters: ['200'],
      settings: { wins: 1, losses: 2, ties: 0, fpts: 288, fpts_decimal: 10 },
    },
  ],
  [`${SLEEPER_API}/league/L1/matchups/3`]: [
    { roster_id: 1, matchup_id: 7, points: 101.2, starters: ['100'] },
    { roster_id: 2, matchup_id: 7, points: 98.7, starters: ['200'] },
  ],
  [`${SLEEPER_API}/league/L1/transactions/3`]: [
    { transaction_id: 't1', type: 'waiver', status: 'complete', leg: 3, adds: { '300': 1 }, drops: null, created: 1000 },
    { transaction_id: 't2', type: 'free_agent', status: 'complete', leg: 3, adds: null, drops: { '101': 1 }, created: 2000 },
  ],
  [`${SLEEPER_API}/players/nfl/trending/add?lookback_hours=24&limit=50`]: [
    { player_id: '300', count: 5000 },
  ],
  [`${SLEEPER_API}/players/nfl/trending/drop?lookback_hours=24&limit=50`]: [
    { player_id: '101', count: 1200 },
  ],
};

/** Recording fetch mock over the fixture map, with per-URL overrides. */
function fetchMock(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    calls.push(url);
    const ov = overrides[url];
    if (ov) return ov();
    if (url in FIX) return resOk(FIX[url]);
    return resErr(404);
  };
  return { fn, calls };
}

function makeStore(): SeasonStore {
  return createSeasonStore({ profileId: 'default', storage: null, now: () => 0 });
}

// ---------------------------------------------------------------------------
// fetchSeasonSnapshot
// ---------------------------------------------------------------------------

test('full sequence: payload correctly mapped from all seven endpoints', async () => {
  const { fn, calls } = fetchMock();
  const p = await fetchSeasonSnapshot('L1', { fetchFn: fn, now: () => 99 });

  assert.equal(calls[0], `${SLEEPER_API}/state/nfl`);
  assert.equal(calls[1], `${SLEEPER_API}/league/L1`);
  assert.equal(p.leagueId, 'L1');
  assert.equal(p.leagueName, 'Test League');
  assert.equal(p.week, 3);
  assert.deepEqual(p.users, {
    u1: { name: 'moritz', teamName: 'Team M' },
    u2: { name: 'rival', teamName: null },
  });
  assert.deepEqual(p.rosters, [
    { rosterId: 1, ownerId: 'u1', players: ['100', '101'], starters: ['100'], wins: 2, losses: 1, ties: 0, fpts: 312.5 },
    { rosterId: 2, ownerId: 'u2', players: ['200'], starters: ['200'], wins: 1, losses: 2, ties: 0, fpts: 288.1 },
  ]);
  assert.deepEqual(p.matchups, [
    { rosterId: 1, matchupId: 7, points: 101.2, starters: ['100'] },
    { rosterId: 2, matchupId: 7, points: 98.7, starters: ['200'] },
  ]);
  assert.deepEqual(p.transactions?.map((t) => t.id), ['t2', 't1']); // newest-first
  assert.deepEqual(p.trending, { add: { '300': 5000 }, drop: { '101': 1200 } });
  assert.equal(p.syncedAt, 99);
});

test('trending 500 → payload.trending null, everything else intact', async () => {
  const { fn } = fetchMock({
    [`${SLEEPER_API}/players/nfl/trending/add?lookback_hours=24&limit=50`]: () => resErr(500),
  });
  const p = await fetchSeasonSnapshot('L1', { fetchFn: fn });
  assert.equal(p.trending, null);
  assert.equal(p.rosters.length, 2);
  assert.equal(p.matchups?.length, 2);
});

test('matchups + transactions failures → null fields, no throw', async () => {
  const { fn } = fetchMock({
    [`${SLEEPER_API}/league/L1/matchups/3`]: () => resErr(500),
    [`${SLEEPER_API}/league/L1/transactions/3`]: () => resErr(503),
  });
  const p = await fetchSeasonSnapshot('L1', { fetchFn: fn });
  assert.equal(p.matchups, null);
  assert.equal(p.transactions, null);
  assert.equal(p.leagueName, 'Test League');
});

test('required endpoint failure (rosters 500) → throws', async () => {
  const { fn } = fetchMock({
    [`${SLEEPER_API}/league/L1/rosters`]: () => resErr(500),
  });
  await assert.rejects(
    () => fetchSeasonSnapshot('L1', { fetchFn: fn }),
    /HTTP 500/,
  );
});

test('preseason week 0 is clamped to 1 (matchups fetched at week 1)', async () => {
  const { fn, calls } = fetchMock({
    [`${SLEEPER_API}/state/nfl`]: () => resOk({ week: 0, season_type: 'pre' }),
    [`${SLEEPER_API}/league/L1/matchups/1`]: () => resOk([]),
    [`${SLEEPER_API}/league/L1/transactions/1`]: () => resOk([]),
  });
  const p = await fetchSeasonSnapshot('L1', { fetchFn: fn });
  assert.equal(p.week, 1);
  assert.ok(calls.includes(`${SLEEPER_API}/league/L1/matchups/1`));
});

// ---------------------------------------------------------------------------
// createLeagueSync
// ---------------------------------------------------------------------------

test('refresh dispatches exactly ONE SEASON_SYNCED with the mapped payload', async () => {
  const store = makeStore();
  let dispatches = 0;
  const rawDispatch = store.dispatch;
  store.dispatch = (a) => {
    dispatches += 1;
    assert.equal(a.type, 'SEASON_SYNCED');
    rawDispatch(a);
  };
  const { fn } = fetchMock();
  const sync = createLeagueSync(store, { leagueId: 'L1', fetchFn: fn, now: () => 7 });
  await sync.refresh();

  assert.equal(dispatches, 1);
  const s = store.getState();
  assert.equal(s.leagueId, 'L1');
  assert.equal(s.leagueName, 'Test League');
  assert.equal(s.week, 3);
  assert.equal(s.rosters.length, 2);
  const info = sync.info();
  assert.equal(info.status, 'live');
  assert.equal(info.error, null);
  assert.equal(info.syncs, 1);
  assert.equal(info.lastSyncAt, 7);
});

test('required-endpoint failure: no dispatch, info().error set, state untouched', async () => {
  const store = makeStore();
  const before = store.getState();
  let dispatches = 0;
  const rawDispatch = store.dispatch;
  store.dispatch = (a) => {
    dispatches += 1;
    rawDispatch(a);
  };
  const { fn } = fetchMock({
    [`${SLEEPER_API}/league/L1/users`]: () => resErr(502),
  });
  const sync = createLeagueSync(store, { leagueId: 'L1', fetchFn: fn });
  await sync.refresh();

  assert.equal(dispatches, 0);
  assert.deepEqual(store.getState(), before); // rev unchanged too
  const info = sync.info();
  assert.equal(info.status, 'error');
  assert.match(info.error!, /HTTP 502/);
  assert.equal(info.syncs, 0);
});

test('stop(): refresh becomes a no-op and status is stopped', async () => {
  const store = makeStore();
  const { fn, calls } = fetchMock();
  const sync = createLeagueSync(store, { leagueId: 'L1', fetchFn: fn });
  sync.stop();
  assert.equal(sync.info().status, 'stopped');
  await sync.refresh();
  assert.equal(calls.length, 0);
  assert.equal(store.getState().leagueId, null);
});

test('onStatus emits syncing → live transitions', async () => {
  const store = makeStore();
  const { fn } = fetchMock();
  const seen: string[] = [];
  const sync = createLeagueSync(store, {
    leagueId: 'L1',
    fetchFn: fn,
    onStatus: (i) => seen.push(i.status),
  });
  await sync.refresh();
  assert.deepEqual(seen, ['syncing', 'live']);
});
