// intent.ts — opponent-intent prediction: which players a given seat is
// likely to take at its next pick. UI-layer glue over THE opponent model
// (engine/opponent.js) plus the archetype inference in engine/insights.js —
// deliberately OUTSIDE engine/insights.js because it needs the simulator.
//
// Deterministic and sample-free: the per-draft jitter is pinned to 1, the
// distribution is REPORTED (pickDistribution), never sampled, and the one
// drawSeatState call runs on a fixed seed (its jitter/need draws are ignored
// — it exists only to latch the per-seat FIXED archetypes into the sim).
// Need-awareness is marginalized analytically: real rooms are need-aware
// with probability needAwareShare, so p = (1−share)·P(mask off) +
// share·P(mask on).
//
// Archetypes: the mix draw is forced OFF (params.mix = null) — in a real
// room we cannot know what a seat drew, so only (a) user-configured fixed
// seat archetypes (opponents.json seats[].archetype, which always win) and
// (b) seats inferSeatStrategies reads as 'strong' play a strategy; everyone
// else stays neutral.
//
// The opponent ctx (flat typed arrays over the whole board) is cached in
// module scope per (board, league, opponents, strategies, inferred-archetype
// assignment) by reference — all four are session-stable objects (board from
// boot, league from the store, the loaders' cached files), so the ctx
// rebuilds only when a NEW strong read appears. Erasable TS.

import { makeOpponentCtx, makeDraftSim } from '../../engine/opponent.js';
import { xorshift128plus } from '../../engine/mc.js';
import { inferSeatStrategies } from '../../engine/insights.js';
import { STRATEGIES } from '../../engine/strategy.js';
import type { Board, LeagueConfig } from './store.ts';

export interface PickEntryLike {
  n: number;
  idx: number | null;
}

export interface LikelyPick {
  idx: number;
  p: number;
}

export interface SeatRead {
  slot: number;
  counts: Record<string, number>;
  bestFit: string | null;
  confidence: 'strong' | 'lean' | null;
}

/** inferSeatStrategies over built-ins + the custom registry — the one
    archetype candidate set every intent surface shares. */
export function inferSeats(
  board: Board,
  league: LeagueConfig,
  strategies: Record<string, object> | null,
  entries: PickEntryLike[],
): SeatRead[] {
  return inferSeatStrategies(entries, league, board.players, {
    ...STRATEGIES,
    ...(strategies ?? {}),
  }) as SeatRead[];
}

interface IntentCache {
  board: Board;
  league: LeagueConfig;
  opponents: unknown;
  strategies: Record<string, object> | null;
  fixedSig: string;
  ctx: Record<string, any>;
  sim: Record<string, any>;
}

let cache: IntentCache | null = null;

/** drawSeatState seed — arbitrary but FIXED; its draws are never used
    (jitter overridden, need-awareness marginalized analytically). */
const INTENT_SEED = 0x1dea;

/**
 * Top-N likely picks for `seat` at its pick in `round`, given the observed
 * n-aware entry log. Throws on a broken board/room — call sites treat the
 * prediction as decoration and catch silently.
 */
export function likelyPicks(
  board: Board,
  league: LeagueConfig,
  opponents: unknown,
  strategies: Record<string, object> | null,
  entries: PickEntryLike[],
  seat: number,
  round: number,
  topN: number = 3,
): LikelyPick[] {
  const baseSeats = ((opponents as Record<string, unknown> | null)?.seats ?? []) as Array<
    Record<string, unknown>
  >;

  // Strong inferred reads become per-seat FIXED archetypes — except where the
  // user already fixed one (opponents.json/Room editor wins), and never for
  // my own seat (my strategy is knob, not inference).
  const patch = new Map<number, string>();
  for (const r of inferSeats(board, league, strategies, entries)) {
    if (r.confidence === 'strong' && r.bestFit && r.slot !== league.slot) {
      patch.set(r.slot, r.bestFit);
    }
  }
  for (const s of baseSeats) {
    if (typeof s.archetype === 'string' && s.archetype.length > 0) {
      patch.delete(s.seat as number);
    }
  }
  const fixedSig = [...patch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, name]) => `${slot}:${name}`)
    .join('|');

  if (
    !cache ||
    cache.board !== board ||
    cache.league !== league ||
    cache.opponents !== opponents ||
    cache.strategies !== strategies ||
    cache.fixedSig !== fixedSig
  ) {
    const bySeat = new Map(baseSeats.map((s) => [s.seat as number, s]));
    const seats: Array<Record<string, unknown>> = [];
    for (let slot = 1; slot <= league.teams; slot++) {
      const base = bySeat.get(slot) ?? { seat: slot };
      seats.push(patch.has(slot) ? { ...base, archetype: patch.get(slot) } : base);
    }
    const eff = { ...((opponents as object) ?? {}), seats };
    const ctx = makeOpponentCtx(board, league, eff, {
      strategies: strategies ?? null,
      mix: null, // no mix draw — see header
    }) as Record<string, any>;
    cache = { board, league, opponents, strategies, fixedSig, ctx, sim: makeDraftSim(ctx) };
  }

  const { ctx, sim } = cache;
  sim.reset();
  sim.drawSeatState(xorshift128plus(INTENT_SEED)); // latches fixed archetypes only
  sim.applyEntries(entries);

  const off = sim.pickDistribution(seat, round, { jitter: 1, needMask: 'off' }) as LikelyPick[];
  const share = Math.min(1, Math.max(0, (ctx.needAwareShare as number) ?? 0));
  let mixed: LikelyPick[];
  if (share <= 0) {
    mixed = off;
  } else {
    const on = sim.pickDistribution(seat, round, { jitter: 1, needMask: 'on' }) as LikelyPick[];
    if (share >= 1) {
      mixed = on;
    } else {
      const acc = new Map<number, number>();
      for (const e of off) acc.set(e.idx, (1 - share) * e.p);
      for (const e of on) acc.set(e.idx, (acc.get(e.idx) ?? 0) + share * e.p);
      mixed = [...acc.entries()].map(([idx, p]) => ({ idx, p }));
      mixed.sort((a, b) => b.p - a.p || a.idx - b.idx);
    }
  }
  return mixed.slice(0, Math.max(0, topN));
}

/** Test hook — drop the module-scope ctx cache. */
export function _resetIntentCache(): void {
  cache = null;
}
