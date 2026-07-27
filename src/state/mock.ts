// mock.ts — the in-app mock-draft driver (plan: "Rehearsal"). Thin stateless
// glue between the store and engine/opponent.js — the ONE opponent model the
// offline Monte Carlo (tools/simulate.mjs) and this driver share. The driver
// owns NO draft state: every step() re-derives the room from the store's pick
// log (sim.reset → drawSeatState → applyEntries), so UNDO / EDIT_PICK /
// SET_PICK_CURSOR mid-mock are automatically coherent — the derived-state-
// never-persisted invariant, applied to the simulator.
//
// Seeding (all determinism, no Date.now — the engine rule):
//   - mockSeed = opts.seed ?? ui.mockSeed ?? hash(rev, cursor, picks,
//     buildHash). A generated seed is persisted via SET_UI {mockSeed} (the
//     same ui escape hatch SyncPanel uses for sleeperDraftId), so remounts
//     and reloads keep the SAME room for the whole mock.
//   - drawSeatState always runs on xorshift128plus(mockSeed): the room's τ
//     jitter, need-awareness flags and seat archetypes are a pure function of
//     the mock seed — stable across every step of the mock.
//   - each pick samples from xorshift128plus(mix32(mockSeed, pickCursor)):
//     the rng is a pure function of (seed, overall pick), so a re-render or
//     retried step never re-rolls history, and every pick differs.
//
// League (teams/rounds/roster) is captured at CREATION time — it shapes the
// opponent ctx's flat arrays. A mid-mock SET_LEAGUE that changes teams or
// rounds requires a NEW driver (RehearsalTab keys its driver on them).
//
// TypeScript here is ERASABLE only (plain annotations — Node strip-types runs
// the .ts tests directly; no enums, no namespaces, no parameter properties).

import { makeOpponentCtx, makeDraftSim } from '../../engine/opponent.js';
import { xorshift128plus } from '../../engine/mc.js';
import { recommend } from '../../engine/index.js';
import { selectors } from './store.ts';
import type { Board, DraftState, Store, UiState } from './store.ts';

export interface MockDriverOpts {
  /** Mock-session seed; default: persisted ui.mockSeed, else derived from
      store state (rev + cursor + picks + buildHash) and persisted. */
  seed?: number;
  /** Custom-strategy registry (defineStrategy outputs, e.g. from
      strategies.json) — resolves archetype names AND rides into recommend(). */
  strategies?: Record<string, object> | null;
}

export interface MockDriver {
  /** One opponent pick → PICK_MADE {source:'sim'}. False when it's my turn
      or the draft is over. */
  step(): boolean;
  /** Engine rank-1 for MY slot → PICK_MADE {source:'sim'}. False when it is
      not my turn or the draft is over. */
  autoMyPick(): boolean;
  /** Loop step() until false; returns the number of picks made. */
  runToMyPick(): number;
  /** This mock's drawn room character — one entry per seat, archetype null
      when no archetypes.mix is configured. */
  seatArchetypes(): Array<{ slot: number; archetype: string | null }>;
}

const SKILL = ['QB', 'RB', 'WR', 'TE'];

/** 32-bit avalanche combine (murmur3 finalizer over a golden-ratio mix) —
    decorrelates (seed, pickNo) pairs into per-pick rng seeds. */
function mix32(a: number, b: number): number {
  let h = ((a | 0) + Math.imul(b | 0, 0x9e3779b9)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

/** opts.seed ?? persisted ui.mockSeed ?? a deterministic-ish hash of the
    current state (no Date.now), persisted via SET_UI for the mock's lifetime. */
function resolveSeed(store: Store, explicit: number | undefined): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit | 0;
  const s = store.getState();
  const existing = (s.ui as Record<string, unknown>).mockSeed;
  if (typeof existing === 'number' && Number.isFinite(existing)) return existing | 0;
  let h = mix32(s.rev + 1, s.pickCursor);
  for (let i = 0; i < s.buildHash.length; i++) h = mix32(h, s.buildHash.charCodeAt(i));
  for (const p of s.picks) h = mix32(h, mix32(p.n, p.idx));
  store.dispatch({ type: 'SET_UI', ui: { mockSeed: h } as unknown as Partial<UiState> });
  return h;
}

/**
 * Build a mock-draft driver over the store. Board + opponents feed
 * makeOpponentCtx ONCE here (board.players must be in ADP order — the ctx
 * asserts it); unknown archetype names in opponents.archetypes.mix throw
 * here, fail-fast (pass opts.strategies for custom names).
 */
export function createMockDriver(
  store: Store,
  board: Board,
  opponents: unknown,
  opts: MockDriverOpts = {},
): MockDriver {
  const league = store.getState().league; // captured — see header
  const strategies = opts.strategies ?? null;
  const ctx = makeOpponentCtx(board, league, opponents, { strategies });
  const sim = makeDraftSim(ctx);
  const total = league.teams * league.rounds;
  const seed = resolveSeed(store, opts.seed);

  /** Re-derive the whole room from the store's pick log — never persisted. */
  function rebuild(s: DraftState): void {
    sim.reset();
    sim.drawSeatState(xorshift128plus(seed)); // SAME seed every step — stable room
    sim.applyEntries(s.picks.map((p) => ({ n: p.n, idx: p.idx })));
  }

  function step(): boolean {
    const s = store.getState();
    if (s.pickCursor > total) return false; // draft over
    if (selectors.isMyPick(s)) return false; // my picks stay manual
    rebuild(s);
    const seat = selectors.onClockSlot(s);
    const round = Math.ceil(s.pickCursor / league.teams);
    const pickRng = xorshift128plus(mix32(seed, s.pickCursor));
    let idx = sim.samplePick(seat, round, pickRng);
    // Defensive: applyEntries marked every taken player, so samplePick cannot
    // return one — but a taken idx would make PICK_MADE a no-op and stall
    // runToMyPick, so guard with the next free player.
    if (sim.taken[idx]) {
      idx = -1;
      for (let i = 0; i < ctx.n; i++) {
        if (!sim.taken[i]) { idx = i; break; }
      }
      if (idx < 0) return false; // pool exhausted (pathological)
    }
    store.dispatch({ type: 'PICK_MADE', idx, source: 'sim' });
    return true;
  }

  function autoMyPick(): boolean {
    const s = store.getState();
    if (s.pickCursor > total) return false;
    if (!selectors.isMyPick(s)) return false;
    const out = recommend(
      board,
      s.league,
      {
        entries: s.picks.map((p) => ({ n: p.n, idx: p.idx })),
        cursor: s.pickCursor,
        strategy: s.league.strategy,
      },
      { strategies },
    );
    let idx: number | undefined = out.recommendations[0]?.idx;
    if (idx == null) {
      // Engine returned an empty shortlist (pathological) — best-eff untaken
      // skill player, then any untaken player at all.
      const taken = new Set(s.picks.map((p) => p.idx));
      let best = -1;
      let bestEff = -Infinity;
      let anyFree = -1;
      for (const p of board.players) {
        if (taken.has(p.idx)) continue;
        if (anyFree < 0) anyFree = p.idx;
        if (!SKILL.includes(p.pos)) continue;
        const eff = typeof p.eff === 'number' ? p.eff : -Infinity;
        if (eff > bestEff) { bestEff = eff; best = p.idx; }
      }
      idx = best >= 0 ? best : anyFree >= 0 ? anyFree : undefined;
      if (idx == null) return false;
    }
    store.dispatch({ type: 'PICK_MADE', idx, source: 'sim' });
    return true;
  }

  function runToMyPick(): number {
    let made = 0;
    while (step()) made += 1;
    return made;
  }

  function seatArchetypes(): Array<{ slot: number; archetype: string | null }> {
    // Pure function of the mock seed — the exact draw every step() replays.
    sim.drawSeatState(xorshift128plus(seed));
    const out: Array<{ slot: number; archetype: string | null }> = [];
    for (let slot = 1; slot <= league.teams; slot++) {
      out.push({ slot, archetype: sim.seatArchetypeName(slot) });
    }
    return out;
  }

  return { step, autoMyPick, runToMyPick, seatArchetypes };
}
