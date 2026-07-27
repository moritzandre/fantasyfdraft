// LeagueScreen.tsx — #/league: the room, not just my seat. Two modes
// (PickLog's log|catchup precedent): ROSTERS — all N team cards built from
// selectors.rosterOf + fillSlots (the same pure pieces MY TEAM uses), with
// per-team needs, next-pick-at, an inferred "plays like: …" archetype chip
// (engine/insights.js inferSeatStrategies) and, for seats picking inside MY
// wait window, their likely next picks (src/state/intent.ts likelyPicks);
// GRID — the live rounds×teams draft board (LiveDraftGrid). Everything is
// derived from the pick log, memoized on [s.rev], never persisted; intent is
// pure decoration — any failure renders nothing. Display-only: recording
// picks stays a one-tap action on #/live.
// Live feel: a "latest picks" ticker strip (last 5, newest first, position-
// tinted) sits above both modes, and a team card flashes briefly when that
// seat's pick count increases (prev counts in a ref — sync/sim/manual all
// read the same way because it's derived from s.picks, not the source).

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Board, DraftState, Store } from '../../state/store';
import { selectors } from '../../state/store';
import { fillSlots } from './RosterRail';
import { leagueNeeds } from '../../../engine/insights.js';
import { nextMyPick, roundForPick, slotForPick } from '../../../engine/picks.js';
import { abbrevName } from '../../../shared/format.js';
import { loadOpponents, seatName } from '../../state/opponents';
import type { OpponentsFile } from '../../state/opponents';
import { inferSeats, likelyPicks } from '../../state/intent';
import type { SeatRead } from '../../state/intent';
import { loadStrategies } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';
import LiveDraftGrid from './LiveDraftGrid';

type Mode = 'rosters' | 'grid';

export default function LeagueScreen({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const [mode, setMode] = useState<Mode>('rosters');
  const [opp, setOpp] = useState<OpponentsFile | null>(null);
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  useEffect(() => {
    loadOpponents().then(setOpp);
    loadStrategies().then(setRegistry);
  }, []);

  const entries = useMemo(() => s.picks.map((p) => ({ n: p.n, idx: p.idx })), [s.rev]);

  const needs = useMemo(
    () => leagueNeeds(entries, s.league, board.players, s.pickCursor),
    [s.rev],
  );

  // "plays like" reads — lazy (registry loaded), silent on failure.
  const reads: SeatRead[] | null = useMemo(() => {
    if (registry === null) return null;
    try {
      return inferSeats(board, s.league, registry, entries);
    } catch {
      return null;
    }
  }, [s.rev, registry]);

  // Likely next picks for the seats that pick BETWEEN the cursor and my next
  // pick (waitWindowThreats' window semantics: when I'm on the clock the
  // window starts after my pick). Decoration — failures render nothing.
  const likelyBySlot = useMemo(() => {
    const m = new Map<number, string>();
    if (!opp || registry === null) return m;
    const winStart = selectors.isMyPick(s) ? s.pickCursor + 1 : s.pickCursor;
    const winEnd = nextMyPick(winStart, s.league);
    if (winEnd === null) return m;
    for (const t of needs.teams) {
      if (t.slot === s.league.slot || t.nextPickAt === null) continue;
      if (t.nextPickAt < winStart || t.nextPickAt >= winEnd) continue;
      try {
        const lp = likelyPicks(
          board, s.league, opp, registry, entries,
          t.slot, roundForPick(t.nextPickAt, s.league.teams), 3,
        );
        const names = lp
          .map((x) => abbrevName(board.players[x.idx]?.name ?? `#${x.idx}`, 14))
          .join(' · ');
        if (names) m.set(t.slot, names);
      } catch {
        /* intent is decoration — the card renders without it */
      }
    }
    return m;
  }, [s.rev, opp, registry]);
  const rosters = useMemo(
    () =>
      Array.from({ length: s.league.teams }, (_, i) =>
        fillSlots(selectors.rosterOf(s, board, i + 1), s.league),
      ),
    [s.rev],
  );
  const onClock = selectors.onClockSlot(s);

  // ── Latest-picks ticker: last 5 recorded picks, newest first ────────────
  const latest = useMemo(
    () =>
      [...s.picks]
        .sort((a, b) => b.n - a.n)
        .slice(0, 5)
        .map((p) => ({
          n: p.n,
          round: roundForPick(p.n, s.league.teams),
          slot: slotForPick(p.n, s.league.teams, s.league.snake),
          player: board.players[p.idx] ?? null,
        })),
    [s.rev],
  );

  // ── Flash the cards of seats that picked since the last render ──────────
  // Prev pick-count per slot in a ref; any increase flags that slot for a
  // brief highlight (cleared on a timer). Derived from s.picks, so synced,
  // simmed and manual picks all flash the same way. UNDO only decreases —
  // never flashes.
  const prevCounts = useRef<Map<number, number> | null>(null);
  const [flashSlots, setFlashSlots] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    const counts = new Map<number, number>();
    for (const p of s.picks) {
      const slot = slotForPick(p.n, s.league.teams, s.league.snake);
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    const prev = prevCounts.current;
    prevCounts.current = counts;
    if (!prev) return;
    const grew = new Set<number>();
    counts.forEach((c, slot) => {
      if (c > (prev.get(slot) ?? 0)) grew.add(slot);
    });
    if (grew.size === 0) return;
    setFlashSlots(grew);
    const t = setTimeout(() => setFlashSlots(new Set()), 1600);
    return () => clearTimeout(t);
  }, [s.rev]);

  return (
    <main class="lv-tool-league mx-auto max-w-6xl px-3 pb-16">
      <div class="lv-blurbar sticky top-0 z-10 flex items-center gap-2 py-2">
        <a
          href="#/live"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Live
        </a>
        <h1 class="lv-h-tool flex-1 text-lg font-bold">League</h1>
        {(['rosters', 'grid'] as Mode[]).map((m) => (
          <button
            type="button"
            class={`h-14 rounded-lg border px-4 font-bold ${
              mode === m ? 'lv-seg-on' : 'border-app-border bg-app-surface'
            }`}
            onClick={() => setMode(m)}
          >
            {m === 'rosters' ? 'Rosters' : 'Grid'}
          </button>
        ))}
      </div>

      {latest.length > 0 && (
        <div
          class="lv-hscroll items-center gap-1.5 px-2 py-1.5"
          aria-label="Latest picks, newest first"
        >
          <span class="shrink-0 text-[11px] font-bold tracking-widest text-app-dim">LATEST</span>
          {latest.map((t, i) => (
            <span
              class={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs ${
                i === 0 ? 'border-accent/60 bg-app-surface' : 'border-app-border bg-app-surface/60'
              }`}
            >
              <span class="num text-app-dim">T{t.slot}</span>
              {t.player ? (
                <>
                  <span
                    class={`lv-post lv-post-${String(t.player.pos ?? '').toLowerCase()} num rounded px-1 font-bold`}
                  >
                    {t.player.pos}
                  </span>
                  <span class={`max-w-32 truncate font-semibold lv-pos-${String(t.player.pos ?? '').toLowerCase()}`}>
                    {abbrevName(t.player.name, 16)}
                  </span>
                </>
              ) : (
                <span class="text-app-dim">off-board</span>
              )}
              <span class="num text-app-dim">R{t.round}·{t.n}</span>
            </span>
          ))}
        </div>
      )}

      {mode === 'grid' ? (
        <LiveDraftGrid s={s} board={board} opp={opp} />
      ) : (
        <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {needs.teams.map((t) => {
            const isMe = t.slot === s.league.slot;
            const { slots, bench } = rosters[t.slot - 1];
            const read = !isMe ? reads?.[t.slot - 1] : undefined;
            const likely = likelyBySlot.get(t.slot);
            const needSummary = Object.entries(t.unfilled.dedicated)
              .map(([pos, n]) => ((n as number) > 1 ? `${n}×${pos}` : pos))
              .join(' · ');
            return (
              <section
                class={`rounded-xl border p-3 ${
                  isMe
                    ? 'border-accent bg-app-surface'
                    : t.slot === onClock
                      ? 'lv-bye-alert border-app-border bg-app-surface'
                      : 'border-app-border bg-app-surface/60'
                }${flashSlots.has(t.slot) ? ' lv-just-picked' : ''}`}
              >
                <header class="flex items-baseline justify-between pb-2">
                  <span class="min-w-0 font-bold">
                    {seatName(opp, t.slot, s.league.slot)}
                    <span class="ml-2 text-xs font-normal text-app-dim">T{t.slot}</span>
                    {read?.bestFit && (
                      <span
                        class={`ml-2 rounded border px-1.5 py-0.5 text-[11px] font-bold ${
                          read.confidence === 'strong'
                            ? 'border-accent text-accent'
                            : 'border-app-border text-app-dim'
                        }`}
                        title={`inferred from this seat's picks (${read.confidence})`}
                      >
                        plays like: {read.bestFit}
                        {read.confidence === 'lean' ? '?' : ''}
                      </span>
                    )}
                  </span>
                  <span class="num text-xs text-app-dim">
                    {t.slot === onClock
                      ? 'ON THE CLOCK'
                      : t.nextPickAt
                        ? `next @ ${t.nextPickAt}`
                        : 'done'}
                  </span>
                </header>
                <ul class="flex flex-col gap-0.5">
                  {slots.map((b) => (
                    <li class="flex items-center gap-2 text-sm">
                      <span class={`lv-post lv-post-${b.pos.toLowerCase()} num w-10 shrink-0 rounded text-center text-xs font-bold`}>
                        {b.label}
                      </span>
                      {b.player ? (
                        <span class={`truncate lv-pos-${b.player.pos.toLowerCase()}`}>
                          {abbrevName(b.player.name)}
                          <span class="ml-1 text-xs text-app-dim">{b.player.team}</span>
                        </span>
                      ) : (
                        <span class="text-app-dim">—</span>
                      )}
                    </li>
                  ))}
                </ul>
                {likely && (
                  <p class="truncate pt-1.5 text-xs text-app-dim" title="likely next pick (opponent model + inferred archetype)">
                    likely: <span class="text-app-text">{likely}</span>
                  </p>
                )}
                <footer class="flex items-baseline justify-between pt-2 text-xs text-app-dim">
                  <span>
                    {bench.length > 0 && `${bench.length} bench`}
                    {bench.length > 0 && needSummary && ' · '}
                    {needSummary && `needs ${needSummary}`}
                    {!needSummary && bench.length === 0 && `${t.picksMade} picks`}
                  </span>
                  {t.unfilled.flex > 0 && <span>{t.unfilled.flex} FLEX open</span>}
                </footer>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
