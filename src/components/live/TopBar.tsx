// TopBar.tsx — 72px sticky, safe-area aware. Round·Pick · on-the-clock
// banner (grey / amber "2 away" / green YOU ARE UP) · "you pick in N" · sync
// dot (LIVE green / MANUAL grey / OFFLINE red-hatched — tap opens #/sync) ·
// UNDO 56px always-enabled (tap = UNDO, long-press 500ms = pick log) ·
// search (17px, debounced downstream) · Pick# stepper — the two-tap desync fix.

import { useEffect, useRef, useState } from 'preact/hooks';
import { roundForPick } from '../../../engine/picks.js';
import type { DraftState, Store } from '../../state/store';
import { selectors } from '../../state/store';
import { useSyncInfo } from './SyncPanel';

const LONG_PRESS_MS = 500;

export default function TopBar({ s, store }: { s: DraftState; store: Store }) {
  const { dispatch } = store;
  const total = s.league.teams * s.league.rounds;
  const done = s.pickCursor > total;
  const round = roundForPick(Math.min(s.pickCursor, total), s.league.teams);
  const myNext = selectors.myNextPick(s);
  const away = myNext === null ? null : myNext - s.pickCursor;

  let clockClass = 'lv-clock-far';
  let clockText = 'draft complete';
  if (!done) {
    if (away === 0) {
      clockClass = 'lv-clock-up';
      clockText = 'YOU ARE UP';
    } else if (away !== null && away <= 2) {
      clockClass = 'lv-clock-near';
      clockText = `${away} pick${away === 1 ? '' : 's'} away`;
    } else if (away !== null) {
      clockText = `you pick in ${away}`;
    } else {
      clockText = 'no picks left';
    }
  }

  // Search → ui.searchText, debounced 120ms.
  const [q, setQ] = useState(s.ui.searchText);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (v: string) => {
    setQ(v);
    if (deb.current) clearTimeout(deb.current);
    deb.current = setTimeout(() => dispatch({ type: 'SET_UI', ui: { searchText: v } }), 120);
  };
  useEffect(() => {
    // external clears (e.g. import) sync back into the field
    if (s.ui.searchText === '' && q !== '') setQ('');
  }, [s.ui.searchText]);

  // UNDO: tap = undo, long-press 500ms = open the editable pick log.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const undoDown = () => {
    longFired.current = false;
    pressTimer.current = setTimeout(() => {
      longFired.current = true;
      location.hash = '#/log';
    }, LONG_PRESS_MS);
  };
  const undoUp = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    if (!longFired.current) dispatch({ type: 'UNDO' });
  };
  const undoCancel = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  };

  // Sync dot — three states, never colour-only (label text + hatch pattern):
  // LIVE solid green · MANUAL grey · OFFLINE red-hatched. Tap opens SyncPanel.
  // When live the label carries the poll age ("LIVE·2s") — a 1s re-render
  // tick keeps it moving between status events, so sync visibly breathes.
  const sync = useSyncInfo();
  const [, setSyncTick] = useState(0);
  useEffect(() => {
    if (sync.status !== 'live') return;
    const t = setInterval(() => setSyncTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [sync.status]);
  let dotLabel = 'MANUAL';
  let dotClass = 'border-app-border bg-app-border';
  if (sync.status === 'live') {
    const age =
      sync.lastPollAt === null
        ? null
        : Math.max(0, Math.round((Date.now() - sync.lastPollAt) / 1000));
    dotLabel = age === null ? 'LIVE' : `LIVE·${age}s`;
    dotClass = 'lv-dot-ok';
  } else if (sync.status === 'error') {
    dotLabel = 'OFFLINE';
    dotClass = 'lv-dot-bad';
  }

  return (
    <header class="lv-topbar flex items-center gap-2 px-2">
      <div class="num shrink-0 px-1 text-sm leading-tight">
        <div class="font-bold">R{round}</div>
        <div class="text-app-dim">
          {done ? total : s.pickCursor}/{total}
        </div>
      </div>

      <div
        class={`${clockClass} flex h-14 min-w-0 flex-1 items-center justify-center rounded-lg px-3 text-center text-[17px] font-bold`}
      >
        <span class="truncate">{clockText}</span>
      </div>

      <button
        type="button"
        class="flex h-14 min-w-14 shrink-0 flex-col items-center justify-center rounded-lg border border-app-border bg-app-surface px-1"
        onClick={() => {
          location.hash = '#/sync';
        }}
        title="Sleeper sync — tap to configure"
        aria-label={`Sync: ${dotLabel}`}
      >
        <span class={`h-3 w-3 rounded-full border ${dotClass}`} />
        <span class="mt-0.5 text-[10px] tracking-wide text-app-dim">{dotLabel}</span>
      </button>

      <a
        href="#/league"
        class="lv-tool-league flex h-14 min-w-14 shrink-0 flex-col items-center justify-center rounded-lg border border-app-border bg-app-surface px-1 font-bold"
        title="League — all rosters + draft grid"
        aria-label="League view"
      >
        <span class="lv-h-tool text-sm">LG</span>
        <span class="mt-0.5 text-[10px] tracking-wide text-app-dim">LEAGUE</span>
      </a>

      <input
        type="search"
        value={q}
        placeholder="Search players"
        aria-label="Search players"
        onInput={(e: any) => onSearch(e.currentTarget.value)}
        class="h-14 w-40 min-w-0 shrink rounded-lg border border-app-border bg-app-bg px-3 text-[17px] outline-none focus:border-accent"
      />

      <div class="flex shrink-0 items-center gap-1" aria-label="Pick number override">
        <button
          type="button"
          class="num h-14 w-14 rounded-lg border border-app-border bg-app-bg text-xl"
          onClick={() => dispatch({ type: 'SET_PICK_CURSOR', pick: s.pickCursor - 1 })}
        >
          −
        </button>
        <div class="num w-12 text-center text-lg font-bold" title="pick on the clock">
          #{Math.min(s.pickCursor, total)}
        </div>
        <button
          type="button"
          class="num h-14 w-14 rounded-lg border border-app-border bg-app-bg text-xl"
          onClick={() => dispatch({ type: 'SET_PICK_CURSOR', pick: s.pickCursor + 1 })}
        >
          +
        </button>
      </div>

      <button
        type="button"
        class="relative h-14 min-w-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-2 font-bold"
        onPointerDown={undoDown}
        onPointerUp={undoUp}
        onPointerLeave={undoCancel}
        onPointerCancel={undoCancel}
        onContextMenu={(e: Event) => e.preventDefault()}
        title="Tap: undo last pick · Hold: pick log"
      >
        UNDO
        <span class="num absolute -top-1.5 -right-1.5 rounded-full bg-accent px-1.5 text-[11px] font-bold text-app-bg">
          {store.undoDepth()}
        </span>
      </button>
    </header>
  );
}
