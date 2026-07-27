// ReviewScreen.tsx — #/review: grade my picks against the engine, after (or
// during) a mock. The grading itself lives in src/state/review.ts
// gradeMyPicks (shared with the MockControls archive flow — ONE pipeline):
// for each of MY recorded picks, the board state just before it is replayed
// through recommend() with includeIdxs forcing my actual pick through the
// identical scoring pipeline (engine scoredExtras). Δ under ε renders as
// EVEN, never a miss — the tie invariant applies to grading too. Pure
// derivation, memoized on [s.rev], never persisted. Below the live review:
// the mock-draft HISTORY (dp:mock-history:v1, global — archived from
// practice, reviewable in any mode); a tapped row re-grades its stored
// picks under the RECORD's league shape, delete is a 3s HoldButton.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { abbrevName, fmt1 } from '../../../shared/format.js';
import type { Board, DraftState, Store } from '../../state/store';
import { deleteMock, loadMockHistory } from '../../state/mockHistory';
import type { MockRecord } from '../../state/mockHistory';
import { gradeMyPicks } from '../../state/review';
import type { GradedPick } from '../../state/review';
import { loadStrategies } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';
import HoldButton from './HoldButton';

function GradedList({ graded }: { graded: GradedPick[] }) {
  return (
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
  );
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export default function ReviewScreen({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  useEffect(() => {
    loadStrategies().then(setRegistry);
  }, []);

  const eps = s.league.epsilonPoints ?? 4;

  const { graded, matches, evens, totalDelta } = useMemo(
    () => gradeMyPicks(board, s.league, s.picks, registry),
    [s.rev, registry],
  );

  // --- mock HISTORY (global — archived from practice, reviewable anywhere)
  const [history, setHistory] = useState<MockRecord[]>(() => loadMockHistory());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expandedGrade = useMemo(() => {
    if (expandedId === null) return null;
    const rec = history.find((r) => r.id === expandedId);
    if (!rec) return null;
    // Re-grade under the RECORD's league shape (a stored 10-team mock must
    // not be graded as today's 12-team league); roster/scoring knobs the
    // record doesn't carry come from the current league. strategy is set
    // explicitly — JSON drops undefined, and an absent key must NOT let the
    // current league's strategy leak into an old mock's grade.
    const league = {
      ...s.league,
      teams: rec.league.teams,
      slot: rec.league.slot,
      rounds: rec.league.rounds,
      snake: rec.league.snake,
      strategy: rec.league.strategy,
    };
    return gradeMyPicks(board, league, rec.picks, registry);
  }, [expandedId, registry, history]);

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

          <GradedList graded={graded} />
        </>
      )}

      {history.length > 0 && (
        <section class="mt-6">
          <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">HISTORY</h2>
          <ul class="flex flex-col gap-1.5">
            {history.map((r) => (
              <li class="rounded-lg border border-app-border bg-app-surface">
                <div class="flex items-center gap-2 px-3 py-1">
                  <button
                    type="button"
                    class="flex min-h-14 min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-semibold">
                        {fmtWhen(r.finishedAt)} · {r.league.teams}-team slot {r.league.slot}
                      </span>
                      <span class="block truncate text-xs text-app-dim">
                        {r.league.strategy ?? 'balanced'} · {r.picks.length} picks
                      </span>
                    </span>
                    {r.summary ? (
                      <>
                        <span class="num shrink-0 rounded border border-app-border px-2 py-1 text-xs font-bold">
                          {r.summary.matches}/{r.summary.myPicks}
                        </span>
                        <span class="shrink-0 rounded border border-accent px-2 py-1 text-xs font-bold text-accent">
                          {r.summary.evens} even
                        </span>
                        <span class="lv-clock-near num shrink-0 rounded px-2 py-1 text-xs font-bold">
                          −{fmt1(r.summary.totalDelta)}
                        </span>
                      </>
                    ) : (
                      <span class="shrink-0 text-xs text-app-dim">ungraded</span>
                    )}
                  </button>
                  <HoldButton
                    ms={3000}
                    onHold={() => {
                      if (expandedId === r.id) setExpandedId(null);
                      setHistory(deleteMock(r.id));
                    }}
                    class="h-14 shrink-0 rounded-lg border border-app-border px-3 text-xs font-bold text-app-dim"
                  >
                    Hold ✕
                  </HoldButton>
                </div>
                {expandedId === r.id && (
                  <div class="border-t border-app-border px-3 pb-3">
                    {expandedGrade === null || expandedGrade.graded === null ? (
                      <p class="py-2 text-sm text-app-dim">
                        Grading unavailable — the engine rejected this state.
                      </p>
                    ) : expandedGrade.graded.length === 0 ? (
                      <p class="py-2 text-sm text-app-dim">No picks of mine in this mock.</p>
                    ) : (
                      <GradedList graded={expandedGrade.graded} />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
