// LiveScreen.tsx — S3, the draft screen. TopBar + a 3-column CSS grid
// (22 / 44 / 34: MY TEAM · SHORTLIST · BOARD), container-query responsive:
// under 900px it collapses to a single column with a bottom tab bar
// (Board / Recs / My Team) that stacks above the persistent NavBar. NO
// modals anywhere in this subtree — every overlay-shaped thing (pick log,
// Plan B) is a hash ROUTE. Wake lock is armed while mounted (first gesture
// requests it, visibility re-acquires). Real mode with zero picks and sync
// stopped shows the dismissible "connect" strip → #/sync.

import { useEffect, useState } from 'preact/hooks';
import type { Board, DraftState, Store } from '../../state/store';
import type { AppMode } from '../../state/mode';
import { enableWakeLock } from '../../ui/wakelock';
import BoardList from './BoardList';
import MockControls from './MockControls';
import RecCards from './RecCards';
import RosterRail from './RosterRail';
import TopBar from './TopBar';
import { useSyncInfo } from './SyncPanel';

const CONNECT_DISMISS_KEY = 'dp:connect-dismissed';

const TABS: [string, string][] = [
  ['board', 'Board'],
  ['recs', 'Recs'],
  ['team', 'My Team'],
];

export default function LiveScreen({
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
  const [tab, setTab] = useState<'board' | 'recs' | 'team'>('recs');

  useEffect(() => enableWakeLock(), []);

  // Practice-only: the MockControls strip. Real mode renders byte-identical
  // #/live — draft day never sees any of this.
  const practice = mode === 'practice';

  // Real mode, empty draft, sync stopped: the "connect" entry point — a slim
  // 56px strip to #/sync (join a live or mock Sleeper draft). Dismiss is
  // per-session (sessionStorage); [data-connect] makes the grid subtract it
  // (live.css calc table), so nothing overlaps.
  const sync = useSyncInfo();
  const [connectHidden, setConnectHidden] = useState(() => {
    try {
      return sessionStorage.getItem(CONNECT_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const showConnect =
    !practice && s.picks.length === 0 && sync.status === 'stopped' && !connectHidden;
  const dismissConnect = () => {
    try {
      sessionStorage.setItem(CONNECT_DISMISS_KEY, '1');
    } catch {
      /* private mode — in-memory dismiss still holds this render */
    }
    setConnectHidden(true);
  };

  return (
    <div
      class="lv-root"
      data-tab={tab}
      data-practice={practice ? '' : undefined}
      data-connect={showConnect ? '' : undefined}
    >
      <TopBar s={s} store={store} />
      {practice && <MockControls s={s} store={store} board={board} />}
      {showConnect && (
        <div class="lv-connect flex items-stretch">
          <a
            href="#/sync"
            class="flex min-w-0 flex-1 items-center gap-2 px-4 text-[15px] font-semibold"
          >
            <span class="h-3 w-3 shrink-0 rounded-full border border-app-border bg-app-border" />
            <span class="truncate">
              Not connected — tap to join a live or mock Sleeper draft
            </span>
          </a>
          <button
            type="button"
            class="min-w-14 shrink-0 font-bold text-app-dim"
            aria-label="Dismiss for this session"
            onClick={dismissConnect}
          >
            ✕
          </button>
        </div>
      )}
      <div class="lv-grid">
        <section class="lv-panel lv-panel-team">
          <RosterRail s={s} store={store} board={board} />
        </section>
        <section class="lv-panel lv-panel-recs">
          <RecCards s={s} store={store} board={board} />
        </section>
        <section class="lv-panel lv-panel-board">
          <BoardList s={s} store={store} board={board} />
        </section>
      </div>
      <nav class="lv-tabs">
        {TABS.map(([id, label]) => (
          <button
            type="button"
            class={`h-full flex-1 text-[15px] font-bold ${
              tab === id ? 'text-accent' : 'text-app-dim'
            }`}
            onClick={() => setTab(id as 'board' | 'recs' | 'team')}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
