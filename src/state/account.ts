// account.ts — the Sleeper ACCOUNT: enter a username ONCE (Hub), resolve it
// to a user_id, and remember it in localStorage. From then on the Hub lists
// the user's real leagues (GET /v1/user/<id>/leagues/nfl/<season>) and one
// tap maps a league's settings onto a LeagueProfile — no IDs to copy around.
//
// Contract:
//   - loadAccount/saveAccount: one synchronous localStorage key
//     'dp:account:v1'; save(null) clears; corrupt blobs load as null.
//   - connectAccount: GET /v1/user/<username>. Sleeper answers unknown
//     usernames with 404 OR a 200 `null` body — both throw a clear "not
//     found" Error (same handling as sleeperMock.resolveUser).
//   - fetchMyLeagues: GET /v1/user/<userId>/leagues/nfl/<season> — the raw
//     league records, typed loosely; a 200 `null` body means no leagues.
//   - mapLeagueToProfile: pure — Sleeper league record → LeagueProfile
//     fields (sans id) + warnings. teams = total_rosters; roster from the
//     roster_positions array (DEF→DST); rounds = roster_positions.length
//     (every slot incl BN drafts); snake assumed; SUPER_FLEX and non-half-PPR
//     scoring become warnings, never errors.
//
// Everything impure is injectable (fetch, storage, clock) so it all runs
// under `node --test`. No preact imports — UI glue lives in HubScreen.
// TypeScript is ERASABLE only (Node 24 strip-types runs the .ts test directly).

import type { LeagueConfig } from './store.ts';
import type { StorageLike } from './persist.ts';
import type { LeagueProfile } from './profiles.ts';
import { SLEEPER_API } from '../sync/sleeper.ts';

export const ACCOUNT_KEY = 'dp:account:v1';

export interface SleeperAccount {
  username: string;      // canonical Sleeper username (response wins over typed casing)
  userId: string;
  displayName: string;
  avatar: string | null; // Sleeper avatar id — kept for later, never fetched by the hub
  connectedAt: number;   // ms epoch
}

/** Raw record from GET /v1/user/<id>/leagues/nfl/<season> — typed loosely,
    mapLeagueToProfile is the only consumer that interprets it. */
export type SleeperLeague = Record<string, unknown>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function defaultStorage(): StorageLike | null {
  const g: any = globalThis as any;
  try {
    const s = g.localStorage;
    if (s && typeof s.getItem === 'function') return s as StorageLike;
  } catch {
    /* private mode */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function loadAccount(storage: StorageLike | null = defaultStorage()): SleeperAccount | null {
  if (!storage) return null;
  try {
    const raw = JSON.parse(storage.getItem(ACCOUNT_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.username !== 'string' || raw.username.length === 0) return null;
    if (typeof raw.userId !== 'string' || raw.userId.length === 0) return null;
    return {
      username: raw.username,
      userId: raw.userId,
      displayName:
        typeof raw.displayName === 'string' && raw.displayName.length > 0
          ? raw.displayName
          : raw.username,
      avatar: typeof raw.avatar === 'string' ? raw.avatar : null,
      connectedAt: Number.isFinite(raw.connectedAt) ? Number(raw.connectedAt) : 0,
    };
  } catch {
    return null;
  }
}

/** Persist the account; `null` disconnects (removes the key — reversible,
    reconnecting is one lookup away). */
export function saveAccount(
  a: SleeperAccount | null,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (a === null) storage.removeItem(ACCOUNT_KEY);
    else storage.setItem(ACCOUNT_KEY, JSON.stringify(a));
  } catch {
    /* quota / private mode — account stays in memory for the session */
  }
}

// ---------------------------------------------------------------------------
// API lookups — injectable fetch, one-line Errors on failure
// ---------------------------------------------------------------------------

export async function connectAccount(
  username: string,
  fetchFn?: FetchLike,
  now: () => number = () => Date.now(),
): Promise<SleeperAccount> {
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
    username: typeof data.username === 'string' && data.username.length > 0 ? data.username : name,
    userId: String(uid),
    displayName:
      typeof data.display_name === 'string' && data.display_name.length > 0
        ? data.display_name
        : name,
    avatar: typeof data.avatar === 'string' ? data.avatar : null,
    connectedAt: now(),
  };
}

export async function fetchMyLeagues(
  userId: string,
  season: string,
  fetchFn?: FetchLike,
): Promise<SleeperLeague[]> {
  const f = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const uid = encodeURIComponent(String(userId ?? '').trim());
  const yr = encodeURIComponent(String(season ?? '').trim());
  const res = await f(`${SLEEPER_API}/user/${uid}/leagues/nfl/${yr}`, {
    cache: 'no-store',
  } as RequestInit);
  if (!res.ok) throw new Error(`Sleeper leagues lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  if (data === null) return []; // Sleeper's "no leagues" answer
  if (!Array.isArray(data)) throw new Error('unexpected leagues response from Sleeper');
  return data as SleeperLeague[];
}

// ---------------------------------------------------------------------------
// League record → profile fields (pure)
// ---------------------------------------------------------------------------

// Sleeper roster_positions entry → the store's roster key (DEF → DST).
const POSITION_MAP: Record<string, string> = {
  QB: 'QB',
  RB: 'RB',
  WR: 'WR',
  TE: 'TE',
  FLEX: 'FLEX',
  K: 'K',
  DEF: 'DST',
  BN: 'BN',
};

/** Map a raw Sleeper league record onto LeagueProfile fields (the caller
    picks the id — newProfileId for a fresh profile, or the existing id when
    a profile already carries this sleeperLeagueId). Recoverable oddities
    (superflex, non-half-PPR scoring) are warnings; missing fields simply
    omit the corresponding league key so config defaults apply. */
export function mapLeagueToProfile(
  league: Record<string, unknown>,
): { profile: Omit<LeagueProfile, 'id'>; warnings: string[] } {
  const raw: Record<string, unknown> =
    league !== null && typeof league === 'object' && !Array.isArray(league) ? league : {};
  const warnings: string[] = [];
  const cfg: Partial<LeagueConfig> = { snake: true };

  const teams = Number(raw.total_rosters);
  if (Number.isInteger(teams) && teams >= 2) cfg.teams = teams;

  const positions = Array.isArray(raw.roster_positions)
    ? (raw.roster_positions as unknown[]).map(String)
    : null;
  if (positions && positions.length > 0) {
    // Every slot incl BN gets drafted in a Sleeper draft — rounds is the
    // full array length, not just the starters.
    cfg.rounds = positions.length;
    const roster: Record<string, number> = {};
    let superflexWarned = false;
    for (const slot of positions) {
      const key = POSITION_MAP[slot];
      if (key) {
        roster[key] = (roster[key] ?? 0) + 1;
      } else if (slot === 'SUPER_FLEX' && !superflexWarned) {
        warnings.push('superflex not modeled');
        superflexWarned = true;
      }
      // other exotic slots (IDP etc.) still count toward rounds, nothing else
    }
    cfg.roster = roster;
    if ((roster.FLEX ?? 0) > 0) cfg.flexEligible = ['RB', 'WR', 'TE'];
  }

  const scoring =
    raw.scoring_settings !== null && typeof raw.scoring_settings === 'object'
      ? (raw.scoring_settings as Record<string, unknown>)
      : null;
  const rec = scoring ? scoring.rec : undefined;
  if (typeof rec === 'number' && rec !== 0.5) {
    warnings.push(`league is ${rec}-PPR, board projections are half-PPR`);
  }

  const name =
    typeof raw.name === 'string' && raw.name.trim().length > 0
      ? raw.name.trim()
      : 'Sleeper league';

  return {
    profile: {
      name,
      league: cfg,
      board: 'board.json',
      sleeperLeagueId: raw.league_id != null ? String(raw.league_id) : null,
      sleeperDraftId: raw.draft_id != null ? String(raw.draft_id) : null,
    },
    warnings,
  };
}

/** Pure: the profile already linked to this Sleeper league, if any — the
    hub's "Connected ✓" test and its create-vs-update switch. */
export function findProfileBySleeperLeagueId(
  profiles: LeagueProfile[],
  leagueId: string | null,
): LeagueProfile | null {
  if (!leagueId) return null;
  return profiles.find((p) => p.sleeperLeagueId === leagueId) ?? null;
}
