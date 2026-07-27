// BoardList.tsx — the BOARD rail. Filter chips ALL/QB/RB/WR/TE/K/DST +
// TARGETS · search (ui.searchText, already debounced 120ms in TopBar) ·
// tier-banded 52px rows (4px left border via tokens.css) · row: rank ·
// tierLetter · abbrevName · posRank · team · bye · proj · ADP · adpArrow.
// TAP = dispatch PICK_MADE at the current cursor — one tap, no modes, no
// confirm (UNDO is 56px away and always enabled). Sliced to the top 60 with
// "show all"; rows are content-visibility:auto (live.css).

import { useMemo, useState } from 'preact/hooks';
import { abbrevName, adpArrow, fmtAdp, fmtInt, tierLetter } from '../../../shared/format.js';
import type { Board, DraftState, Store } from '../../state/store';
import { selectors } from '../../state/store';

const CHIPS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST', 'TARGETS'];
const SLICE = 60;

function isTarget(p: any): boolean {
  return Array.isArray(p.flags) && p.flags.some((f: any) => String(f).toLowerCase().includes('target'));
}

export default function BoardList({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const { dispatch } = store;
  const [showAll, setShowAll] = useState(false);
  const total = s.league.teams * s.league.rounds;
  const draftOver = s.pickCursor > total;

  const filtered = useMemo(() => {
    const pool = selectors.remainingPool(s, board).slice().sort((a, b) => a.overallRank - b.overallRank);
    const f = s.ui.posFilter;
    const q = s.ui.searchText.trim().toLowerCase();
    return pool.filter((p) => {
      if (f === 'TARGETS' && !isTarget(p)) return false;
      if (f !== 'ALL' && f !== 'TARGETS' && p.pos !== f) return false;
      if (q && !(`${p.name} ${p.team}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [s.rev]);

  const rows = showAll ? filtered : filtered.slice(0, SLICE);

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-wrap gap-1 p-2 pb-1">
        {CHIPS.map((c) => (
          <button
            type="button"
            class={`num min-h-14 rounded-lg border px-3 text-[15px] font-semibold ${
              s.ui.posFilter === c
                ? 'border-accent bg-accent text-app-bg'
                : 'border-app-border bg-app-surface text-app-text'
            }`}
            onClick={() => dispatch({ type: 'SET_UI', ui: { posFilter: c } })}
          >
            {c === 'TARGETS' ? '★' : c}
          </button>
        ))}
      </div>

      <div class="num px-3 pb-1 text-xs text-app-dim">
        {filtered.length} available{s.ui.searchText ? ` · “${s.ui.searchText}”` : ''}
      </div>

      <div class="min-h-0 flex-1">
        {rows.map((p) => {
          const tl = p.tierLetter ?? tierLetter(p.tier);
          const delta = p.adp?.mu != null ? p.adp.mu - p.overallRank : null;
          return (
            <button
              type="button"
              class={`lv-row lv-tier-${String(tl).toLowerCase()} flex w-full items-center gap-1.5 border-b border-app-border px-2 text-left active:bg-app-surface`}
              disabled={draftOver}
              onClick={() => dispatch({ type: 'PICK_MADE', idx: p.idx, source: 'manual' })}
              title={`Record ${p.name} taken at pick ${s.pickCursor}`}
            >
              <span class="num w-8 shrink-0 text-right text-sm text-app-dim">{p.overallRank}</span>
              <span class={`lv-chip-${String(tl).toLowerCase()} num w-5 shrink-0 rounded text-center text-xs font-bold`}>
                {tl}
              </span>
              <span class="min-w-0 flex-1 truncate text-[16px] font-semibold">
                {abbrevName(p.name, 18)}
                {isTarget(p) && <span class="ml-1 text-accent">★</span>}
              </span>
              <span class={`lv-pos-${p.pos.toLowerCase()} num w-9 shrink-0 pb-0.5 text-center text-[13px] font-bold`}>
                {p.pos}
                {p.posRank}
              </span>
              <span class="num w-9 shrink-0 text-center text-xs text-app-dim">{p.team}</span>
              <span class="num w-6 shrink-0 text-center text-xs text-app-dim">{p.bye ?? '—'}</span>
              <span class="num w-9 shrink-0 text-right text-sm">{fmtInt(p.proj?.halfPpr)}</span>
              <span class="num w-8 shrink-0 text-right text-xs text-app-dim">{fmtAdp(p.adp?.mu)}</span>
              <span class="w-4 shrink-0 text-center text-xs">{adpArrow(delta)}</span>
            </button>
          );
        })}

        {!showAll && filtered.length > SLICE && (
          <button
            type="button"
            class="min-h-14 w-full text-center font-semibold text-accent"
            onClick={() => setShowAll(true)}
          >
            Show all {filtered.length}
          </button>
        )}
        {rows.length === 0 && <p class="p-4 text-app-dim">No players match.</p>}
      </div>
    </div>
  );
}
