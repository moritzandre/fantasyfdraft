// account.test.ts — Sleeper account storage, user/leagues lookups and the
// league→profile mapping, under node --test with an injectable fetch mock
// (same harness style as sleeperMock.test.ts).
// Run: node --test "src/state/*.test.ts"   (Node 24 strip-types — erasable TS)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLEEPER_API } from '../sync/sleeper.ts';
import {
  ACCOUNT_KEY,
  connectAccount,
  fetchMyLeagues,
  findProfileBySleeperLeagueId,
  loadAccount,
  mapLeagueToProfile,
  saveAccount,
} from './account.ts';
import type { SleeperAccount } from './account.ts';
import type { StorageLike } from './persist.ts';
import { makeDefaultProfile } from './profiles.ts';

// ---------------------------------------------------------------------------
// Harness
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

/** A realistic half-PPR 12-team league record (GET /v1/user/<id>/leagues/nfl/<season>). */
function leagueFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    league_id: 'L900',
    name: '  Kreisliga Bochum  ',
    status: 'pre_draft',
    sport: 'nfl',
    season: '2026',
    total_rosters: 12,
    draft_id: 'D77',
    roster_positions: [
      'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
    ],
    scoring_settings: { rec: 0.5, pass_td: 4, rush_td: 6 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Storage round-trip
// ---------------------------------------------------------------------------

test('account storage: save/load round-trip; null clears; corrupt loads as null', () => {
  const storage = fakeStorage();
  assert.equal(loadAccount(storage), null); // absent
  const acc: SleeperAccount = {
    username: 'moritz',
    userId: 'u1',
    displayName: 'Moritz',
    avatar: 'abc123',
    connectedAt: 1_753_600_000_000,
  };
  saveAccount(acc, storage);
  assert.deepEqual(loadAccount(storage), acc);
  // corrupt blob → null, never a throw
  storage.setItem(ACCOUNT_KEY, '{not json');
  assert.equal(loadAccount(storage), null);
  storage.setItem(ACCOUNT_KEY, JSON.stringify({ username: 'x' })); // no userId
  assert.equal(loadAccount(storage), null);
  // null disconnects — the key is GONE, not an empty record
  saveAccount(acc, storage);
  saveAccount(null, storage);
  assert.ok(!storage.map.has(ACCOUNT_KEY));
  assert.equal(loadAccount(storage), null);
  assert.equal(loadAccount(null), null); // no storage at all (private mode)
});

// ---------------------------------------------------------------------------
// connectAccount
// ---------------------------------------------------------------------------

test('connectAccount hits /v1/user/<username>, returns the canonical account', async () => {
  const { fn, calls } = fetchMock(() =>
    resOk({ user_id: 'u1', username: 'moritz', display_name: 'Moritz', avatar: 'abc123' }),
  );
  const acc = await connectAccount('  Moritz ', fn, () => 42);
  assert.equal(calls[0].url, `${SLEEPER_API}/user/Moritz`); // trimmed + encoded
  assert.deepEqual(acc, {
    username: 'moritz', // response casing wins over what was typed
    userId: 'u1',
    displayName: 'Moritz',
    avatar: 'abc123',
    connectedAt: 42, // injected clock
  });
});

test('connectAccount falls back to the typed name when the response is sparse', async () => {
  const { fn } = fetchMock(() => resOk({ user_id: 12345 })); // numeric id, no names, no avatar
  const acc = await connectAccount('ghostname', fn, () => 7);
  assert.deepEqual(acc, {
    username: 'ghostname',
    userId: '12345',
    displayName: 'ghostname',
    avatar: null,
    connectedAt: 7,
  });
});

test('connectAccount throws clearly on 404, 200-null body, and malformed payloads', async () => {
  const notFound = fetchMock(() => resErr(404));
  await assert.rejects(() => connectAccount('nobody', notFound.fn), /"nobody" not found/);
  // Sleeper also answers unknown usernames with a 200 `null` body
  const nullBody = fetchMock(() => resOk(null));
  await assert.rejects(() => connectAccount('ghost', nullBody.fn), /"ghost" not found/);
  const malformed = fetchMock(() => resOk({ display_name: 'NoId' }));
  await assert.rejects(() => connectAccount('weird', malformed.fn), /unexpected user response/);
  const serverErr = fetchMock(() => resErr(500));
  await assert.rejects(() => connectAccount('x', serverErr.fn), /HTTP 500/);
});

// ---------------------------------------------------------------------------
// fetchMyLeagues
// ---------------------------------------------------------------------------

test('fetchMyLeagues returns the raw league list; 200-null means no leagues', async () => {
  const leagues = [leagueFixture(), leagueFixture({ league_id: 'L901', name: 'Other' })];
  const { fn, calls } = fetchMock(() => resOk(leagues));
  const got = await fetchMyLeagues('u1', '2026', fn);
  assert.equal(calls[0].url, `${SLEEPER_API}/user/u1/leagues/nfl/2026`);
  assert.equal(got.length, 2);
  assert.equal(got[0].league_id, 'L900'); // raw records, untouched

  const empty = fetchMock(() => resOk(null));
  assert.deepEqual(await fetchMyLeagues('u1', '2026', empty.fn), []);
});

test('fetchMyLeagues throws on non-ok and on non-array payloads', async () => {
  const err = fetchMock(() => resErr(429));
  await assert.rejects(() => fetchMyLeagues('u1', '2026', err.fn), /HTTP 429/);
  const bad = fetchMock(() => resOk({ nope: true }));
  await assert.rejects(() => fetchMyLeagues('u1', '2026', bad.fn), /unexpected leagues response/);
});

// ---------------------------------------------------------------------------
// mapLeagueToProfile
// ---------------------------------------------------------------------------

test('mapLeagueToProfile: full mapping — DEF→DST, rounds incl BN, flex eligibility, ids', () => {
  const { profile, warnings } = mapLeagueToProfile(leagueFixture());
  assert.deepEqual(warnings, []); // 0.5 rec is exactly the board's scoring
  assert.deepEqual(profile, {
    name: 'Kreisliga Bochum', // trimmed
    league: {
      snake: true,
      teams: 12,
      rounds: 16, // roster_positions.length — every slot incl BN drafts
      roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
      flexEligible: ['RB', 'WR', 'TE'],
    },
    board: 'board.json',
    sleeperLeagueId: 'L900',
    sleeperDraftId: 'D77',
  });
});

test('mapLeagueToProfile warns ONCE on SUPER_FLEX and still maps; rounds count it', () => {
  const fixture = leagueFixture({
    roster_positions: ['QB', 'SUPER_FLEX', 'RB', 'WR', 'SUPER_FLEX', 'BN'],
  });
  const { profile, warnings } = mapLeagueToProfile(fixture);
  assert.deepEqual(warnings, ['superflex not modeled']);
  assert.equal(profile.league.rounds, 6); // exotic slots still draft
  assert.deepEqual(profile.league.roster, { QB: 1, RB: 1, WR: 1, BN: 1 });
  assert.equal('flexEligible' in profile.league, false); // no FLEX slot → no eligibility
});

test('mapLeagueToProfile warns when scoring_settings.rec differs from half-PPR', () => {
  const full = mapLeagueToProfile(leagueFixture({ scoring_settings: { rec: 1 } }));
  assert.deepEqual(full.warnings, ['league is 1-PPR, board projections are half-PPR']);
  const std = mapLeagueToProfile(leagueFixture({ scoring_settings: { rec: 0 } }));
  assert.deepEqual(std.warnings, ['league is 0-PPR, board projections are half-PPR']);
  // missing scoring_settings → unknown, NOT a warning
  const unknown = mapLeagueToProfile(leagueFixture({ scoring_settings: null }));
  assert.deepEqual(unknown.warnings, []);
});

test('mapLeagueToProfile: missing fields fall back to safe defaults, never throw', () => {
  const { profile, warnings } = mapLeagueToProfile({});
  assert.deepEqual(warnings, []);
  assert.deepEqual(profile, {
    name: 'Sleeper league',
    league: { snake: true }, // teams/rounds/roster omitted → config defaults apply
    board: 'board.json',
    sleeperLeagueId: null,
    sleeperDraftId: null,
  });
  // numeric league_id stringifies; missing draft_id → null
  const p2 = mapLeagueToProfile(leagueFixture({ league_id: 987654, draft_id: undefined }));
  assert.equal(p2.profile.sleeperLeagueId, '987654');
  assert.equal(p2.profile.sleeperDraftId, null);
});

// ---------------------------------------------------------------------------
// findProfileBySleeperLeagueId
// ---------------------------------------------------------------------------

test('findProfileBySleeperLeagueId matches linked profiles; null/absent → null', () => {
  const linked = { ...makeDefaultProfile({}), id: 'kreisliga', sleeperLeagueId: 'L900' };
  const profiles = [makeDefaultProfile({}), linked];
  assert.equal(findProfileBySleeperLeagueId(profiles, 'L900'), linked);
  assert.equal(findProfileBySleeperLeagueId(profiles, 'L999'), null);
  assert.equal(findProfileBySleeperLeagueId(profiles, null), null);
  assert.equal(findProfileBySleeperLeagueId([], 'L900'), null);
});
