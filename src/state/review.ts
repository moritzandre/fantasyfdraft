// review.ts — the ONE pick-grading pipeline (extracted verbatim from
// ReviewScreen's useMemo so the archive flow in MockControls and the
// history re-grade in ReviewScreen produce byte-identical numbers). For
// each of MY picks, the board state just before it is replayed through
// recommend() with includeIdxs forcing my actual pick through the identical
// scoring pipeline (engine scoredExtras). Δ under ε renders as EVEN, never
// a miss — the tie invariant applies to grading too. Pure function of its
// inputs; the caller decides memoization.
//
// TypeScript here is ERASABLE only (plain annotations — Node strip-types
// runs the .ts tests directly; no enums, no namespaces, no parameter
// properties).

import { recommend } from '../../engine/index.js';
import { roundForPick, slotForPick } from '../../engine/picks.js';
import type { Board, LeagueConfig } from './store.ts';
import type { StrategyRegistry } from './strategies.ts';

export interface GradedPick {
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

export interface GradeResult {
  graded: GradedPick[] | null; // null ⇒ the engine rejected this state
  matches: number;
  evens: number;
  totalDelta: number;
}

/** Grade my picks against the engine. `picks` is the FULL pick list (all
    slots — my picks are filtered by league.slot, the rest form each pick's
    prefix); entries only need {n, idx}. ~16 recommend() calls ≈ tens of ms. */
export function gradeMyPicks(
  board: Board,
  league: LeagueConfig,
  picks: Array<{ n: number; idx: number }>,
  registry: StrategyRegistry | null,
): GradeResult {
  const eps = league.epsilonPoints ?? 4;
  let graded: GradedPick[] | null;
  const mine = picks
    .filter((p) => slotForPick(p.n, league.teams, league.snake) === league.slot)
    .sort((a, b) => a.n - b.n);
  if (mine.length === 0) {
    graded = [];
  } else {
    try {
      graded = mine.map((pick) => {
        const prefix = picks
          .filter((q) => q.n < pick.n)
          .map((q) => ({ n: q.n, idx: q.idx }));
        const res = recommend(
          board,
          league,
          { entries: prefix, cursor: pick.n, strategy: league.strategy },
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
          round: roundForPick(pick.n, league.teams),
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
      graded = null;
    }
  }

  const matches = graded?.filter((g) => g.matched).length ?? 0;
  const evens = graded?.filter((g) => g.even).length ?? 0;
  const totalDelta = graded?.reduce((a, g) => a + (g.even || g.matched ? 0 : g.delta), 0) ?? 0;
  return { graded, matches, evens, totalDelta };
}
