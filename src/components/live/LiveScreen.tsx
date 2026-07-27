// LiveScreen.tsx — S3, the draft screen. TopBar + a 3-column CSS grid
// (22 / 44 / 34: MY TEAM · SHORTLIST · BOARD), container-query responsive:
// under 900px it collapses to a single column with a bottom tab bar
// (Board / Recs / My Team). NO modals anywhere in this subtree — every
// overlay-shaped thing (pick log, Plan B) is a hash ROUTE. Wake lock is
// armed while mounted (first gesture requests it, visibility re-acquires).

import { useEffect, useState } from 'preact/hooks';
import type { Board, DraftState, Store } from '../../state/store';
import { enableWakeLock } from '../../ui/wakelock';
import BoardList from './BoardList';
import RecCards from './RecCards';
import RosterRail from './RosterRail';
import TopBar from './TopBar';

const TABS: [string, string][] = [
  ['board', 'Board'],
  ['recs', 'Recs'],
  ['team', 'My Team'],
];

export default function LiveScreen({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const [tab, setTab] = useState<'board' | 'recs' | 'team'>('recs');

  useEffect(() => enableWakeLock(), []);

  return (
    <div class="lv-root" data-tab={tab}>
      <TopBar s={s} store={store} />
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
