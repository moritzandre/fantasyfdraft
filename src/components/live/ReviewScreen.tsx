// ReviewScreen.tsx — #/review: grade my picks against the engine, after (or
// during) a mock. For each of MY recorded picks, the board state just
// before it is replayed through recommend() with includeIdxs forcing my
// actual pick through the identical scoring pipeline (engine
// scoredExtras). Δ under ε renders as EVEN, never a miss — the tie
// invariant applies to grading too. Pure derivation, memoized on [s.rev],
// never persisted. ~16 recommend() calls ≈ tens of ms, once per state
// change.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { recommend } from '../../../engine/index.js';
import { roundForPick, slotForPick } from '../../../engine/picks.js';
import { abbrevName, fmt1 } from '../../../shared/format.js';
import type { Board, DraftState, Store } from '../../state/store';
import { loadStrategies } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';

interface Graded {
  n: number;
  round: number;
  mine: any;        // board player I took
  myScore: number | null;
  top: any | null;  // engine's #1 player at that point
  topScore: number;
  delta: number;    // topScore − myScore (0 when I matched)
  matched: boolean;
  even: boolean;
  offList: boolean; // my pick wasn't in the engine's shortlist
}

export default function ReviewScreen({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  useEffect(() => {
    loadStrategies().then(setRegistry);
  }, []);

  const eps = s.league.epsilonPoints ?? 4;

  const graded = useMemo<Graded[] | null>(() => {
    const mine = s.picks
      .filter((p) => slotForPick(p.n, s.league.teams, s.league.snake) === s.league.slot)
      .sort((a, b) => a.n - b.n);
    if (mine.length === 0) return [];
    try {
      return mine.map((pick) => {
        const prefix = s.picks
          .filter((q) => q.n < pick.n)
          .map((q) => ({ n: q.n, idx: q.idx }));
        const res = recommend(
          board,
          s.league,
          { entries: prefix, cursor: pick.n, strategy: s.league.strategy },
          { strategies: registry, includeIdxs: [pick.idx] },
        );
        const top = res.recommendations[0] ?? null;
        const inList = res.recommendations.find((r: any) => r.idx === pick.idx) ?? null;
        const extra = res.scoredExtras.find((x: any) => x.idx === pick.idx) ?? null;
        const myScore = (inList ?? extra)?.score ?? null;
        const topScore = top?.score ?? 0;
        const matched = top !== null && top.idx === pick.idx;
        const delta = matched || myScore === null ? 0 : Math.max(0, topScore - myScore);
        return {
          n: pick.n,
          round: roundForPick(pick.n, s.league.teams),
          mine: board.players[pick.idx],
          myScore,
          top: top ? board.players[top.idx] : null,
          topScore,
          delta,
          matched,
          even: !matched && delta < eps,
          offList: !matched && inList === null,
        };
      });
    } catch (e) {
      console.warn('[review] grading failed:', (e as Error)?.message ?? e);
      return null;
    }
  }, [s.rev, registry]);

  const matches = graded?.filter((g) => g.matched).length ?? 0;
  const evens = graded?.filter((g) => g.even).length ?? 0;
  const totalDelta = graded?.reduce((a, g) => a + (g.even || g.matched ? 0 : g.delta), 0) ?? 0;

  return (
    <main class="mx-auto max-w-2xl px-4 pb-16">
      <div class="sticky top-0 z-10 flex items-center gap-2 bg-app-bg py-2">
        <a
          href="#/live"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Live
        </a>
        <h1 class="flex-1 text-lg font-bold">Pick review</h1>
      </div>

      {graded === null && (
        <p class="pt-4 text-app-dim">Grading unavailable — the engine rejected this state.</p>
      )}
      {graded !== null && graded.length === 0 && (
        <p class="pt-4 text-app-dim">No picks of yours to review yet — run a mock first.</p>
      )}
      {graded !== null && graded.length > 0 && (
        <>
          <section class="num mt-3 flex gap-4 rounded-xl border border-app-border bg-app-surface p-3 text-center">
            <div class="flex-1">
              <div class="text-2xl font-bold">{matches}/{graded.length}</div>
              <div class="text-xs text-app-dim">engine match</div>
            </div>
            <div class="flex-1">
              <div class="text-2xl font-bold">{evens}</div>
              <div class="text-xs text-app-dim">even (Δ&lt;{eps})</div>
            </div>
            <div class="flex-1">
              <div class="text-2xl font-bold">{fmt1(totalDelta)}</div>
              <div class="text-xs text-app-dim">pts left on the board</div>
            </div>
          </section>

          <ul class="mt-3 flex flex-col gap-1.5">
            {graded.map((g) => (
              <li class="flex min-h-[52px] items-center gap-2 rounded-lg border border-app-border bg-app-surface px-3 py-1.5">
                <span class="num w-14 shrink-0 text-sm text-app-dim">R{g.round}·{g.n}</span>
                <span class="min-w-0 flex-1">
                  <span class={`block truncate font-semibold lv-pos-${g.mine?.pos?.toLowerCase() ?? ''}`}>
                    {g.mine ? abbrevName(g.mine.name, 20) : '?'}
                  </span>
                  {!g.matched && g.top && (
                    <span class="block truncate text-xs text-app-dim">
                      engine: {abbrevName(g.top.name, 20)}
                    </span>
                  )}
                </span>
                {g.matched ? (
                  <span class="lv-clock-up shrink-0 rounded px-2 py-1 text-xs font-bold">MATCH</span>
                ) : g.even ? (
                  <span class="shrink-0 rounded border border-accent px-2 py-1 text-xs font-bold text-accent">
                    EVEN
                  </span>
                ) : (
                  <span class="lv-clock-near num shrink-0 rounded px-2 py-1 text-xs font-bold">
                    −{fmt1(g.delta)}
                  </span>
                )}
                {g.offList && !g.matched && (
                  <span class="shrink-0 text-xs text-app-dim" title="not in the engine's shortlist at that pick">
                    off-list
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
