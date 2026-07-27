// RecCards.tsx — the SHORTLIST (plan S3 center + Phase 7). Calls the pure
// engine recommend() on every state change (memoized by rev; <5ms), renders
// 5 cards (toggle 3). Each card: rank chip · name 20px/600 · POS-rank·TEAM·
// BYE · tier badge · proj + p90 ceiling · ONE plain-English headline (engine
// provides) · stacked bar decomposing the score (mv/cow/scarcity/penalties)
// · two LARGE numbers (P(tier holds to my next pick), "waiting costs ~X") ·
// explicit TIE grouping · strategy-conflict chip · "changed" dot with
// UI-side hysteresis: keep the previous ordering unless the score delta
// exceeds ε. Tap a card → full term table. Engine throw → Plan B pointer,
// never a blank screen.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { recommend } from '../../../engine/index.js';
import { waitWindowThreats } from '../../../engine/insights.js';
import { abbrevName, fmt1, fmtInt, tierLetter } from '../../../shared/format.js';
import type { Board, DraftState, Store } from '../../state/store';
import { likelyPicks } from '../../state/intent';
import { loadOpponents, seatName } from '../../state/opponents';
import type { OpponentsFile } from '../../state/opponents';
import { loadStrategies } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';

interface Shown {
  rec: any;
  p: any;
  changed: boolean;
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function Bar({ terms }: { terms: any }) {
  const mv = Math.abs(terms.mv);
  const cow = Math.abs(terms.cow);
  const scarcity = Math.abs(terms.scarcity);
  const pen = Math.abs(terms.bye) + Math.abs(terms.stack) + Math.abs(terms.risk);
  const total = mv + cow + scarcity + pen || 1;
  const w = (x: number) => `width:${((100 * x) / total).toFixed(2)}%`;
  return (
    <div class="lv-bar" title={`MV ${fmt1(terms.mv)} · κ·CoW ${fmt1(terms.cow)} · scarcity ${fmt1(terms.scarcity)} · penalties ${fmt1(terms.bye + terms.stack + terms.risk)}`}>
      <span class="lv-bar-mv" style={w(mv)} />
      <span class="lv-bar-cow" style={w(cow)} />
      <span class="lv-bar-scarcity" style={w(scarcity)} />
      <span class="lv-bar-pen" style={w(pen)} />
    </div>
  );
}

function TermTable({ rec }: { rec: any }) {
  const t = rec.terms;
  const rows: [string, number][] = [
    ['Marginal value', t.mv],
    ['κ · cost of waiting', t.cow],
    ['Scarcity', t.scarcity],
    ['Bye penalty', -t.bye],
    ['Stack penalty', -t.stack],
    ['Risk term', -t.risk],
  ];
  return (
    <div class="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-app-bg p-3 text-sm">
      {rows.map(([label, v]) => (
        <>
          <span class="text-app-dim">{label}</span>
          <span class="text-right">{fmt1(v)}</span>
        </>
      ))}
      <span class="border-t border-app-border pt-1 font-bold text-app-text">Score</span>
      <span class="border-t border-app-border pt-1 text-right font-bold">{fmt1(rec.score)}</span>
      <span class="text-app-dim">P(survives to my pick)</span>
      <span class="text-right">{Math.round(rec.survivalToNextPick * 100)}%</span>
      <span class="text-app-dim">P(tier holds ×2)</span>
      <span class="text-right">{Math.round(rec.tierHoldTwoProb * 100)}%</span>
      <span class="text-app-dim">p90 ceiling</span>
      <span class="text-right">{fmtInt(rec.ceiling)}</span>
    </div>
  );
}

export default function RecCards({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const { dispatch } = store;
  const eps = (s.league.epsilonPoints as number) ?? 4;
  const total = s.league.teams * s.league.rounds;
  const [expanded, setExpanded] = useState<number | null>(null);

  // Custom-strategy registry (cached fetch) — recommend() consults it after
  // the built-ins; null until loaded, which resolveStrategy treats as
  // built-ins-only. Opponents feed the wait-window intent line only.
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  const [opp, setOpp] = useState<OpponentsFile | null>(null);
  useEffect(() => {
    loadStrategies().then(setRegistry);
    loadOpponents().then(setOpp);
  }, []);

  // Previous displayed ordering, for hysteresis + the "changed" dot.
  const prevOrder = useRef<number[] | null>(null);

  const view = useMemo(() => {
    if (s.picks.length >= total) return { done: true } as any;
    let result: any;
    try {
      // n-aware entries + cursor: log holes (EDIT_PICK deletes, cursor
      // skips, off-board sync picks) keep every pick attributed to the
      // right team — the dense form misassigned everything after a hole.
      result = recommend(
        board,
        s.league,
        {
          entries: s.picks.filter((p) => p.n <= total).map((p) => ({ n: p.n, idx: p.idx })),
          cursor: s.pickCursor,
          strategy: s.league.strategy,
        },
        { strategies: registry },
      );
    } catch (e: any) {
      return { error: String(e?.message ?? e) } as any;
    }

    let recs: any[] = result.recommendations ?? [];
    const newOrder = recs.map((r) => r.idx);
    const prev = prevOrder.current;
    const changed = new Set<number>();

    if (prev && sameSet(prev, newOrder)) {
      const byIdx = new Map(recs.map((r) => [r.idx, r]));
      const prevTop = byIdx.get(prev[0]);
      if (prevTop && recs[0].score - prevTop.score <= eps) {
        // hysteresis: ordering churn under ε keeps the previous ordering
        recs = prev.map((i) => byIdx.get(i));
      } else {
        newOrder.forEach((idx, i) => {
          if (prev[i] !== idx) changed.add(idx);
        });
      }
    } else if (prev) {
      newOrder.forEach((idx, i) => {
        if (prev[i] !== idx) changed.add(idx);
      });
    }
    prevOrder.current = recs.map((r) => r.idx);

    const shown: Shown[] = recs.map((rec) => ({
      rec,
      p: board.players[rec.idx],
      changed: changed.has(rec.idx),
    }));
    return { shown, diagnostics: result.diagnostics, slack: result.slack, runFlags: result.runFlags };
  }, [s.rev, registry]);

  if (view.done) {
    return <div class="p-6 text-center text-app-dim">Draft complete — nice work.</div>;
  }
  if (view.error) {
    return (
      <div class="flex flex-col gap-3 p-4">
        <p class="font-semibold">Engine unavailable: {view.error}</p>
        <a
          href="#/planb"
          class="lv-clock-near flex min-h-14 items-center justify-center rounded-xl px-4 text-center font-bold"
        >
          Open Plan B — printed tier sheet with drafted players struck
        </a>
      </div>
    );
  }

  const cards: Shown[] = view.shown.slice(0, s.ui.showFive ? 5 : 3);
  const d = view.diagnostics;
  const runs = Object.entries(view.runFlags ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);

  // Wait-window threat strip: the demand pressure specifically between the
  // cursor and my next pick ("8 picks until yours — 5 still need RB").
  // Display-only — the score already carries urgency via VONA. Tap → #/league.
  const threats = useMemo(() => {
    try {
      return waitWindowThreats(
        s.picks.map((p) => ({ n: p.n, idx: p.idx })),
        s.league,
        s.pickCursor,
        board.players,
      );
    } catch {
      return null;
    }
  }, [s.rev]);
  const pressure = threats
    ? ['RB', 'WR', 'TE', 'QB']
        .map((pos) => ({ pos, ...threats.posPressure[pos] }))
        .filter((x) => (x.teamsNeeding?.length ?? 0) > 0)
        .sort((a, b) => b.picksInWindow - a.picksInWindow)
        .slice(0, 3)
    : [];

  // The on-clock team's top-2 likely picks (window[0] — when I'm up, the
  // window starts at the next opponent instead). Lazy (opponents + registry
  // loaded) and pure decoration: any failure leaves the strip as-is.
  const likelyLine = useMemo(() => {
    if (!threats || threats.window.length === 0 || !opp || registry === null) return null;
    const w = threats.window[0];
    try {
      const lp = likelyPicks(
        board, s.league, opp, registry,
        s.picks.map((p) => ({ n: p.n, idx: p.idx })),
        w.slot, w.round, 2,
      );
      if (lp.length === 0) return null;
      const names = lp
        .map((x) => abbrevName(board.players[x.idx]?.name ?? `#${x.idx}`, 14))
        .join(' · ');
      return `${seatName(opp, w.slot, s.league.slot)} likely: ${names}`;
    } catch {
      return null;
    }
  }, [s.rev, opp, registry]);

  return (
    <div class="p-2">
      <div class="flex items-center justify-between px-1 pb-1">
        <h2 class="text-xs font-bold tracking-widest text-app-dim">SHORTLIST</h2>
        <div class="num flex items-center gap-2 text-xs text-app-dim">
          {runs.length > 0 && <span class="lv-clock-near rounded px-1.5 py-0.5 font-bold">RUN: {runs.join(' ')}</span>}
          <span>
            κ{fmt1(d?.kappa)} · slack {view.slack} · {d?.strategy}
          </span>
          <button
            type="button"
            class="min-h-14 min-w-14 rounded-lg border border-app-border bg-app-surface px-2 font-bold"
            onClick={() => dispatch({ type: 'SET_UI', ui: { showFive: !s.ui.showFive } })}
          >
            {s.ui.showFive ? '5' : '3'}
          </button>
        </div>
      </div>

      {threats && threats.window.length > 0 && (
        <a
          href="#/league"
          class="mb-2 block rounded-lg border border-app-border bg-app-bg px-2 py-1.5 text-xs text-app-dim"
          title="League view — all rosters + draft grid"
        >
          <span class="font-bold text-app-text">
            {threats.window.length} pick{threats.window.length === 1 ? '' : 's'} until yours
          </span>
          {pressure.length > 0 && (
            <>
              {' — '}
              {pressure.map((x, i) => (
                <span>
                  {i > 0 && ' · '}
                  <b>{x.teamsNeeding.length}</b> team{x.teamsNeeding.length === 1 ? '' : 's'} need{' '}
                  {x.pos}
                  {x.pos === pressure[0].pos && x.teamsNeeding.length >= 3 ? ' ⚠' : ''}
                </span>
              ))}
            </>
          )}
          {threats.flexOpenInWindow.length > 0 && (
            <span> · {threats.flexOpenInWindow.length} flex open</span>
          )}
          {likelyLine && <span> · {likelyLine}</span>}
        </a>
      )}

      {cards.length === 0 && (
        <p class="p-4 text-app-dim">No candidates — check the pick cursor or roster limits.</p>
      )}

      <div class="flex flex-col gap-2">
        {cards.map((c, i) => {
          const { rec, p } = c;
          const tl = tierLetter(p.tier);
          const holdPct = Math.round(rec.tierHoldProb * 100);
          const waitCost = Math.max(0, rec.evLossIfWait);
          const off = !rec.strategyCompliant && rec.strategyConflictPoints > 20;
          return (
            <button
              type="button"
              class={`lv-tier-${tl.toLowerCase()} w-full rounded-xl border bg-app-surface p-3 text-left ${
                rec.isTie ? 'border-accent' : 'border-app-border'
              }`}
              onClick={() => setExpanded(expanded === rec.idx ? null : rec.idx)}
            >
              <div class="flex items-center gap-2">
                <span class="num flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-app-bg font-bold">
                  {rec.isTie ? '=' : i + 1}
                </span>
                <span class="min-w-0 flex-1 truncate text-[20px] font-semibold leading-tight">
                  {abbrevName(p.name, 22)}
                </span>
                {c.changed && <span class="lv-dot shrink-0" title="ordering moved vs previous pick" />}
                {rec.isTie && (
                  <span class="shrink-0 rounded border border-accent px-1.5 py-0.5 text-xs font-bold text-accent">
                    TIE
                  </span>
                )}
                {off && (
                  <span class="lv-clock-near shrink-0 rounded px-1.5 py-0.5 text-xs font-bold">
                    OFF-PLAN +{fmtInt(rec.strategyConflictPoints)}
                  </span>
                )}
                <span class={`lv-chip-${tl.toLowerCase()} num shrink-0 rounded px-1.5 py-0.5 text-sm font-bold`}>
                  {tl}
                </span>
              </div>

              <div class="num mt-1 flex items-center gap-2 text-sm text-app-dim">
                <span class={`lv-posc lv-posc-${p.pos.toLowerCase()} rounded px-1.5 text-[12px] font-bold`}>
                  {p.pos}
                  {p.posRank}
                </span>
                <span>
                  {p.team} · bye {p.bye ?? '—'}
                </span>
                <span>
                  {fmtInt(p.proj?.halfPpr)} pts · p90 {fmtInt(rec.ceiling)}
                </span>
              </div>

              <p class="mt-1 text-[15px] leading-snug">{rec.headline}</p>

              <div class="mt-2">
                <Bar terms={rec.terms} />
              </div>

              <div class="num mt-2 flex items-end justify-between">
                <div>
                  <div class="text-2xl font-bold leading-none">{holdPct}%</div>
                  <div class="text-xs text-app-dim">tier holds to #{d?.myNextPick}</div>
                </div>
                <div class="text-right">
                  <div class="text-2xl font-bold leading-none">~{fmt1(waitCost)}</div>
                  <div class="text-xs text-app-dim">pts lost by waiting</div>
                </div>
              </div>

              {expanded === rec.idx && <TermTable rec={rec} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
