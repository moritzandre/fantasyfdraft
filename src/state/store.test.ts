// store.test.ts — reducer, undo semantics, rev discipline, selectors.
// Run: node --test "src/state/*.test.ts"   (Node 24 strip-types — erasable TS only)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, selectors, MAX_LOG } from './store.ts';
import type {
  Board,
  DraftState,
  LeagueConfig,
  LogEntry,
  PersistAdapter,
  PersistedSnapshot,
  Store,
} from './store.ts';
import { exportState, importEnvelope } from './portable.ts';
import { myPicks } from '../../engine/picks.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBoard(n: number = 220): Board {
  const POS = ['RB', 'WR', 'TE', 'QB', 'K', 'DST'];
  return {
    buildHash: 'testhash',
    players: Array.from({ length: n }, (_, idx) => ({
      idx,
      name: `Player ${idx}`,
      pos: POS[idx % POS.length],
    })),
  };
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

function mk(over: Partial<LeagueConfig> = {}): Store {
  let t = 1000;
  return createStore({ board: makeBoard(), league: makeLeague(over), now: () => t++ });
}

/** Independent snake oracle — deliberately NOT engine/picks.js. */
function expectedSlot(n: number, teams: number): number {
  const round = Math.ceil(n / teams);
  const inRound = n - (round - 1) * teams;
  return round % 2 === 1 ? inRound : teams - inRound + 1;
}

function comparable(s: DraftState): unknown {
  return { league: s.league, picks: s.picks, pickCursor: s.pickCursor, ui: s.ui };
}

// ---------------------------------------------------------------------------
// Reducer round-trips — all 9 action types
// ---------------------------------------------------------------------------

test('PICK_MADE records at the cursor and advances to the next unrecorded pick', () => {
  const st = mk();
  st.dispatch({ type: 'PICK_MADE', idx: 5, source: 'manual' });
  const s = st.getState();
  assert.equal(s.picks.length, 1);
  assert.deepEqual(
    { n: s.picks[0].n, idx: s.picks[0].idx, source: s.picks[0].source },
    { n: 1, idx: 5, source: 'manual' },
  );
  assert.equal(s.pickCursor, 2);
  assert.equal(s.rev, 1);
});

test('PICK_MADE on an already-taken player is a no-op for picks (rev still bumps)', () => {
  const st = mk();
  st.dispatch({ type: 'PICK_MADE', idx: 5, source: 'manual' });
  st.dispatch({ type: 'PICK_MADE', idx: 5, source: 'sleeper' });
  const s = st.getState();
  assert.equal(s.picks.length, 1);
  assert.equal(s.pickCursor, 2);
  assert.equal(s.rev, 2);
});

test('CATCHUP marks several gone in order from the cursor, one log entry', () => {
  const st = mk();
  st.dispatch({ type: 'CATCHUP', idxs: [10, 11, 12, 13, 14, 15] });
  const s = st.getState();
  assert.deepEqual(s.picks.map((p) => p.n), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(s.picks.map((p) => p.idx), [10, 11, 12, 13, 14, 15]);
  assert.equal(s.pickCursor, 7);
  assert.equal(st.undoDepth(), 1); // ONE undoable entry, not six
});

test('CATCHUP skips already-taken players without burning pick slots', () => {
  const st = mk();
  st.dispatch({ type: 'PICK_MADE', idx: 10, source: 'manual' });
  st.dispatch({ type: 'CATCHUP', idxs: [10, 11, 12] });
  const s = st.getState();
  assert.deepEqual(s.picks.map((p) => p.idx), [10, 11, 12]);
  assert.deepEqual(s.picks.map((p) => p.n), [1, 2, 3]);
  assert.equal(s.pickCursor, 4);
});

test('SET_PICK_CURSOR clamps to [1, total+1] and PICK_MADE skips recorded picks', () => {
  const st = mk();
  st.dispatch({ type: 'PICK_MADE', idx: 0, source: 'manual' });
  st.dispatch({ type: 'PICK_MADE', idx: 1, source: 'manual' });
  st.dispatch({ type: 'SET_PICK_CURSOR', pick: 1 }); // desync fix backwards
  assert.equal(st.getState().pickCursor, 1);
  st.dispatch({ type: 'PICK_MADE', idx: 2, source: 'manual' });
  // picks 1 and 2 were recorded → the new pick lands on 3
  assert.deepEqual(st.getState().picks.map((p) => [p.n, p.idx]), [[1, 0], [2, 1], [3, 2]]);
  assert.equal(st.getState().pickCursor, 4);
  st.dispatch({ type: 'SET_PICK_CURSOR', pick: 9999 });
  assert.equal(st.getState().pickCursor, 193); // 12×16 + 1
  st.dispatch({ type: 'SET_PICK_CURSOR', pick: -4 });
  assert.equal(st.getState().pickCursor, 1);
});

test('EDIT_PICK mid-history preserves later picks; null deletes the entry', () => {
  const st = mk();
  for (let i = 0; i < 10; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  const before = st.getState().picks;

  st.dispatch({ type: 'EDIT_PICK', pickNumber: 4, idx: 99 });
  let s = st.getState();
  assert.equal(s.picks.length, 10);
  assert.equal(s.picks.find((p) => p.n === 4)?.idx, 99);
  for (const p of before) {
    if (p.n === 4) continue;
    assert.equal(s.picks.find((q) => q.n === p.n)?.idx, p.idx, `pick ${p.n} must be untouched`);
  }
  assert.equal(s.pickCursor, 11, 'cursor untouched by an edit');

  st.dispatch({ type: 'EDIT_PICK', pickNumber: 4, idx: null });
  s = st.getState();
  assert.equal(s.picks.length, 9);
  assert.equal(s.picks.find((p) => p.n === 4), undefined);
  assert.equal(s.picks.find((p) => p.n === 10)?.idx, 9, 'later picks preserved after delete');
});

test('EDIT_PICK naming a player already drafted elsewhere MOVES him (no duplicates)', () => {
  const st = mk();
  for (let i = 0; i < 5; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  st.dispatch({ type: 'EDIT_PICK', pickNumber: 2, idx: 4 }); // idx 4 was at pick 5
  const s = st.getState();
  assert.deepEqual(s.picks.filter((p) => p.idx === 4).map((p) => p.n), [2]);
  assert.equal(s.picks.find((p) => p.n === 5), undefined);
});

test('SET_LEAGUE merges partial config (slot is runtime data)', () => {
  const st = mk();
  st.dispatch({ type: 'SET_LEAGUE', league: { slot: 3, strategy: 'heroRb' } });
  const s = st.getState();
  assert.equal(s.league.slot, 3);
  assert.equal(s.league.strategy, 'heroRb');
  assert.equal(s.league.teams, 12, 'unmentioned keys survive');
});

test('SET_UI merges partial ui', () => {
  const st = mk();
  st.dispatch({ type: 'SET_UI', ui: { posFilter: 'RB', searchText: 'gib' } });
  const s = st.getState();
  assert.equal(s.ui.posFilter, 'RB');
  assert.equal(s.ui.searchText, 'gib');
  assert.equal(s.ui.showFive, true);
});

test('RESET_DRAFT clears picks and cursor but keeps league config', () => {
  const st = mk();
  st.dispatch({ type: 'SET_LEAGUE', league: { slot: 5 } });
  st.dispatch({ type: 'CATCHUP', idxs: [1, 2, 3] });
  st.dispatch({ type: 'RESET_DRAFT' });
  const s = st.getState();
  assert.deepEqual(s.picks, []);
  assert.equal(s.pickCursor, 1);
  assert.equal(s.league.slot, 5, 'league config survives reset');
});

test('IMPORT_STATE fully replaces picks/cursor/league/ui', () => {
  const src = mk();
  src.dispatch({ type: 'SET_LEAGUE', league: { slot: 2 } });
  for (let i = 0; i < 7; i++) src.dispatch({ type: 'PICK_MADE', idx: i, source: 'sim' });
  src.dispatch({ type: 'SET_UI', ui: { posFilter: 'WR' } });
  const env = exportState(src.getState(), '2026-08-24T15:30:00Z');

  const dst = mk();
  dst.dispatch({ type: 'CATCHUP', idxs: [100, 101] }); // junk that must vanish
  const res = importEnvelope(env, 'testhash');
  assert.equal(res.ok, true);
  dst.dispatch({ type: 'IMPORT_STATE', state: res.state! });

  assert.deepEqual(comparable(dst.getState()), comparable(src.getState()));
});

// ---------------------------------------------------------------------------
// UNDO — a pure log operation
// ---------------------------------------------------------------------------

test('UNDO pops the last log entry of ANY type', () => {
  const st = mk();
  st.dispatch({ type: 'SET_LEAGUE', league: { slot: 4 } });
  st.dispatch({ type: 'UNDO' });
  assert.equal(st.getState().league.slot, 8);

  st.dispatch({ type: 'PICK_MADE', idx: 3, source: 'manual' });
  st.dispatch({ type: 'SET_PICK_CURSOR', pick: 50 });
  st.dispatch({ type: 'UNDO' }); // pops the cursor move
  assert.equal(st.getState().pickCursor, 2);
  assert.equal(st.getState().picks.length, 1);
  st.dispatch({ type: 'UNDO' }); // pops the pick
  assert.equal(st.getState().picks.length, 0);
  assert.equal(st.getState().pickCursor, 1);
});

test('UNDO after CATCHUP restores the pre-catchup state exactly', () => {
  const st = mk();
  st.dispatch({ type: 'PICK_MADE', idx: 0, source: 'manual' });
  st.dispatch({ type: 'PICK_MADE', idx: 1, source: 'manual' });
  const before = JSON.parse(JSON.stringify(comparable(st.getState())));

  st.dispatch({ type: 'CATCHUP', idxs: [20, 21, 22, 23, 24, 25] });
  assert.equal(st.getState().picks.length, 8);
  st.dispatch({ type: 'UNDO' });

  assert.deepEqual(JSON.parse(JSON.stringify(comparable(st.getState()))), before);
});

test('UNDO on an empty log is a safe no-op (rev still bumps)', () => {
  const st = mk();
  st.dispatch({ type: 'UNDO' });
  const s = st.getState();
  assert.equal(s.rev, 1);
  assert.deepEqual(s.picks, []);
  assert.equal(st.undoDepth(), 0);
});

test('undoDepth reports min(10, log length)', () => {
  const st = mk();
  assert.equal(st.undoDepth(), 0);
  for (let i = 0; i < 3; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  assert.equal(st.undoDepth(), 3);
  for (let i = 3; i < 15; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  assert.equal(st.undoDepth(), 10, 'capped at 10');
  st.dispatch({ type: 'UNDO' });
  assert.equal(st.undoDepth(), 10, 'log is deeper than the reported cap');
});

// ---------------------------------------------------------------------------
// rev discipline
// ---------------------------------------------------------------------------

test('rev is strictly monotone across every dispatch, including no-ops and UNDO', () => {
  const st = mk();
  const seen: number[] = [];
  st.subscribe((s) => seen.push(s.rev));
  const actions: Parameters<Store['dispatch']>[0][] = [
    { type: 'PICK_MADE', idx: 1, source: 'manual' },
    { type: 'PICK_MADE', idx: 1, source: 'manual' }, // no-op (already taken)
    { type: 'SET_UI', ui: { searchText: 'x' } },
    { type: 'UNDO' },
    { type: 'CATCHUP', idxs: [] }, // no-op
    { type: 'SET_PICK_CURSOR', pick: 10 },
    { type: 'UNDO' },
    { type: 'UNDO' },
    { type: 'UNDO' }, // empty log by now — still bumps
    { type: 'RESET_DRAFT' },
  ];
  for (const a of actions) st.dispatch(a);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(st.getState().rev, 10);
});

// ---------------------------------------------------------------------------
// Log compaction — the persisted log stays capped at MAX_LOG (200)
// ---------------------------------------------------------------------------

test('past 200 actions the oldest are compacted into base; state stays exact', () => {
  const snaps: PersistedSnapshot[] = [];
  const adapter: PersistAdapter = { save: (snap) => snaps.push(snap) };
  const st = createStore({
    board: makeBoard(300),
    league: makeLeague(),
    persist: adapter,
    now: () => 7,
  });
  for (let i = 0; i < 192; i++) st.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  for (let i = 0; i < 30; i++) st.dispatch({ type: 'SET_UI', ui: { searchText: `q${i}` } });

  const last = snaps[snaps.length - 1];
  assert.equal(last.log.length, MAX_LOG);
  assert.equal(last.rev, 222);
  assert.equal(st.getState().picks.length, 192);
  assert.equal(st.getState().ui.searchText, 'q29');
  // compacted base carries the picks that scrolled off the log
  assert.equal(last.base.picks.length, 222 - MAX_LOG);
  // and undo still works across the compaction boundary
  st.dispatch({ type: 'UNDO' });
  assert.equal(st.getState().ui.searchText, 'q28');
  assert.equal(st.getState().picks.length, 192);
});

// ---------------------------------------------------------------------------
// Persistence adapter contract: SYNCHRONOUS on every dispatch, before notify
// ---------------------------------------------------------------------------

test('spy adapter is called synchronously on every dispatch, before subscribers', () => {
  let calls = 0;
  let lastRev = -1;
  let lastEntry: LogEntry | null = null;
  const adapter: PersistAdapter = {
    save(snapshot, entry) {
      calls += 1;
      lastRev = snapshot.rev;
      lastEntry = entry;
    },
  };
  const st = createStore({ board: makeBoard(), league: makeLeague(), persist: adapter, now: () => 42 });
  let notifiedAfterPersist = 0;
  st.subscribe((s) => {
    if (lastRev === s.rev) notifiedAfterPersist += 1; // persist already ran for this rev
  });

  st.dispatch({ type: 'PICK_MADE', idx: 0, source: 'manual' });
  assert.equal(calls, 1, 'called during dispatch, not later');
  assert.equal(lastRev, 1);
  assert.equal(lastEntry!.a.type, 'PICK_MADE');

  st.dispatch({ type: 'UNDO' });
  assert.equal(calls, 2, 'UNDO persists too');
  assert.equal(lastEntry!.a.type, 'UNDO');

  st.dispatch({ type: 'SET_UI', ui: { posFilter: 'TE' } });
  st.dispatch({ type: 'CATCHUP', idxs: [1, 2] });
  assert.equal(calls, 4);
  assert.equal(notifiedAfterPersist, 4, 'persist strictly precedes notify');
});

test('a throwing adapter never blocks the dispatch or subscribers', () => {
  const adapter: PersistAdapter = {
    save() {
      throw new Error('quota exceeded');
    },
  };
  const st = createStore({ board: makeBoard(), league: makeLeague(), persist: adapter });
  let notified = 0;
  st.subscribe(() => notified++);
  st.dispatch({ type: 'PICK_MADE', idx: 0, source: 'manual' });
  assert.equal(st.getState().picks.length, 1);
  assert.equal(notified, 1);
});

// ---------------------------------------------------------------------------
// Restore round-trip through the snapshot shape (persist.ts owns the tiers)
// ---------------------------------------------------------------------------

test('a store rebuilt from its own snapshot is identical, undo log included', () => {
  let snap: PersistedSnapshot | null = null;
  const adapter: PersistAdapter = { save: (s) => (snap = s) };
  const a = createStore({ board: makeBoard(), league: makeLeague(), persist: adapter, now: () => 5 });
  for (let i = 0; i < 12; i++) a.dispatch({ type: 'PICK_MADE', idx: i, source: 'manual' });
  a.dispatch({ type: 'SET_UI', ui: { posFilter: 'RB' } });

  const b = createStore({
    board: makeBoard(),
    league: makeLeague(),
    restore: { snapshot: JSON.parse(JSON.stringify(snap)) },
  });
  assert.equal(b.getState().rev, 13);
  assert.deepEqual(comparable(b.getState()), comparable(a.getState()));
  assert.equal(b.undoDepth(), 10);
  b.dispatch({ type: 'UNDO' }); // undo works across the restore boundary
  assert.equal(b.getState().ui.posFilter, 'ALL');
});

// ---------------------------------------------------------------------------
// Selectors — full 192-pick 12-team replays at slots 1, 8, 12
// ---------------------------------------------------------------------------

for (const slot of [1, 8, 12]) {
  test(`selectors track a full 192-pick replay correctly at slot ${slot}`, () => {
    const board = makeBoard(220);
    const league = makeLeague({ slot });
    const st = createStore({ board, league, now: () => 1 });
    const ladder: number[] = myPicks(league);
    const total = 12 * 16;

    for (let n = 1; n <= total; n++) {
      const s = st.getState();
      const exp = expectedSlot(n, 12);
      assert.equal(s.pickCursor, n);
      assert.equal(selectors.onClockSlot(s), exp, `on-clock slot at pick ${n}`);
      assert.equal(selectors.isMyPick(s), exp === slot, `isMyPick at pick ${n}`);
      // myNextPick DURING my pick is the pick itself; otherwise the next rung
      const expNext = ladder.find((p) => p >= n) ?? null;
      assert.equal(selectors.myNextPick(s), expNext, `myNextPick at pick ${n}`);
      st.dispatch({ type: 'PICK_MADE', idx: n - 1, source: 'sim' });
    }

    const s = st.getState();
    assert.equal(s.pickCursor, total + 1);
    assert.equal(selectors.isMyPick(s), false, 'draft over — never my pick');
    assert.equal(selectors.myNextPick(s), null, 'no next pick after the draft');
    assert.equal(selectors.remainingPool(s, board).length, 220 - 192);

    // every team ends with exactly 16 players; mine are exactly the ladder picks
    for (let t = 1; t <= 12; t++) {
      assert.equal(selectors.rosterOf(s, board, t).length, 16, `team ${t} roster size`);
    }
    const mine = selectors.myRoster(s, board);
    assert.deepEqual(
      mine.map((pl: any) => pl.idx),
      ladder.map((p) => p - 1), // idx n-1 was taken at overall pick n
    );
  });
}

test('myNextPick just after my pick jumps to the next rung of the ladder', () => {
  const league = makeLeague({ slot: 8 });
  const st = createStore({ board: makeBoard(), league, now: () => 1 });
  // burn picks 1..7
  st.dispatch({ type: 'CATCHUP', idxs: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(selectors.isMyPick(st.getState()), true);
  assert.equal(selectors.myNextPick(st.getState()), 8);
  st.dispatch({ type: 'PICK_MADE', idx: 7, source: 'manual' });
  assert.equal(selectors.isMyPick(st.getState()), false);
  assert.equal(selectors.myNextPick(st.getState()), 17, 'slot 8: 8 → 17 (9-gap)');
});

test('selectors respect a live slot change (slot is data, never baked in)', () => {
  const st = mk();
  st.dispatch({ type: 'SET_LEAGUE', league: { slot: 1 } });
  assert.equal(selectors.isMyPick(st.getState()), true, 'pick 1 belongs to slot 1');
  assert.equal(selectors.myNextPick(st.getState()), 1);
  st.dispatch({ type: 'SET_LEAGUE', league: { slot: 12 } });
  assert.equal(selectors.isMyPick(st.getState()), false);
  assert.equal(selectors.myNextPick(st.getState()), 12);
});

// ---------------------------------------------------------------------------
// Export/import — lossless round-trip
// ---------------------------------------------------------------------------

test('export → import round-trip is lossless (league, picks, cursor, ui)', () => {
  const a = mk({ slot: 6 });
  for (let i = 0; i < 40; i++) a.dispatch({ type: 'PICK_MADE', idx: i, source: i % 2 ? 'sleeper' : 'manual' });
  a.dispatch({ type: 'EDIT_PICK', pickNumber: 12, idx: 77 });
  a.dispatch({ type: 'SET_UI', ui: { posFilter: 'RB', searchText: 'j', showFive: false } });
  a.dispatch({ type: 'SET_LEAGUE', league: { strategy: 'zeroRb' } });

  const json = JSON.stringify(exportState(a.getState()));
  const res = importEnvelope(json, 'testhash');
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.buildHashMismatch, false);

  const b = mk();
  b.dispatch({ type: 'IMPORT_STATE', state: res.state! });
  assert.deepEqual(comparable(b.getState()), comparable(a.getState()));

  // and a second round-trip is a fixed point
  const res2 = importEnvelope(JSON.stringify(exportState(b.getState())), 'testhash');
  assert.equal(res2.ok, true);
  const c = mk();
  c.dispatch({ type: 'IMPORT_STATE', state: res2.state! });
  assert.deepEqual(comparable(c.getState()), comparable(b.getState()));
});
