// mock.test.ts — the mock-draft driver: never picks on my turn, seeded
// reproducibility, UNDO coherence, re-render stability, room archetypes.
// Run: node --test "src/state/*.test.ts"   (Node strip-types — erasable TS only)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, selectors } from './store.ts';
import type { Board, DraftState, LeagueConfig, Store } from './store.ts';
import { createMockDriver } from './mock.ts';
import type { MockDriver, MockDriverOpts } from './mock.ts';
import { defineStrategy } from '../../engine/strategy.js';
import { slotForPick } from '../../engine/picks.js';

// ---------------------------------------------------------------------------
// Fixtures — synthetic board in ADP order (the opponent.test.js pattern).
// ---------------------------------------------------------------------------

function synthBoard(): Board {
  // Repeating skill pattern RB,WR,RB,WR,QB,TE… then all K, then all DST —
  // mirrors real ADP structure well enough for the sampler AND the engine.
  const skill: string[] = [];
  for (let i = 0; i < 35; i++) skill.push('RB', 'WR', 'RB', 'WR', 'QB', 'TE');
  const posSeq = [...skill, ...Array(15).fill('K'), ...Array(15).fill('DST')];
  const teams = ['DAL', 'PHI', 'KC', 'DET', 'SF', 'BUF', 'MIA', 'GB'];
  const posRank: Record<string, number> = {};
  const players = posSeq.map((pos, idx) => {
    posRank[pos] = (posRank[pos] ?? 0) + 1;
    return {
      idx,
      id: String(idx),
      name: `P${idx}`,
      short: `P${idx}`,
      pos,
      posRank: posRank[pos],
      team: teams[idx % teams.length],
      bye: 5 + (idx % 10),
      eff: 400 - idx,
      sigmaProj: 55,
      proj: { halfPpr: 400 - idx, rec: 60 },
      adp: { mu: idx + 1, sigmaFinal: 3 + idx * 0.05 },
    };
  });
  return { buildHash: 'testtest', players };
}

function makeLeague(over: Partial<LeagueConfig> = {}): LeagueConfig {
  return {
    teams: 12,
    slot: 8,
    rounds: 16,
    snake: true,
    roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
    flexEligible: ['RB', 'WR', 'TE'],
    strategy: 'balanced',
    ...over,
  };
}

const NEUTRAL_OPP = {
  seats: Array.from({ length: 12 }, (_, i) => ({
    seat: i + 1, name: '', adpDiscipline: 0.5, positionBias: {}, homerTeams: [], reachRounds: [],
  })),
};

const TOTAL = 12 * 16;

function boot(over: Partial<LeagueConfig> = {}): { store: Store; board: Board } {
  let t = 1000;
  const board = synthBoard();
  // No persist adapter — createStore defaults to a no-op (Node-safe).
  const store = createStore({ board, league: makeLeague(over), now: () => t++ });
  return { store, board };
}

function mkDriver(
  over: Partial<LeagueConfig> = {},
  opponents: unknown = NEUTRAL_OPP,
  opts: MockDriverOpts = {},
): { store: Store; board: Board; driver: MockDriver } {
  const { store, board } = boot(over);
  return { store, board, driver: createMockDriver(store, board, opponents, opts) };
}

function pickedIdxs(s: DraftState): number[] {
  return s.picks.map((p) => p.idx);
}

function assertUniquePicks(s: DraftState): void {
  const idxs = pickedIdxs(s);
  assert.equal(new Set(idxs).size, idxs.length, 'no player may ever be drafted twice');
  const ns = s.picks.map((p) => p.n);
  assert.equal(new Set(ns).size, ns.length, 'no pick number recorded twice');
}

// ---------------------------------------------------------------------------
// 1. The driver never picks on my turn
// ---------------------------------------------------------------------------

test('mock: from empty at slot 8, runToMyPick makes exactly 7 picks and stops', () => {
  const { store, driver } = mkDriver({ slot: 8 });
  const made = driver.runToMyPick();
  assert.equal(made, 7, 'picks 1..7 belong to the other seats');
  const s = store.getState();
  assert.equal(s.picks.length, 7);
  assert.equal(s.pickCursor, 8);
  assert.equal(selectors.isMyPick(s), true);
  assert.equal(driver.step(), false, 'step refuses to pick on my turn');
  assert.equal(store.getState().picks.length, 7, 'refusal dispatched nothing');
  for (const p of s.picks) assert.equal(p.source, 'sim');
  // The generated seed was persisted through the SyncPanel ui escape hatch.
  assert.equal(typeof (s.ui as Record<string, unknown>).mockSeed, 'number');
});

// ---------------------------------------------------------------------------
// 2. autoMyPick drafts for MY slot through the engine
// ---------------------------------------------------------------------------

test('mock: autoMyPick only fires on my turn and grows my roster with source sim', () => {
  const { store, board, driver } = mkDriver({ slot: 8 });
  assert.equal(driver.autoMyPick(), false, 'pick 1 is not mine');
  driver.runToMyPick();
  assert.equal(selectors.myRoster(store.getState(), board).length, 0);
  assert.equal(driver.autoMyPick(), true);
  const s = store.getState();
  assert.equal(s.pickCursor, 9, 'my pick 8 recorded, seat 9 on the clock');
  const mine = s.picks.find((p) => p.n === 8);
  assert.ok(mine, 'pick 8 exists');
  assert.equal(mine!.source, 'sim');
  assert.equal(slotForPick(mine!.n, 12, true), 8);
  assert.equal(selectors.myRoster(s, board).length, 1);
  assert.equal(driver.autoMyPick(), false, 'seat 9 is on the clock now');
});

// ---------------------------------------------------------------------------
// 3. Seeded reproducibility — two rooms, one seed, identical 192-pick logs
// ---------------------------------------------------------------------------

test('mock: same seed ⇒ identical full-mock pick logs on independent stores', () => {
  const runFullMock = (seed: number): Array<[number, number]> => {
    const { store, driver } = mkDriver({ slot: 8 }, NEUTRAL_OPP, { seed });
    for (let guard = 0; guard < TOTAL && store.getState().pickCursor <= TOTAL; guard++) {
      driver.runToMyPick();
      driver.autoMyPick();
    }
    const s = store.getState();
    assert.equal(s.pickCursor, TOTAL + 1, 'draft ran to completion');
    assert.equal(s.picks.length, TOTAL);
    assertUniquePicks(s);
    assert.equal(driver.step(), false, 'draft over — step refuses');
    assert.equal(driver.autoMyPick(), false, 'draft over — autoMyPick refuses');
    return s.picks.map((p) => [p.n, p.idx]);
  };
  const a = runFullMock(20260824);
  const b = runFullMock(20260824);
  assert.deepEqual(a, b, 'same seed ⇒ bit-identical mock');
  const c = runFullMock(1);
  assert.notDeepEqual(a, c, 'different seed ⇒ different room');
});

// ---------------------------------------------------------------------------
// 4. UNDO mid-mock — state is re-derived from the log every step
// ---------------------------------------------------------------------------

test('mock: UNDO twice mid-mock, then step — coherent, no duplicates ever', () => {
  const { store, driver } = mkDriver({ slot: 8 }, NEUTRAL_OPP, { seed: 7 });
  driver.runToMyPick(); // picks 1..7
  store.dispatch({ type: 'UNDO' });
  store.dispatch({ type: 'UNDO' });
  let s = store.getState();
  assert.equal(s.picks.length, 5);
  assert.equal(s.pickCursor, 6);
  assertUniquePicks(s);

  assert.equal(driver.step(), true, 'step re-derives the room and picks pick 6');
  s = store.getState();
  assert.equal(s.picks.length, 6);
  assert.equal(s.pickCursor, 7);
  assertUniquePicks(s);

  const made = driver.runToMyPick();
  assert.equal(made, 1, 'only pick 7 was left before my turn');
  s = store.getState();
  assert.equal(s.pickCursor, 8);
  assert.equal(s.picks.length, 7);
  assert.deepEqual(s.picks.map((p) => p.n), [1, 2, 3, 4, 5, 6, 7]);
  assertUniquePicks(s);
  assert.equal(selectors.isMyPick(s), true);
});

// ---------------------------------------------------------------------------
// 5. Re-render stability — a no-op dispatch never re-rolls the next pick
// ---------------------------------------------------------------------------

test('mock: SET_UI between steps does not change the next sampled pick', () => {
  const SEED = 424242;
  const { store: sa, driver: da } = mkDriver({ slot: 8 }, NEUTRAL_OPP, { seed: SEED });
  const { store: sb, driver: db } = mkDriver({ slot: 8 }, NEUTRAL_OPP, { seed: SEED });
  for (let k = 0; k < 3; k++) {
    assert.equal(da.step(), true);
    assert.equal(db.step(), true);
  }
  assert.deepEqual(pickedIdxs(sa.getState()), pickedIdxs(sb.getState()));

  // Simulate a re-render / unrelated dispatch on store A only.
  sa.dispatch({ type: 'SET_UI', ui: { searchText: 'zzz' } });
  assert.equal(da.step(), true);
  assert.equal(db.step(), true);
  const a = sa.getState();
  const b = sb.getState();
  assert.equal(a.picks[3].idx, b.picks[3].idx, 'same cursor ⇒ same pick rng ⇒ same pick');
  assert.deepEqual(pickedIdxs(a), pickedIdxs(b));
});

// ---------------------------------------------------------------------------
// 6. seatArchetypes — the room's drawn character
// ---------------------------------------------------------------------------

test('mock: seatArchetypes reports all seats; mix ⇒ non-null, custom names resolve', () => {
  // No mix configured: 12 entries, all null (legacy tendency-only room).
  const { driver: plain } = mkDriver({ slot: 8 }, NEUTRAL_OPP, { seed: 3 });
  const bare = plain.seatArchetypes();
  assert.equal(bare.length, 12);
  assert.deepEqual(bare.map((e) => e.slot), Array.from({ length: 12 }, (_, i) => i + 1));
  for (const e of bare) assert.equal(e.archetype, null);

  // opponents.json-style mix incl. a CUSTOM strategy through opts.strategies.
  const wrHeavy = defineStrategy({
    name: 'wr_heavy_test',
    multipliers: { WR: [{ from: 1, to: 4, m: 1.2 }] },
    constraints: [{ pos: 'WR', type: 'min', by: 5, need: 3 }],
  });
  const mixed = {
    ...NEUTRAL_OPP,
    archetypes: { mix: { balanced: 0.55, robust_rb: 0.25, wr_heavy_test: 0.2 } },
  };
  const { driver } = mkDriver({ slot: 8 }, mixed, {
    seed: 11,
    strategies: { wr_heavy_test: wrHeavy },
  });
  const room = driver.seatArchetypes();
  assert.equal(room.length, 12);
  const names = new Set(room.map((e) => e.archetype));
  assert.ok(room.every((e) => e.archetype !== null), 'a mix assigns every seat an archetype');
  for (const nm of names) assert.ok(['balanced', 'robust_rb', 'wr_heavy_test'].includes(nm as string));
  // Stable for the whole mock: repeated calls (and steps in between) agree.
  driver.step();
  driver.step();
  assert.deepEqual(driver.seatArchetypes(), room);
});
