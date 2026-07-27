// LeagueScreen.tsx — #/league: the room, not just my seat. Two modes
// (PickLog's log|catchup precedent): ROSTERS — all N team cards built from
// selectors.rosterOf + fillSlots (the same pure pieces MY TEAM uses), with
// per-team needs and next-pick-at; GRID — the live rounds×teams draft board
// (LiveDraftGrid). Everything is derived from the pick log, memoized on
// [s.rev], never persisted. Display-only: recording picks stays a one-tap
// action on #/live.

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Board, DraftState, Store } from '../../state/store';
import { selectors } from '../../state/store';
import { fillSlots } from './RosterRail';
import { leagueNeeds } from '../../../engine/insights.js';
import { abbrevName } from '../../../shared/format.js';
import { loadOpponents, seatName } from '../../state/opponents';
import type { OpponentsFile } from '../../state/opponents';
import LiveDraftGrid from './LiveDraftGrid';

type Mode = 'rosters' | 'grid';

export default function LeagueScreen({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const [mode, setMode] = useState<Mode>('rosters');
  const [opp, setOpp] = useState<OpponentsFile | null>(null);
  useEffect(() => {
    loadOpponents().then(setOpp);
  }, []);

  const needs = useMemo(
    () =>
      leagueNeeds(
        s.picks.map((p) => ({ n: p.n, idx: p.idx })),
        s.league,
        board.players,
        s.pickCursor,
      ),
    [s.rev],
  );
  const rosters = useMemo(
    () =>
      Array.from({ length: s.league.teams }, (_, i) =>
        fillSlots(selectors.rosterOf(s, board, i + 1), s.league),
      ),
    [s.rev],
  );
  const onClock = selectors.onClockSlot(s);

  return (
    <main class="mx-auto max-w-6xl px-3 pb-16">
      <div class="sticky top-0 z-10 flex items-center gap-2 bg-app-bg py-2">
        <a
          href="#/live"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Live
        </a>
        <h1 class="flex-1 text-lg font-bold">League</h1>
        {(['rosters', 'grid'] as Mode[]).map((m) => (
          <button
            type="button"
            class={`h-14 rounded-lg border px-4 font-bold ${
              mode === m ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-surface'
            }`}
            onClick={() => setMode(m)}
          >
            {m === 'rosters' ? 'Rosters' : 'Grid'}
          </button>
        ))}
      </div>

      {mode === 'grid' ? (
        <LiveDraftGrid s={s} board={board} opp={opp} />
      ) : (
        <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {needs.teams.map((t) => {
            const isMe = t.slot === s.league.slot;
            const { slots, bench } = rosters[t.slot - 1];
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
                }`}
              >
                <header class="flex items-baseline justify-between pb-2">
                  <span class="font-bold">
                    {seatName(opp, t.slot, s.league.slot)}
                    <span class="ml-2 text-xs font-normal text-app-dim">T{t.slot}</span>
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
                      <span class="num w-10 shrink-0 text-xs font-bold text-app-dim">{b.label}</span>
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
