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
import { syncStartOpts } from '../../state/syncResume';
import {
  fetchDraft,
  fetchUserDrafts,
  isMockDraft,
  mapDraftToLeague,
  resolveUser,
} from '../../sync/sleeperMock';
import type { AppMode } from '../../state/mode';
import { loadAccount } from '../../state/account';

/** Subscribe to the app-wide sync manager (shared with the TopBar dot). */
export function useSyncInfo(): ManagedSyncInfo {
  const [info, setInfo] = useState(syncManager.getInfo());
  useEffect(() => syncManager.subscribe(setInfo), []);
  return info;
}

export default function SyncPanel({
  s,
  store,
  board,
  mode = 'real',
}: {
  s: DraftState;
  store: Store;
  board: Board;
  mode?: AppMode;
}) {
  const info = useSyncInfo();
  const persisted = ((s.ui as Record<string, unknown>).sleeperDraftId as string | undefined) ?? '';
  const [draftId, setDraftId] = useState(info.draftId ?? persisted);
  const [leagueId, setLeagueId] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const running = info.status !== 'stopped';

  /** Practice-only clean slate before pointing sync at a NEW draft: stop the
      old loop, wipe the old mock's picks and its room seed/label — remnants
      of the previous draft must never mix into the synced one. */
  const wipePracticeDraft = () => {
    syncManager.stop();
    store.dispatch({ type: 'RESET_DRAFT' });
    store.dispatch({
      type: 'SET_UI',
      ui: { mockSeed: undefined, mockLabel: undefined } as unknown as Partial<UiState>,
    });
  };

  const start = () => {
    const id = draftId.trim();
    if (!id) return;
    setNote(null);
    // Same id as the last synced draft = resume (picks kept). A DIFFERENT id
    // in practice mode gets the clean-slate treatment — never in real mode,
    // where the recorded picks are the actual draft.
    if (mode === 'practice' && id !== persisted) wipePracticeDraft();
    // syncAutoResume rides every Start and is only cleared by the explicit
    // Stop button — a reload mid-draft restarts sync (LiveApp maybeResumeSync).
    store.dispatch({
      type: 'SET_UI',
      ui: { sleeperDraftId: id, syncAutoResume: true } as unknown as Partial<UiState>,
    });
    // Practice mode tolerates off-board picks (mock rooms draft outside our
    // board): skip + log instead of pause. Real mode keeps the pause invariant.
    syncManager.start(store, board, id, syncStartOpts(mode));
  };

  // ── Sleeper MOCK discovery (practice mode only) ─────────────────────────
  const [username, setUsername] = useState(() => loadAccount()?.username ?? '');
  const [mockUserId, setMockUserId] = useState<string | null>(null);
  const [mocks, setMocks] = useState<Array<Record<string, unknown>> | null>(null);

  const findMocks = async () => {
    const name = username.trim();
    if (!name) return;
    setNote('Looking up your Sleeper mock drafts…');
    setMocks(null);
    try {
      const user = await resolveUser(name);
      setMockUserId(user.userId);
      const season = String(new Date().getFullYear());
      const drafts = await fetchUserDrafts(user.userId, season);
      const found = drafts
        .filter(isMockDraft)
        .sort((a: any, b: any) => (b.created ?? 0) - (a.created ?? 0))
        .slice(0, 6);
      setMocks(found);
      setNote(found.length === 0
        ? `No ${season} mock drafts on that account yet — join a mock lobby in the Sleeper app first.`
        : `${found.length} mock draft${found.length === 1 ? '' : 's'} found — tap one to track it.`);
    } catch (e) {
      setNote(`Mock lookup failed: ${String((e as Error)?.message ?? e)}`);
    }
  };

  const trackMock = async (d: Record<string, unknown>) => {
    const id = String(d.draft_id ?? '');
    if (!id || !mockUserId) return;
    setNote('Reading draft settings…');
    try {
      const meta = await fetchDraft(id);
      const mapped = mapDraftToLeague(meta, mockUserId);
      if ('error' in mapped) {
        setNote(`Can't track this draft: ${mapped.error}`);
        return;
      }
      // Clean slate FIRST (stop sync → RESET_DRAFT → clear seed/label): the
      // previous mock's picks must be gone before the new league shape and
      // the first synced pick land — no remnants mixing into this draft.
      wipePracticeDraft();
      store.dispatch({ type: 'SET_LEAGUE', league: mapped.league });
      setDraftId(id);
      store.dispatch({
        type: 'SET_UI',
        ui: {
          sleeperDraftId: id,
          mockLabel: `Sleeper mock ${id}`,
          syncAutoResume: true,
        } as unknown as Partial<UiState>,
      });
      syncManager.start(store, board, id, syncStartOpts('practice'));
      setNote(
        `Tracking mock ${id}.` +
          (mapped.warnings.length ? ` ⚠ ${mapped.warnings.join(' · ')}` : ''),
      );
    } catch (e) {
      setNote(`Failed to read draft: ${String((e as Error)?.message ?? e)}`);
    }
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

  // 1s re-render while running so the next-poll countdown actually counts.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const sleeperCount = s.picks.filter((p) => p.source === 'sleeper').length;
  const lastPoll =
    info.lastPollAt === null ? 'never' : new Date(info.lastPollAt).toLocaleTimeString();
  const nextIn =
    info.nextPollAt === null
      ? null
      : Math.max(0, Math.ceil((info.nextPollAt - Date.now()) / 1000));
  let statusLine = 'MANUAL — picks are entered by tapping the board.';
  if (info.status === 'live')
    statusLine = `LIVE — polling every ${Math.round(info.backoffMs / 1000)}s${
      nextIn !== null ? ` · next in ${nextIn}s` : ''
    }.`;
  else if (info.status === 'error' && info.paused) statusLine = 'PAUSED on an unresolved player — see below.';
  else if (info.status === 'error')
    statusLine = `OFFLINE — ${info.error ?? 'poll failed'} · retrying in ~${
      nextIn !== null ? nextIn : Math.round(info.backoffMs / 1000)
    }s${info.backoffMs > POLL_MS ? ' (backing off)' : ''}.`;

  return (
    <main class="mx-auto max-w-xl px-4 pb-16">
      <div class="lv-blurbar sticky top-0 z-10 flex items-center gap-2 py-2">
        <a
          href="#/live"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Live
        </a>
        <h1 class="lv-h-tool lv-tool-sync flex-1 text-lg font-bold">Sleeper sync</h1>
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
        <h2 class="lv-h-tool lv-tool-sync pb-1 text-xs font-bold tracking-widest">SLEEPER DRAFT ID</h2>
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
        <h2 class="lv-h-tool lv-tool-sync pb-1 text-xs font-bold tracking-widest">
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

      {/* Sleeper MOCK drafts — practice mode only: discovery via username
          (mocks have no league_id, so the league lookup can never find them) */}
      {mode === 'practice' && (
        <section class="lv-tool-sync mt-4 rounded-xl border border-app-border bg-app-surface/50 p-3">
          <h2 class="lv-h-tool pb-1 text-xs font-bold tracking-widest">
            SLEEPER MOCK DRAFT (PRACTICE)
          </h2>
          <p class="pb-2 text-sm text-app-dim">
            Join a mock lobby in the Sleeper app, then find it here by username. League shape and
            your slot are read from the draft; off-board picks are skipped, never fatal.
          </p>
          <div class="flex gap-1">
            <input
              type="text"
              autocomplete="off"
              value={username}
              placeholder="Sleeper username"
              aria-label="Sleeper username"
              onInput={(e: any) => setUsername(e.currentTarget.value)}
              class="h-14 min-w-0 flex-1 rounded-lg border border-app-border bg-app-bg px-3 text-[17px] outline-none focus:border-accent"
            />
            <button
              type="button"
              class="h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-4 font-bold"
              onClick={findMocks}
              disabled={username.trim() === ''}
            >
              Find mocks
            </button>
          </div>
          {mocks && mocks.length > 0 && (
            <ul class="mt-2 flex flex-col gap-1">
              {mocks.map((d: any) => (
                <li>
                  <button
                    type="button"
                    class="flex min-h-14 w-full items-center gap-2 rounded-lg border border-app-border bg-app-bg px-3 text-left"
                    onClick={() => trackMock(d)}
                  >
                    <span class="num min-w-0 flex-1 truncate text-sm">
                      {String(d.draft_id)}
                    </span>
                    <span class="num shrink-0 text-xs text-app-dim">
                      {d.settings?.teams ?? '?'}-team · {String(d.status ?? '')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {note && <p class="pt-2 text-sm text-app-dim">{note}</p>}

      {/* Off-board picks skipped this session ('skip' mode) */}
      {info.offboard && info.offboard.length > 0 && (
        <section class="mt-3 rounded-lg border border-app-border bg-app-surface p-3 text-sm">
          <h3 class="pb-1 text-xs font-bold tracking-widest text-app-dim">
            OFF-BOARD PICKS (SKIPPED)
          </h3>
          <ul class="num flex flex-col gap-0.5 text-app-dim">
            {info.offboard.map((o) => (
              <li>
                pick {o.pickNo}: {o.name ?? `player_id ${o.playerId}`}
                {o.pos ? ` (${o.pos}${o.team ? ` · ${o.team}` : ''})` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

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
          onClick={() => {
            // Explicit Stop is the ONE gesture that also clears the
            // auto-resume flag — a reload after this stays stopped.
            syncManager.stop();
            store.dispatch({
              type: 'SET_UI',
              ui: { syncAutoResume: false } as unknown as Partial<UiState>,
            });
          }}
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
