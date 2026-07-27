// PickLog.tsx — the editable pick log (#/log; opened by long-pressing UNDO)
// plus CATCH-UP mode ("I looked away for 6 picks"): multi-select remaining
// players → ONE commit, marked gone in ADP order from the current cursor.
// A full-screen ROUTE, not a modal — the live screen never hosts dialogs.
// Row edits dispatch EDIT_PICK (inline player search); delete = idx null.

import { useMemo, useState } from 'preact/hooks';
import { roundForPick, slotForPick } from '../../../engine/picks.js';
import { abbrevName, fmtAdp } from '../../../shared/format.js';
import type { Board, DraftState, Store } from '../../state/store';
import { selectors } from '../../state/store';

export default function PickLog({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const { dispatch } = store;
  const [mode, setMode] = useState<'log' | 'catchup'>('log');
  const [editing, setEditing] = useState<number | null>(null); // pick number
  const [editQ, setEditQ] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [catchQ, setCatchQ] = useState('');

  const pool = useMemo(
    () => selectors.remainingPool(s, board).slice().sort((a, b) => a.overallRank - b.overallRank),
    [s.rev],
  );

  const teamLabel = (n: number) => {
    const slot = slotForPick(n, s.league.teams, s.league.snake);
    return slot === s.league.slot ? 'YOU' : `T${slot}`;
  };

  const editMatches = useMemo(() => {
    const q = editQ.trim().toLowerCase();
    if (!q) return pool.slice(0, 8);
    return pool.filter((p) => `${p.name} ${p.team}`.toLowerCase().includes(q)).slice(0, 8);
  }, [editQ, s.rev]);

  const catchMatches = useMemo(() => {
    const q = catchQ.trim().toLowerCase();
    const base = q ? pool.filter((p) => `${p.name} ${p.team}`.toLowerCase().includes(q)) : pool;
    return base.slice(0, 40);
  }, [catchQ, s.rev]);

  const commitCatchup = () => {
    if (selected.size === 0) return;
    // one commit, in ADP order — the order the room most plausibly took them
    const idxs = [...selected]
      .map((idx) => board.players[idx])
      .sort((a, b) => (a.adp?.mu ?? 999) - (b.adp?.mu ?? 999))
      .map((p) => p.idx);
    dispatch({ type: 'CATCHUP', idxs });
    setSelected(new Set());
    setCatchQ('');
    location.hash = '#/live';
  };

  const log = s.picks.slice().reverse(); // latest first

  return (
    <main class="mx-auto max-w-2xl px-3 pb-24">
      <div class="sticky top-0 z-10 flex items-center gap-2 bg-app-bg py-2">
        <a
          href="#/live"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Live
        </a>
        <h1 class="flex-1 text-lg font-bold">Pick log</h1>
        <button
          type="button"
          class={`min-h-14 rounded-lg border px-4 font-semibold ${
            mode === 'catchup' ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-surface'
          }`}
          onClick={() => setMode(mode === 'catchup' ? 'log' : 'catchup')}
        >
          Catch-up
        </button>
      </div>

      {mode === 'catchup' ? (
        <section>
          <p class="py-2 text-sm text-app-dim">
            Looked away? Select everyone who went, commit once — they're marked gone in ADP order
            starting at pick {s.pickCursor}.
          </p>
          <input
            type="search"
            value={catchQ}
            placeholder="Filter players"
            onInput={(e: any) => setCatchQ(e.currentTarget.value)}
            class="h-14 w-full rounded-lg border border-app-border bg-app-surface px-3 text-[17px] outline-none focus:border-accent"
          />
          <div class="mt-2 flex flex-col gap-1">
            {catchMatches.map((p) => {
              const on = selected.has(p.idx);
              return (
                <button
                  type="button"
                  class={`flex min-h-[52px] items-center gap-2 rounded-lg border px-3 text-left ${
                    on ? 'border-accent bg-app-surface' : 'border-app-border'
                  }`}
                  onClick={() => {
                    const next = new Set(selected);
                    if (on) next.delete(p.idx);
                    else next.add(p.idx);
                    setSelected(next);
                  }}
                >
                  <span class={`num w-6 text-center text-lg ${on ? 'text-accent' : 'text-app-dim'}`}>
                    {on ? '☑' : '☐'}
                  </span>
                  <span class="min-w-0 flex-1 truncate font-semibold">{abbrevName(p.name, 20)}</span>
                  <span class="num text-sm text-app-dim">
                    {p.pos}
                    {p.posRank} · {p.team} · ADP {fmtAdp(p.adp?.mu)}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={selected.size === 0}
            class={`fixed bottom-3 left-1/2 min-h-14 w-[min(92%,40rem)] -translate-x-1/2 rounded-xl font-bold ${
              selected.size > 0 ? 'bg-accent text-app-bg' : 'bg-app-surface text-app-dim'
            }`}
            onClick={commitCatchup}
          >
            Mark {selected.size} gone from pick {s.pickCursor}
          </button>
        </section>
      ) : (
        <section class="flex flex-col gap-1 py-1">
          {log.length === 0 && <p class="py-6 text-center text-app-dim">No picks recorded yet.</p>}
          {log.map((entry) => {
            const p = board.players[entry.idx];
            const isEditing = editing === entry.n;
            return (
              <div class="rounded-lg border border-app-border bg-app-surface">
                <div class="flex min-h-[52px] items-center gap-2 px-3">
                  <span class="num w-14 shrink-0 text-sm text-app-dim">
                    R{roundForPick(entry.n, s.league.teams)}·{entry.n}
                  </span>
                  <span
                    class={`num w-11 shrink-0 rounded px-1 text-center text-xs font-bold ${
                      teamLabel(entry.n) === 'YOU' ? 'bg-accent text-app-bg' : 'bg-app-bg text-app-dim'
                    }`}
                  >
                    {teamLabel(entry.n)}
                  </span>
                  <span class="min-w-0 flex-1 truncate font-semibold">
                    {p ? abbrevName(p.name, 20) : `#${entry.idx}?`}
                    <span class="num ml-2 text-xs text-app-dim">
                      {p ? `${p.pos}${p.posRank}` : ''} · {entry.source}
                    </span>
                  </span>
                  <button
                    type="button"
                    class="h-14 min-w-14 rounded-lg border border-app-border px-2 font-semibold"
                    onClick={() => {
                      setEditing(isEditing ? null : entry.n);
                      setEditQ('');
                    }}
                  >
                    {isEditing ? 'Close' : 'Edit'}
                  </button>
                  <button
                    type="button"
                    class="h-14 min-w-14 rounded-lg border border-app-border px-2 font-semibold text-app-dim"
                    title="Delete this pick entry (undoable)"
                    onClick={() => dispatch({ type: 'EDIT_PICK', pickNumber: entry.n, idx: null })}
                  >
                    ✕
                  </button>
                </div>
                {isEditing && (
                  <div class="border-t border-app-border p-2">
                    <input
                      type="search"
                      value={editQ}
                      placeholder={`Who really went at pick ${entry.n}?`}
                      onInput={(e: any) => setEditQ(e.currentTarget.value)}
                      class="h-14 w-full rounded-lg border border-app-border bg-app-bg px-3 text-[17px] outline-none focus:border-accent"
                    />
                    <div class="mt-1 flex flex-col">
                      {editMatches.map((m) => (
                        <button
                          type="button"
                          class="flex min-h-[52px] items-center gap-2 border-b border-app-border px-2 text-left last:border-b-0"
                          onClick={() => {
                            dispatch({ type: 'EDIT_PICK', pickNumber: entry.n, idx: m.idx });
                            setEditing(null);
                          }}
                        >
                          <span class="min-w-0 flex-1 truncate">{abbrevName(m.name, 20)}</span>
                          <span class="num text-sm text-app-dim">
                            {m.pos}
                            {m.posRank} · {m.team} · ADP {fmtAdp(m.adp?.mu)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}
