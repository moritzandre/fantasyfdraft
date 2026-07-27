// mockHistory.ts — the mock-draft archive (localStorage, GLOBAL key — not
// context-namespaced on purpose: mocks are archived from practice mode, but
// reviewing them anywhere is fine). Newest first, capped at 20 records;
// corrupt/absent data is an empty list, never a throw; writes are
// SYNCHRONOUS (the prefs.ts convention — never debounced). The record holds
// the raw picks so ReviewScreen can re-grade through gradeMyPicks
// (review.ts) at view time — the summary is only the grade AT ARCHIVE TIME
// for the row chips.
//
// TypeScript here is ERASABLE only (plain annotations — Node strip-types
// runs the .ts tests directly; no enums, no namespaces, no parameter
// properties). Storage is injectable so the tests stay hermetic.

export const MOCK_HISTORY_KEY = 'dp:mock-history:v1';
export const MOCK_HISTORY_CAP = 20;

export interface MockRecord {
  id: string; // e.g. `${finishedAt}-${seed ?? 'x'}`
  finishedAt: number; // Date.now() at archive time (UI layer passes it)
  league: { teams: number; slot: number; rounds: number; snake: boolean; strategy?: string };
  seed: number | null; // ui.mockSeed when present
  picks: Array<{ n: number; idx: number; source: string }>;
  /** Grade at archive time (row chips); null when grading was unavailable. */
  summary: { myPicks: number; matches: number; evens: number; totalDelta: number } | null;
}

export interface HistoryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): HistoryStorageLike | null {
  try {
    const s = (globalThis as any).localStorage;
    return s && typeof s.getItem === 'function' ? (s as HistoryStorageLike) : null;
  } catch {
    return null;
  }
}

function isRecord(x: unknown): x is MockRecord {
  const r = x as MockRecord;
  return (
    r !== null &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    typeof r.id === 'string' &&
    typeof r.finishedAt === 'number' &&
    r.league !== null &&
    typeof r.league === 'object' &&
    Array.isArray(r.picks)
  );
}

/** The archive, newest first. Corrupt blob / private mode ⇒ [], never a
    throw; invalid entries inside an otherwise-valid list are dropped. */
export function loadMockHistory(
  storage: HistoryStorageLike | null = defaultStorage(),
): MockRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(MOCK_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Stored newest-first (archiveMock prepends) — the sort is a guarantee,
    // not a reorder: stable, so equal timestamps keep their stored order.
    return parsed.filter(isRecord).sort((a, b) => b.finishedAt - a.finishedAt);
  } catch {
    return [];
  }
}

function save(list: MockRecord[], storage: HistoryStorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(MOCK_HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* quota/private mode — the returned list still serves this session */
  }
}

/** Prepend a record (an id collision replaces the old copy), cap at 20 —
    the oldest falls off. Returns the new list, newest first. */
export function archiveMock(
  record: MockRecord,
  storage: HistoryStorageLike | null = defaultStorage(),
): MockRecord[] {
  const rest = loadMockHistory(storage).filter((r) => r.id !== record.id);
  const list = [record, ...rest].slice(0, MOCK_HISTORY_CAP);
  save(list, storage);
  return list;
}

/** Remove one record by id. Returns the new list, newest first. */
export function deleteMock(
  id: string,
  storage: HistoryStorageLike | null = defaultStorage(),
): MockRecord[] {
  const list = loadMockHistory(storage).filter((r) => r.id !== id);
  save(list, storage);
  return list;
}
