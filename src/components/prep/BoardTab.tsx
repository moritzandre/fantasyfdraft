// BoardTab.tsx — full board explorer. Sortable table (tap a header to sort,
// tap again to flip): rank · name · pos · team · bye · proj · eff · ADP ·
// σ(ADP) · tier. Tap a row → inline detail sheet (never a modal): weekly
// half-PPR sparkline as inline SVG (bye hatched), SoS early/playoff from
// board.teams, ADP divergence vs ESPN, flags, tag + note. Renders the DERIVED
// board so every prep edit previews instantly. Virtualization-free —
// content-visibility per row via Tailwind arbitrary properties.

import { useMemo, useState } from 'preact/hooks';
import { abbrevName, adpArrow, fmt1, fmtAdp, fmtInt, fmtSigned, tierLetter } from '../../../shared/format.js';
import type { PrepCtx } from './PrepScreen';

const COLS: [string, string, (p: any) => number | string | null][] = [
  ['rank', '#', (p) => p.overallRank],
  ['name', 'Player', (p) => p.name],
  ['pos', 'Pos', (p) => `${p.pos}${String(p.posRank ?? 0).padStart(3, '0')}`],
  ['team', 'Team', (p) => p.team],
  ['bye', 'Bye', (p) => p.bye],
  ['proj', 'Proj', (p) => p.proj?.halfPpr],
  ['eff', 'Eff', (p) => p.eff],
  ['adp', 'ADP', (p) => p.adp?.mu],
  ['sigma', 'σ', (p) => p.adp?.sigmaFinal],
  ['tier', 'Tier', (p) => p.tier],
];

const DESC_DEFAULT = new Set(['proj', 'eff']);
const SLICE = 120;

/** Weekly half-PPR sparkline — inline SVG bars, bye week hatched outline. */
function Sparkline({ weekly, bye }: { weekly: number[]; bye: number | null }) {
  const W = 396;
  const H = 56;
  const n = weekly.length || 18;
  const bw = W / n;
  const max = Math.max(...weekly, 1);
  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} class="h-auto w-full" role="img" aria-label="weekly projection">
      {weekly.map((v, i) => {
        const h = Math.max(1, (v / max) * H);
        const isBye = v === 0;
        return (
          <g>
            {isBye ? (
              <rect
                x={i * bw + 1.5}
                y={1}
                width={bw - 3}
                height={H - 2}
                fill="none"
                stroke="currentColor"
                stroke-opacity="0.35"
                stroke-dasharray="3 2"
              />
            ) : (
              <rect x={i * bw + 1.5} y={H - h} width={bw - 3} height={h} fill="currentColor" fill-opacity="0.75" />
            )}
            {(i === 0 || isBye || i === n - 1) && (
              <text x={i * bw + bw / 2} y={H + 11} text-anchor="middle" font-size="9" fill="currentColor" fill-opacity="0.6">
                {isBye && bye != null ? `bye` : i + 1}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Detail({ p, teams }: { p: any; teams: any }) {
  const t = teams?.[p.team];
  const div = p.adp?.divergence;
  const weekly: number[] = Array.isArray(p.weeklyHalfPpr) ? p.weeklyHalfPpr : [];
  return (
    <div class="border-b border-app-border bg-app-bg px-4 py-3">
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span class="text-[17px] font-bold">{p.name}</span>
        <span class="num text-sm text-app-dim">
          {p.pos}
          {p.posRank} · {p.team} · bye {p.bye ?? '—'} · {fmt1(p.gamesExpected)} games exp
        </span>
      </div>

      {weekly.length > 0 && (
        <div class="mt-2 max-w-lg">
          <Sparkline weekly={weekly} bye={p.bye ?? null} />
        </div>
      )}

      <div class="num mt-2 grid max-w-lg grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <span class="text-app-dim">Half-PPR proj / eff</span>
        <span class="text-right">
          {fmt1(p.proj?.halfPpr)} / {fmt1(p.eff)}
          {Number.isFinite(p.projDelta) && <span class="text-accent"> ({fmtSigned(p.projDelta)} edit)</span>}
        </span>
        <span class="text-app-dim">σ projection / σ ADP</span>
        <span class="text-right">
          {fmt1(p.sigmaProj)} / {fmt1(p.adp?.sigmaFinal)}
        </span>
        <span class="text-app-dim">ADP (FFC) vs ESPN</span>
        <span class="text-right">
          {fmtAdp(p.adp?.mu)} vs {fmtAdp(p.adp?.espnMu)}
          {Number.isFinite(div) && (
            <span> · divergence {fmtSigned(div)} {adpArrow(-(div as number))}</span>
          )}
        </span>
        <span class="text-app-dim">SoS wk 1–13 / playoffs 15–17</span>
        <span class="text-right">
          {t ? `${fmtSigned(t.sosEarly)} / ${fmtSigned(t.sosPlayoff)}` : '—'}
          <span class="text-app-dim"> (− = harder)</span>
        </span>
        {Array.isArray(p.flags) && p.flags.length > 0 && (
          <>
            <span class="text-app-dim">Flags</span>
            <span class="text-right">{p.flags.join(' · ')}</span>
          </>
        )}
        {p.tag && (
          <>
            <span class="text-app-dim">Tag</span>
            <span class="text-right font-semibold">
              {String(p.tag).toUpperCase()}
              {p.tagNote ? ` — “${p.tagNote}”` : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export default function BoardTab({ ctx }: { ctx: PrepCtx }) {
  const { derived } = ctx;
  const [sortKey, setSortKey] = useState('rank');
  const [desc, setDesc] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const col = COLS.find(([k]) => k === sortKey) ?? COLS[0];
    const acc = col[2];
    const query = q.trim().toLowerCase();
    const list = derived.players.filter(
      (p: any) => !query || `${p.name} ${p.team} ${p.pos}`.toLowerCase().includes(query),
    );
    list.sort((a: any, b: any) => {
      const va = acc(a);
      const vb = acc(b);
      const aMiss = va == null || (typeof va === 'number' && !Number.isFinite(va));
      const bMiss = vb == null || (typeof vb === 'number' && !Number.isFinite(vb));
      if (aMiss || bMiss) return aMiss && bMiss ? 0 : aMiss ? 1 : -1; // missing always last
      let c: number;
      if (typeof va === 'string' || typeof vb === 'string') c = String(va).localeCompare(String(vb));
      else c = (va as number) - (vb as number);
      if (desc) c = -c;
      return c !== 0 ? c : a.overallRank - b.overallRank;
    });
    return list;
  }, [derived, sortKey, desc, q]);

  const shown = showAll ? rows : rows.slice(0, SLICE);

  const onHeader = (key: string) => {
    if (key === sortKey) setDesc(!desc);
    else {
      setSortKey(key);
      setDesc(DESC_DEFAULT.has(key));
    }
  };

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-2 px-3 py-2">
        <input
          type="search"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="Search player / team / pos"
          class="h-14 w-full max-w-sm rounded-lg border border-app-border bg-app-surface px-3 text-[17px]"
        />
        <span class="num text-xs text-app-dim">{rows.length} players</span>
      </div>

      <div class="min-h-0 flex-1 overflow-x-auto">
        <div class="min-w-[720px]">
          {/* header — every header cell is a 56px sort control */}
          <div class="sticky top-0 z-10 flex border-b-2 border-app-border bg-app-surface">
            {COLS.map(([key, label]) => (
              <button
                type="button"
                class={`flex min-h-14 items-center gap-0.5 px-1 text-[13px] font-bold ${colCls(key)} ${
                  sortKey === key ? 'text-accent' : 'text-app-dim'
                }`}
                onClick={() => onHeader(key)}
              >
                {label}
                {sortKey === key && <span>{desc ? '▾' : '▴'}</span>}
              </button>
            ))}
          </div>

          {shown.map((p: any) => {
            const tl = p.tierLetter ?? tierLetter(p.tier);
            const open = openIdx === p.idx;
            return (
              <>
                <button
                  type="button"
                  class={`lv-tier-${String(tl).toLowerCase()} flex min-h-14 w-full items-center border-b border-app-border px-1 text-left [contain-intrinsic-size:auto_56px] [content-visibility:auto] active:bg-app-surface ${
                    open ? 'bg-app-surface' : ''
                  }`}
                  onClick={() => setOpenIdx(open ? null : p.idx)}
                >
                  <span class={`num px-1 text-right text-sm text-app-dim ${colCls('rank')}`}>{p.overallRank}</span>
                  <span class={`truncate px-1 text-[16px] font-semibold ${colCls('name')}`}>
                    {abbrevName(p.name, 20)}
                    {p.tag === 'target' && <span class="ml-1 text-accent">★</span>}
                  </span>
                  <span class={`lv-pos-${String(p.pos).toLowerCase()} num mx-1 pb-0.5 text-center text-[13px] font-bold ${colCls('pos')}`}>
                    {p.pos}
                    {p.posRank}
                  </span>
                  <span class={`num px-1 text-center text-sm text-app-dim ${colCls('team')}`}>{p.team}</span>
                  <span class={`num px-1 text-center text-sm text-app-dim ${colCls('bye')}`}>{p.bye ?? '—'}</span>
                  <span class={`num px-1 text-right text-sm ${colCls('proj')}`}>{fmtInt(p.proj?.halfPpr)}</span>
                  <span class={`num px-1 text-right text-sm ${colCls('eff')}`}>{fmtInt(p.eff)}</span>
                  <span class={`num px-1 text-right text-sm ${colCls('adp')}`}>{fmtAdp(p.adp?.mu)}</span>
                  <span class={`num px-1 text-right text-sm text-app-dim ${colCls('sigma')}`}>{fmt1(p.adp?.sigmaFinal)}</span>
                  <span class={`px-1 text-center ${colCls('tier')}`}>
                    <span class={`lv-chip-${String(tl).toLowerCase()} num inline-block w-5 rounded text-center text-xs font-bold`}>
                      {tl}
                    </span>
                  </span>
                </button>
                {open && <Detail p={p} teams={derived.teams} />}
              </>
            );
          })}

          {!showAll && rows.length > SLICE && (
            <button
              type="button"
              class="min-h-14 w-full text-center font-semibold text-accent"
              onClick={() => setShowAll(true)}
            >
              Show all {rows.length}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Fixed column widths so the header sorts align with the body. */
function colCls(key: string): string {
  switch (key) {
    case 'rank':
      return 'w-11 shrink-0 justify-end';
    case 'name':
      return 'min-w-0 flex-1';
    case 'pos':
      return 'w-12 shrink-0 justify-center';
    case 'team':
      return 'w-12 shrink-0 justify-center';
    case 'bye':
      return 'w-10 shrink-0 justify-center';
    case 'proj':
    case 'eff':
      return 'w-12 shrink-0 justify-end';
    case 'adp':
      return 'w-12 shrink-0 justify-end';
    case 'sigma':
      return 'w-11 shrink-0 justify-end';
    case 'tier':
      return 'w-11 shrink-0 justify-center';
    default:
      return '';
  }
}
