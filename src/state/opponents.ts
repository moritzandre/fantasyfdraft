// opponents.ts — loader for public/data/opponents.json (seat names +
// tendencies + archetype mix) MERGED with the LOCAL room patch the Sim Lab
// Room editor keeps in localStorage (dp:opponents-local:v1). Fetched ONCE
// per session and cached; a missing/broken file degrades to neutral
// anonymous seats. Consumers: the League view (seat names), the mock-draft
// driver and RehearsalTab (the opponent model), the Recs insights strip,
// the Sim Lab sweeps. After a Room-editor save call invalidateOpponents()
// so the next loadOpponents() re-merges. Erasable TS.
//
// Local patch semantics (applyLocalOpponents):
//   archetypes.mix  REPLACES the file mix entirely; an explicit null
//                   (patch.archetypes === null or .mix === null) turns
//                   archetypes OFF.
//   params          shallow-merged over the file params.
//   seats           PARTIAL list merged by seat number — only name,
//                   adpDiscipline and archetype (the per-seat FIXED
//                   strategy) are patchable; archetype null/'' clears it.

export interface OpponentSeat {
  seat: number;
  name?: string;
  adpDiscipline?: number;
  positionBias?: Record<string, number>;
  homerTeams?: string[];
  reachRounds?: number[];
  /** FIXED strategy for this seat — skips the archetype mix draw. */
  archetype?: string;
}

export interface OpponentsFile {
  seats?: OpponentSeat[];
  archetypes?: { mix?: Record<string, number> | null } | null;
  params?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface OpponentsLocalPatch {
  archetypes?: { mix?: Record<string, number> | null } | null;
  params?: Record<string, unknown> | null;
  seats?: Array<{ seat: number; name?: string; adpDiscipline?: number; archetype?: string | null }>;
}

export interface OppStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const LOCAL_OPPONENTS_KEY = 'dp:opponents-local:v1';

function defaultStorage(): OppStorageLike | null {
  try {
    const s = (globalThis as any).localStorage;
    return s && typeof s.getItem === 'function' ? (s as OppStorageLike) : null;
  } catch {
    return null;
  }
}

/** The local room patch, or null when absent/corrupt — never a throw. */
export function loadLocalOpponents(
  storage: OppStorageLike | null = defaultStorage(),
): OpponentsLocalPatch | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LOCAL_OPPONENTS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? (o as OpponentsLocalPatch) : null;
  } catch {
    return null;
  }
}

/** SYNCHRONOUS write (the prefs.ts convention — never debounced); patch
    null clears the local layer ("Reset to file"). */
export function saveLocalOpponents(
  patch: OpponentsLocalPatch | null,
  storage: OppStorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (patch === null) {
      if (typeof storage.removeItem === 'function') storage.removeItem(LOCAL_OPPONENTS_KEY);
      else storage.setItem(LOCAL_OPPONENTS_KEY, 'null');
    } else {
      storage.setItem(LOCAL_OPPONENTS_KEY, JSON.stringify(patch));
    }
  } catch {
    /* quota/private mode — the session keeps its in-memory room */
  }
}

/** Pure deep-merge of the local patch over the file (see header). */
export function applyLocalOpponents(
  file: OpponentsFile,
  patch: OpponentsLocalPatch | null,
): OpponentsFile {
  if (!patch) return file;
  const out: OpponentsFile = { ...file };
  if ('archetypes' in patch) {
    const a = patch.archetypes;
    if (a === null || a?.mix == null) out.archetypes = null; // archetypes OFF
    else out.archetypes = { mix: { ...a.mix } };
  }
  if (patch.params && typeof patch.params === 'object' && !Array.isArray(patch.params)) {
    out.params = { ...(file.params ?? {}), ...patch.params };
  }
  if (Array.isArray(patch.seats) && patch.seats.length > 0) {
    const merged: OpponentSeat[] = (file.seats ?? []).map((s) => ({ ...s }));
    for (const ps of patch.seats) {
      if (!ps || typeof ps.seat !== 'number') continue;
      let tgt = merged.find((m) => m.seat === ps.seat);
      if (!tgt) {
        tgt = { seat: ps.seat };
        merged.push(tgt);
      }
      if (typeof ps.name === 'string') tgt.name = ps.name;
      if (typeof ps.adpDiscipline === 'number' && Number.isFinite(ps.adpDiscipline)) {
        tgt.adpDiscipline = Math.min(1, Math.max(0, ps.adpDiscipline));
      }
      if ('archetype' in ps) {
        if (typeof ps.archetype === 'string' && ps.archetype.length > 0) tgt.archetype = ps.archetype;
        else delete tgt.archetype; // null/'' clears the fixed strategy
      }
    }
    merged.sort((a, b) => a.seat - b.seat);
    out.seats = merged;
  }
  return out;
}

let cache: Promise<OpponentsFile> | null = null;

export function loadOpponents(
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u),
  baseUrl: string = (import.meta as any).env?.BASE_URL ?? '/',
  storage: OppStorageLike | null = defaultStorage(),
): Promise<OpponentsFile> {
  if (!cache) {
    cache = fetchFn(baseUrl + 'data/opponents.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`opponents.json HTTP ${r.status}`))))
      .then((o: any) => (o && typeof o === 'object' ? (o as OpponentsFile) : { seats: [] }))
      .catch((e) => {
        console.warn('[opponents] load failed — neutral seats:', (e as Error)?.message ?? e);
        return { seats: [] } as OpponentsFile;
      })
      .then((file: OpponentsFile) => applyLocalOpponents(file, loadLocalOpponents(storage)));
  }
  return cache;
}

/** Invalidate the session cache — call after a Room-editor save so the NEXT
    loadOpponents() re-merges file + local. Components that already loaded
    the room keep their copy until they re-mount; nothing re-rolls
    mid-draft. */
export function invalidateOpponents(): void {
  cache = null;
}

/** Display name for a seat: the configured name, else T{slot}; the user's
    own slot renders as YOU wherever the caller passes mySlot. */
export function seatName(opp: OpponentsFile | null, slot: number, mySlot?: number): string {
  if (mySlot != null && slot === mySlot) return 'YOU';
  const seat = opp?.seats?.find((x) => x.seat === slot);
  const name = seat?.name?.trim();
  return name && name.length > 0 && name !== `ME (slot ${slot})` ? name : `T${slot}`;
}

/** Test hook (alias of invalidateOpponents, kept for existing callers). */
export function _resetOpponentsCache(): void {
  invalidateOpponents();
}
