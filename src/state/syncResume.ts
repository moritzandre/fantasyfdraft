// syncResume.ts — sync survives reloads. Every manual Start / trackMock sets
// ui.syncAutoResume=true (persisted with the draft state); the explicit Stop
// button sets it false. On store boot LiveApp calls maybeResumeSync: when a
// draft id is persisted AND the flag is truthy, sync restarts through the
// module-level syncManager with the mode-appropriate off-board policy
// ('skip' + the faster mock cadence in practice, the 'pause' invariant +
// POLL_MS default in real mode). Pure glue — no UI, no timers of its own.
// TypeScript here is ERASABLE only (Node strip-types convention).

import { MOCK_POLL_MS, syncManager } from '../sync/sleeper.ts';
import type { Board, Store } from './store.ts';
import type { AppMode } from './mode.ts';

/** Mode-appropriate syncManager.start options — ONE definition so Start,
    trackMock and auto-resume can never drift apart. Real mode: the pause
    invariant, default POLL_MS. Practice: skip off-board picks, poll faster. */
export function syncStartOpts(
  mode: AppMode,
): { onUnresolvable: 'pause' | 'skip'; intervalMs?: number } {
  return mode === 'practice'
    ? { onUnresolvable: 'skip', intervalMs: MOCK_POLL_MS }
    : { onUnresolvable: 'pause' };
}

/** Restart sync for a freshly booted store when the persisted ui says it was
    running (ui.sleeperDraftId set + ui.syncAutoResume truthy). Returns
    whether sync was started. */
export function maybeResumeSync(store: Store, board: Board, mode: AppMode): boolean {
  const ui = store.getState().ui as Record<string, unknown>;
  const id = typeof ui.sleeperDraftId === 'string' ? ui.sleeperDraftId.trim() : '';
  if (!id || !ui.syncAutoResume) return false;
  syncManager.start(store, board, id, syncStartOpts(mode));
  return true;
}
