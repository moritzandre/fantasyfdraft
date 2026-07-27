// mode.ts — the real/practice mode flag, OUTSIDE the store on purpose: the
// mode decides WHICH persisted store boots (see persist.ts contexts), so it
// cannot live inside one. Absent key ⇒ 'real' — the draft-day default.

import type { StorageLike } from './persist.ts';

export const MODE_KEY = 'dp:mode:v1';

export type AppMode = 'real' | 'practice';

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

export function getMode(storage: StorageLike | null = defaultStorage()): AppMode {
  if (!storage) return 'real';
  try {
    return storage.getItem(MODE_KEY) === 'practice' ? 'practice' : 'real';
  } catch {
    return 'real';
  }
}

export function setMode(mode: AppMode, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    if (mode === 'real') storage.removeItem(MODE_KEY); // absent ⇒ real
    else storage.setItem(MODE_KEY, mode);
  } catch {
    /* swallow */
  }
}
