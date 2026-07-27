// league.ts — Sleeper LEAGUE sync for the in-season platform (plan Phase A:
// "League sync"). Copies the injectable patterns of sleeper.ts (draft sync).
//
// Contract:
//   - fetchSeasonSnapshot(leagueId) walks the Sleeper read-only API:
//       /state/nfl → /league/{id} → /users → /rosters   (REQUIRED — any
//       failure throws and NOTHING is dispatched)
//       → /matchups/{week} → /transactions/{week} → /players/nfl/trending
//       add+drop   (best-effort — failures become null payload fields)
//     and returns ONE SeasonSyncPayload.
//   - One successful snapshot dispatches exactly ONE atomic SEASON_SYNCED
//     through the season reducer — the same invariant as draft sync's
//     PICK_MADE-only rule. On failure the info dot changes and nothing else.
//   - Preseason: /state/nfl reports week 0 → clamped to 1.
//   - On-demand refresh is the primary mode (no background poll loop here —
//     season data moves weekly, not per-second).
//
// Everything impure is injectable (fetch, clock) so the whole flow runs under
// `node --test`. No preact imports; framework-free. TypeScript is ERASABLE.

import type { SeasonStore, SeasonSyncPayload, RosterEntry, MatchupEntry, TxEntry } from '../state/season.ts';
import { SLEEPER_API } from './sleeper.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeagueSyncStatus = 'idle' | 'syncing' | 'live' | 'error' | 'stopped';

export interface LeagueSyncInfo {
  status: LeagueSyncStatus;
  /** ms epoch of the last SUCCESSFUL sync (null before the first). */
  lastSyncAt: number | null;
  /** Successful snapshot count by this instance. */
  syncs: number;
  /** One-line error text from the last failed refresh (null when live). */
  error: string | null;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface LeagueSyncOpts {
  leagueId: string;
  onStatus?: (info: LeagueSyncInfo) => void;
  // injectables — defaults are the real globals
  fetchFn?: FetchFn;
  now?: () => number;
}

export interface LeagueSync {
  refresh(): Promise<void>;
  stop(): void;
  info(): LeagueSyncInfo;
  leagueId: string;
}

// ---------------------------------------------------------------------------
// Snapshot fetch — the full endpoint walk, mapped to SeasonSyncPayload.
// ---------------------------------------------------------------------------

async function getJson(fetchFn: FetchFn, url: string): Promise<any> {
  const res = await fetchFn(url, { cache: 'no-store' } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  return res.json();
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toCountMap(rows: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(rows)) {
    for (const r of rows as Array<Record<string, unknown>>) {
      const id = r?.player_id;
      if (typeof id === 'string' && id.length > 0) out[id] = num(r.count);
    }
  }
  return out;
}

export async function fetchSeasonSnapshot(
  leagueId: string,
  opts: { fetchFn?: FetchFn; now?: () => number } = {},
): Promise<SeasonSyncPayload> {
  // NB: never pass the bare global `fetch` around — unbound fetch throws
  // "Illegal invocation" in browsers. Always wrap (sleeper.ts precedent).
  const fetchFn = opts.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const id = encodeURIComponent(String(leagueId ?? '').trim());
  if (!id) throw new Error('empty league id');

  // ── required legs — any failure throws, nothing is dispatched ────────────
  const state = await getJson(fetchFn, `${SLEEPER_API}/state/nfl`);
  let week = Number(state?.week);
  if (!Number.isFinite(week) || week < 1) week = 1; // preseason reports 0
  week = Math.min(18, Math.trunc(week));

  const league = await getJson(fetchFn, `${SLEEPER_API}/league/${id}`);
  if (!league || typeof league !== 'object' || !Array.isArray(league.roster_positions)) {
    throw new Error('unexpected league payload (roster_positions missing)');
  }

  const usersRaw = await getJson(fetchFn, `${SLEEPER_API}/league/${id}/users`);
  if (!Array.isArray(usersRaw)) throw new Error('unexpected users payload');
  const users: SeasonSyncPayload['users'] = {};
  for (const u of usersRaw as Array<Record<string, any>>) {
    if (!u || typeof u.user_id !== 'string') continue;
    users[u.user_id] = {
      name: typeof u.display_name === 'string' && u.display_name ? u.display_name : u.user_id,
      teamName:
        typeof u.metadata?.team_name === 'string' && u.metadata.team_name
          ? u.metadata.team_name
          : null,
    };
  }

  const rostersRaw = await getJson(fetchFn, `${SLEEPER_API}/league/${id}/rosters`);
  if (!Array.isArray(rostersRaw)) throw new Error('unexpected rosters payload');
  const rosters: RosterEntry[] = [];
  for (const r of rostersRaw as Array<Record<string, any>>) {
    if (!r || !Number.isInteger(r.roster_id)) continue;
    rosters.push({
      rosterId: r.roster_id,
      ownerId: typeof r.owner_id === 'string' ? r.owner_id : '',
      players: Array.isArray(r.players) ? r.players.map(String) : [],
      starters: Array.isArray(r.starters) ? r.starters.map(String) : [],
      wins: num(r.settings?.wins),
      losses: num(r.settings?.losses),
      ties: num(r.settings?.ties),
      fpts: num(r.settings?.fpts) + num(r.settings?.fpts_decimal) / 100,
    });
  }

  // ── best-effort legs — failures become null fields, never a throw ────────
  let matchups: MatchupEntry[] | null = null;
  try {
    const raw = await getJson(fetchFn, `${SLEEPER_API}/league/${id}/matchups/${week}`);
    if (Array.isArray(raw)) {
      matchups = (raw as Array<Record<string, any>>)
        .filter((m) => m && Number.isInteger(m.roster_id))
        .map((m) => ({
          rosterId: m.roster_id,
          matchupId: Number.isInteger(m.matchup_id) ? m.matchup_id : null,
          points: num(m.points),
          starters: Array.isArray(m.starters) ? m.starters.map(String) : [],
        }));
    }
  } catch {
    matchups = null;
  }

  let transactions: TxEntry[] | null = null;
  try {
    const raw = await getJson(fetchFn, `${SLEEPER_API}/league/${id}/transactions/${week}`);
    if (Array.isArray(raw)) {
      transactions = (raw as Array<Record<string, any>>)
        .filter((t) => t && typeof t.transaction_id === 'string')
        .map((t) => ({
          id: t.transaction_id,
          type: typeof t.type === 'string' ? t.type : 'unknown',
          status: typeof t.status === 'string' ? t.status : 'unknown',
          week: Number.isInteger(t.leg) ? t.leg : week,
          adds: t.adds && typeof t.adds === 'object' ? t.adds : null,
          drops: t.drops && typeof t.drops === 'object' ? t.drops : null,
          created: num(t.created),
        }))
        .sort((x, y) => y.created - x.created)
        .slice(0, 50);
    }
  } catch {
    transactions = null;
  }

  let trending: SeasonSyncPayload['trending'] = null;
  try {
    const add = await getJson(
      fetchFn,
      `${SLEEPER_API}/players/nfl/trending/add?lookback_hours=24&limit=50`,
    );
    const drop = await getJson(
      fetchFn,
      `${SLEEPER_API}/players/nfl/trending/drop?lookback_hours=24&limit=50`,
    );
    trending = { add: toCountMap(add), drop: toCountMap(drop) };
  } catch {
    trending = null;
  }

  return {
    leagueId: String(leagueId).trim(),
    leagueName: typeof league.name === 'string' ? league.name : null,
    week,
    users,
    rosters,
    matchups,
    transactions,
    trending,
    syncedAt: now(),
  };
}

// ---------------------------------------------------------------------------
// Sync instance — one league, on-demand refresh, one SEASON_SYNCED each.
// ---------------------------------------------------------------------------

export function createLeagueSync(store: SeasonStore, opts: LeagueSyncOpts): LeagueSync {
  const leagueId = String(opts.leagueId ?? '').trim();
  const fetchFn = opts.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = opts.now ?? (() => Date.now());

  const info: LeagueSyncInfo = { status: 'idle', lastSyncAt: null, syncs: 0, error: null };
  let dead = false;
  let inflight: Promise<void> | null = null;

  function emit(): void {
    try {
      opts.onStatus?.({ ...info });
    } catch {
      /* a broken status subscriber must never take down the sync */
    }
  }

  async function doRefresh(): Promise<void> {
    info.status = 'syncing';
    emit();
    try {
      const payload = await fetchSeasonSnapshot(leagueId, { fetchFn, now });
      if (dead) return; // stopped mid-flight — never dispatch after stop()
      store.dispatch({ type: 'SEASON_SYNCED', payload }); // EXACTLY one
      info.status = 'live';
      info.error = null;
      info.lastSyncAt = now();
      info.syncs += 1;
    } catch (e) {
      if (dead) return;
      info.status = 'error';
      info.error = String((e as Error)?.message ?? e);
      // state untouched — the persisted store remains the offline cache
    }
    emit();
  }

  return {
    refresh(): Promise<void> {
      if (dead) return Promise.resolve();
      if (inflight) return inflight; // coalesce concurrent refreshes
      inflight = doRefresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    stop(): void {
      dead = true;
      info.status = 'stopped';
      emit();
    },
    info: () => ({ ...info }),
    leagueId,
  };
}

// ---------------------------------------------------------------------------
// UI-facing singleton manager — one league sync app-wide, survives route
// changes (header dot + LeaguePanel both subscribe). Thin glue over the
// tested core above; no logic of its own beyond lifecycle. Mirrors
// sleeper.ts syncManager.
// ---------------------------------------------------------------------------

export interface ManagedLeagueSyncInfo extends LeagueSyncInfo {
  leagueId: string | null;
}

export interface LeagueSyncManager {
  start(store: SeasonStore, leagueId: string): void;
  refresh(): Promise<void>;
  stop(): void;
  getInfo(): ManagedLeagueSyncInfo;
  subscribe(fn: (info: ManagedLeagueSyncInfo) => void): () => void;
}

function createManager(): LeagueSyncManager {
  let inst: LeagueSync | null = null;
  let leagueId: string | null = null;
  let last: LeagueSyncInfo = { status: 'idle', lastSyncAt: null, syncs: 0, error: null };
  const subs = new Set<(info: ManagedLeagueSyncInfo) => void>();

  function snapshot(): ManagedLeagueSyncInfo {
    return { ...last, leagueId };
  }
  function notify(): void {
    const m = snapshot();
    for (const fn of Array.from(subs)) {
      try {
        fn(m);
      } catch {
        /* never let one subscriber block the rest */
      }
    }
  }

  return {
    start(store: SeasonStore, id: string): void {
      if (inst) {
        inst.stop();
        inst = null;
      }
      leagueId = String(id ?? '').trim() || null;
      if (!leagueId) {
        last = { status: 'idle', lastSyncAt: null, syncs: 0, error: null };
        notify();
        return;
      }
      inst = createLeagueSync(store, {
        leagueId,
        onStatus: (i) => {
          last = i;
          notify();
        },
      });
      last = inst.info();
      notify();
      void inst.refresh(); // first snapshot immediately
    },
    refresh(): Promise<void> {
      return inst ? inst.refresh() : Promise.resolve();
    },
    stop(): void {
      if (inst) {
        inst.stop(); // emits 'stopped' through onStatus → last/notify
        inst = null;
      }
    },
    getInfo: snapshot,
    subscribe(fn: (info: ManagedLeagueSyncInfo) => void): () => void {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export const leagueSyncManager: LeagueSyncManager = createManager();
