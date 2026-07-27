// sleeperMock.ts — Sleeper MOCK-draft discovery + league mapping (plan "Sleeper
// sync" follow-up: rehearse against a live mock room before draft day).
//
// Contract:
//   - resolveUser: GET /v1/user/<username> → { userId, displayName }.
//     Sleeper answers unknown usernames with 404 OR a 200 `null` body — both
//     throw a clear "not found" Error; any other malformed body throws too.
//   - fetchUserDrafts: GET /v1/user/<userId>/drafts/nfl/<season> → the user's
//     drafts for that season, RAW. Mock drafts are the ones with
//     league_id === null (isMockDraft) — filtering is the caller's business.
//   - fetchDraft: GET /v1/draft/<draftId> → the raw draft metadata object.
//   - mapDraftToLeague: pure — Sleeper draft metadata → Partial<LeagueConfig>
//     for SET_LEAGUE, plus warnings. Unsupported shapes (auction, missing
//     teams/rounds) return { error } instead of guessing. slot comes from
//     draft_order[myUserId]; when absent the partial simply OMITS slot and
//     warns — Setup keeps whatever slot is already configured.
//
// Everything impure is injectable (fetch) so it all runs under `node --test`.
// No preact imports here — UI glue is a separate work item; this module is
// framework-free. TypeScript is ERASABLE only (Node 24 strip-types runs the
// .ts test directly).

import type { LeagueConfig } from '../state/store.ts';
import { SLEEPER_API } from './sleeper.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SleeperUser {
  userId: string;
  displayName: string;
}

export interface DraftMapping {
  league: Partial<LeagueConfig>;
  warnings: string[];
}

export type MapDraftResult = DraftMapping | { error: string };

// Sleeper roster-slot settings key → the store's roster key (slots_def → DST).
const SLOT_KEYS: Array<[string, string]> = [
  ['slots_qb', 'QB'],
  ['slots_rb', 'RB'],
  ['slots_wr', 'WR'],
  ['slots_te', 'TE'],
  ['slots_flex', 'FLEX'],
  ['slots_k', 'K'],
  ['slots_def', 'DST'],
  ['slots_bn', 'BN'],
];

// ---------------------------------------------------------------------------
// API lookups — all injectable-fetch, all throw one-line Errors on failure
// ---------------------------------------------------------------------------

export async function resolveUser(
  username: string,
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<SleeperUser> {
  // NB: never pass the bare global `fetch` around — unbound fetch throws
  // "Illegal invocation" in browsers. Always wrap.
  const f = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const name = String(username ?? '').trim();
  const res = await f(`${SLEEPER_API}/user/${encodeURIComponent(name)}`, {
    cache: 'no-store',
  } as RequestInit);
  if (res.status === 404) throw new Error(`Sleeper user "${name}" not found`);
  if (!res.ok) throw new Error(`Sleeper user lookup failed (HTTP ${res.status})`);
  const data = (await res.json()) as Record<string, unknown> | null;
  if (data === null) throw new Error(`Sleeper user "${name}" not found`);
  const uid = data?.user_id;
  if (typeof uid !== 'string' && typeof uid !== 'number') {
    throw new Error('unexpected user response from Sleeper (no user_id)');
  }
  return {
    userId: String(uid),
    displayName: typeof data.display_name === 'string' ? data.display_name : name,
  };
}

export async function fetchUserDrafts(
  userId: string,
  season: string,
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Array<Record<string, unknown>>> {
  const f = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const uid = encodeURIComponent(String(userId ?? '').trim());
  const yr = encodeURIComponent(String(season ?? '').trim());
  const res = await f(`${SLEEPER_API}/user/${uid}/drafts/nfl/${yr}`, {
    cache: 'no-store',
  } as RequestInit);
  if (!res.ok) throw new Error(`Sleeper drafts lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('unexpected drafts response from Sleeper');
  return data as Array<Record<string, unknown>>;
}

export async function fetchDraft(
  draftId: string,
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Record<string, unknown>> {
  const f = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const res = await f(`${SLEEPER_API}/draft/${encodeURIComponent(String(draftId ?? '').trim())}`, {
    cache: 'no-store',
  } as RequestInit);
  if (!res.ok) throw new Error(`Sleeper draft lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('unexpected draft response from Sleeper');
  }
  return data as Record<string, unknown>;
}

/** GET /v1/draft/<draftId>/picks → the raw pick array (pick_no, player_id,
    metadata, …). Additive helper for the in-app mock-calibration flow (Sim
    Lab keeps slim {draft, picks} pairs in dp:mocks:v1). */
export async function fetchDraftPicks(
  draftId: string,
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Array<Record<string, unknown>>> {
  const f = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const res = await f(`${SLEEPER_API}/draft/${encodeURIComponent(String(draftId ?? '').trim())}/picks`, {
    cache: 'no-store',
  } as RequestInit);
  if (!res.ok) throw new Error(`Sleeper draft picks lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('unexpected draft picks response from Sleeper');
  return data as Array<Record<string, unknown>>;
}

/** Mock drafts are the ones without a league — league_id is null (== also
    catches drafts that omit the key entirely). Pure — unit-tested. */
export function isMockDraft(draft: Record<string, unknown>): boolean {
  return draft != null && draft.league_id == null;
}

// ---------------------------------------------------------------------------
// Draft metadata → LeagueConfig partial (pure)
// ---------------------------------------------------------------------------

/** Map GET /v1/draft/<id> metadata onto the store's LeagueConfig shape.
    Returns { error } for shapes the engine cannot model (auction, missing
    teams/rounds); recoverable oddities become warnings instead. */
export function mapDraftToLeague(draft: Record<string, unknown>, myUserId: string): MapDraftResult {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    return { error: 'no draft metadata from Sleeper' };
  }
  const type = String(draft.type ?? '');
  if (type === 'auction') {
    return { error: 'auction drafts are not supported — the engine models snake/linear only' };
  }

  const settings = (draft.settings ?? null) as Record<string, unknown> | null;
  const teams = settings ? Number(settings.teams) : NaN;
  const rounds = settings ? Number(settings.rounds) : NaN;
  if (!Number.isInteger(teams) || teams < 2 || !Number.isInteger(rounds) || rounds < 1) {
    return { error: 'draft settings are missing teams/rounds — cannot map to a league' };
  }

  const warnings: string[] = [];

  // Roster: mirror Sleeper faithfully — a slot key present in settings maps
  // through (even at 0, so a K-less mock does NOT inherit the default K:1);
  // absent keys stay absent.
  const roster: Record<string, number> = {};
  for (const [from, to] of SLOT_KEYS) {
    const v = Number((settings as Record<string, unknown>)[from]);
    if (Number.isInteger(v) && v >= 0) roster[to] = v;
  }

  const league: Partial<LeagueConfig> = {
    teams,
    rounds,
    snake: type === 'snake',
    roster,
  };
  if ((roster.FLEX ?? 0) > 0) league.flexEligible = ['RB', 'WR', 'TE'];

  const superflex = Number(settings ? settings.slots_super_flex : NaN);
  if (Number.isInteger(superflex) && superflex > 0) {
    warnings.push('superflex draft — the engine does not model a QB-eligible flex, QBs will be undervalued');
  }

  // slot: draft_order is { user_id → slot }. Missing (mock rooms fill it only
  // once seats are taken) or my id absent → omit slot entirely and warn;
  // SET_LEAGUE then leaves the configured slot untouched.
  const order = (draft.draft_order ?? null) as Record<string, unknown> | null;
  const slot = order ? Number(order[String(myUserId ?? '')]) : NaN;
  if (Number.isInteger(slot) && slot >= 1 && slot <= teams) {
    league.slot = slot;
  } else {
    warnings.push('slot unknown — pick it in Setup');
  }

  return { league, warnings };
}
