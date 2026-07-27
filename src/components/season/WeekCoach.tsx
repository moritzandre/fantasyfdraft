// WeekCoach.tsx — #/coach (the season page's default route). "Week {n}" +
// my matchup projections, then startSit (engine/week.js) over my synced
// roster: optimal-vs-current headline and the swap list, each row with week
// points, the p10–p90 band (board σ_proj only — extras outside the board
// have no σ, their band is skipped), opponent and injury tag.
//
// Pre-sync there is deliberately NO sandbox demo here (spec decision): the
// hint points at the League tab and the Trade Desk — the Trade Desk IS the
// pre-season sandbox. All derived data memoizes on [store rev, week].

import { useMemo } from 'preact/hooks';
import { startSit, weekBand, weekEff, weeklyLineup } from '../../../engine/week.js';
import { seasonSelectors } from '../../state/season';
import type { ResolvedPlayer } from '../../state/seasonMerge';
import {
  fmt1,
  oppFor,
  resolveIds,
  sigmaFor,
  signed1,
  teamLabel,
} from './seasonShared';
import type { SeasonScreenProps } from './seasonShared';

export default function WeekCoach({
  ss,
  merged,
  board,
  season,
  slots,
  flexEligible,
}: SeasonScreenProps) {
  const week = seasonSelectors.currentWeek(ss);
  const my = seasonSelectors.myRoster(ss);

  const view = useMemo(() => {
    if (!my) return null;
    const { players, missing } = resolveIds(merged, my.players);
    const starterKeys = my.starters
      .filter((id) => id !== '0') // Sleeper pads empty slots with '0'
      .map((id) => merged.resolve(id)?.key)
      .filter((k): k is string => typeof k === 'string');
    const advice = startSit(players, starterKeys, week, slots, flexEligible, (p: any) => p.key);
    const optimal = weeklyLineup(players, week, slots, flexEligible);
    const optimalKeys = new Set(optimal.starters.map((p: any) => p.key as string));
    const starterSet = new Set(starterKeys);

    let matchup: { myProj: number; opp: { name: string; proj: number } | null } | null = null;
    const mm = seasonSelectors.myMatchup(ss);
    if (mm) {
      let opp: { name: string; proj: number } | null = null;
      if (mm.opp) {
        const oppRoster = ss.rosters.find((r) => r.rosterId === mm.opp!.rosterId);
        if (oppRoster) {
          const oppPlayers = resolveIds(merged, oppRoster.players).players;
          opp = {
            name: teamLabel(ss, oppRoster.rosterId),
            proj: weeklyLineup(oppPlayers, week, slots, flexEligible).total,
          };
        }
      }
      matchup = { myProj: optimal.total, opp };
    }
    return { players, missing, advice, optimalKeys, starterSet, matchup };
  }, [ss.rev, week, merged]);

  if (!my || !view) {
    return (
      <main class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
        <h1 class="text-2xl font-bold">Week {week}</h1>
        <p class="text-app-dim">
          No team selected yet — connect your league on the{' '}
          <a href="#/league" class="underline">League tab</a> and pick which roster is you,
          or explore trades in the sandbox{' '}
          <a href="#/trade" class="underline">Trade Desk</a> (no league needed).
        </p>
      </main>
    );
  }

  const { players, missing, advice, optimalKeys, starterSet, matchup } = view;
  const bandTxt = (p: ResolvedPlayer): string => {
    const sig = sigmaFor(board, p);
    if (sig === null) return '';
    const b = weekBand(weekEff(p.weekly, week), sig);
    return `${fmt1(b.floor)}–${fmt1(b.ceiling)}`;
  };

  const row = (p: ResolvedPlayer, tag: string | null) => {
    const pts = weekEff(p.weekly, week);
    const band = bandTxt(p);
    const opp = oppFor(season, p.team, week);
    const onBye = p.bye === week;
    return (
      <li
        key={p.key}
        class={`flex min-h-[52px] items-center gap-3 border-b border-app-border px-3 py-1 ${
          onBye ? 'lv-bye-hatch' : ''
        }`}
      >
        <span class="num w-12 shrink-0 text-right text-lg font-bold">{fmt1(pts)}</span>
        <div class="min-w-0 flex-1 leading-tight">
          <div class="truncate font-bold">
            {p.short}{' '}
            <span class="font-normal text-app-dim">
              {p.pos} · {p.team}
            </span>
            {onBye && (
              <span class="ml-2 rounded border border-app-border px-1.5 py-0.5 text-[11px] font-bold">
                BYE
              </span>
            )}
            {p.injury && (
              <span class="lv-clock-near ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold">
                {p.injury}
              </span>
            )}
          </div>
          <div class="num truncate text-[12px] text-app-dim">
            {band && `p10–p90 ${band}`}
            {opp && `${band ? ' · ' : ''}vs ${opp}`}
          </div>
        </div>
        {tag && <span class="shrink-0 text-[11px] font-bold text-accent">{tag}</span>}
      </li>
    );
  };

  const starters = players.filter((p) => starterSet.has(p.key));
  const bench = players.filter((p) => !starterSet.has(p.key));

  return (
    <main class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6">
      <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 class="text-2xl font-bold">Week {week}</h1>
        {matchup && (
          <p class="num text-app-dim">
            {matchup.opp
              ? `vs ${matchup.opp.name} — proj ${fmt1(matchup.myProj)} : ${fmt1(matchup.opp.proj)}`
              : `proj ${fmt1(matchup.myProj)} · no opponent this week`}
          </p>
        )}
      </header>

      {/* Optimal vs current headline */}
      <section class="rounded-xl border border-app-border bg-app-surface p-4">
        <div class="num text-sm text-app-dim">
          optimal {fmt1(advice.optimalTotal)} · current {fmt1(advice.currentTotal)}
        </div>
        <div class={`text-2xl font-bold ${advice.delta > 0.05 ? 'text-accent' : ''}`}>
          {advice.delta > 0.05
            ? `${signed1(advice.delta)} pts sitting on your bench`
            : 'Lineup is optimal ✓'}
        </div>
      </section>

      {/* Swap list */}
      {advice.swaps.length > 0 && (
        <section class="flex flex-col gap-2">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-app-dim">Start / sit</h2>
          <ul class="flex flex-col gap-2">
            {advice.swaps.map((sw: any) => {
              const inn = sw.in as ResolvedPlayer;
              const out = sw.out as ResolvedPlayer | null;
              const innOpp = oppFor(season, inn.team, week);
              const outOpp = out ? oppFor(season, out.team, week) : null;
              return (
                <li
                  key={inn.key}
                  class="rounded-xl border border-app-border bg-app-surface px-4 py-3"
                >
                  <div class="font-bold">
                    Start {inn.short} over {out ? out.short : 'empty slot'}{' '}
                    <span class="num text-accent">{signed1(sw.gain)}</span>{' '}
                    <span class="font-normal text-app-dim">· {sw.slot}</span>
                  </div>
                  <div class="num mt-0.5 text-[13px] text-app-dim">
                    IN {inn.short}: {fmt1(weekEff(inn.weekly, week))}
                    {bandTxt(inn) && ` (${bandTxt(inn)})`}
                    {innOpp && ` vs ${innOpp}`}
                    {inn.injury && ` · ${inn.injury}`}
                    {out &&
                      ` — OUT ${out.short}: ${fmt1(weekEff(out.weekly, week))}` +
                        (bandTxt(out) ? ` (${bandTxt(out)})` : '') +
                        (outOpp ? ` vs ${outOpp}` : '') +
                        (out.injury ? ` · ${out.injury}` : '')}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Roster */}
      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-app-dim">
          Current starters
        </h2>
        <ul class="rounded-xl border border-app-border bg-app-surface">
          {starters.length > 0 ? (
            starters.map((p) => row(p, optimalKeys.has(p.key) ? null : 'SIT'))
          ) : (
            <li class="px-3 py-4 text-sm text-app-dim">
              No starters set on Sleeper yet — the optimal lineup above still works.
            </li>
          )}
        </ul>
        <h2 class="mt-2 text-sm font-semibold uppercase tracking-wide text-app-dim">Bench</h2>
        <ul class="rounded-xl border border-app-border bg-app-surface">
          {bench.map((p) => row(p, optimalKeys.has(p.key) ? 'START' : null))}
          {bench.length === 0 && (
            <li class="px-3 py-4 text-sm text-app-dim">Empty bench.</li>
          )}
        </ul>
      </section>

      {missing.length > 0 && (
        <section class="flex flex-wrap items-center gap-2">
          <span class="text-sm text-app-dim">Not in board/season data:</span>
          {missing.map((id) => (
            <span
              key={id}
              class="num rounded border border-app-border px-2 py-1 text-[12px] text-app-dim"
            >
              {id}
            </span>
          ))}
        </section>
      )}
    </main>
  );
}
