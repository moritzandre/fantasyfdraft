// store.ts — THE store contract for DraftPrep (plan: "Persistence" + panic-proofing).
// Replaces the thin placeholder wholesale; the exported surface is a superset.
//
// Design invariants:
//   - The append-only ACTION LOG is the source of truth. Derived data (remaining
//     pool, rosters, on-the-clock) is NEVER stored — always recomputed via the
//     pure `selectors` below, using engine/picks.js for snake math.
//   - UNDO is a pure log operation: pop the last log entry (ANY action type)
//     and re-reduce from the base state. Never an inverse mutation. Replaying
//     200 actions over a 192-pick draft is well under 100 ms.
//   - The last MAX_LOG (200) actions are kept as the undo/audit log inside
//     persisted state; older actions are compacted into `base`.
//   - rev increments on EVERY dispatch (including no-ops and UNDO) so the
//     persistence tiers can reconcile by max(rev).
//   - Persistence is injected as an optional adapter so this module stays
//     importable under plain `node --test` (default: no adapter, no-op).
//     The browser wiring lives in persist.ts (bootPersistedStore).
//   - league.slot is DATA (1..teams, default 8) — nothing here hardcodes slot 8.
//
// TypeScript here is ERASABLE only (plain annotations — Node 24 strip-types
// runs the .ts tests directly; no enums, no namespaces, no parameter properties).

import { slotForPick, nextMyPick } from '../../engine/picks.js';

// ---------------------------------------------------------------------------
// Types — the contract both workstreams code against.
// ---------------------------------------------------------------------------

export type Source = 'manual' | 'sleeper' | 'sim';

export type Action =
  | { type: 'PICK_MADE'; idx: number; source: Source }
  | { type: 'UNDO' }
  | { type: 'SET_PICK_CURSOR'; pick: number }
  | { type: 'CATCHUP'; idxs: number[] }
  | { type: 'EDIT_PICK'; pickNumber: number; idx: number | null }
  | { type: 'SET_LEAGUE'; league: Partial<LeagueConfig> }
  | { type: 'SET_UI'; ui: Partial<UiState> }
  | { type: 'RESET_DRAFT' }
  | { type: 'IMPORT_STATE'; state: PortableState };

export interface LeagueConfig {
  teams: number;
  slot: number; // THE slot (1..teams, default 8) — runtime data, never assumed
  rounds: number;
  snake: boolean;
  roster: Record<string, number>;
  flexEligible: string[];
  scoring?: Record<string, unknown>;
  strategy?: string;
  epsilonPoints?: number;
  kappaLongGap?: number;
  overrideDelta?: number;
  [k: string]: unknown;
}

export interface Board {
  buildHash: string;
  configFingerprint?: string;
  builtAt?: string;
  players: any[];
  [k: string]: unknown;
}

export interface UiState {
  posFilter: string;
  searchText: string;
  showFive: boolean;
  grayscalePreview: boolean;
  lastScreen: string;
  rehearsalDone?: boolean; // Ready Check airplane-mode rehearsal checkbox
}

export interface PickEntry {
  n: number; // overall pick number, 1-based
  idx: number; // board index of the player taken
  source: Source;
  ts: number;
}

export interface DraftState {
  rev: number; // increments on every dispatch
  schemaVersion: 1;
  buildHash: string; // from board.json at boot
  league: LeagueConfig;
  picks: PickEntry[]; // kept sorted by n; mutations only via actions
  pickCursor: number; // next overall pick to be recorded, 1-based
  ui: UiState;
}

/** The board-independent, JSON-safe slice used by export/import (portable.ts). */
export interface PortableState {
  rev?: number;
  schemaVersion: 1;
  buildHash: string;
  league: LeagueConfig;
  picks: PickEntry[];
  pickCursor: number;
  ui: UiState;
}

/** One dispatched action, as logged for undo/audit and the persisted picklog. */
export interface LogEntry {
  rev: number;
  ts: number;
  a: Action;
}

/** What the persistence tier receives on every dispatch (and what boot restores). */
export interface PersistedSnapshot {
  v: 1;
  rev: number;
  base: DraftState; // state with the compacted (pre-log) history folded in
  log: LogEntry[]; // last ≤ MAX_LOG non-UNDO actions — the undo/audit log
}

export interface PersistAdapter {
  /** MUST write its synchronous tier before returning. `entry` is the action
      just dispatched (including UNDO) — the append-only picklog record. */
  save(snapshot: PersistedSnapshot, entry: LogEntry): void;
}

export interface RestorePayload {
  snapshot?: PersistedSnapshot | null;
  /** picklog entries with rev > snapshot.rev — replayed at boot (torn-write recovery). */
  tail?: LogEntry[];
}

export interface Store {
  getState(): DraftState;
  dispatch(a: Action): void; // reduce → rev++ → SYNCHRONOUS persist → notify
  subscribe(fn: (s: DraftState) => void): () => void;
  undoDepth(): number; // how many undos remain (max 10 reported; log holds up to 200)
}

export const MAX_LOG = 200; // audit-log length kept in persisted state
const UNDO_REPORT_CAP = 10;

const LEAGUE_DEFAULTS = {
  teams: 12,
  slot: 8, // default, never an assumption — SET_LEAGUE changes it live
  rounds: 16,
  snake: true,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
  flexEligible: ['RB', 'WR', 'TE'],
};

const UI_DEFAULTS: UiState = {
  posFilter: 'ALL',
  searchText: '',
  showFive: true,
  grayscalePreview: false,
  lastScreen: 'ready',
  rehearsalDone: false,
};

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

function totalPicks(l: LeagueConfig): number {
  return l.teams * l.rounds;
}

export function initialState(board: Board, league: LeagueConfig): DraftState {
  return {
    rev: 0,
    schemaVersion: 1,
    buildHash: typeof board?.buildHash === 'string' ? board.buildHash : '',
    league: { ...LEAGUE_DEFAULTS, ...league },
    picks: [],
    pickCursor: 1,
    ui: { ...UI_DEFAULTS },
  };
}

function byPickNumber(a: PickEntry, b: PickEntry): number {
  return a.n - b.n;
}

/** Record one or more players as gone, starting at the current cursor,
    skipping already-recorded pick numbers and already-taken players. */
function recordPicks(s: DraftState, idxs: number[], source: Source, ts: number): DraftState {
  const t = totalPicks(s.league);
  const taken = new Set(s.picks.map((p) => p.idx));
  const recorded = new Set(s.picks.map((p) => p.n));
  let cursor = s.pickCursor;
  const added: PickEntry[] = [];

  for (const idx of idxs) {
    while (cursor <= t && recorded.has(cursor)) cursor += 1;
    if (cursor > t) break; // draft over — nothing more to record
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (taken.has(idx)) continue; // player already gone — skip, don't burn the slot
    added.push({ n: cursor, idx, source, ts });
    taken.add(idx);
    recorded.add(cursor);
    cursor += 1;
  }
  // land the cursor on the next UNRECORDED pick
  while (cursor <= t && recorded.has(cursor)) cursor += 1;
  cursor = Math.min(cursor, t + 1);

  if (added.length === 0 && cursor === s.pickCursor) return s;
  const picks = added.length > 0 ? [...s.picks, ...added].sort(byPickNumber) : s.picks;
  return { ...s, picks, pickCursor: cursor };
}

/** The pure reducer. UNDO is deliberately a no-op here — it is a LOG operation
    handled by the store (pop + re-reduce), never an inverse mutation. */
export function applyAction(s: DraftState, a: Action, ts: number): DraftState {
  switch (a.type) {
    case 'PICK_MADE':
      return recordPicks(s, [a.idx], a.source, ts);

    case 'CATCHUP':
      return recordPicks(s, Array.isArray(a.idxs) ? a.idxs : [], 'manual', ts);

    case 'SET_PICK_CURSOR': {
      if (!Number.isFinite(a.pick)) return s;
      const pick = Math.max(1, Math.min(totalPicks(s.league) + 1, Math.trunc(a.pick)));
      return pick === s.pickCursor ? s : { ...s, pickCursor: pick };
    }

    case 'EDIT_PICK': {
      const n = Math.trunc(a.pickNumber);
      if (!Number.isInteger(n) || n < 1 || n > totalPicks(s.league)) return s;
      let picks = s.picks.filter((p) => p.n !== n);
      if (a.idx !== null) {
        if (!Number.isInteger(a.idx) || a.idx < 0) return s;
        // a player can only be drafted once — naming him at a new pick MOVES him
        picks = picks.filter((p) => p.idx !== a.idx);
        picks = [...picks, { n, idx: a.idx, source: 'manual' as Source, ts }].sort(byPickNumber);
      } else if (picks.length === s.picks.length) {
        return s; // deleted a pick that wasn't there
      }
      return { ...s, picks };
    }

    case 'SET_LEAGUE':
      return { ...s, league: { ...s.league, ...a.league } };

    case 'SET_UI':
      return { ...s, ui: { ...s.ui, ...a.ui } };

    case 'RESET_DRAFT':
      return { ...s, picks: [], pickCursor: 1 };

    case 'IMPORT_STATE': {
      const st = a.state;
      if (!st || st.schemaVersion !== 1 || !Array.isArray(st.picks)) return s;
      return {
        ...s,
        // buildHash stays the RUNNING board's hash; portable.ts flags mismatches
        league: { ...s.league, ...st.league },
        picks: st.picks.map((p) => ({ ...p })).sort(byPickNumber),
        pickCursor: typeof st.pickCursor === 'number' ? st.pickCursor : 1,
        ui: { ...UI_DEFAULTS, ...st.ui },
      };
    }

    case 'UNDO':
      return s;
  }
  return s;
}

function withRev(s: DraftState, rev: number): DraftState {
  return s.rev === rev ? s : { ...s, rev };
}

function replayLog(base: DraftState, entries: LogEntry[]): DraftState {
  let s = base;
  for (const e of entries) s = applyAction(s, e.a, e.ts);
  return s;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createStore(boot: {
  board: Board;
  league: LeagueConfig;
  persist?: PersistAdapter | null; // optional adapter — default no-op (Node-safe)
  restore?: RestorePayload | null; // from persist.ts bootRestore()
  now?: () => number; // injectable clock for deterministic tests
}): Store {
  const now = boot.now ?? (() => Date.now());
  const persist = boot.persist ?? null;
  const subs = new Set<(s: DraftState) => void>();

  let base: DraftState = initialState(boot.board, boot.league);
  let log: LogEntry[] = [];
  let rev = 0;

  // --- restore tier: best snapshot first…
  const snap = boot.restore?.snapshot ?? null;
  if (snap && snap.v === 1 && snap.base && typeof snap.base === 'object' && Array.isArray(snap.log)) {
    const bootHash = base.buildHash;
    base = { ...snap.base };
    if (bootHash) base = { ...base, buildHash: bootHash }; // running board wins
    log = snap.log.filter((e) => e && e.a && typeof e.a.type === 'string');
    rev = typeof snap.rev === 'number' && snap.rev >= 0 ? snap.rev : 0;
  }

  let current: DraftState = withRev(replayLog(base, log), rev);

  /** Apply one dispatched action. UNDO = pop + re-reduce from base; anything
      else appends to the log (compacting the oldest entry past MAX_LOG). */
  function applyOne(a: Action, ts: number, entryRev: number): LogEntry {
    const entry: LogEntry = { rev: entryRev, ts, a };
    if (a.type === 'UNDO') {
      if (log.length > 0) {
        log.pop();
        current = withRev(replayLog(base, log), entryRev);
      } else {
        current = withRev(current, entryRev);
      }
      return entry;
    }
    log.push(entry);
    while (log.length > MAX_LOG) {
      const oldest = log.shift() as LogEntry;
      base = applyAction(base, oldest.a, oldest.ts);
    }
    current = withRev(applyAction(current, a, ts), entryRev);
    return entry;
  }

  // --- …then the picklog tail (torn-snapshot recovery)
  for (const e of boot.restore?.tail ?? []) {
    if (!e || typeof e.rev !== 'number' || e.rev <= rev) continue;
    if (!e.a || typeof e.a.type !== 'string') continue;
    applyOne(e.a, typeof e.ts === 'number' ? e.ts : 0, e.rev);
    rev = e.rev;
  }
  current = withRev(current, rev);

  function makeSnapshot(): PersistedSnapshot {
    return { v: 1, rev, base: withRev(base, 0), log: log.slice() };
  }

  function dispatch(a: Action): void {
    rev += 1;
    const entry = applyOne(a, now(), rev);
    if (persist) {
      try {
        persist.save(makeSnapshot(), entry); // SYNCHRONOUS — before anyone is notified
      } catch {
        // persistence must never take down a live draft
      }
    }
    for (const fn of Array.from(subs)) {
      try {
        fn(current);
      } catch {
        // a broken subscriber must never block the others
      }
    }
  }

  return {
    getState: () => current,
    dispatch,
    subscribe(fn: (s: DraftState) => void): () => void {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    undoDepth: () => Math.min(UNDO_REPORT_CAP, log.length),
  };
}

// ---------------------------------------------------------------------------
// Pure selectors — derived data is NEVER stored, always recomputed.
// ---------------------------------------------------------------------------

export const selectors = {
  /** Players not yet taken, in board order. */
  remainingPool(s: DraftState, board: Board): any[] {
    const taken = new Set(s.picks.map((p) => p.idx));
    return board.players.filter((p) => !taken.has(p.idx));
  },

  /** Roster of any team slot (1-based), reconstructed from the log in draft order. */
  rosterOf(s: DraftState, board: Board, teamSlot: number): any[] {
    const out: any[] = [];
    for (const p of s.picks) {
      if (slotForPick(p.n, s.league.teams, s.league.snake) !== teamSlot) continue;
      const pl = board.players[p.idx];
      if (pl !== undefined) out.push(pl);
    }
    return out;
  },

  /** My roster — league.slot is data, never hardcoded. */
  myRoster(s: DraftState, board: Board): any[] {
    return selectors.rosterOf(s, board, s.league.slot);
  },

  /** Team slot on the clock (clamped to the final pick once the draft is over). */
  onClockSlot(s: DraftState): number {
    return slotForPick(Math.min(s.pickCursor, totalPicks(s.league)), s.league.teams, s.league.snake);
  },

  isMyPick(s: DraftState): boolean {
    return s.pickCursor <= totalPicks(s.league) && selectors.onClockSlot(s) === s.league.slot;
  },

  /** My next pick number at/after the cursor (equals the cursor when I'm up); null after my last. */
  myNextPick(s: DraftState): number | null {
    return nextMyPick(s.pickCursor, s.league);
  },
};
