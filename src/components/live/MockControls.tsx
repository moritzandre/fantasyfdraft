// MockControls.tsx — the practice-mode strip between TopBar and the live
// grid (NEVER rendered in real mode — draft day gets byte-identical #/live).
// Drives the unified opponent model (src/state/mock.ts createMockDriver →
// engine/opponent.js): Start/Pause auto-advance · single Step · speed ·
// auto-pick-me toggle (engine rank 1) · strategy quick-cycle (SET_LEAGUE) ·
// room-archetype readout · Archive (grade via the shared gradeMyPicks →
// dp:mock-history:v1, then RESET_DRAFT + clear ui.mockSeed for a fresh
// room) · Redo room (RESET_DRAFT keeping ui.mockSeed AND the driver — the
// same seed reproduces the same room, nothing archived) · Review link.
// Every sim pick dispatches PICK_MADE {source:'sim'} through the one
// reducer — individually undoable like any tap. When ReviewScreen's Resume
// loaded a mock from history, ui.mockLabel names it and the note area shows
// "Loaded: …" (cleared by Archive/Redo — the picks stop being that mock).

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Board, DraftState, Store, UiState } from '../../state/store';
import { selectors } from '../../state/store';
import { useSyncInfo } from './SyncPanel';
import { createMockDriver } from '../../state/mock';
import { archiveMock } from '../../state/mockHistory';
import { loadOpponents } from '../../state/opponents';
import type { OpponentsFile } from '../../state/opponents';
import { gradeMyPicks } from '../../state/review';
import { loadStrategies, strategyList } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';

const SPEEDS: [number, string][] = [
  [700, '1×'],
  [250, '3×'],
  [60, '10×'],
];

export default function MockControls({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const [opp, setOpp] = useState<OpponentsFile | null>(null);
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  useEffect(() => {
    loadOpponents().then(setOpp);
    loadStrategies().then(setRegistry);
  }, []);

  // Bumped by Archive so the driver re-creates over the CLEARED ui.mockSeed
  // (the memoized driver captured the old seed — same trick as RehearsalTab's
  // roomRev); the new driver derives + persists a fresh room seed.
  const [roomRev, setRoomRev] = useState(0);

  // Driver creation mirrors RehearsalTab's degradation chain: full model →
  // archetypes stripped (unknown names / offline strategies.json) → null.
  const driver = useMemo(() => {
    if (!opp || registry === null) return null;
    try {
      return createMockDriver(store, board, opp, { strategies: registry });
    } catch (e) {
      console.warn('[mock] archetypes unavailable, tendency-only room:', (e as Error)?.message ?? e);
      try {
        // Strip the mix AND the per-seat fixed archetypes — either can carry
        // an unresolvable strategy name when strategies.json is unavailable.
        const seats = (opp.seats ?? []).map(({ archetype: _drop, ...rest }) => rest);
        return createMockDriver(store, board, { ...opp, archetypes: null, seats }, {});
      } catch (e2) {
        console.warn('[mock] driver unavailable:', (e2 as Error)?.message ?? e2);
        return null;
      }
    }
  }, [opp, registry, store, board, s.league.teams, s.league.rounds, roomRev]);

  const [running, setRunning] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [autoMe, setAutoMe] = useState(false);
  const [note, setNote] = useState('');
  // Set by ReviewScreen's Resume (what mock is loaded); cleared by
  // Archive/Redo/replay/reset — the ui escape hatch, like mockSeed.
  const mockLabel = (s.ui as Record<string, unknown>).mockLabel as string | undefined;
  const total = s.league.teams * s.league.rounds;
  const done = s.pickCursor > total;
  const myTurn = !done && selectors.isMyPick(s);

  // Sleeper sync (tracked mock lobby): the note shows sync freshness instead
  // of the local room readout — a 1s tick keeps "Xs ago" moving.
  const sync = useSyncInfo();
  const syncLive = sync.status === 'live';
  const [, setSyncTick] = useState(0);
  useEffect(() => {
    if (!syncLive) return;
    const t = setInterval(() => setSyncTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [syncLive]);
  const syncAge =
    sync.lastPollAt === null
      ? null
      : Math.max(0, Math.round((Date.now() - sync.lastPollAt) / 1000));

  useEffect(() => {
    if (!running || !driver || done) return;
    const t = setInterval(() => {
      const advanced = driver.step();
      if (!advanced) {
        const st = store.getState();
        if (st.pickCursor > total) {
          setRunning(false);
        } else if (autoMe) {
          if (!driver.autoMyPick()) setRunning(false);
        } else {
          setRunning(false); // my turn — the shortlist takes over
        }
      }
    }, SPEEDS[speedIdx][0]);
    return () => clearInterval(t);
  }, [running, driver, speedIdx, autoMe, total, done]);

  const room = useMemo(
    () =>
      driver
        ? driver
            .seatArchetypes()
            .filter((x) => x.archetype && x.slot !== s.league.slot)
            .map((x) => `T${x.slot} ${x.archetype}`)
            .join(' · ')
        : '',
    [driver],
  );

  // Built-ins + custom registry, strategyList order — the quick-set cycle.
  const strats = useMemo(() => strategyList(registry), [registry]);
  const curStrategy = s.league.strategy ?? 'balanced';
  const cycleStrategy = () => {
    const i = strats.findIndex((m) => m.name === curStrategy);
    const next = strats[(i + 1) % strats.length]?.name ?? 'balanced';
    store.dispatch({ type: 'SET_LEAGUE', league: { strategy: next } });
  };

  // Archive: grade EXACTLY like ReviewScreen (shared gradeMyPicks), save the
  // mock, then reset + clear the room seed so the next mock rolls fresh. No
  // confirm — the archive is non-destructive, and the reset after it is safe
  // BECAUSE the mock was just saved.
  const onArchive = () => {
    const st = store.getState();
    if (st.picks.length === 0) return;
    setRunning(false);
    const finishedAt = Date.now();
    const rawSeed = (st.ui as Record<string, unknown>).mockSeed;
    const seed = typeof rawSeed === 'number' && Number.isFinite(rawSeed) ? rawSeed : null;
    const g = gradeMyPicks(board, st.league, st.picks, registry);
    archiveMock({
      id: `${finishedAt}-${seed ?? 'x'}`,
      finishedAt,
      league: {
        teams: st.league.teams,
        slot: st.league.slot,
        rounds: st.league.rounds,
        snake: st.league.snake,
        strategy: st.league.strategy,
      },
      seed,
      picks: st.picks.map((p) => ({ n: p.n, idx: p.idx, source: p.source })),
      summary:
        g.graded === null
          ? null
          : { myPicks: g.graded.length, matches: g.matches, evens: g.evens, totalDelta: g.totalDelta },
    });
    store.dispatch({ type: 'RESET_DRAFT' });
    // Clear the persisted room seed so the NEXT mock draws a fresh room (and
    // any resumed-mock label — nothing is loaded anymore); roomRev forces a
    // new driver over the fresh seed (RehearsalTab pattern).
    store.dispatch({
      type: 'SET_UI',
      ui: { mockSeed: undefined, mockLabel: undefined } as unknown as Partial<UiState>,
    });
    setRoomRev((r) => r + 1);
    setNote('archived — fresh room ready');
  };

  // Redo room: archive NOTHING — wipe the picks and keep ui.mockSeed AND the
  // memoized driver (no roomRev bump): the driver re-derives the whole room
  // from the pick log each step (rebuild()), so the same seed over an empty
  // log reproduces the identical seats/archetypes. Recoverable (practice
  // strip only, and the picks were mine to throw away) — no confirm.
  const onRedo = () => {
    if (s.picks.length === 0) return;
    setRunning(false);
    store.dispatch({ type: 'RESET_DRAFT' });
    // A resumed mock's label no longer describes the (now wiped) picks.
    if (mockLabel) {
      store.dispatch({
        type: 'SET_UI',
        ui: { mockLabel: undefined } as unknown as Partial<UiState>,
      });
    }
    setNote('same room, fresh start');
  };

  return (
    <div class="lv-mock-controls flex items-center gap-2 overflow-x-auto px-2">
      <span class="lv-clock-near shrink-0 rounded px-2 py-1 text-xs font-bold">MOCK</span>
      <button
        type="button"
        class={`h-14 shrink-0 rounded-lg px-4 font-bold ${
          running ? 'border border-app-border bg-app-surface' : 'bg-accent text-app-bg'
        }`}
        disabled={!driver || done}
        onClick={() => setRunning(!running)}
      >
        {running ? 'Pause' : done ? 'Done' : 'Start'}
      </button>
      <button
        type="button"
        class="h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-4 font-bold"
        disabled={!driver || done || running}
        onClick={() => driver && (driver.step() || (autoMe && driver.autoMyPick()))}
      >
        Step
      </button>
      <button
        type="button"
        class="num h-14 min-w-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        onClick={() => setSpeedIdx((speedIdx + 1) % SPEEDS.length)}
        title="Sim speed"
      >
        {SPEEDS[speedIdx][1]}
      </button>
      <button
        type="button"
        class={`h-14 shrink-0 rounded-lg border px-3 text-sm font-bold ${
          autoMe ? 'border-accent bg-accent/15' : 'border-app-border bg-app-surface text-app-dim'
        }`}
        onClick={() => setAutoMe(!autoMe)}
        title="Let the engine take your picks too (rank 1)"
      >
        AUTO-ME {autoMe ? 'ON' : 'OFF'}
      </button>
      <button
        type="button"
        class="h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-3 text-sm font-bold text-accent"
        onClick={cycleStrategy}
        title="my strategy — full details in Prep → Strategy"
      >
        {curStrategy}
      </button>
      <span class="min-w-0 flex-1 truncate text-xs text-app-dim">
        {note && s.picks.length === 0
          ? note
          : syncLive
            ? `${myTurn ? 'YOUR PICK (in Sleeper) · ' : ''}synced ${syncAge ?? '?'}s ago · pick ${Math.min(s.pickCursor, total)}`
            : !driver
              ? 'Loading room…'
              : myTurn && !autoMe
                ? 'YOUR PICK — use the shortlist'
                : mockLabel
                  ? `Loaded: ${mockLabel}`
                  : room || 'neutral room'}
      </span>
      <button
        type="button"
        class="h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-4 font-bold disabled:opacity-40"
        disabled={s.picks.length === 0}
        onClick={onArchive}
        title="save this mock to history (Review) and reset for a fresh room"
      >
        Archive
      </button>
      <button
        type="button"
        class="h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-4 font-bold disabled:opacity-40"
        disabled={s.picks.length === 0}
        onClick={onRedo}
        title="same room, fresh start — wipe the picks but keep this room's seed (nothing is archived)"
      >
        Redo room
      </button>
      {(done || s.picks.length > 0) && (
        <a
          href="#/review"
          class="flex h-14 shrink-0 items-center rounded-lg border border-app-border bg-app-surface px-4 font-bold"
        >
          Review →
        </a>
      )}
    </div>
  );
}
