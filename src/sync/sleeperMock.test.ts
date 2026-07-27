// sleeperMock.test.ts — mock-draft discovery + league mapping under node --test
// with an injectable fetch mock (same harness style as sleeper.test.ts).
// Run: node --test src/sync/sleeperMock.test.ts   (Node 24 strip-types — erasable TS)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLEEPER_API } from './sleeper.ts';
import {
  fetchDraft,
  fetchUserDrafts,
  isMockDraft,
  mapDraftToLeague,
  resolveUser,
} from './sleeperMock.ts';
import type { DraftMapping } from './sleeperMock.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

/** A realistic 12-team snake mock-draft metadata object (GET /v1/draft/<id>). */
function draftFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draft_id: 'D1',
    type: 'snake',
    status: 'pre_draft',
    sport: 'nfl',
    season: '2026',
    league_id: null, // mock room
    draft_order: { u1: 7, u2: 1, u3: 12 },
    settings: {
      teams: 12,
      rounds: 16,
      slots_qb: 1,
      slots_rb: 2,
      slots_wr: 2,
      slots_te: 1,
      slots_flex: 2,
      slots_k: 1,
      slots_def: 1, // Sleeper's name for DST
      slots_bn: 6,
      pick_timer: 60,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveUser
// ---------------------------------------------------------------------------

test('resolveUser hits /v1/user/<username> and returns userId + displayName', async () => {
  const { fn, calls } = fetchMock(() => resOk({ user_id: 'u1', display_name: 'Moritz', avatar: 'x' }));
  const u = await resolveUser('  moritz ', fn);
  assert.equal(calls[0].url, `${SLEEPER_API}/user/moritz`); // trimmed + encoded
  assert.deepEqual(u, { userId: 'u1', displayName: 'Moritz' });
});

test('resolveUser throws clearly on 404, 200-null body, and malformed payloads', async () => {
  const notFound = fetchMock(() => resErr(404));
  await assert.rejects(() => resolveUser('nobody', notFound.fn), /"nobody" not found/);

  // Sleeper also answers unknown usernames with a 200 `null` body
  const nullBody = fetchMock(() => resOk(null));
  await assert.rejects(() => resolveUser('ghost', nullBody.fn), /"ghost" not found/);

  const malformed = fetchMock(() => resOk({ display_name: 'NoId' }));
  await assert.rejects(() => resolveUser('weird', malformed.fn), /unexpected user response/);

  const serverErr = fetchMock(() => resErr(500));
  await assert.rejects(() => resolveUser('x', serverErr.fn), /HTTP 500/);
});

// ---------------------------------------------------------------------------
// fetchUserDrafts + isMockDraft
// ---------------------------------------------------------------------------

test('fetchUserDrafts returns ALL drafts; isMockDraft keeps only league_id null', async () => {
  const drafts = [
    { draft_id: 'm1', league_id: null, type: 'snake' }, // mock
    { draft_id: 'l1', league_id: 'L900', type: 'snake' }, // real league draft
    { draft_id: 'm2', league_id: null, type: 'snake' }, // mock
  ];
  const { fn, calls } = fetchMock(() => resOk(drafts));
  const all = await fetchUserDrafts('u1', '2026', fn);
  assert.equal(calls[0].url, `${SLEEPER_API}/user/u1/drafts/nfl/2026`);
  assert.equal(all.length, 3); // raw — league drafts included
  assert.deepEqual(all.filter(isMockDraft).map((d) => d.draft_id), ['m1', 'm2']);
});

test('fetchUserDrafts throws on non-ok and on non-array payloads', async () => {
  const err = fetchMock(() => resErr(429));
  await assert.rejects(() => fetchUserDrafts('u1', '2026', err.fn), /HTTP 429/);
  const bad = fetchMock(() => resOk({ nope: true }));
  await assert.rejects(() => fetchUserDrafts('u1', '2026', bad.fn), /unexpected drafts response/);
});

// ---------------------------------------------------------------------------
// fetchDraft
// ---------------------------------------------------------------------------

test('fetchDraft returns the raw metadata object and throws on non-ok', async () => {
  const { fn, calls } = fetchMock(() => resOk(draftFixture()));
  const d = await fetchDraft('D1', fn);
  assert.equal(calls[0].url, `${SLEEPER_API}/draft/D1`);
  assert.equal(d.draft_id, 'D1');

  const err = fetchMock(() => resErr(404));
  await assert.rejects(() => fetchDraft('nope', err.fn), /HTTP 404/);
  const nullBody = fetchMock(() => resOk(null));
  await assert.rejects(() => fetchDraft('D1', nullBody.fn), /unexpected draft response/);
});

// ---------------------------------------------------------------------------
// mapDraftToLeague
// ---------------------------------------------------------------------------

test('mapDraftToLeague maps a 12-team snake mock: roster (slots_def→DST), my slot, no warnings', () => {
  const r = mapDraftToLeague(draftFixture(), 'u1') as DraftMapping;
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.league, {
    teams: 12,
    rounds: 16,
    snake: true,
    roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
    flexEligible: ['RB', 'WR', 'TE'],
    slot: 7, // draft_order.u1 — data, never assumed
  });
});

test('mapDraftToLeague without draft_order warns and OMITS slot from the partial', () => {
  const r = mapDraftToLeague(draftFixture({ draft_order: null }), 'u1') as DraftMapping;
  assert.equal('slot' in r.league, false); // SET_LEAGUE must not clobber the configured slot
  assert.deepEqual(r.warnings, ['slot unknown — pick it in Setup']);

  // same when the order exists but I'm not seated yet
  const r2 = mapDraftToLeague(draftFixture(), 'stranger') as DraftMapping;
  assert.equal('slot' in r2.league, false);
  assert.deepEqual(r2.warnings, ['slot unknown — pick it in Setup']);
});

test('mapDraftToLeague rejects auction drafts with { error }', () => {
  const r = mapDraftToLeague(draftFixture({ type: 'auction' }), 'u1');
  assert.match((r as { error: string }).error, /auction/);
  assert.equal('league' in r, false);
});

test('mapDraftToLeague rejects missing settings / missing teams-rounds with { error }', () => {
  const noSettings = mapDraftToLeague(draftFixture({ settings: null }), 'u1');
  assert.match((noSettings as { error: string }).error, /teams\/rounds/);
  const noTeams = mapDraftToLeague(
    draftFixture({ settings: { rounds: 16, slots_qb: 1 } }),
    'u1',
  );
  assert.match((noTeams as { error: string }).error, /teams\/rounds/);
});

test('mapDraftToLeague warns on superflex but still returns the mapping', () => {
  const fixture = draftFixture();
  (fixture.settings as Record<string, unknown>).slots_super_flex = 1;
  const r = mapDraftToLeague(fixture, 'u1') as DraftMapping;
  assert.equal(r.league.teams, 12);
  assert.equal(r.league.slot, 7);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /superflex/);
});

test('mapDraftToLeague: linear type maps to snake:false; zero-K mock keeps K:0 explicit', () => {
  const fixture = draftFixture({ type: 'linear' });
  (fixture.settings as Record<string, unknown>).slots_k = 0;
  const r = mapDraftToLeague(fixture, 'u2') as DraftMapping;
  assert.equal(r.league.snake, false);
  assert.equal((r.league.roster as Record<string, number>).K, 0); // does NOT inherit default K:1
  assert.equal(r.league.slot, 1);
});
