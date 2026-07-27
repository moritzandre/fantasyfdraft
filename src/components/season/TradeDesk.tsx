// TradeDesk.tsx — #/trade, SANDBOX-FIRST: the one season tool that works
// with NO league synced (the star of the pre-season). Two columns — A is
// you, B is them. Each column's roster source is either a synced league
// roster (chip row) or a SANDBOX built by searching ALL merged players and
// tapping results in. Tapping a rostered player toggles it into the SENDS
// set (accent border); the verdict recomputes on every change via
// engine/trade.js evaluateTrade, framed from A's side, with B's mirror line
// small. marketDelta (FantasyCalc) is advisory-only and hidden when any
// involved player lacks an fc value — never blended into points math.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { evaluateTrade } from '../../../engine/trade.js';
import { findTrades, positionalNeeds, TIER_RANK } from '../../../engine/tradefinder.js';
import { weekEff } from '../../../engine/week.js';
import { seasonSelectors } from '../../state/season';
import type { ResolvedPlayer } from '../../state/seasonMerge';
import { fmt1, resolveIds, signed1, signedInt, teamLabel } from './seasonShared';
import type { SeasonScreenProps } from './seasonShared';

const PLAYOFF_WEEKS = [15, 16, 17];

interface SideState {
  rosterId: number | null; // null = sandbox
  sandbox: string[]; // merged player keys added via search
  sends: string[]; // keys toggled into the deal
}

export default function TradeDesk({
  ss,
  merged,
  season,
  slots,
  flexEligible,
}: SeasonScreenProps) {
  const week = seasonSelectors.currentWeek(ss);
  const endWeek = typeof season?.endWeek === 'number' ? season.endWeek : 17;
  const byKey = useMemo(
    () => new Map(merged.all.map((p) => [p.key, p])),
    [merged],
  );

  const [a, setA] = useState<SideState>(() => ({
    rosterId: ss.myRosterId,
    sandbox: [],
    sends: [],
  }));
  const [b, setB] = useState<SideState>({ rosterId: null, sandbox: [], sends: [] });
  const [qA, setQA] = useState('');
  const [qB, setQB] = useState('');

  // ---- Trade FINDER ------------------------------------------------------
  // Suggestions require a synced league (my roster + at least one partner);
  // the search runs ONLY on the Find button (state, never per-render) — the
  // sync compute is fast (~150–200ms over 11 rosters, engine/tradefinder.js
  // realism gates prune before any lineup math) but still deferred one tick
  // so the "Searching…" row paints. One search always fetches ALL tiers
  // (minTier 'longshot'); the tier chips filter client-side so switching
  // Likely / +Stretch / +Longshot never re-runs the engine.
  type Tier = 'likely' | 'stretch' | 'longshot';
  interface FinderResult {
    partnerId: number;
    give: ResolvedPlayer[];
    get: ResolvedPlayer[];
    my: any;
    their: any;
    tier: Tier;
    why: string[];
  }
  const [mode, setMode] = useState('ALL');
  const [minTier, setMinTier] = useState<Tier>('stretch');
  const [finder, setFinder] = useState<{
    status: 'idle' | 'running' | 'done';
    results: FinderResult[];
    collapsed: boolean;
  }>({ status: 'idle', results: [], collapsed: false });

  const myRosterEntry = seasonSelectors.myRoster(ss);
  const myPlayers = useMemo(
    () => (myRosterEntry ? resolveIds(merged, myRosterEntry.players).players : []),
    [ss.myRosterId, ss.rev, merged],
  );
  const canFind = myPlayers.length > 0 && ss.rosters.length > 1;
  const needs = useMemo(
    () =>
      myPlayers.length > 0
        ? positionalNeeds(myPlayers, { fromWeek: week, endWeek, slots, flexEligible })
        : [],
    [myPlayers, week, endWeek],
  );
  // Target chips are league-shape-derived; K/DST are never trade targets.
  const targetChips = [
    'ALL',
    ...Object.keys(slots).filter((p) => p !== 'FLEX' && p !== 'K' && p !== 'DST'),
  ];

  const pickMode = (m: string) => {
    setMode(m);
    setFinder({ status: 'idle', results: [], collapsed: false });
  };

  const runFinder = () => {
    if (!canFind || finder.status === 'running') return;
    setFinder({ status: 'running', results: [], collapsed: false });
    setTimeout(() => {
      const partners = ss.rosters
        .filter((r) => r.rosterId !== ss.myRosterId)
        .map((r) => ({
          id: r.rosterId,
          label: teamLabel(ss, r.rosterId),
          roster: resolveIds(merged, r.players).players,
        }));
      const results = findTrades(
        myPlayers,
        partners,
        { fromWeek: week, endWeek, playoffWeeks: PLAYOFF_WEEKS, slots, flexEligible },
        { targetPos: mode === 'ALL' ? null : mode, minTier: 'longshot', maxResults: 30 },
      ) as FinderResult[];
      setFinder({ status: 'done', results, collapsed: false });
    }, 30);
  };

  // Engine ranks tier-first (likely > stretch > longshot), so a client-side
  // tier filter preserves the engine's ordering.
  const visibleResults = finder.results.filter(
    (r) => TIER_RANK[r.tier] >= TIER_RANK[minTier],
  );
  const tierChips: { id: Tier; label: string; hint: string }[] = [
    { id: 'likely', label: 'Likely', hint: 'they say yes as-is' },
    { id: 'stretch', label: '+Stretch', hint: 'small premium asks' },
    { id: 'longshot', label: '+Longshot', hint: 'market frowns on these' },
  ];
  const TIER_BADGE: Record<Tier, string> = {
    likely: 'lv-clock-up',
    stretch: 'lv-clock-near',
    longshot: 'lv-clock-far',
  };

  // Tap a suggestion → load it INTO the evaluator (both columns + SENDS
  // sets) for inspection/tweaking; collapse the list so the verdict is
  // right there.
  const loadSuggestion = (r: FinderResult) => {
    setA({ rosterId: ss.myRosterId, sandbox: [], sends: r.give.map((p) => p.key) });
    setB({ rosterId: r.partnerId, sandbox: [], sends: r.get.map((p) => p.key) });
    setFinder((f) => ({ ...f, collapsed: true }));
  };

  // A first successful sync after mount adopts my roster as side A — but
  // only while A is still the untouched default sandbox.
  useEffect(() => {
    if (
      ss.myRosterId !== null &&
      a.rosterId === null &&
      a.sandbox.length === 0 &&
      a.sends.length === 0
    ) {
      setA({ rosterId: ss.myRosterId, sandbox: [], sends: [] });
    }
  }, [ss.myRosterId]);

  const rosterFor = (side: SideState): ResolvedPlayer[] => {
    if (side.rosterId !== null) {
      const r = ss.rosters.find((x) => x.rosterId === side.rosterId);
      return r ? resolveIds(merged, r.players).players : [];
    }
    return side.sandbox
      .map((k) => byKey.get(k))
      .filter((p): p is ResolvedPlayer => p !== undefined);
  };

  const playersA = useMemo(() => rosterFor(a), [a.rosterId, a.sandbox, ss.rev, merged]);
  const playersB = useMemo(() => rosterFor(b), [b.rosterId, b.sandbox, ss.rev, merged]);

  const verdict = useMemo(() => {
    const sendsA = playersA.filter((p) => a.sends.includes(p.key));
    const sendsB = playersB.filter((p) => b.sends.includes(p.key));
    if (sendsA.length === 0 && sendsB.length === 0) return null;
    // sends are references INTO the roster arrays — evaluateTrade removes
    // by identity, so filtering the same array is load-bearing here.
    const res = evaluateTrade(
      { roster: playersA, sends: sendsA },
      { roster: playersB, sends: sendsB },
      { fromWeek: week, endWeek, playoffWeeks: PLAYOFF_WEEKS, slots, flexEligible },
    );
    return { res, sendsA, sendsB };
  }, [playersA, playersB, a.sends, b.sends, week, endWeek]);

  const sideName = (side: SideState, fallback: string): string =>
    side.rosterId !== null ? teamLabel(ss, side.rosterId) : fallback;

  const renderColumn = (
    label: string,
    side: SideState,
    setSide: (s: SideState) => void,
    players: ResolvedPlayer[],
    q: string,
    setQ: (v: string) => void,
  ) => {
    const toggleSend = (key: string) =>
      setSide({
        ...side,
        sends: side.sends.includes(key)
          ? side.sends.filter((k) => k !== key)
          : [...side.sends, key],
      });
    const removeSandbox = (key: string) =>
      setSide({
        ...side,
        sandbox: side.sandbox.filter((k) => k !== key),
        sends: side.sends.filter((k) => k !== key),
      });
    const addSandbox = (key: string) => {
      if (!side.sandbox.includes(key)) {
        setSide({ ...side, sandbox: [...side.sandbox, key] });
      }
      setQ('');
    };

    const query = q.trim().toLowerCase();
    const inRoster = new Set(players.map((p) => p.key));
    const results =
      side.rosterId === null && query.length >= 2
        ? merged.all
            .filter(
              (p) =>
                !inRoster.has(p.key) &&
                (p.name.toLowerCase().includes(query) ||
                  p.short.toLowerCase().includes(query) ||
                  p.team.toLowerCase() === query),
            )
            .sort((x, y) => y.ros - x.ros)
            .slice(0, 8)
        : [];

    return (
      <section class="flex min-w-0 flex-1 flex-col gap-2">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-app-dim">{label}</h2>

        {/* Source picker: sandbox + every synced roster */}
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class={`min-h-14 rounded-xl border px-4 font-bold ${
              side.rosterId === null
                ? 'border-accent bg-accent/15'
                : 'border-app-border bg-app-surface'
            }`}
            onClick={() => setSide({ ...side, rosterId: null, sends: [] })}
          >
            Sandbox
          </button>
          {ss.rosters.map((r) => (
            <button
              key={r.rosterId}
              type="button"
              class={`min-h-14 rounded-xl border px-4 font-bold ${
                side.rosterId === r.rosterId
                  ? 'border-accent bg-accent/15'
                  : 'border-app-border bg-app-surface'
              }`}
              onClick={() => setSide({ ...side, rosterId: r.rosterId, sends: [] })}
            >
              {teamLabel(ss, r.rosterId)}
              {r.rosterId === ss.myRosterId ? ' (me)' : ''}
            </button>
          ))}
        </div>

        {/* Sandbox search */}
        {side.rosterId === null && (
          <div class="flex flex-col gap-1">
            <input
              type="search"
              value={q}
              placeholder="Add player — search name"
              aria-label={`Search players for ${label}`}
              onInput={(e: any) => setQ(e.currentTarget.value)}
              class="min-h-14 w-full rounded-xl border border-app-border bg-app-bg px-4 text-[17px] outline-none focus:border-accent"
            />
            {results.length > 0 && (
              <ul class="rounded-xl border border-app-border bg-app-surface">
                {results.map((p) => (
                  <li key={p.key}>
                    <button
                      type="button"
                      class="flex min-h-[52px] w-full items-center gap-3 border-b border-app-border px-3 text-left last:border-b-0"
                      onClick={() => addSandbox(p.key)}
                    >
                      <span class="min-w-0 flex-1 truncate">
                        <span class="font-bold">{p.short}</span>{' '}
                        <span class="text-app-dim">
                          {p.pos} · {p.team}
                        </span>
                      </span>
                      <span class="num shrink-0 text-sm text-app-dim">ROS {fmt1(p.ros)}</span>
                      <span class="shrink-0 font-bold text-accent">＋</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Roster — tap toggles into the deal */}
        <ul class="rounded-xl border border-app-border bg-app-surface">
          {players.map((p) => {
            const sending = side.sends.includes(p.key);
            return (
              <li key={p.key} class="flex items-stretch border-b border-app-border last:border-b-0">
                <button
                  type="button"
                  class={`flex min-h-[52px] min-w-0 flex-1 items-center gap-3 px-3 text-left ${
                    sending ? 'border-l-4 border-accent bg-accent/15' : 'border-l-4 border-transparent'
                  }`}
                  onClick={() => toggleSend(p.key)}
                  title={sending ? 'In the deal — tap to keep' : 'Tap to add to the deal'}
                >
                  <div class="min-w-0 flex-1 leading-tight">
                    <div class="truncate font-bold">
                      {p.short}{' '}
                      <span class="font-normal text-app-dim">
                        {p.pos} · {p.team}
                      </span>
                      {p.injury && (
                        <span class="lv-clock-near ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold">
                          {p.injury}
                        </span>
                      )}
                    </div>
                    <div class="num truncate text-[12px] text-app-dim">
                      W{week} {fmt1(weekEff(p.weekly, week))} · ROS {fmt1(p.ros)}
                      {p.bye !== null && ` · bye ${p.bye}`}
                    </div>
                  </div>
                  {sending && (
                    <span class="shrink-0 text-[11px] font-bold text-accent">SENDS</span>
                  )}
                </button>
                {side.rosterId === null && (
                  <button
                    type="button"
                    class="w-14 shrink-0 border-l border-app-border text-app-dim"
                    onClick={() => removeSandbox(p.key)}
                    aria-label={`Remove ${p.short} from sandbox`}
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
          {players.length === 0 && (
            <li class="px-3 py-4 text-sm text-app-dim">
              {side.rosterId === null
                ? 'Empty sandbox — search above to build a roster.'
                : 'No players on this roster yet — sync on the League tab.'}
            </li>
          )}
        </ul>
      </section>
    );
  };

  const ra = verdict?.res.a;
  const rb = verdict?.res.b;
  const bName = sideName(b, 'their sandbox');

  return (
    <main class="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6">
      <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 class="text-2xl font-bold">Trade Desk</h1>
        <p class="text-sm text-app-dim">
          sandbox-first — works with no league connected · horizon W{week}–{endWeek}
        </p>
      </header>

      {/* Trade FINDER — suggestions over the synced league rosters */}
      <section class="flex flex-col gap-3 rounded-xl border border-app-border bg-app-surface p-4">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 class="text-lg font-bold">Trade finder</h2>
          {!canFind ? (
            <span class="text-sm text-app-dim">
              needs a synced league — connect on the League tab and pick your roster
            </span>
          ) : needs.length > 0 ? (
            <div class="flex flex-wrap gap-2">
              {needs.map((n) => (
                <button
                  key={n.pos}
                  type="button"
                  class="lv-clock-near min-h-14 rounded-full px-4 text-[13px] font-bold"
                  onClick={() => pickMode(n.pos)}
                  title={`Tap to hunt ${n.pos} trades`}
                >
                  {n.severity >= 2 ? `need ${n.pos} starter` : `thin at ${n.pos}`}
                </button>
              ))}
            </div>
          ) : (
            <span class="text-sm text-app-dim">no glaring roster holes — scan ALL for value</span>
          )}
        </div>

        {canFind && (
          <div class="flex flex-wrap items-center gap-2">
            {targetChips.map((m) => (
              <button
                key={m}
                type="button"
                class={`min-h-14 rounded-xl border px-4 font-bold ${
                  mode === m ? 'border-accent bg-accent/15' : 'border-app-border bg-app-bg'
                }`}
                onClick={() => pickMode(m)}
              >
                {m}
              </button>
            ))}
            <button
              type="button"
              class="min-h-14 flex-1 whitespace-nowrap rounded-xl border border-accent bg-accent/15 px-5 font-bold"
              onClick={runFinder}
              disabled={finder.status === 'running'}
            >
              {finder.status === 'running'
                ? 'Searching…'
                : mode === 'ALL'
                  ? 'Find value trades'
                  : `Find ${mode} trades`}
            </button>
          </div>
        )}

        {finder.status === 'running' && (
          <p class="text-sm text-app-dim">
            Scanning {ss.rosters.length - 1} rosters for{' '}
            {mode === 'ALL' ? 'value pickups' : `${mode} targets`}…
          </p>
        )}

        {finder.status === 'done' && finder.results.length === 0 && (
          <p class="text-sm text-app-dim">
            No plausible {mode === 'ALL' ? '' : `${mode} `}trades clear the bar right now —
            try another position, or check back after rosters shake up.
          </p>
        )}

        {finder.status === 'done' && finder.results.length > 0 && (
          <div class="flex flex-wrap items-center gap-2">
            {tierChips.map((t) => (
              <button
                key={t.id}
                type="button"
                class={`min-h-14 rounded-xl border px-4 font-bold ${
                  minTier === t.id ? 'border-accent bg-accent/15' : 'border-app-border bg-app-bg'
                }`}
                onClick={() => setMinTier(t.id)}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {finder.status === 'done' && finder.results.length > 0 && visibleResults.length === 0 && (
          <p class="text-sm text-app-dim">
            Nothing at this tier — tap {minTier === 'likely' ? '+Stretch or ' : ''}+Longshot to
            widen the net.
          </p>
        )}

        {finder.status === 'done' && visibleResults.length > 0 && finder.collapsed && (
          <button
            type="button"
            class="min-h-14 rounded-xl border border-app-border bg-app-bg px-4 text-left font-bold"
            onClick={() => setFinder((f) => ({ ...f, collapsed: false }))}
          >
            Trade loaded below ↓ — show {visibleResults.length} suggestion
            {visibleResults.length === 1 ? '' : 's'} again
          </button>
        )}

        {finder.status === 'done' && visibleResults.length > 0 && !finder.collapsed && (
          <ul class="rounded-xl border border-app-border">
            {visibleResults.map((r, i) => (
              <li key={i}>
                <button
                  type="button"
                  class="flex min-h-[52px] w-full flex-col justify-center gap-0.5 border-b border-app-border px-3 py-2 text-left last:border-b-0"
                  onClick={() => loadSuggestion(r)}
                  title="Tap to load into the evaluator below"
                >
                  <span class="flex min-w-0 items-center gap-2">
                    <span
                      class={`${TIER_BADGE[r.tier]} shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold uppercase`}
                    >
                      {r.tier}
                    </span>
                    <span class="min-w-0 truncate">
                      <span class="font-bold">Give {r.give.map((p) => p.short).join(' + ')}</span>
                      <span class="text-app-dim"> ⇄ </span>
                      <span class="font-bold">Get {r.get.map((p) => p.short).join(' + ')}</span>
                    </span>
                  </span>
                  <span class="num truncate text-[13px] text-app-dim">
                    {teamLabel(ss, r.partnerId)} · you {signed1(r.my.rosDelta)} ROS · them{' '}
                    {signed1(r.their.rosDelta)}
                    {r.why.length > 0 && ` · ${r.why.join(' · ')}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Verdict — recomputes live on every change */}
      {ra && rb ? (
        <section class="rounded-xl border border-accent bg-app-surface p-4">
          <div class="text-xl font-bold">
            {Math.abs(ra.rosDelta) < 0.05
              ? 'Dead even rest-of-season'
              : ra.rosDelta > 0
                ? `You gain ${fmt1(ra.rosDelta)} pts rest-of-season`
                : `You lose ${fmt1(-ra.rosDelta)} pts rest-of-season`}
          </div>
          <div class="num mt-2 flex flex-wrap gap-2 text-sm">
            <span class="rounded border border-app-border px-2 py-1">
              this week {signed1(ra.weekDelta)}
            </span>
            <span class="rounded border border-app-border px-2 py-1">
              playoffs W15–17 {signed1(ra.playoffDelta)}
            </span>
            {Object.entries(ra.depthDelta as Record<string, number>)
              .filter(([, d]) => d !== 0)
              .map(([posKey, d]) => (
                <span key={posKey} class="rounded border border-app-border px-2 py-1">
                  {posKey} depth {d > 0 ? `+${d}` : d}
                </span>
              ))}
          </div>
          {(ra.byeExposure as number[]).map((w) => (
            <div key={w} class="lv-clock-near mt-2 rounded px-3 py-2 text-sm font-bold">
              ⚠ adds a week-{w} bye crunch
            </div>
          ))}
          {ra.marketDelta !== null && (
            <div class="num mt-2 text-sm text-app-dim">
              market (FantasyCalc): advisory only · {signedInt(ra.marketDelta)}
            </div>
          )}
          <div class="num mt-2 border-t border-app-border pt-2 text-sm text-app-dim">
            {bName}: {signed1(rb.rosDelta)} ROS · {signed1(rb.weekDelta)} this week
          </div>
        </section>
      ) : (
        <p class="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-sm text-app-dim">
          Tap players on either side to mark what each team sends — the verdict updates live.
          No league? Build both rosters in the sandboxes below.
        </p>
      )}

      <div class="flex flex-col gap-6 md:flex-row">
        {renderColumn('A — you', a, setA, playersA, qA, setQA)}
        {renderColumn(`B — ${b.rosterId !== null ? bName : 'them'}`, b, setB, playersB, qB, setQB)}
      </div>
    </main>
  );
}
