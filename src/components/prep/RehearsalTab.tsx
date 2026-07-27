// RehearsalTab.tsx — "mock the room": drives the OTHER N−1 seats pick-by-pick
// through the SAME reducer as real picks (PICK_MADE {source:'sim'}, so every
// sim pick is individually undoable and lands in the pick log). Opponent
// choice = the Plackett-Luce first-choice distribution from engine/survival.js
// (plackettLuceSurvival with G=1: p_i = 1 − s_i = w_i/W), with τ from
// public/data/opponents.json — adpDiscipline scales the softmax temperature,
// positionBias/homerTeams shift μ′, reachRounds double τ. MY picks stay
// manual: the sim pauses whenever my slot is on the clock and points at
// #/live. Start / Pause / Step + speed slider; reset via 3s HoldButton
// (RESET_DRAFT) — never a confirm dialog.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { plackettLuceSurvival } from '../../../engine/survival.js';
import { roundForPick, slotForPick } from '../../../engine/picks.js';
import { abbrevName, fmtAdp } from '../../../shared/format.js';
import { selectors } from '../../state/store';
import type { Board, DraftState } from '../../state/store';
import HoldButton from '../live/HoldButton';
import type { PrepCtx } from './PrepScreen';

interface Seat {
  seat: number;
  name?: string;
  adpDiscipline?: number;
  positionBias?: Record<string, number>;
  homerTeams?: string[];
  reachRounds?: number[];
}

const NEUTRAL: Seat = { seat: 0, adpDiscipline: 0.5, positionBias: {}, homerTeams: [], reachRounds: [] };
const POOL_TOP = 30;
/** Realistic per-position caps for the opponent model (not my roster rules). */
const CAPS: Record<string, number> = { QB: 2, TE: 2, K: 1, DST: 1 };

/** Sample ONE opponent pick from the Plackett-Luce first-choice distribution. */
export function sampleOpponentPick(
  state: DraftState,
  board: Board,
  seats: Seat[],
  rand: () => number = Math.random,
): number | null {
  const l = state.league;
  const total = l.teams * l.rounds;
  if (state.pickCursor > total) return null;

  const slot = selectors.onClockSlot(state);
  const round = roundForPick(state.pickCursor, l.teams);
  const seat = seats.find((x) => x.seat === slot) ?? NEUTRAL;
  const counts: Record<string, number> = {};
  for (const p of selectors.rosterOf(state, board, slot)) counts[p.pos] = (counts[p.pos] ?? 0) + 1;

  let pool = selectors
    .remainingPool(state, board)
    .filter((p: any) => Number.isFinite(p.adp?.mu))
    .filter((p: any) => {
      const cap = CAPS[p.pos];
      if (cap && (counts[p.pos] ?? 0) >= cap) return false;
      // nobody human drafts K/DST before the last few rounds
      if ((p.pos === 'K' || p.pos === 'DST') && round < l.rounds - 2) return false;
      return true;
    })
    .sort((a: any, b: any) => a.adp.mu - b.adp.mu);
  if (pool.length === 0) pool = selectors.remainingPool(state, board);
  if (pool.length === 0) return null;

  const cands = pool.slice(0, POOL_TOP);

  // τ — the local σ̂ of the ADP window, scaled by discipline (0 = wild reacher
  // → hotter softmax; 1 = strict ADP → colder), doubled in their reach rounds.
  const sigmas = cands.map((c: any) => c.adp?.sigmaFinal ?? c.adp?.sd ?? 6);
  const sigBar = sigmas.reduce((a: number, b: number) => a + b, 0) / sigmas.length;
  let tau = Math.max(1, sigBar) * (1.6 - (seat.adpDiscipline ?? 0.5));
  if (seat.reachRounds?.includes(round)) tau *= 2;

  // Bias enters as a μ′ shift: μ′ = μ − τ·ln(bias) ⇔ w × bias.
  const mus = cands.map((c: any) => {
    let bias = seat.positionBias?.[c.pos] ?? 1;
    if (seat.homerTeams?.includes(c.team)) bias *= 1.35;
    return c.adp.mu - tau * Math.log(Math.max(0.05, bias));
  });

  // One PL round: pick probability p_i = 1 − s_i(G=1) = w_i/W.
  const surv = plackettLuceSurvival(mus, tau, 1);
  const probs = surv.map((s: number) => Math.max(0, 1 - s));
  const sum = probs.reduce((a: number, b: number) => a + b, 0);
  let r = rand() * (sum > 0 ? sum : 1);
  for (let i = 0; i < cands.length; i++) {
    r -= probs[i];
    if (r <= 0) return cands[i].idx;
  }
  return cands[0].idx;
}

export default function RehearsalTab({ ctx }: { ctx: PrepCtx }) {
  const { s, store, derived } = ctx;
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(700); // ms between opponent picks
  const [seats, setSeats] = useState<Seat[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch(import.meta.env.BASE_URL + 'data/opponents.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => {
        if (Array.isArray(o?.seats)) setSeats(o.seats);
      })
      .catch(() => {}); // neutral defaults still work
  }, []);

  const l = s.league;
  const total = l.teams * l.rounds;
  const over = s.pickCursor > total;
  const myTurn = selectors.isMyPick(s);
  const round = roundForPick(Math.min(s.pickCursor, total), l.teams);

  const step = (): boolean => {
    const state = store.getState();
    if (state.pickCursor > state.league.teams * state.league.rounds) return false;
    if (selectors.isMyPick(state)) return false; // my picks stay manual (#/live)
    const idx = sampleOpponentPick(state, derived, seats);
    if (idx == null) return false;
    store.dispatch({ type: 'PICK_MADE', idx, source: 'sim' });
    return true;
  };

  // Interval loop — reads fresh state from the store each tick, pauses itself
  // the moment I'm on the clock or the draft ends.
  useEffect(() => {
    if (!running) return;
    timer.current = setInterval(() => {
      if (!step()) setRunning(false);
    }, speed);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [running, speed, seats, derived]);

  const simPicks = useMemo(
    () => s.picks.filter((p) => p.source === 'sim').slice(-10).reverse(),
    [s.rev],
  );

  return (
    <div class="mx-auto max-w-2xl px-3 pb-16">
      <p class="py-2 text-sm text-app-dim">
        The other {l.teams - 1} seats draft themselves (Plackett-Luce over ADP, tendencies from
        opponents.json). Sim picks go through the normal reducer — each one is undoable, and RESET
        wipes the rehearsal. <b class="text-app-text">Your picks stay manual on the Live screen.</b>
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
          disabled={over || (myTurn && !running)}
          onClick={() => setRunning(!running)}
        >
          {running ? 'Pause' : 'Start'}
        </button>
        <button
          type="button"
          class="min-h-14 flex-1 rounded-xl border border-app-border bg-app-surface font-bold disabled:opacity-40"
          disabled={over || myTurn || running}
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
          }}
          class="min-h-14 w-full rounded-xl border border-app-border bg-app-surface font-bold text-app-dim"
        >
          Hold 3s to reset the rehearsal ({s.picks.length} picks)
        </HoldButton>
      </section>
    </div>
  );
}
