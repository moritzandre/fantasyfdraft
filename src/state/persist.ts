// persist.ts — three-tier persistence for the live draft store.
//
//   (a) SYNCHRONOUS localStorage.setItem on EVERY dispatch, key 'dp:state:v1',
//       never debounced — iPad Safari discards tabs under memory pressure with
//       zero warning. A separate append-only 'dp:picklog:v1' key means a torn
//       snapshot write is always replayable.
//   (b) async IndexedDB mirror (raw indexedDB, no library) — best-effort,
//       every failure swallowed.
//   (c) boot reconciliation: read all three, take the max-rev snapshot, then
//       replay any picklog entries newer than it.
//
// Flush hooks: pagehide + visibilitychange→hidden. NEVER beforeunload — it is
// unreliable on iOS. navigator.storage.persist() is requested once, try/catch.
//
// Every browser API sits behind a feature check / injectable env so store.ts
// and this module stay importable under plain `node --test`.

import { createStore } from './store.ts';
import type {
  Board,
  LeagueConfig,
  LogEntry,
  PersistAdapter,
  PersistedSnapshot,
  RestorePayload,
  Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Context namespacing. A "context" identifies one independent draft state:
// '' (the default league, real mode — the LEGACY keys, so pre-context
// installs keep their state with zero migration), 'mock' (practice mode),
// 'p-<profileId>' (another league profile), 'p-<profileId>:mock'. Contexts
// never read or write each other's keys — practice can never touch real
// draft prep (src/state/profiles.ts builds the context string).
// ---------------------------------------------------------------------------

export function snapshotKey(ctx = ''): string {
  return ctx ? `dp:state:${ctx}:v1` : 'dp:state:v1';
}
export function picklogKey(ctx = ''): string {
  return ctx ? `dp:picklog:${ctx}:v1` : 'dp:picklog:v1';
}
function idbKey(ctx = ''): string {
  return ctx ? `state:${ctx}` : 'state';
}

export const SNAPSHOT_KEY = snapshotKey();
export const PICKLOG_KEY = picklogKey();
const PERSIST_ASKED_KEY = 'dp:persistAsked:v1';
const IDB_NAME = 'dp';
const IDB_STORE = 'kv';
/** picklog cap — entries newer than the snapshot are NEVER trimmed (they are
    the torn-write safety net); older ones are only history. */
const PICKLOG_MAX = 400;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Injectable environment — real browser globals by default, fakes in tests. */
export interface PersistEnv {
  storage?: StorageLike | null;
  indexedDB?: any;
  win?: any; // addEventListener host (window)
  doc?: any; // document, for visibilitychange + visibilityState
  nav?: any; // navigator, for storage.persist()
}

export function detectEnv(): PersistEnv {
  const g: any = globalThis as any;
  let storage: StorageLike | null = null;
  try {
    const s = g.localStorage;
    if (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') {
      // Safari private mode: setItem throws — probe once so we know the tier is real
      s.setItem('dp:probe', '1');
      s.removeItem('dp:probe');
      storage = s;
    }
  } catch {
    storage = null;
  }
  let idb: any = null;
  try {
    idb = g.indexedDB ?? null;
  } catch {
    idb = null;
  }
  return {
    storage,
    indexedDB: idb,
    win: typeof g.addEventListener === 'function' ? g : null,
    doc: g.document && typeof g.document.addEventListener === 'function' ? g.document : null,
    nav: g.navigator ?? null,
  };
}

// ---------------------------------------------------------------------------
// Parsing / validation of persisted blobs (torn or corrupt data must never
// block boot — worst case we fall back to the next tier or an empty draft).
// ---------------------------------------------------------------------------

function parseSnapshot(raw: string | null | undefined): PersistedSnapshot | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const o: any = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    if (o.v !== 1) return null;
    if (typeof o.rev !== 'number' || !(o.rev >= 0)) return null;
    if (!o.base || typeof o.base !== 'object' || o.base.schemaVersion !== 1) return null;
    if (!Array.isArray(o.log)) return null;
    return o as PersistedSnapshot;
  } catch {
    return null;
  }
}

function parsePicklog(raw: string | null | undefined): LogEntry[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const o: any = JSON.parse(raw);
    if (!Array.isArray(o)) return [];
    return o.filter(
      (e: any) =>
        e && typeof e.rev === 'number' && e.a && typeof e.a.type === 'string',
    ) as LogEntry[];
  } catch {
    return [];
  }
}

function trimPicklog(entries: LogEntry[], snapshotRev: number): LogEntry[] {
  if (entries.length <= PICKLOG_MAX) return entries;
  const excess = entries.length - PICKLOG_MAX;
  let drop = 0;
  while (drop < excess && entries[drop].rev <= snapshotRev) drop += 1;
  return drop > 0 ? entries.slice(drop) : entries;
}

// ---------------------------------------------------------------------------
// Tier (b): raw-IndexedDB mirror — fire and forget, all failures swallowed.
// ---------------------------------------------------------------------------

function makeIdbMirror(idb: any, key: string = idbKey()): {
  put(snapshot: PersistedSnapshot): void;
  get(): Promise<PersistedSnapshot | null>;
} {
  let dbPromise: Promise<any> | null = null;

  function open(): Promise<any> {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        try {
          const req = idb.open(IDB_NAME, 1);
          req.onupgradeneeded = () => {
            try {
              req.result.createObjectStore(IDB_STORE);
            } catch {
              /* store may already exist */
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('idb blocked'));
        } catch (e) {
          reject(e);
        }
      });
      // a failed open must not poison every later attempt with an unhandled rejection
      dbPromise.catch(() => {
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  return {
    put(snapshot: PersistedSnapshot): void {
      if (!idb) return;
      open()
        .then((db) => {
          try {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(JSON.stringify(snapshot), key);
            tx.onerror = () => {};
            tx.onabort = () => {};
          } catch {
            /* swallow */
          }
        })
        .catch(() => {});
    },
    get(): Promise<PersistedSnapshot | null> {
      if (!idb) return Promise.resolve(null);
      return open()
        .then(
          (db) =>
            new Promise<PersistedSnapshot | null>((resolve) => {
              try {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () =>
                  resolve(typeof req.result === 'string' ? parseSnapshot(req.result) : null);
                req.onerror = () => resolve(null);
              } catch {
                resolve(null);
              }
            }),
        )
        .catch(() => null);
    },
  };
}

// ---------------------------------------------------------------------------
// Tier (a) adapter — synchronous localStorage on every dispatch.
// ---------------------------------------------------------------------------

export interface BrowserPersist {
  adapter: PersistAdapter;
  /** Re-write the last snapshot to every tier (pagehide / hidden hook). */
  flush(): void;
}

export function createBrowserPersist(env: PersistEnv = detectEnv(), ctx = ''): BrowserPersist | null {
  const storage = env.storage ?? null;
  const idb = env.indexedDB ?? null;
  if (!storage && !idb) return null; // nowhere to write

  const SNAP = snapshotKey(ctx);
  const PLOG = picklogKey(ctx);
  const mirror = makeIdbMirror(idb, idbKey(ctx));
  let picklog: LogEntry[] = storage ? parsePicklog(storage.getItem(PLOG)) : [];
  let last: PersistedSnapshot | null = null;

  const adapter: PersistAdapter = {
    save(snapshot: PersistedSnapshot, entry: LogEntry): void {
      last = snapshot;
      if (storage) {
        // 1. picklog FIRST — append-only, so a torn snapshot write is replayable
        try {
          picklog.push(entry);
          picklog = trimPicklog(picklog, snapshot.rev);
          storage.setItem(PLOG, JSON.stringify(picklog));
        } catch {
          /* quota — snapshot below may still land */
        }
        // 2. snapshot — SYNCHRONOUS, never debounced
        try {
          storage.setItem(SNAP, JSON.stringify(snapshot));
        } catch {
          /* quota/private mode: IDB mirror still gets it */
        }
      }
      // 3. async IndexedDB mirror
      mirror.put(snapshot);
    },
  };

  return {
    adapter,
    flush(): void {
      if (!last) return;
      if (storage) {
        try {
          storage.setItem(SNAP, JSON.stringify(last));
        } catch {
          /* swallow */
        }
      }
      mirror.put(last);
    },
  };
}

// ---------------------------------------------------------------------------
// Tier (c): boot reconciliation.
// ---------------------------------------------------------------------------

/** Read all three tiers; return the max-rev snapshot plus the picklog tail
    newer than it (or null when nothing was ever persisted). */
export async function bootRestore(env: PersistEnv = detectEnv(), ctx = ''): Promise<RestorePayload | null> {
  const storage = env.storage ?? null;
  const lsSnap = storage ? parseSnapshot(storage.getItem(snapshotKey(ctx))) : null;

  let idbSnap: PersistedSnapshot | null = null;
  try {
    idbSnap = await makeIdbMirror(env.indexedDB ?? null, idbKey(ctx)).get();
  } catch {
    idbSnap = null;
  }

  let snapshot = lsSnap;
  if (idbSnap && (!snapshot || idbSnap.rev > snapshot.rev)) snapshot = idbSnap;

  const picklog = storage ? parsePicklog(storage.getItem(picklogKey(ctx))) : [];
  const baseRev = snapshot ? snapshot.rev : 0;
  const tail = picklog.filter((e) => e.rev > baseRev).sort((a, b) => a.rev - b.rev);

  if (!snapshot && tail.length === 0) return null;
  return { snapshot, tail };
}

/** pagehide + visibilitychange→hidden flush. Deliberately NOT beforeunload. */
export function attachLifecycle(env: PersistEnv, bp: BrowserPersist | null): void {
  if (!bp) return;
  const flush = () => bp.flush();
  try {
    if (env.win && typeof env.win.addEventListener === 'function') {
      env.win.addEventListener('pagehide', flush);
    }
  } catch {
    /* swallow */
  }
  try {
    if (env.doc && typeof env.doc.addEventListener === 'function') {
      env.doc.addEventListener('visibilitychange', () => {
        if (env.doc.visibilityState === 'hidden') flush();
      });
    }
  } catch {
    /* swallow */
  }
}

/** Ask the browser to make our storage eviction-exempt. Once, best-effort. */
export function requestStoragePersist(env: PersistEnv = detectEnv()): void {
  try {
    const nav = env.nav;
    if (!nav || !nav.storage || typeof nav.storage.persist !== 'function') return;
    const storage = env.storage ?? null;
    if (storage && storage.getItem(PERSIST_ASKED_KEY)) return; // only ask once
    if (storage) {
      try {
        storage.setItem(PERSIST_ASKED_KEY, '1');
      } catch {
        /* swallow */
      }
    }
    const p = nav.storage.persist();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* swallow */
  }
}

/** For the Ready Check "last save" row — reads the synchronous tier only.
    savedAt is the ts of the newest logged action (null when the log is empty,
    e.g. right after boot or after undoing everything). */
export function lastSaveInfo(
  env: PersistEnv = detectEnv(),
  ctx = '',
): { rev: number; savedAt: number | null } | null {
  const storage = env.storage ?? null;
  const snap = storage ? parseSnapshot(storage.getItem(snapshotKey(ctx))) : null;
  if (!snap) return null;
  const lastTs = snap.log.length > 0 ? snap.log[snap.log.length - 1].ts : 0;
  return { rev: snap.rev, savedAt: Number.isFinite(lastTs) && lastTs > 0 ? lastTs : null };
}

/** Wipe ONE context's persisted draft state (used by RESET flows in dev
    tools; the normal RESET_DRAFT action is itself persisted and needs no
    wipe). Record-scoped: deleting the practice context never touches the
    real one — never deleteDatabase, which would cross-nuke every context. */
export function clearPersisted(env: PersistEnv = detectEnv(), ctx = ''): void {
  const storage = env.storage ?? null;
  if (storage) {
    try {
      storage.removeItem(snapshotKey(ctx));
      storage.removeItem(picklogKey(ctx));
    } catch {
      /* swallow */
    }
  }
  const idb = env.indexedDB ?? null;
  if (idb) {
    try {
      const req = idb.open(IDB_NAME, 1);
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(idbKey(ctx));
          tx.onerror = () => {};
          tx.onabort = () => {};
        } catch {
          /* swallow */
        }
      };
      req.onerror = () => {};
    } catch {
      /* swallow */
    }
  }
}

// ---------------------------------------------------------------------------
// One-stop boot for the app: restore → createStore(with adapter) → lifecycle.
// ---------------------------------------------------------------------------

export async function bootPersistedStore(
  boot: { board: Board; league: LeagueConfig },
  env: PersistEnv = detectEnv(),
  ctx = '',
): Promise<Store> {
  let restore: RestorePayload | null = null;
  try {
    restore = await bootRestore(env, ctx);
  } catch {
    restore = null;
  }
  const bp = createBrowserPersist(env, ctx);
  const store = createStore({
    board: boot.board,
    league: boot.league,
    persist: bp ? bp.adapter : null,
    restore,
  });
  attachLifecycle(env, bp);
  requestStoragePersist(env);
  return store;
}
