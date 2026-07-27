// sleeper.ts — Sleeper draft sync (plan "Sleeper sync": progressive enhancement,
// deliberately last, behind a toggle).
//
// Contract:
//   - Poll GET https://api.sleeper.app/v1/draft/<draftId>/picks every 3 s.
//   - NEW picks (pick_no >= the store's pickCursor, not already recorded)
//     dispatch PICK_MADE {idx, source:'sleeper'} through the SAME reducer as
//     manual taps, in pick_no order — individually undoable, replay-safe.
//   - Already-recorded pick numbers and already-taken players are skipped
//     (idempotent: re-polling the full pick list is a no-op).
//   - Errors / 429: exponential backoff 3s → 6 → 12 → 24 → 30s cap, ±15% jitter.
//     On death the dot just goes grey/red — NEVER a reload, NEVER a dialog.
//   - Unresolvable player_id (not in board.slimSleeperMap): surface a one-line
//     banner naming the Sleeper player_id, do NOT advance the cursor for it,
//     log and PAUSE sync — manual entry is the fallback, Start resumes.
//   - stop() aborts the in-flight fetch and cancels the pending timer cleanly.
//
// Everything impure is injectable (fetch, timers, clock, RNG) so the whole
// loop runs under `node --test` with fake timers. No preact imports here —
// UI glue lives in SyncPanel/TopBar; this module is framework-free.
// TypeScript is ERASABLE only (Node 24 strip-types runs the .ts test directly).

import type { Board, Store } from '../state/store';

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export type SyncStatus = 'live' | 'error' | 'stopped';

export interface SyncInfo {
  status: SyncStatus;
  /** ms epoch of the last poll attempt (null before the first). */
  lastPollAt: number | null;
  /** Picks dispatched via sync by THIS instance. */
  pickCount: number;
  /** Delay before the next poll (base 3000; grows on error up to 30000). */
  backoffMs: number;
  /** Total poll attempts by this instance. */
  polls: number;
  /** One-line error text (HTTP status, network failure, unresolved id). */
  error: string | null;
  /** Sleeper player_id sync paused on (null unless paused-on-unresolvable). */
  unresolved: string | null;
  /** True when sync paused itself on an unresolvable player_id. */
  paused: boolean;
}

export interface SleeperSyncOpts {
  draftId: string;
  onStatus?: (info: SyncInfo) => void;
  // injectables — defaults are the real browser/node globals
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  now?: () => number;
  random?: () => number;
  intervalMs?: number;
  maxBackoffMs?: number;
}

export interface SleeperSync {
  stop(): void;
  info(): SyncInfo;
  draftId: string;
}

export const SLEEPER_API = 'https://api.sleeper.app/v1';
export const POLL_MS = 3000;
export const MAX_BACKOFF_MS = 30000;

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

export function createSleeperSync(store: Store, board: Board, opts: SleeperSyncOpts): SleeperSync {
  const draftId = String(opts.draftId ?? '').trim();
  // NB: never pass the bare global `fetch` around — unbound fetch throws
  // "Illegal invocation" in browsers. Always wrap.
  const fetchFn = opts.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const setT = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const base = opts.intervalMs ?? POLL_MS;
  const maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
  const slimMap = (board.slimSleeperMap ?? {}) as Record<string, number>;

  const info: SyncInfo = {
    status: 'stopped',
    lastPollAt: null,
    pickCount: 0,
    backoffMs: base,
    polls: 0,
    error: null,
    unresolved: null,
    paused: false,
  };

  let dead = false; // set by stop() and by the unresolvable-id pause
  let timer: unknown = null;
  let ctrl: AbortController | null = null;
  let delay = base;

  function emit(): void {
    try {
      opts.onStatus?.({ ...info });
    } catch {
      /* a broken status subscriber must never take down the poll loop */
    }
  }

  /** Shared teardown: cancel the pending timer and abort any in-flight fetch. */
  function halt(): void {
    dead = true;
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
    if (ctrl) {
      ctrl.abort();
      ctrl = null;
    }
  }

  function stop(): void {
    halt();
    info.status = 'stopped';
    info.paused = false;
    emit();
  }

  /** Apply one poll's pick list. Returns normally; on an unresolvable
      player_id it pauses the loop (dead = true) and leaves status 'error'. */
  function applyPicks(raw: unknown): void {
    if (!Array.isArray(raw)) throw new Error('unexpected picks payload');
    const picks = (raw as Array<Record<string, unknown>>)
      .filter((p) => p && Number.isInteger(p.pick_no as number))
      .sort((a, b) => (a.pick_no as number) - (b.pick_no as number));

    // Picks strictly before the cursor at poll start are the user's business
    // (manual entries, deliberate SET_PICK_CURSOR overrides) — never touched.
    const startCursor = store.getState().pickCursor;

    for (const p of picks) {
      const pickNo = p.pick_no as number;
      if (pickNo < startCursor) continue;
      const s = store.getState();
      if (s.picks.some((e) => e.n === pickNo)) continue; // already recorded — skip
      const pid = String(p.player_id ?? '');
      const idx = slimMap[pid];
      if (!Number.isInteger(idx)) {
        // Unresolvable: banner + pause, cursor NOT advanced for this pick.
        info.unresolved = pid;
        info.status = 'error';
        info.paused = true;
        info.error = `Sleeper player_id ${pid || '(empty)'} not on the board — record pick #${pickNo} manually, then Start again`;
        halt();
        emit();
        // eslint-disable-next-line no-console
        console.warn(`[sleeper-sync] unresolvable player_id ${pid} at pick ${pickNo} — sync paused`);
        return;
      }
      if (s.picks.some((e) => e.idx === idx)) continue; // player already gone — skip
      store.dispatch({ type: 'PICK_MADE', idx, source: 'sleeper' });
      info.pickCount += 1;
    }
  }

  async function poll(): Promise<void> {
    if (dead) return;
    info.polls += 1;
    info.lastPollAt = now();
    ctrl = new AbortController();
    try {
      const res = await fetchFn(`${SLEEPER_API}/draft/${encodeURIComponent(draftId)}/picks`, {
        signal: ctrl.signal,
        cache: 'no-store',
      } as RequestInit);
      if (dead) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (dead) return;
      applyPicks(data);
      if (dead) return; // paused on an unresolvable id — applyPicks emitted
      delay = base;
      info.backoffMs = delay;
      info.status = 'live';
      info.error = null;
      info.unresolved = null;
    } catch (e) {
      if (dead) return; // stop()/pause mid-flight — never flip the status back
      delay = Math.min(maxBackoff, Math.max(base * 2, delay * 2));
      info.backoffMs = delay;
      info.status = 'error';
      info.error = String((e as Error)?.message ?? e);
    } finally {
      ctrl = null;
    }
    schedule();
    emit();
  }

  function schedule(): void {
    if (dead) return;
    const wait = Math.round(delay * (0.85 + 0.3 * random())); // ±15% jitter
    timer = setT(() => {
      timer = null;
      void poll();
    }, wait);
  }

  void poll(); // first poll immediately

  return { stop, info: () => ({ ...info }), draftId };
}

// ---------------------------------------------------------------------------
// League-id → draft-id resolution (SyncPanel's alternative entry path)
// ---------------------------------------------------------------------------

export async function fetchDraftsForLeague(
  leagueId: string,
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Array<Record<string, unknown>>> {
  const f = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const res = await f(`${SLEEPER_API}/league/${encodeURIComponent(leagueId.trim())}/drafts`, {
    cache: 'no-store',
  } as RequestInit);
  if (!res.ok) throw new Error(`Sleeper league lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('unexpected response from Sleeper');
  return data as Array<Record<string, unknown>>;
}

const STATUS_RANK: Record<string, number> = { drafting: 0, paused: 1, pre_draft: 2, complete: 3 };

/** Pick the ACTIVE draft from a league's draft list: status drafting > paused
    > pre_draft > complete, newest `created` wins ties. Pure — unit-tested. */
export function pickActiveDraft(drafts: Array<Record<string, unknown>>): string | null {
  const valid = (drafts ?? []).filter((d) => d && typeof d.draft_id === 'string');
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const ra = STATUS_RANK[String(a.status)] ?? 9;
    const rb = STATUS_RANK[String(b.status)] ?? 9;
    if (ra !== rb) return ra - rb;
    return (Number(b.created) || 0) - (Number(a.created) || 0);
  });
  return valid[0].draft_id as string;
}

// ---------------------------------------------------------------------------
// UI-facing singleton manager — one sync instance app-wide, survives route
// changes (TopBar dot + SyncPanel both subscribe). Thin glue over the tested
// core above; no logic of its own beyond lifecycle.
// ---------------------------------------------------------------------------

export interface ManagedSyncInfo extends SyncInfo {
  draftId: string | null;
}

export interface SyncManager {
  start(store: Store, board: Board, draftId: string): void;
  stop(): void;
  getInfo(): ManagedSyncInfo;
  subscribe(fn: (info: ManagedSyncInfo) => void): () => void;
}

function createManager(): SyncManager {
  let inst: SleeperSync | null = null;
  let draftId: string | null = null;
  let last: SyncInfo = {
    status: 'stopped',
    lastPollAt: null,
    pickCount: 0,
    backoffMs: POLL_MS,
    polls: 0,
    error: null,
    unresolved: null,
    paused: false,
  };
  const subs = new Set<(info: ManagedSyncInfo) => void>();

  function snapshot(): ManagedSyncInfo {
    return { ...last, draftId };
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
    start(store: Store, board: Board, id: string): void {
      if (inst) {
        inst.stop();
        inst = null;
      }
      draftId = String(id ?? '').trim() || null;
      if (!draftId) {
        notify();
        return;
      }
      inst = createSleeperSync(store, board, {
        draftId,
        onStatus: (i) => {
          last = i;
          notify();
        },
      });
      last = inst.info();
      notify();
    },
    stop(): void {
      if (inst) {
        inst.stop(); // emits 'stopped' through onStatus → last/notify
        inst = null;
      }
    },
    getInfo: snapshot,
    subscribe(fn: (info: ManagedSyncInfo) => void): () => void {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export const syncManager: SyncManager = createManager();
