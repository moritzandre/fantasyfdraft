// SetupScreen.tsx — #/setup. League shape + THE slot-generalization control:
// a row of big numbered chips 1..teams (default 8) that re-derives the pick
// ladder, gap annotations and κ schedule LIVE via engine/picks.js. Also:
// teams segmented control, rounds, roster ± steppers, strategy picker with
// one-line descriptions, snake toggle, and a 3s-hold reset (no dialogs).

import { useEffect, useState } from 'preact/hooks';
import { gapsAfter, myPicks } from '../../../engine/picks.js';
import type { DraftState, Store, UiState } from '../../state/store';
import { loadStrategies, strategyList } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';
import HoldButton from './HoldButton';

const TEAM_OPTIONS = [8, 10, 12, 14];
const ROSTER_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST', 'BN'];

export default function SetupScreen({ s, store }: { s: DraftState; store: Store }) {
  const { dispatch } = store;
  const l = s.league;
  const picks = myPicks(l);
  const gaps = gapsAfter(picks);

  // Built-ins + custom strategies.json entries (loaded once, cached).
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  useEffect(() => {
    loadStrategies().then(setRegistry);
  }, []);
  const strategies = strategyList(registry);

  const setLeague = (league: Record<string, unknown>) => dispatch({ type: 'SET_LEAGUE', league });
  const setRoster = (pos: string, delta: number) => {
    const cur = l.roster[pos] ?? 0;
    const next = Math.max(pos === 'QB' ? 1 : 0, Math.min(12, cur + delta));
    if (next !== cur) setLeague({ roster: { ...l.roster, [pos]: next } });
  };

  return (
    <main class="mx-auto max-w-3xl px-4 pb-16">
      <div class="sticky top-0 z-10 flex items-center gap-2 bg-app-bg py-2">
        <a
          href="#/ready"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Ready
        </a>
        <h1 class="flex-1 text-lg font-bold">Setup</h1>
        <a href="#/live" class="flex h-14 items-center rounded-lg bg-accent px-5 font-bold text-app-bg">
          Go Live →
        </a>
      </div>

      {/* Teams */}
      <section class="mt-3">
        <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">TEAMS</h2>
        <div class="flex gap-1">
          {TEAM_OPTIONS.map((t) => (
            <button
              type="button"
              class={`num h-14 flex-1 rounded-lg border text-lg font-bold ${
                l.teams === t ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-surface'
              }`}
              onClick={() => setLeague({ teams: t, slot: Math.min(l.slot, t) })}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      {/* THE slot picker — every slot 1..N selectable at runtime, 8 default */}
      <section class="mt-4">
        <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">YOUR DRAFT SLOT</h2>
        <div class="grid grid-cols-7 gap-1">
          {Array.from({ length: l.teams }, (_, i) => i + 1).map((slot) => (
            <button
              type="button"
              class={`num h-14 rounded-lg border text-lg font-bold ${
                l.slot === slot ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-surface'
              }`}
              onClick={() => setLeague({ slot })}
            >
              {slot}
            </button>
          ))}
        </div>
        {/* Live-derived ladder: re-derives instantly when slot/teams change */}
        <div class="mt-2 rounded-lg border border-app-border bg-app-surface p-2">
          <div class="pb-1 text-xs text-app-dim">
            Your picks (gap to your next pick annotated — short gap ⇒ BPA, long gap ⇒ weight the
            cost of waiting):
          </div>
          <div class="flex flex-wrap gap-1">
            {picks.map((p, i) => (
              <span class="num rounded border border-app-border px-1.5 py-1 text-[14px]">
                {p}
                {i < gaps.length && <span class="text-app-dim"> +{gaps[i]}</span>}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Rounds + snake */}
      <section class="mt-4 flex gap-4">
        <div class="flex-1">
          <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">ROUNDS</h2>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="num h-14 w-14 rounded-lg border border-app-border bg-app-surface text-xl"
              onClick={() => setLeague({ rounds: Math.max(8, l.rounds - 1) })}
            >
              −
            </button>
            <span class="num w-12 text-center text-xl font-bold">{l.rounds}</span>
            <button
              type="button"
              class="num h-14 w-14 rounded-lg border border-app-border bg-app-surface text-xl"
              onClick={() => setLeague({ rounds: Math.min(20, l.rounds + 1) })}
            >
              +
            </button>
          </div>
        </div>
        <div class="flex-1">
          <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">ORDER</h2>
          <button
            type="button"
            class={`h-14 w-full rounded-lg border px-3 font-bold ${
              l.snake ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-surface'
            }`}
            onClick={() => setLeague({ snake: !l.snake })}
          >
            {l.snake ? 'Snake ↩' : 'Linear →'}
          </button>
        </div>
      </section>

      {/* Roster steppers */}
      <section class="mt-4">
        <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">ROSTER</h2>
        <div class="grid grid-cols-2 gap-2">
          {ROSTER_ORDER.map((pos) => (
            <div class="flex items-center justify-between rounded-lg border border-app-border bg-app-surface px-3 py-1">
              <span class="font-bold">{pos}</span>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="num h-14 w-14 rounded-lg border border-app-border bg-app-bg text-xl"
                  onClick={() => setRoster(pos, -1)}
                >
                  −
                </button>
                <span class="num w-8 text-center text-lg font-bold">{l.roster[pos] ?? 0}</span>
                <button
                  type="button"
                  class="num h-14 w-14 rounded-lg border border-app-border bg-app-bg text-xl"
                  onClick={() => setRoster(pos, +1)}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Strategy */}
      <section class="mt-4">
        <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">STRATEGY</h2>
        <div class="flex flex-col gap-1">
          {strategies.map(({ name: id, label, blurb, custom }) => (
            <button
              type="button"
              class={`min-h-14 rounded-lg border px-3 py-2 text-left ${
                (l.strategy ?? 'balanced') === id
                  ? 'border-accent bg-app-surface'
                  : 'border-app-border bg-app-surface/50'
              }`}
              onClick={() => setLeague({ strategy: id })}
            >
              <span class="font-bold">
                {(l.strategy ?? 'balanced') === id ? '● ' : '○ '}
                {label}
                {custom && <span class="ml-2 rounded bg-app-border px-1.5 text-xs font-normal">custom</span>}
              </span>
              <span class="ml-2 text-sm text-app-dim">{blurb}</span>
            </button>
          ))}
        </div>
        <p class="pt-1 text-xs text-app-dim">
          Priors, not handcuffs — a pick {'>'}{l.overrideDelta ?? 20} pts better than the compliant
          best is surfaced as a flagged conflict, never silently obeyed.
        </p>
      </section>

      {/* Reset — two-step inline confirm via 3s hold, never a dialog */}
      <section class="mt-6">
        <HoldButton
          ms={3000}
          onHold={() => {
            dispatch({ type: 'RESET_DRAFT' });
            // A resumed-mock label (ReviewScreen → ui.mockLabel) no longer
            // describes anything once the picks are wiped. The room seed is
            // deliberately KEPT (same-room semantics, like Redo room).
            if ((s.ui as Record<string, unknown>).mockLabel != null) {
              dispatch({
                type: 'SET_UI',
                ui: { mockLabel: undefined } as unknown as Partial<UiState>,
              });
            }
          }}
          class="min-h-14 w-full rounded-xl border border-app-border bg-app-surface font-bold text-app-dim"
        >
          Hold 3s to reset draft ({s.picks.length} picks recorded — league config is kept)
        </HoldButton>
      </section>
    </main>
  );
}
