// season.ts — the per-profile SEASON store (plan Phase A: "Season store").
// One store per league profile, key 'dp:season:<profileId>:v1' — never the
// bare '' context; the default profile uses the literal id 'default'.
//
// Design invariants (mirrors store.ts):
//   - Pure reducer `applySeasonAction(state, action, ts)` — replay-testable,
//     no clock/storage access inside.
//   - Persistence is SYNCHRONOUS localStorage on EVERY dispatch (the CLAUDE.md
//     invariant), never debounced. Storage is injectable so this module runs
//     under plain `node --test`. A corrupt persisted blob boots fresh.
//   - League sync dispatches only ONE atomic SEASON_SYNCED per snapshot
//     (src/sync/league.ts); on sync failure the store is never touched.
//   - Derived data (FA pool, my matchup, current week) is NEVER stored —
//     recomputed via the pure `seasonSelectors` below.
//
// TypeScript here is ERASABLE only (plain annotations — Node strip-types runs
// the .ts tests directly; no enums, no namespaces, no parameter properties).

import type { StorageLike } from './persist.ts';

// ---------------------------------------------------------------------------
// Types — the season contract the UI codes against.
// ---------------------------------------------------------------------------

export interface RosterEntry {
  rosterId: number;
  ownerId: string;
  players: string[]; // sleeper player ids
  starters: string[]; // sleeper player ids, slot order ("0" = empty slot)
  wins: number;
  losses: number;
  ties: number;
  fpts: number;
}

export interface MatchupEntry {
  rosterId: number;
  matchupId: number | null;
  points: number;
  starters: string[];
}

export interface TxEntry {
  id: string;
  type: string;
  status: string;
  week: number;
  adds: Record<string, number> | null; // sleeper id → roster_id
  drops: Record<string, number> | null;
  created: number;
}

/** ONE atomic sync snapshot (produced by src/sync/league.ts). Best-effort
    fields (matchups/transactions/trending) are null when their endpoint
    failed — the reducer keeps the previous value for those. */
export interface SeasonSyncPayload {
  leagueId: string;
  leagueName: string | null;
  week: number;
  users: Record<string, { name: string; teamName: string | null }>;
  rosters: RosterEntry[];
  matchups: MatchupEntry[] | null;
  transactions: TxEntry[] | null;
  trending: { add: Record<string, number>; drop: Record<string, number> } | null;
  syncedAt: number;
}

export type SeasonAction =
  | { type: 'SEASON_SYNCED'; payload: SeasonSyncPayload }
  | { type: 'SET_LEAGUE_ID'; leagueId: string | null }
  | { type: 'SET_MY_ROSTER'; rosterId: number | null }
  | { type: 'SET_WEEK_OVERRIDE'; week: number | null }
  | { type: 'SET_SEASON_UI'; ui: Partial<SeasonUi> }
  | { type: 'RESET_SEASON' };

export interface SeasonUi {
  lastScreen: string;
  [k: string]: unknown;
}

export interface SeasonState {
  rev: number; // increments on every dispatch
  schemaVersion: 1;
  leagueId: string | null;
  leagueName: string | null;
  myRosterId: number | null;
  week: number; // from the last sync (Sleeper NFL state), clamped 1..18
  weekOverride: number | null; // manual override, wins in currentWeek()
  users: Record<string, { name: string; teamName: string | null }>;
  rosters: RosterEntry[];
  matchups: MatchupEntry[]; // CURRENT week only — replaced wholesale on sync
  transactions: TxEntry[]; // newest-first, cap TX_CAP
  trending: { add: Record<string, number>; drop: Record<string, number>; at: number } | null;
  syncedAt: number | null;
  ui: SeasonUi;
}

export interface SeasonStore {
  getState(): SeasonState;
  dispatch(a: SeasonAction): void; // reduce → rev++ → SYNCHRONOUS persist → notify
  subscribe(fn: (s: SeasonState) => void): () => void;
  profileId: string;
}

export const TX_CAP = 50;
export const MIN_WEEK = 1;
export const MAX_WEEK = 18;

/** The one storage key per profile — '' is never used as a profile id. */
export function seasonKey(profileId: string): string {
  const id = typeof profileId === 'string' && profileId.length > 0 ? profileId : 'default';
  return `dp:season:${id}:v1`;
}

const UI_DEFAULTS: SeasonUi = { lastScreen: 'coach' };

export function initialSeasonState(): SeasonState {
  return {
    rev: 0,
    schemaVersion: 1,
    leagueId: null,
    leagueName: null,
    myRosterId: null,
    week: 1,
    weekOverride: null,
    users: {},
    rosters: [],
    matchups: [],
    transactions: [],
    trending: null,
    syncedAt: null,
    ui: { ...UI_DEFAULTS },
  };
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

function clampWeek(w: unknown, fallback: number): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return fallback;
  return Math.max(MIN_WEEK, Math.min(MAX_WEEK, Math.trunc(w)));
}

/** Merge incoming transactions with the kept history: dedupe by id (incoming
    wins), newest-first by `created`, cap TX_CAP. Idempotent by construction —
    re-syncing the same payload changes nothing. */
function mergeTransactions(existing: TxEntry[], incoming: TxEntry[]): TxEntry[] {
  const seen = new Set(incoming.map((t) => t.id));
  return [...incoming, ...existing.filter((t) => !seen.has(t.id))]
    .sort((x, y) => y.created - x.created)
    .slice(0, TX_CAP);
}

/** The pure reducer. `ts` is the dispatch clock (injectable via the store) —
    used only as the syncedAt fallback when a payload carries none. */
export function applySeasonAction(s: SeasonState, a: SeasonAction, ts: number): SeasonState {
  switch (a.type) {
    case 'SEASON_SYNCED': {
      const p = a.payload;
      if (!p || typeof p !== 'object') return s;
      const syncedAt = typeof p.syncedAt === 'number' ? p.syncedAt : ts;
      return {
        ...s,
        leagueId: typeof p.leagueId === 'string' && p.leagueId ? p.leagueId : s.leagueId,
        leagueName: typeof p.leagueName === 'string' ? p.leagueName : s.leagueName,
        week: clampWeek(p.week, s.week),
        users: p.users && typeof p.users === 'object' ? p.users : s.users,
        rosters: Array.isArray(p.rosters) ? p.rosters : s.rosters,
        // best-effort fields: null ⇒ keep what we had (stale beats empty)
        matchups: Array.isArray(p.matchups) ? p.matchups : s.matchups,
        transactions: mergeTransactions(
          s.transactions,
          Array.isArray(p.transactions) ? p.transactions : [],
        ),
        trending: p.trending
          ? { add: p.trending.add ?? {}, drop: p.trending.drop ?? {}, at: syncedAt }
          : s.trending,
        syncedAt,
      };
    }

    case 'SET_LEAGUE_ID': {
      const id = typeof a.leagueId === 'string' ? a.leagueId.trim() : '';
      return { ...s, leagueId: id.length > 0 ? id : null };
    }

    case 'SET_MY_ROSTER':
      return {
        ...s,
        myRosterId: Number.isInteger(a.rosterId) ? (a.rosterId as number) : null,
      };

    case 'SET_WEEK_OVERRIDE':
      return {
        ...s,
        weekOverride:
          typeof a.week === 'number' && Number.isFinite(a.week)
            ? clampWeek(a.week, MIN_WEEK)
            : null,
      };

    case 'SET_SEASON_UI':
      return { ...s, ui: { ...s.ui, ...a.ui } };

    case 'RESET_SEASON':
      return initialSeasonState();
  }
  return s;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function defaultStorage(): StorageLike | null {
  const g: any = globalThis as any;
  try {
    const st = g.localStorage;
    if (st && typeof st.getItem === 'function' && typeof st.setItem === 'function') {
      return st as StorageLike;
    }
  } catch {
    /* private mode */
  }
  return null;
}

/** Parse a persisted blob; anything corrupt/foreign boots fresh. Forward-safe:
    unknown extra keys are dropped by rebuilding over the initial shape. */
function restoreState(raw: string | null): SeasonState | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const o: any = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    if (o.schemaVersion !== 1) return null;
    if (typeof o.rev !== 'number' || !(o.rev >= 0)) return null;
    const init = initialSeasonState();
    return {
      ...init,
      ...o,
      week: clampWeek(o.week, init.week),
      users: o.users && typeof o.users === 'object' ? o.users : {},
      rosters: Array.isArray(o.rosters) ? o.rosters : [],
      matchups: Array.isArray(o.matchups) ? o.matchups : [],
      transactions: Array.isArray(o.transactions) ? o.transactions.slice(0, TX_CAP) : [],
      ui: { ...UI_DEFAULTS, ...(o.ui && typeof o.ui === 'object' ? o.ui : {}) },
    } as SeasonState;
  } catch {
    return null;
  }
}

export function createSeasonStore(boot: {
  profileId: string;
  storage?: StorageLike | null; // injectable — default: real localStorage
  now?: () => number; // injectable clock for deterministic tests
}): SeasonStore {
  const profileId =
    typeof boot.profileId === 'string' && boot.profileId.length > 0 ? boot.profileId : 'default';
  const storage = boot.storage === undefined ? defaultStorage() : boot.storage;
  const now = boot.now ?? (() => Date.now());
  const key = seasonKey(profileId);
  const subs = new Set<(s: SeasonState) => void>();

  let current: SeasonState;
  let restored: SeasonState | null = null;
  if (storage) {
    try {
      restored = restoreState(storage.getItem(key));
    } catch {
      restored = null;
    }
  }
  current = restored ?? initialSeasonState();

  function dispatch(a: SeasonAction): void {
    const next = applySeasonAction(current, a, now());
    current = { ...next, rev: current.rev + 1 };
    if (storage) {
      try {
        storage.setItem(key, JSON.stringify(current)); // SYNCHRONOUS — before notify
      } catch {
        /* quota/private mode must never take down the app */
      }
    }
    for (const fn of Array.from(subs)) {
      try {
        fn(current);
      } catch {
        /* a broken subscriber must never block the others */
      }
    }
  }

  return {
    getState: () => current,
    dispatch,
    subscribe(fn: (s: SeasonState) => void): () => void {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    profileId,
  };
}

// ---------------------------------------------------------------------------
// Pure selectors — derived data is NEVER stored, always recomputed.
// ---------------------------------------------------------------------------

export const seasonSelectors = {
  /** The week every screen renders: manual override wins, clamped 1..18. */
  currentWeek(s: SeasonState): number {
    const w = s.weekOverride ?? s.week;
    return Math.max(MIN_WEEK, Math.min(MAX_WEEK, w));
  },

  myRoster(s: SeasonState): RosterEntry | null {
    if (s.myRosterId === null) return null;
    return s.rosters.find((r) => r.rosterId === s.myRosterId) ?? null;
  },

  /** Free agents: ids (from the caller's universe) on no synced roster. */
  faPoolIds(s: SeasonState, allSleeperIds: string[]): string[] {
    const rostered = new Set<string>();
    for (const r of s.rosters) for (const id of r.players) rostered.add(id);
    return allSleeperIds.filter((id) => !rostered.has(id));
  },

  /** My current-week matchup row + the opponent sharing my matchupId. */
  myMatchup(s: SeasonState): { me: MatchupEntry; opp: MatchupEntry | null } | null {
    if (s.myRosterId === null) return null;
    const me = s.matchups.find((m) => m.rosterId === s.myRosterId);
    if (!me) return null;
    const opp =
      me.matchupId === null
        ? null
        : s.matchups.find(
            (m) => m.rosterId !== me.rosterId && m.matchupId === me.matchupId,
          ) ?? null;
    return { me, opp };
  },
};
