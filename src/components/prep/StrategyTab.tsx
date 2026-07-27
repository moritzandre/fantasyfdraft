// StrategyTab.tsx — the four strategies (engine/strategy.js is the single
// source of the multipliers + constraints; nothing re-encoded here) rendered
// as a round-shape table for the CURRENT slot: each round column carries your
// pick number and gap-after (myPicks/gapsAfter), and long-gap rounds — where
// κ = kappaLongGap and tier cliffs actually cost you — are marked. Picking a
// strategy writes prefs.strategy AND dispatches SET_LEAGUE {strategy} so prep
// and live can never disagree. Priors, not handcuffs: the >overrideDelta
// conflict rule is stated on every card.

import { STRATEGIES, multiplierFor } from '../../../engine/strategy.js';
import { gapsAfter, kappaForRound, myPicks } from '../../../engine/picks.js';
import { fmt1 } from '../../../shared/format.js';
import { setStrategy } from '../../state/prefs';
import type { PrepCtx } from './PrepScreen';

const META: Record<string, [string, string]> = {
  balanced: ['Balanced / BPA', 'Pure tier discipline — the most robust default.'],
  anchor_rb: ['Hero / Anchor RB', 'One elite RB, then pass-catchers; RB again R6–9.'],
  zero_rb_mod: ['Modified Zero RB', 'No RB before R4 — load WR/TE while RBs fly.'],
  robust_rb: ['Robust RB', '2 RB by R3, 3 by R5 — volume early (weakest from a late slot).'],
};

function constraintText(c: any): string {
  return c.type === 'max'
    ? `≤${c.limit} ${c.pos} through R${c.through}`
    : `≥${c.need} ${c.pos} by R${c.by}`;
}

export default function StrategyTab({ ctx }: { ctx: PrepCtx }) {
  const { s, store, prefs, update } = ctx;
  const l = s.league;
  const rounds = Array.from({ length: l.rounds }, (_, i) => i + 1);
  const picks = myPicks(l);
  const gaps = gapsAfter(picks);
  const longGap = rounds.map((r) => kappaForRound(r, l) > 1.0);
  const active = prefs.strategy ?? l.strategy ?? 'balanced';

  const choose = (name: string) => {
    update((p) => setStrategy(p, name));
    store.dispatch({ type: 'SET_LEAGUE', league: { strategy: name } });
  };

  return (
    <div class="mx-auto max-w-4xl px-3 pb-16">
      <p class="py-2 text-sm text-app-dim">
        Slot <b class="text-app-text">{l.slot}</b> of {l.teams} — marked rounds are LONG-GAP waits
        (gap {'>'} {l.teams} picks ⇒ κ = {fmt1(l.kappaLongGap ?? 1.3)}): take the player who won't
        be there. Unmarked rounds you're back soon — take the best player.
      </p>

      {/* The round strip for the current slot — shared header for every table */}
      <div class="overflow-x-auto rounded-lg border border-app-border">
        <table class="num w-full border-collapse text-center text-sm">
          <thead>
            <tr class="bg-app-surface">
              <th class="sticky left-0 bg-app-surface px-2 py-2 text-left text-xs text-app-dim">ROUND</th>
              {rounds.map((r) => (
                <th class={`min-w-9 px-1 py-2 font-bold ${longGap[r - 1] ? 'lv-clock-near' : ''}`}>{r}</th>
              ))}
            </tr>
            <tr>
              <th class="sticky left-0 bg-app-bg px-2 py-1 text-left text-xs text-app-dim">my pick</th>
              {rounds.map((r) => (
                <td class="px-1 py-1 text-xs text-app-dim">{picks[r - 1]}</td>
              ))}
            </tr>
            <tr class="border-b border-app-border">
              <th class="sticky left-0 bg-app-bg px-2 py-1 text-left text-xs text-app-dim">gap after</th>
              {rounds.map((r) => (
                <td class={`px-1 py-1 text-xs ${longGap[r - 1] ? 'font-bold' : 'text-app-dim'}`}>
                  {r - 1 < gaps.length ? `+${gaps[r - 1]}` : '·'}
                </td>
              ))}
            </tr>
          </thead>
        </table>
      </div>

      <div class="mt-3 flex flex-col gap-3">
        {Object.values(STRATEGIES).map((strat: any) => {
          const [label, blurb] = META[strat.name] ?? [strat.name, ''];
          const posRows = Object.keys(strat.multipliers);
          const selected = active === strat.name;
          return (
            <section
              class={`rounded-xl border ${selected ? 'border-accent' : 'border-app-border'} bg-app-surface`}
            >
              <button
                type="button"
                class="flex min-h-14 w-full items-center gap-2 px-3 text-left"
                onClick={() => choose(strat.name)}
              >
                <span class="text-[17px] font-bold">
                  {selected ? '● ' : '○ '}
                  {label}
                </span>
                <span class="min-w-0 flex-1 truncate text-sm text-app-dim">{blurb}</span>
                {selected && (
                  <span class="shrink-0 rounded border border-accent px-2 py-0.5 text-xs font-bold text-accent">
                    ACTIVE
                  </span>
                )}
              </button>

              <div class="overflow-x-auto px-3 pb-2">
                <table class="num w-full border-collapse text-center text-sm">
                  {posRows.length === 0 ? (
                    <tbody>
                      <tr>
                        <td class="py-1 text-left text-sm text-app-dim">
                          No multipliers — every round is pure tier discipline.
                        </td>
                      </tr>
                    </tbody>
                  ) : (
                    <tbody>
                      {posRows.map((pos) => (
                        <tr>
                          <th class="min-w-14 px-2 py-1 text-left text-xs font-bold">m({pos})</th>
                          {rounds.map((r) => {
                            const m = multiplierFor(strat, pos, r);
                            return (
                              <td
                                class={`min-w-9 px-1 py-1 ${
                                  m > 1 ? 'font-bold' : m < 1 ? 'text-app-dim' : 'opacity-40'
                                } ${longGap[r - 1] ? 'underline decoration-dotted underline-offset-4' : ''}`}
                                title={longGap[r - 1] ? `R${r} is a long-gap round at slot ${l.slot}` : undefined}
                              >
                                {m === 1 ? '·' : m.toFixed(2)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  )}
                </table>
              </div>

              <div class="flex flex-wrap items-center gap-1 px-3 pb-3">
                {strat.constraints.length === 0 ? (
                  <span class="text-xs text-app-dim">No hard constraints.</span>
                ) : (
                  strat.constraints.map((c: any) => (
                    <span class="num rounded border border-app-border bg-app-bg px-2 py-1 text-xs font-semibold">
                      {constraintText(c)}
                    </span>
                  ))
                )}
                <span class="ml-auto text-xs text-app-dim">
                  override: conflict {'>'} {strat.overrideDelta} pts is surfaced, never obeyed silently
                </span>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
