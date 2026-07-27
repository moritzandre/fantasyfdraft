// PlanBSheet.tsx — #/planb: the EXACT printed S4 big board (the same Preact
// renderer, src/components/print/BigBoard.tsx) on-screen, with drafted
// players struck through. If the engine ever throws mid-draft this degrades
// to a very good paper experience without leaving the app.
//
// BigBoard has no drafted-prop (print never needs one), and it is NOT ours to
// edit — so the strike-through is applied client-side: BigBoard renders one
// .bb-row per player in overallRank order, so row i ↔ players-sorted[i], and
// an effect toggles .lv-struck by idx lookup. print.css is injected as a
// scoped-lifetime <style> (?inline) so the paged-media CSS exists only while
// this route is mounted and never fights the app chrome elsewhere.

import { useEffect, useMemo, useRef } from 'preact/hooks';
import BigBoard from '../print/BigBoard';
import PdfBuilder from './PdfBuilder';
import printCss from '../../styles/print.css?inline';
import type { Board, DraftState, Store } from '../../state/store';

export default function PlanBSheet({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const { dispatch } = store;
  const host = useRef<HTMLDivElement>(null);

  const sorted = useMemo(
    () => [...board.players].sort((a, b) => a.overallRank - b.overallRank),
    [board],
  );
  const drafted = useMemo(() => new Set(s.picks.map((p) => p.idx)), [s.rev]);

  useEffect(() => {
    const rows = host.current?.querySelectorAll('.bb-row:not(.bb-headrow)');
    if (!rows) return;
    rows.forEach((el, i) => {
      const idx = sorted[i]?.idx;
      el.classList.toggle('lv-struck', idx !== undefined && drafted.has(idx));
    });
  }, [drafted, sorted]);

  return (
    <div class="lv-planb">
      <style>{printCss}</style>
      <div class="sticky top-0 z-10 flex items-center gap-2 border-b border-app-border bg-app-surface px-3 py-2 text-app-text">
        <a
          href="#/live"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-bg px-3 font-bold"
        >
          ← Live
        </a>
        <h1 class="min-w-0 flex-1 truncate text-lg font-bold">
          Plan B — printed big board · {drafted.size} gone
        </h1>
        <button
          type="button"
          class={`min-h-14 rounded-lg border px-4 font-semibold ${
            s.ui.grayscalePreview ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-bg'
          }`}
          onClick={() => dispatch({ type: 'SET_UI', ui: { grayscalePreview: !s.ui.grayscalePreview } })}
        >
          B&W
        </button>
      </div>
      <PdfBuilder s={s} />
      <p class="border-b border-app-border bg-app-surface px-3 py-2 text-sm text-app-dim">
        Print-grade tier board — engine-free fallback. Drafted players strike through as picks
        are recorded.
      </p>
      <div ref={host}>
        <BigBoard board={board} league={s.league} />
      </div>
    </div>
  );
}
