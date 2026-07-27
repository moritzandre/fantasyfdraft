// Waivers.tsx — #/waivers. Free-agent pool = every merged player's sleeper
// id minus every synced roster (seasonSelectors.faPoolIds), sorted by ROS,
// position-filtered, TOP 60 only — and the weekGain/rosGain lineup math runs
// for exactly those 60 rows (each is a handful of tiny bestLineup calls, so
// 60 × ~15 weeks stays instant; computing the full pool would not).
// weekGain = would this FA change MY optimal lineup THIS week; rosGain =
// same over the rest of the season. Drop suggestion = my lowest-ROS bench
// player outside this week's optimal lineup. Needs a synced roster —
// without one the FA pool is unknowable, so it's a hint, not a demo.

import { useMemo, useState } from 'preact/hooks';
import { rosValue, weekEff, weeklyLineup } from '../../../engine/week.js';
import { seasonSelectors } from '../../state/season';
import type { ResolvedPlayer } from '../../state/seasonMerge';
import { fmt1, resolveIds, signed1 } from './seasonShared';
import type { SeasonScreenProps } from './seasonShared';

const POS_CHIPS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'];
const TOP_N = 60;

export default function Waivers({
  ss,
  merged,
  season,
  slots,
  flexEligible,
}: SeasonScreenProps) {
  const week = seasonSelectors.currentWeek(ss);
  const my = seasonSelectors.myRoster(ss);
  const endWeek = typeof season?.endWeek === 'number' ? season.endWeek : 17;
  const [pos, setPos] = useState('ALL');

  const view = useMemo(() => {
    if (!my) return null;
    const myPlayers = resolveIds(merged, my.players).players;

    const allIds: string[] = [];
    for (const p of merged.all) if (p.sleeper) allIds.push(p.sleeper);
    const faIds = seasonSelectors.faPoolIds(ss, allIds);
    let pool = faIds
      .map((id) => merged.resolve(id))
      .filter((p): p is ResolvedPlayer => p !== null);
    if (pos !== 'ALL') pool = pool.filter((p) => p.pos === pos);
    pool.sort((x, y) => y.ros - x.ros);
    const top = pool.slice(0, TOP_N);

    const baseWeek = weeklyLineup(myPlayers, week, slots, flexEligible);
    const baseRos = rosValue(myPlayers, week, endWeek, slots, flexEligible);
    const rows = top.map((fa) => ({
      fa,
      weekGain:
        weeklyLineup([...myPlayers, fa], week, slots, flexEligible).total - baseWeek.total,
      rosGain:
        rosValue([...myPlayers, fa], week, endWeek, slots, flexEligible) - baseRos,
    }));

    // Drop suggestion: lowest-ROS bench piece not in this week's optimal lineup.
    const optKeys = new Set(baseWeek.starters.map((p: any) => p.key as string));
    let drop: ResolvedPlayer | null = null;
    for (const p of myPlayers) {
      if (optKeys.has(p.key)) continue;
      if (!drop || p.ros < drop.ros) drop = p;
    }
    return { rows, drop, poolSize: pool.length };
  }, [ss.rev, week, pos, merged]);

  if (!my || !view) {
    return (
      <main class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
        <h1 class="text-2xl font-bold">Waivers</h1>
        <p class="text-app-dim">
          The free-agent pool comes from your league's synced rosters — connect on the{' '}
          <a href="#/league" class="underline">League tab</a> and pick your team first.
        </p>
      </main>
    );
  }

  return (
    <main class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
      <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 class="text-2xl font-bold">Waivers — W{week}</h1>
        <p class="num text-sm text-app-dim">
          {view.poolSize} free agent{view.poolSize === 1 ? '' : 's'} · top {TOP_N} by ROS
        </p>
      </header>

      <div class="flex flex-wrap gap-2">
        {POS_CHIPS.map((p) => (
          <button
            key={p}
            type="button"
            class={`min-h-14 rounded-xl border px-4 font-bold ${
              pos === p
                ? p === 'ALL'
                  ? 'border-accent bg-accent/15'
                  : `lv-posc lv-posc-${p.toLowerCase()} border-transparent`
                : 'border-app-border bg-app-surface'
            }`}
            onClick={() => setPos(p)}
          >
            {p}
          </button>
        ))}
      </div>

      {view.drop && (
        <p class="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-sm">
          <span class="font-bold">Drop candidate:</span> {view.drop.short} ({view.drop.pos}) ·
          ROS <span class="num">{fmt1(view.drop.ros)}</span> — your lowest-value bench piece
          outside this week's optimal lineup.
        </p>
      )}

      <ul class="rounded-xl border border-app-border bg-app-surface">
        {view.rows.map(({ fa, weekGain, rosGain }) => (
          <li
            key={fa.key}
            class="flex min-h-[52px] items-center gap-3 border-b border-app-border px-3 py-1 last:border-b-0"
          >
            <div class="min-w-0 flex-1 leading-tight">
              <div class="truncate font-bold">
                {fa.short}{' '}
                <span class={`lv-post lv-post-${fa.pos.toLowerCase()} num rounded px-1 text-[11px] font-bold`}>
                  {fa.pos}
                </span>{' '}
                <span class="font-normal text-app-dim">{fa.team}</span>
                {fa.injury && (
                  <span class="lv-clock-near ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold">
                    {fa.injury}
                  </span>
                )}
                {fa.trend && fa.trend.add > 0 && (
                  <span
                    class={`num ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold ${
                      fa.trend.add >= 500
                        ? 'lv-clock-near'
                        : 'border border-app-border text-app-dim'
                    }`}
                    title={`${fa.trend.add} Sleeper adds in the last 24h`}
                  >
                    ▲{fa.trend.add}
                  </span>
                )}
              </div>
              <div class="num truncate text-[12px] text-app-dim">
                W{week} {fmt1(weekEff(fa.weekly, week))} · ROS {fmt1(fa.ros)}
              </div>
            </div>
            <div class="num shrink-0 text-right text-sm leading-tight">
              <div class={weekGain > 0.05 ? 'lv-good font-bold' : 'text-app-dim'}>
                wk {signed1(weekGain)}
              </div>
              <div class={rosGain > 0.05 ? 'lv-good font-bold' : 'text-app-dim'}>
                ros {signed1(rosGain)}
              </div>
            </div>
          </li>
        ))}
        {view.rows.length === 0 && (
          <li class="px-3 py-4 text-sm text-app-dim">No free agents match this filter.</li>
        )}
      </ul>
    </main>
  );
}
