// PlanBSheet.tsx — #/planb: a clean, PDF-like, colorful reference in the app
// color system — two switchable views: position TIERS and per-STRATEGY draft
// lists. Engine-free fallback: everything here is pure data formatting (no
// recommend() call), so it stays useful even if the engine throws mid-draft.
// Drafted players strike through live; the 🖨 button reveals the collapsed
// PdfBuilder (the print kit lives on in the /sheets routes — the old embedded
// print BigBoard is gone from this screen).
//
// LIVE PREFS: this screen re-applies the prep layer over the RAW board —
// applyPrefs is PURE over rawBoard, and a fresh mount is a fresh memo, so
// tags / tier moves / ADP / projection overrides made in Prep show up the
// moment you navigate back here. This does not touch the boot invariant
// ("prefs apply at next launch" is about the STORE's board), and it must
// NEVER re-apply over the boot-applied board: double-applying would compound
// projection deltas and σ inflation.

import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  gapsAfter,
  kappaForRound,
  myPicks,
  roundForPick,
  slotForPick,
} from '../../../engine/picks.js';
import { multiplierFor, resolveStrategy } from '../../../engine/strategy.js';
import { abbrevName, fmtAdp, fmtInt, tierLetter } from '../../../shared/format.js';
import { applyPrefs, loadPrefs } from '../../state/prefs';
import { loadStrategies, strategyList } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';
import type { Board, DraftState } from '../../state/store';
import PdfBuilder from './PdfBuilder';

const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
const MULT_POS = ['QB', 'RB', 'WR', 'TE']; // K/DST bypass strategy multipliers
const LIST_SIZE = 120;

/** Prep-tag icons: shape + hue, never color-only (title carries the note). */
const TAG_META: Record<string, { ch: string; cls: string }> = {
  target: { ch: '★', cls: 'text-accent' },
  value: { ch: '▲', cls: 'lv-good' },
  avoid: { ch: '▼', cls: 'lv-warn-t' },
  never: { ch: '✕', cls: 'text-app-dim' },
};

const tagOf = (p: any): string | null => {
  if (p.tag && TAG_META[p.tag]) return p.tag;
  if (Array.isArray(p.flags)) return p.flags.find((f: any) => TAG_META[String(f)]) ?? null;
  return null;
};

/** Tier wash/chip class letter — the tokens.css ramp defines A–F only, so
    deeper tiers saturate at the F band; the chip still shows the TRUE letter. */
const washOf = (tier: number): string =>
  tierLetter(Math.min(Math.max(1, Math.trunc(tier || 1)), 6)).toLowerCase();

const seg = (on: boolean) =>
  `min-h-14 flex-1 rounded-lg border text-[17px] font-bold ${
    on ? 'lv-seg-on' : 'border-app-border bg-app-bg text-app-text'
  }`;

export default function PlanBSheet({ s, rawBoard }: { s: DraftState; rawBoard: Board }) {
  const [mode, setMode] = useState<'tiers' | 'strats'>('tiers');
  const [posFilter, setPosFilter] = useState('ALL');
  const [showPrint, setShowPrint] = useState(false);
  const [stratName, setStratName] = useState(s.league.strategy ?? 'balanced');
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  useEffect(() => {
    loadStrategies().then(setRegistry);
  }, []);

  // Live prefs — deliberately over rawBoard (see header comment); s.rev keeps
  // the derivation in step during the draft without any persistence here.
  const applied = useMemo(() => applyPrefs(rawBoard, loadPrefs()), [rawBoard, s.rev]);

  const byIdx = useMemo(
    () => new Map<number, any>(applied.players.map((p: any) => [p.idx, p])),
    [applied],
  );
  const takenBy = useMemo(() => {
    const m = new Map<number, number>(); // idx → overall pick n
    for (const e of s.picks) m.set(e.idx, e.n);
    return m;
  }, [s.rev]);

  const lg = s.league;
  const snake = lg.snake !== false;
  const totalPicks = lg.teams * lg.rounds;
  const mine = (n: number) => slotForPick(n, lg.teams, snake) === lg.slot;

  const myCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of s.picks) {
      if (!mine(e.n)) continue;
      const pos = byIdx.get(e.idx)?.pos;
      if (pos) c[pos] = (c[pos] ?? 0) + 1;
    }
    return c;
  }, [s.rev, byIdx]);

  // ── Shared row furniture ─────────────────────────────────────────────────

  const tagIcon = (p: any) => {
    const t = tagOf(p);
    if (!t) return null;
    return (
      <span class={`ml-1 shrink-0 text-[13px] ${TAG_META[t].cls}`} title={p.tagNote || t}>
        {TAG_META[t].ch}
      </span>
    );
  };

  const youChip = (
    <span class="num shrink-0 rounded bg-accent px-1.5 text-[11px] font-bold text-app-bg">YOU</span>
  );

  // ── TIERS mode ───────────────────────────────────────────────────────────

  const tierGroups = useMemo(() => {
    const tiers: any[] = Array.isArray((applied as any).tiers) ? (applied as any).tiers : [];
    return POS.map((pos) => ({
      pos,
      groups: tiers.filter((g) => g.pos === pos).sort((a, b) => a.tier - b.tier),
    })).filter((e) => e.groups.length > 0);
  }, [applied]);

  const tierRow = (p: any, wash: string) => {
    const pickN = takenBy.get(p.idx);
    const gone = pickN !== undefined;
    return (
      <div
        class={`lv-row lv-tier-${wash} flex items-center gap-1.5 border-b border-app-border px-2 last:border-b-0 ${
          gone ? 'lv-struck' : ''
        }`}
      >
        <span
          class={`lv-posc lv-posc-${String(p.pos).toLowerCase()} num w-11 shrink-0 rounded text-center text-[12px] font-bold`}
        >
          {p.pos}
          {p.posRank}
        </span>
        <span class="min-w-0 flex-1 truncate text-[16px] font-semibold">
          {abbrevName(p.name, 20)}
          {tagIcon(p)}
        </span>
        {gone && mine(pickN!) && youChip}
        <span class="num w-9 shrink-0 text-center text-xs text-app-dim">{p.team}</span>
        <span class="num w-6 shrink-0 text-center text-xs text-app-dim">{p.bye ?? '—'}</span>
        <span class="num w-10 shrink-0 text-right text-sm">{fmtInt(p.proj?.halfPpr)}</span>
        <span class="num w-9 shrink-0 text-right text-xs text-app-dim">{fmtAdp(p.adp?.mu)}</span>
      </div>
    );
  };

  const tierCard = (pos: string, g: any) => {
    const wash = washOf(g.tier);
    return (
      <section class="mb-3 break-inside-avoid overflow-hidden rounded-xl border border-app-border bg-app-surface">
        <header class="flex min-h-11 flex-wrap items-center gap-2 border-b border-app-border px-2 py-1.5">
          <span class={`lv-chip-${wash} num w-6 shrink-0 rounded text-center text-[15px] font-bold`}>
            {g.letter}
          </span>
          <span class={`lv-posc lv-posc-${pos.toLowerCase()} num shrink-0 rounded px-1.5 text-[12px] font-bold`}>
            {pos}
          </span>
          <span class="text-[15px] font-bold">Tier {g.tier}</span>
          <span class="num text-xs text-app-dim">· {g.members.length}</span>
          <span class="ml-auto" />
          {g.edited && (
            <span
              class="shrink-0 rounded bg-app-border px-1.5 text-[11px] font-semibold text-app-dim"
              title="Your prep tier moves changed this group — boundary stats cleared, not faked"
            >
              edited
            </span>
          )}
          {Number.isFinite(g.cliffPoints) && (
            <span class="lv-warn-t num shrink-0 text-xs font-semibold">
              cliff {fmtInt(g.cliffPoints)} pts
            </span>
          )}
        </header>
        {g.members.map((idx: number) => {
          const p = byIdx.get(idx);
          return p ? tierRow(p, wash) : null;
        })}
      </section>
    );
  };

  // ── STRATEGIES mode ──────────────────────────────────────────────────────

  const metas = strategyList(registry);
  const strat: any = useMemo(() => {
    try {
      return resolveStrategy(stratName, registry);
    } catch {
      return resolveStrategy('balanced', null); // registry not loaded yet
    }
  }, [stratName, registry]);

  const planCfg = {
    teams: lg.teams,
    slot: lg.slot,
    rounds: lg.rounds,
    snake,
    kappaLongGap: (lg.kappaLongGap as number) ?? 1.3,
  };
  const plan = useMemo(() => {
    const picks = myPicks(planCfg);
    const gaps = gapsAfter(picks);
    return picks.map((pick, i) => ({
      r: i + 1,
      pick,
      gap: i < gaps.length ? gaps[i] : null,
      long: kappaForRound(i + 1, planCfg) > 1,
    }));
  }, [lg.teams, lg.slot, lg.rounds, snake, lg.kappaLongGap]);

  /** Per-round annotations: multipliers in force, max-blocks vs MY current
      counts, min-constraint deadlines. */
  const cellMarks = (r: number) => {
    const marks: { txt: string; cls: string }[] = [];
    for (const pos of MULT_POS) {
      const m = multiplierFor(strat, pos, r);
      if (m !== 1) marks.push({ txt: `${pos}×${m}`, cls: m > 1 ? 'lv-good' : 'text-app-dim' });
    }
    for (const c of strat.constraints ?? []) {
      if (c.type === 'max' && r <= c.through && (myCounts[c.pos] ?? 0) >= c.limit) {
        marks.push({ txt: `${c.pos}⊘`, cls: 'text-app-dim' });
      }
      if (c.type === 'min' && c.by === r) {
        marks.push({ txt: `${c.pos}≥${c.need}`, cls: 'lv-warn-t' });
      }
    }
    return marks;
  };

  const multChips: string[] = Object.entries(strat.multipliers ?? {}).flatMap(
    ([pos, rules]: [string, any]) =>
      (rules as any[]).map(
        (r) => `${r.from === r.to ? `R${r.from}` : `R${r.from}–${r.to}`} ${pos} ×${r.m}`,
      ),
  );
  const conChips: string[] = (strat.constraints ?? []).map((c: any) =>
    c.type === 'max' ? `≤${c.limit} ${c.pos} through R${c.through}` : `≥${c.need} ${c.pos} by R${c.by}`,
  );

  // The LIST: every player scored through the strategy lens, top ~120 kept.
  // Paper-sheet semantics: the ranking is over the FULL board, and drafted
  // players stay listed struck-through — like crossing names off a print-out.
  const lensList = useMemo(() => {
    const rows = applied.players
      .map((p: any) => {
        const target = Number.isFinite(p.adp?.mu) ? Math.round(p.adp.mu) : p.overallRank;
        const likelyRound = roundForPick(Math.min(Math.max(1, target), totalPicks), lg.teams);
        const m = multiplierFor(strat, p.pos, likelyRound);
        const base = Number.isFinite(p.eff) ? p.eff : (p.proj?.halfPpr ?? 0);
        return { p, likelyRound, m, lens: base * m, rank: 0 };
      })
      .sort((a, b) => b.lens - a.lens)
      .slice(0, LIST_SIZE);
    rows.forEach((r, i) => {
      r.rank = i + 1;
    });
    return rows;
  }, [applied, strat, lg.teams, totalPicks]);

  const bands = useMemo(() => {
    const raw: [number, number][] = [[1, 3], [4, 6], [7, 10], [11, lg.rounds]];
    return raw
      .filter(([lo]) => lo <= lg.rounds)
      .map(([lo, hi]) => {
        const h = Math.max(lo, Math.min(hi, lg.rounds));
        return { lo, hi: h, label: `R${lo}–${h}` };
      });
  }, [lg.rounds]);

  const lensRow = (row: { p: any; likelyRound: number; m: number; lens: number; rank: number }) => {
    const { p, likelyRound, m, lens, rank } = row;
    const pickN = takenBy.get(p.idx);
    const gone = pickN !== undefined;
    const blocked =
      !gone &&
      (strat.constraints ?? []).some(
        (c: any) =>
          c.type === 'max' &&
          c.pos === p.pos &&
          likelyRound <= c.through &&
          (myCounts[p.pos] ?? 0) + 1 > c.limit,
      );
    return (
      <div
        class={`lv-row flex items-center gap-1.5 border-b border-app-border px-2 ${
          gone ? 'lv-struck' : ''
        }`}
      >
        <span class="num w-7 shrink-0 text-right text-sm text-app-dim">{rank}</span>
        <span
          class={`lv-posc lv-posc-${String(p.pos).toLowerCase()} num w-11 shrink-0 rounded text-center text-[12px] font-bold`}
        >
          {p.pos}
          {p.posRank}
        </span>
        <span class="min-w-0 flex-1 truncate text-[16px] font-semibold">
          {abbrevName(p.name, 20)}
          {tagIcon(p)}
          {blocked && (
            <span
              class="ml-1 rounded bg-app-border px-1 text-[10px] font-semibold text-app-dim"
              title={`A max constraint forbids ${p.pos} at his likely round, given your current roster`}
            >
              ⊘ blocked
            </span>
          )}
        </span>
        {gone && mine(pickN!) && youChip}
        <span class="num w-9 shrink-0 text-center text-xs text-app-dim">{p.team}</span>
        <span class="num w-6 shrink-0 text-center text-xs text-app-dim">{p.bye ?? '—'}</span>
        <span class="num w-11 shrink-0 text-right text-sm font-semibold">{fmtInt(lens)}</span>
        <span class="num w-10 shrink-0 text-right text-[11px] text-app-dim">
          {m !== 1 ? `×${m}` : ''}
        </span>
        <span class="num w-9 shrink-0 text-right text-xs text-app-dim">{fmtAdp(p.adp?.mu)}</span>
      </div>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div class="lv-planb lv-tool-draft pb-6 text-app-text">
      <div class="sticky top-0 z-10 border-b border-app-border bg-app-surface">
        <div class="flex items-center gap-2 px-3 pt-2">
          <a
            href="#/live"
            class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-bg px-3 font-bold"
          >
            ← Live
          </a>
          <h1 class="lv-h-tool min-w-0 flex-1 truncate text-xl font-extrabold">Plan B</h1>
          <span class="num shrink-0 text-sm text-app-dim">{takenBy.size} gone</span>
          <button
            type="button"
            class={`min-h-14 shrink-0 rounded-lg border px-4 font-semibold ${
              showPrint ? 'border-accent text-accent' : 'border-app-border bg-app-bg'
            }`}
            onClick={() => setShowPrint(!showPrint)}
          >
            🖨 Print
          </button>
        </div>
        <div class="flex gap-1 px-3 py-2">
          <button type="button" class={seg(mode === 'tiers')} onClick={() => setMode('tiers')}>
            TIERS
          </button>
          <button type="button" class={seg(mode === 'strats')} onClick={() => setMode('strats')}>
            STRATEGIES
          </button>
        </div>
      </div>

      {showPrint && <PdfBuilder s={s} />}

      {mode === 'tiers' && (
        <>
          <div class="flex flex-wrap gap-1 px-3 py-2">
            {['ALL', ...POS].map((c) => (
              <button
                type="button"
                class={`num min-h-14 rounded-lg border px-4 text-[15px] font-semibold ${
                  posFilter === c
                    ? c === 'ALL'
                      ? 'lv-seg-on'
                      : `lv-posc lv-posc-${c.toLowerCase()} border-transparent`
                    : 'border-app-border bg-app-surface text-app-text'
                }`}
                onClick={() => setPosFilter(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <div class={posFilter === 'ALL' ? 'gap-x-3 px-3 md:columns-2' : 'mx-auto max-w-2xl px-3'}>
            {tierGroups
              .filter((e) => posFilter === 'ALL' || e.pos === posFilter)
              .flatMap((e) => e.groups.map((g) => tierCard(e.pos, g)))}
          </div>
        </>
      )}

      {mode === 'strats' && (
        <>
          <div class="flex flex-wrap gap-1 px-3 py-2">
            {metas.map((m) => (
              <button
                type="button"
                class={`min-h-14 rounded-lg border px-3 text-[15px] font-semibold ${
                  stratName === m.name ? 'lv-seg-on' : 'border-app-border bg-app-surface text-app-text'
                }`}
                onClick={() => setStratName(m.name)}
              >
                {m.label}
                {m.custom && (
                  <span class="ml-1.5 rounded bg-app-bg px-1 text-[10px] font-bold uppercase text-app-dim">
                    custom
                  </span>
                )}
              </button>
            ))}
          </div>

          <div class="mx-auto max-w-3xl">
            <div class="lv-sect mx-3 mb-2 rounded-lg bg-app-surface px-3 py-2">
              <div class="text-[15px] font-bold">{strat.label ?? strat.name}</div>
              {strat.blurb && <p class="text-sm text-app-dim">{strat.blurb}</p>}
              {(multChips.length > 0 || conChips.length > 0) && (
                <div class="mt-1.5 flex flex-wrap gap-1">
                  {multChips.map((t) => (
                    <span class="lv-tag-ok num rounded px-1.5 py-0.5 text-xs font-semibold">{t}</span>
                  ))}
                  {conChips.map((t) => (
                    <span class="lv-tag-warn num rounded px-1.5 py-0.5 text-xs font-semibold">{t}</span>
                  ))}
                </div>
              )}
            </div>

            <div class="flex gap-1 overflow-x-auto px-3 pb-1">
              {plan.map((c) => (
                <div
                  class={`num flex min-w-[4.25rem] shrink-0 flex-col items-center rounded-lg border px-1 py-1 text-center ${
                    c.long ? 'lv-tag-warn border-transparent' : 'border-app-border bg-app-surface'
                  }`}
                >
                  <span class={`text-[11px] ${c.long ? '' : 'text-app-dim'}`}>R{c.r}</span>
                  <b class="text-[15px]">{c.pick}</b>
                  <span class={`text-[11px] ${c.long ? '' : 'text-app-dim'}`}>
                    {c.gap == null ? 'END' : `+${c.gap}`}
                  </span>
                  {cellMarks(c.r).map((mk) => (
                    <span class={`text-[10px] font-semibold ${mk.cls}`}>{mk.txt}</span>
                  ))}
                </div>
              ))}
            </div>
            <p class="px-3 pb-2 text-[11px] text-app-dim">
              amber = long-gap wait after that pick (κ {planCfg.kappaLongGap}) — tier cliffs cost
              most there · ⊘ = max constraint blocks that position right now · ×m = multiplier in
              force · deadline chips mark min constraints
            </p>

            {bands.map((b) => {
              const rows = lensList.filter((r) => r.likelyRound >= b.lo && r.likelyRound <= b.hi);
              if (rows.length === 0) return null;
              return (
                <section class="mx-3 mb-3 overflow-hidden rounded-xl border border-app-border bg-app-surface">
                  <header class="flex items-center gap-2 border-b border-app-border bg-app-bg px-3 py-1.5">
                    <span class="num text-sm font-bold">{b.label}</span>
                    <span class="num text-xs text-app-dim">
                      my picks{' '}
                      {plan
                        .filter((c) => c.r >= b.lo && c.r <= b.hi)
                        .map((c) => c.pick)
                        .join(' · ')}
                    </span>
                  </header>
                  {rows.map(lensRow)}
                </section>
              );
            })}

            <p class="px-3 py-1 text-xs text-app-dim">
              Honesty note: lens = eff × m(POS, likely round), likely round = where ADP expects the
              player to go. A first-order re-weighting, not a re-simulation — and raw points, not
              value over replacement, so compare within a band (use TIERS for cross-position
              calls). Drafted players stay listed, struck — the sheet reads like paper.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
