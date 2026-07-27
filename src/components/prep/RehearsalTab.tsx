// RehearsalTab.tsx — "mock the room": drives the OTHER N−1 seats pick-by-pick
// through the SAME reducer as real picks (PICK_MADE {source:'sim'}, so every
// sim pick is individually undoable and lands in the pick log). Opponent
// choice = src/state/mock.ts createMockDriver over engine/opponent.js — the
// ONE opponent model the offline Monte Carlo (tools/simulate.mjs) samples
// from, tendencies from public/data/opponents.json, archetype names resolved
// against public/data/strategies.json. The driver re-derives the room from
// the store's pick log on every step, so UNDO/EDIT_PICK mid-mock stay
// coherent; its seed persists in ui.mockSeed so the room's character is
// stable for the whole mock. MY picks stay manual: the sim pauses whenever my
// slot is on the clock and points at #/live. Start / Pause / Step + speed
// slider; reset via 3s HoldButton (RESET_DRAFT + fresh room seed) — never a
// confirm dialog.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { defineStrategy } from '../../../engine/strategy.js';
import { roundForPick, slotForPick } from '../../../engine/picks.js';
import { abbrevName, fmtAdp } from '../../../shared/format.js';
import { selectors } from '../../state/store';
import type { UiState } from '../../state/store';
import { createMockDriver } from '../../state/mock';
import type { MockDriver } from '../../state/mock';
import { loadOpponents } from '../../state/opponents';
import HoldButton from '../live/HoldButton';
import type { PrepCtx } from './PrepScreen';

interface Room {
  opponents: unknown; // parsed opponents.json (null ⇒ neutral defaults)
  strategies: Record<string, object> | null; // defineStrategy registry
}

export default function RehearsalTab({ ctx }: { ctx: PrepCtx }) {
  const { s, store, board, derived } = ctx;
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(700); // ms between opponent picks
  const [room, setRoom] = useState<Room | null>(null);
  const [roomRev, setRoomRev] = useState(0); // bumped by reset → new driver
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const grab = (file: string) =>
      fetch(import.meta.env.BASE_URL + 'data/' + file)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null); // neutral defaults still work offline
    // Opponents come through loadOpponents so the Sim Lab Room editor's
    // local patch (dp:opponents-local:v1) applies to rehearsal too.
    Promise.all([loadOpponents(), grab('strategies.json')]).then(([opp, strat]) => {
      if (!alive) return;
      // Invalid custom specs are dropped with a warning, never fatal
      // (strategies.json contract) — archetype resolution falls back below.
      const registry: Record<string, object> = {};
      for (const spec of (strat as { strategies?: object[] } | null)?.strategies ?? []) {
        try {
          const d = defineStrategy(spec);
          registry[(d as { name: string }).name] = d;
        } catch (e) {
          console.warn('rehearsal: dropped invalid strategy spec —', e);
        }
      }
      setRoom({ opponents: opp, strategies: Object.keys(registry).length ? registry : null });
    });
    return () => {
      alive = false;
    };
  }, []);

  const l = s.league;

  // The driver captures league (teams/rounds) and the board at creation —
  // rebuild it whenever they change, when the room data lands, or after a
  // reset (roomRev). Fallbacks, visibly (console.warn), never mid-draft:
  //   1. derived board + full archetype mix (the normal path)
  //   2. archetypes stripped (strategies.json missing/invalid ⇒ unknown names)
  //   3. RAW board (a prep ADP override can break the ctx's ADP-order assert)
  const driver = useMemo<MockDriver | null>(() => {
    if (!room) return null;
    const opp = room.opponents as Record<string, unknown> | null;
    // "no archetypes" must strip the per-seat FIXED archetypes too — an
    // unresolvable strategy name would otherwise still throw at ctx build.
    const strip = (o: Record<string, unknown> | null) =>
      o
        ? {
            ...o,
            archetypes: null,
            seats: ((o.seats as Array<Record<string, unknown>>) ?? []).map(
              ({ archetype: _drop, ...rest }) => rest,
            ),
          }
        : null;
    const attempts: Array<[string, unknown, unknown]> = [
      ['full', derived, opp],
      ['no archetypes', derived, strip(opp)],
      ['raw board', board, opp],
      ['raw board, no archetypes', board, strip(opp)],
    ];
    for (const [label, b, o] of attempts) {
      try {
        const d = createMockDriver(store, b as typeof board, o, { strategies: room.strategies });
        if (label !== 'full') console.warn(`rehearsal: opponent model degraded to "${label}"`);
        return d;
      } catch (e) {
        console.warn(`rehearsal: driver "${label}" failed —`, e);
      }
    }
    return null;
  }, [room, roomRev, derived, board, store, l.teams, l.rounds]);

  const total = l.teams * l.rounds;
  const over = s.pickCursor > total;
  const myTurn = selectors.isMyPick(s);
  const round = roundForPick(Math.min(s.pickCursor, total), l.teams);

  const step = (): boolean => driver?.step() ?? false;

  // Interval loop — the driver reads fresh state from the store each tick,
  // pauses itself the moment I'm on the clock or the draft ends.
  useEffect(() => {
    if (!running || !driver) return;
    timer.current = setInterval(() => {
      if (!step()) setRunning(false);
    }, speed);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [running, speed, driver]);

  const simPicks = useMemo(
    () => s.picks.filter((p) => p.source === 'sim').slice(-10).reverse(),
    [s.rev],
  );

  // This mock's drawn room character — seats whose archetype deviates from
  // the balanced default (null/balanced seats stay quiet).
  const roomCharacter = useMemo(() => {
    if (!driver) return [];
    return driver
      .seatArchetypes()
      .filter((e) => e.archetype !== null && e.archetype !== 'balanced' && e.slot !== l.slot);
  }, [driver, l.slot]);

  return (
    <div class="mx-auto max-w-2xl px-3 pb-16">
      <p class="py-2 text-sm text-app-dim">
        The other {l.teams - 1} seats draft themselves through the same opponent model as the Monte
        Carlo (Plackett-Luce over ADP, tendencies + archetypes from opponents.json). Sim picks go
        through the normal reducer — each one is undoable, and RESET wipes the rehearsal.{' '}
        <b class="text-app-text">Your picks stay manual on the Live screen.</b>
      </p>

      <div class="num rounded-lg border border-app-border bg-app-surface p-3 text-center">
        <div class="text-2xl font-bold">
          {over ? 'Draft complete' : `Round ${round} · Pick ${Math.min(s.pickCursor, total)} of ${total}`}
        </div>
        <div class="text-sm text-app-dim">
          {over
            ? `${s.picks.length} picks recorded`
            : myTurn
              ? `slot ${l.slot} (YOU) on the clock`
              : `slot ${selectors.onClockSlot(s)} on the clock · ${s.picks.length} recorded`}
        </div>
        {roomCharacter.length > 0 && (
          <div class="num pt-1 text-xs text-app-dim">
            Room: {roomCharacter.map((e) => `s${e.slot} ${e.archetype}`).join(' · ')}
          </div>
        )}
      </div>

      {myTurn && !over && (
        <a href="#/live" class="lv-clock-up mt-2 flex min-h-14 items-center justify-center rounded-xl px-4 text-center">
          YOU ARE UP — pick on the Live screen, then come back
        </a>
      )}

      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class={`min-h-14 flex-1 rounded-xl font-bold ${
            running ? 'lv-clock-near' : 'bg-accent text-app-bg'
          } disabled:opacity-40`}
          disabled={!driver || over || (myTurn && !running)}
          onClick={() => setRunning(!running)}
        >
          {driver ? (running ? 'Pause' : 'Start') : 'Loading room…'}
        </button>
        <button
          type="button"
          class="min-h-14 flex-1 rounded-xl border border-app-border bg-app-surface font-bold disabled:opacity-40"
          disabled={!driver || over || myTurn || running}
          onClick={step}
        >
          Step (1 pick)
        </button>
      </div>

      <label class="mt-3 block">
        <span class="num text-sm text-app-dim">Speed — one opponent pick every {speed} ms</span>
        <input
          type="range"
          min={200}
          max={2000}
          step={100}
          value={speed}
          onInput={(e) => setSpeed(Number((e.target as HTMLInputElement).value))}
          class="h-14 w-full accent-current"
        />
      </label>

      <section class="mt-3">
        <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">LAST SIM PICKS</h2>
        {simPicks.map((pk) => {
          const p = derived.players[pk.idx];
          return (
            <div class="num flex min-h-9 items-center gap-2 border-b border-app-border px-1 text-sm">
              <span class="w-9 shrink-0 text-right text-app-dim">#{pk.n}</span>
              <span class="w-14 shrink-0 text-app-dim">slot {slotForPick(pk.n, l.teams, l.snake)}</span>
              <span class="min-w-0 flex-1 truncate font-semibold">{p ? abbrevName(p.name, 22) : `idx ${pk.idx}`}</span>
              <span class="shrink-0 text-app-dim">
                {p ? `${p.pos}${p.posRank} · adp ${fmtAdp(p.adp?.mu)}` : ''}
              </span>
            </div>
          );
        })}
        {simPicks.length === 0 && <p class="py-2 text-sm text-app-dim">No sim picks yet — hit Start.</p>}
      </section>

      <section class="mt-6">
        <HoldButton
          ms={3000}
          onHold={() => {
            setRunning(false);
            store.dispatch({ type: 'RESET_DRAFT' });
            // Clear the persisted room seed so the NEXT mock draws a fresh
            // room (and any resumed-mock label — mirrors MockControls'
            // Archive); roomRev forces a new driver over the fresh seed.
            store.dispatch({
              type: 'SET_UI',
              ui: { mockSeed: undefined, mockLabel: undefined } as unknown as Partial<UiState>,
            });
            setRoomRev((r) => r + 1);
          }}
          class="min-h-14 w-full rounded-xl border border-app-border bg-app-surface font-bold text-app-dim"
        >
          Hold 3s to reset the rehearsal ({s.picks.length} picks)
        </HoldButton>
      </section>
    </div>
  );
}
