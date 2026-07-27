// SyncPanel.tsx — #/sync, opened from the TopBar sync dot. Sleeper draft-id
// entry (17px input + paste), league-id alternative (GET /v1/league/<id>/drafts
// → pickActiveDraft), Start/Stop at 56px, status line (last poll · picks
// synced · backoff), and the unresolved-player banner. The draftId is
// persisted in ui state (SET_UI) so it survives a relaunch. Sync itself runs
// in the module-level syncManager, so leaving this screen changes nothing.

import { useEffect, useState } from 'preact/hooks';
import type { Board, DraftState, Store, UiState } from '../../state/store';
import { POLL_MS, fetchDraftsForLeague, pickActiveDraft, syncManager } from '../../sync/sleeper';
import type { ManagedSyncInfo } from '../../sync/sleeper';

/** Subscribe to the app-wide sync manager (shared with the TopBar dot). */
export function useSyncInfo(): ManagedSyncInfo {
  const [info, setInfo] = useState(syncManager.getInfo());
  useEffect(() => syncManager.subscribe(setInfo), []);
  return info;
}

export default function SyncPanel({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const info = useSyncInfo();
  const persisted = ((s.ui as Record<string, unknown>).sleeperDraftId as string | undefined) ?? '';
  const [draftId, setDraftId] = useState(info.draftId ?? persisted);
  const [leagueId, setLeagueId] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const running = info.status !== 'stopped';

  const persistDraftId = (v: string) =>
    store.dispatch({ type: 'SET_UI', ui: { sleeperDraftId: v } as unknown as Partial<UiState> });

  const start = () => {
    const id = draftId.trim();
    if (!id) return;
    persistDraftId(id);
    setNote(null);
    syncManager.start(store, board, id);
  };

  const paste = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) {
        setDraftId(t);
        setNote(`Pasted ${t}`);
      } else {
        setNote('Clipboard is empty.');
      }
    } catch {
      setNote('Clipboard read blocked — type or long-press-paste into the field instead.');
    }
  };

  const findFromLeague = async () => {
    const id = leagueId.trim();
    if (!id) return;
    setNote('Looking up drafts for that league…');
    try {
      const drafts = await fetchDraftsForLeague(id);
      const found = pickActiveDraft(drafts);
      if (found) {
        const st = drafts.find((d) => d.draft_id === found)?.status;
        setDraftId(found);
        setNote(`Found draft ${found}${st ? ` (${st})` : ''} — tap Start.`);
      } else {
        setNote('That league has no drafts yet.');
      }
    } catch (e) {
      setNote(`Lookup failed: ${String((e as Error)?.message ?? e)}`);
    }
  };

  const sleeperCount = s.picks.filter((p) => p.source === 'sleeper').length;
  const lastPoll =
    info.lastPollAt === null ? 'never' : new Date(info.lastPollAt).toLocaleTimeString();
  let statusLine = 'MANUAL — picks are entered by tapping the board.';
  if (info.status === 'live') statusLine = `LIVE — polling every ${Math.round(info.backoffMs / 1000)}s.`;
  else if (info.status === 'error' && info.paused) statusLine = 'PAUSED on an unresolved player — see below.';
  else if (info.status === 'error')
    statusLine = `OFFLINE — ${info.error ?? 'poll failed'} · retrying in ~${Math.round(info.backoffMs / 1000)}s${
      info.backoffMs > POLL_MS ? ' (backing off)' : ''
    }.`;

  return (
    <main class="mx-auto max-w-xl px-4 pb-16">
      <div class="sticky top-0 z-10 flex items-center gap-2 bg-app-bg py-2">
        <a
          href="#/live"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Live
        </a>
        <h1 class="flex-1 text-lg font-bold">Sleeper sync</h1>
      </div>

      <p class="pt-1 text-sm text-app-dim">
        Progressive enhancement — manual entry always works. Synced picks go through the same
        reducer as taps and are individually undoable. If sync dies, the dot goes grey/red and
        nothing else changes.
      </p>

      {/* Unresolved-player banner — the one-line manual-fallback instruction */}
      {info.unresolved && (
        <div class="lv-clock-near mt-3 rounded-lg px-3 py-2 text-[15px] font-semibold">
          ⚠ {info.error ?? `Sleeper player_id ${info.unresolved} not on the board.`}
        </div>
      )}

      {/* Draft ID */}
      <section class="mt-4">
        <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">SLEEPER DRAFT ID</h2>
        <div class="flex gap-1">
          <input
            type="text"
            inputMode="numeric"
            autocomplete="off"
            value={draftId}
            placeholder="e.g. 1134567890123456789"
            aria-label="Sleeper draft ID"
            onInput={(e: any) => setDraftId(e.currentTarget.value)}
            class="num h-14 min-w-0 flex-1 rounded-lg border border-app-border bg-app-bg px-3 text-[17px] outline-none focus:border-accent"
          />
          <button
            type="button"
            class="h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-4 font-bold"
            onClick={paste}
          >
            Paste
          </button>
        </div>
      </section>

      {/* League ID alternative */}
      <section class="mt-4">
        <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">
          …OR FIND IT FROM THE LEAGUE ID
        </h2>
        <div class="flex gap-1">
          <input
            type="text"
            inputMode="numeric"
            autocomplete="off"
            value={leagueId}
            placeholder="Sleeper league ID"
            aria-label="Sleeper league ID"
            onInput={(e: any) => setLeagueId(e.currentTarget.value)}
            class="num h-14 min-w-0 flex-1 rounded-lg border border-app-border bg-app-bg px-3 text-[17px] outline-none focus:border-accent"
          />
          <button
            type="button"
            class="h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-4 font-bold"
            onClick={findFromLeague}
            disabled={leagueId.trim() === ''}
          >
            Find draft
          </button>
        </div>
      </section>

      {note && <p class="pt-2 text-sm text-app-dim">{note}</p>}

      {/* Start / Stop */}
      <section class="mt-4 flex gap-2">
        <button
          type="button"
          class={`h-14 flex-1 rounded-lg px-4 font-bold ${
            draftId.trim() === ''
              ? 'border border-app-border bg-app-surface text-app-dim'
              : 'bg-accent text-app-bg'
          }`}
          onClick={start}
          disabled={draftId.trim() === ''}
        >
          {running ? 'Restart sync' : 'Start sync'}
        </button>
        <button
          type="button"
          class="h-14 flex-1 rounded-lg border border-app-border bg-app-surface px-4 font-bold"
          onClick={() => syncManager.stop()}
          disabled={!running}
        >
          Stop
        </button>
      </section>

      {/* Status */}
      <section class="mt-4 rounded-lg border border-app-border bg-app-surface p-3 text-[15px]">
        <div class="font-bold">{statusLine}</div>
        <div class="num mt-1 text-app-dim">
          last poll {lastPoll} · {info.pickCount} pick{info.pickCount === 1 ? '' : 's'} synced this
          session · {sleeperCount} sleeper pick{sleeperCount === 1 ? '' : 's'} in the log
          {info.polls > 0 ? ` · ${info.polls} polls` : ''}
        </div>
      </section>
    </main>
  );
}
