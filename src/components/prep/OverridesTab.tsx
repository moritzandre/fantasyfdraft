// OverridesTab.tsx — per-player manual layer: projection delta stepper (±1 /
// ±5 season points), ADP override stepper, staleNews toggle (σ_final ×1.35 —
// the plan's σ cascade). The effect is shown LIVE as before → after (eff and
// σ come from the raw board vs the derived board, i.e. the exact numbers the
// engine will see). Active overrides are listed below with one-tap recall.
// Export / import prefs JSON lives here (separate from draft-state export).

import { useMemo, useState } from 'preact/hooks';
import { abbrevName, fmt1, fmtAdp, fmtSigned } from '../../../shared/format.js';
import {
  exportPrefsJson,
  importPrefsJson,
  savePrefs,
  setAdpOverride,
  setProjDelta,
  toggleStaleNews,
} from '../../state/prefs';
import type { PrepCtx } from './PrepScreen';

const SLICE = 40;

function Stepper({
  label,
  value,
  onStep,
  onClear,
  steps = [-5, -1, +1, +5],
  cleared,
}: {
  label: string;
  value: string;
  onStep: (d: number) => void;
  onClear: () => void;
  steps?: number[];
  cleared: boolean;
}) {
  return (
    <div class="flex flex-wrap items-center gap-1 py-1">
      <span class="w-28 shrink-0 text-sm font-bold">{label}</span>
      {steps.slice(0, 2).map((d) => (
        <button
          type="button"
          class="num min-h-14 min-w-14 rounded-lg border border-app-border bg-app-bg text-[15px] font-bold"
          onClick={() => onStep(d)}
        >
          {d}
        </button>
      ))}
      <span class="num min-w-16 px-1 text-center text-lg font-bold">{value}</span>
      {steps.slice(2).map((d) => (
        <button
          type="button"
          class="num min-h-14 min-w-14 rounded-lg border border-app-border bg-app-bg text-[15px] font-bold"
          onClick={() => onStep(d)}
        >
          +{d}
        </button>
      ))}
      <button
        type="button"
        class="min-h-14 rounded-lg border border-app-border bg-app-bg px-3 text-sm font-bold disabled:opacity-30"
        disabled={cleared}
        onClick={onClear}
      >
        Clear
      </button>
    </div>
  );
}

export default function OverridesTab({ ctx }: { ctx: PrepCtx }) {
  const { board, derived, prefs, update } = ctx;
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);

  const rawById = useMemo(() => {
    const m = new Map<string, any>();
    for (const p of board.players) m.set(String(p.id), p);
    return m;
  }, [board]);
  const derById = useMemo(() => {
    const m = new Map<string, any>();
    for (const p of derived.players) m.set(String(p.id), p);
    return m;
  }, [derived]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return board.players
      .filter((p: any) => `${p.name} ${p.team} ${p.pos}`.toLowerCase().includes(query))
      .sort((a: any, b: any) => a.overallRank - b.overallRank)
      .slice(0, SLICE);
  }, [board, q]);

  const activeIds = useMemo(() => {
    const ids = new Set<string>([
      ...Object.keys(prefs.projections),
      ...Object.keys(prefs.adp),
      ...prefs.staleNews,
    ]);
    return [...ids]
      .filter((id) => rawById.has(id))
      .sort((a, b) => (rawById.get(a).overallRank ?? 999) - (rawById.get(b).overallRank ?? 999));
  }, [prefs, rawById]);

  const raw = selId ? rawById.get(selId) : null;
  const der = selId ? derById.get(selId) : null;

  const doExport = () => {
    const json = exportPrefsJson(prefs);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'draftprep-prefs.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = (file: File | null) => {
    if (!file) return;
    file.text().then((text) => {
      try {
        const next = importPrefsJson(text);
        setImportErr(null);
        update(() => next);
        savePrefs(next);
      } catch (e: any) {
        setImportErr(String(e?.message ?? e));
      }
    });
  };

  return (
    <div class="mx-auto max-w-2xl px-3 pb-16">
      <div class="sticky top-0 z-10 bg-app-bg py-2">
        <input
          type="search"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="Search player to override"
          class="h-14 w-full rounded-lg border border-app-border bg-app-surface px-3 text-[17px]"
        />
      </div>

      {q && (
        <div class="rounded-lg border border-app-border">
          {results.map((p: any) => (
            <button
              type="button"
              class="flex min-h-14 w-full items-center gap-2 border-b border-app-border px-2 text-left last:border-b-0 active:bg-app-surface"
              onClick={() => {
                setSelId(String(p.id));
                setQ('');
              }}
            >
              <span class="num w-9 shrink-0 text-right text-sm text-app-dim">{p.overallRank}</span>
              <span class="min-w-0 flex-1 truncate font-semibold">{abbrevName(p.name, 24)}</span>
              <span class="num shrink-0 text-sm text-app-dim">
                {p.pos}
                {p.posRank} · {p.team}
              </span>
            </button>
          ))}
          {results.length === 0 && <p class="p-3 text-app-dim">No match.</p>}
        </div>
      )}

      {raw && der && (
        <section class="mt-3 rounded-lg border border-app-border bg-app-surface p-3">
          <div class="flex items-baseline gap-2 pb-2">
            <h2 class="text-[17px] font-bold">{raw.name}</h2>
            <span class="num text-sm text-app-dim">
              {raw.pos}
              {raw.posRank} · {raw.team} · bye {raw.bye ?? '—'}
            </span>
          </div>

          <Stepper
            label="Proj Δ (pts)"
            value={fmtSigned(prefs.projections[selId!] ?? 0)}
            cleared={!(selId! in prefs.projections)}
            onStep={(d) => update((p) => setProjDelta(p, selId!, (p.projections[selId!] ?? 0) + d))}
            onClear={() => update((p) => setProjDelta(p, selId!, 0))}
          />
          <Stepper
            label="ADP override"
            value={selId! in prefs.adp ? fmtAdp(prefs.adp[selId!]) : `(${fmtAdp(raw.adp?.mu)})`}
            cleared={!(selId! in prefs.adp)}
            steps={[-5, -1, +1, +5]}
            onStep={(d) =>
              update((p) =>
                setAdpOverride(p, selId!, Math.max(1, (p.adp[selId!] ?? raw.adp?.mu ?? 100) + d)),
              )
            }
            onClear={() => update((p) => setAdpOverride(p, selId!, null))}
          />
          <div class="flex items-center gap-2 py-1">
            <span class="w-28 shrink-0 text-sm font-bold">Stale news</span>
            <button
              type="button"
              class={`min-h-14 rounded-lg border px-4 font-bold ${
                prefs.staleNews.includes(selId!)
                  ? 'lv-clock-near border-transparent'
                  : 'border-app-border bg-app-bg'
              }`}
              onClick={() => update((p) => toggleStaleNews(p, selId!))}
            >
              {prefs.staleNews.includes(selId!) ? 'STALE — σ ×1.35' : 'fresh'}
            </button>
          </div>

          {/* the effect, live: raw board → derived board (what the engine sees) */}
          <div class="num mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-app-bg p-3 text-sm">
            <span class="text-app-dim">proj (half-PPR)</span>
            <span>
              {fmt1(raw.proj?.halfPpr)} → <b>{fmt1(der.proj?.halfPpr)}</b>
            </span>
            <span class="text-app-dim">eff (VBD input)</span>
            <span>
              {fmt1(raw.eff)} → <b>{fmt1(der.eff)}</b>
            </span>
            <span class="text-app-dim">ADP μ</span>
            <span>
              {fmtAdp(raw.adp?.mu)} → <b>{fmtAdp(der.adp?.mu)}</b>
            </span>
            <span class="text-app-dim">σ final (survival)</span>
            <span>
              {fmt1(raw.adp?.sigmaFinal)} → <b>{fmt1(der.adp?.sigmaFinal)}</b>
            </span>
          </div>
        </section>
      )}

      <section class="mt-4">
        <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">
          ACTIVE OVERRIDES ({activeIds.length})
        </h2>
        {activeIds.map((id) => {
          const p = rawById.get(id);
          const bits: string[] = [];
          if (id in prefs.projections) bits.push(`Δ${fmtSigned(prefs.projections[id])}`);
          if (id in prefs.adp) bits.push(`adp ${fmtAdp(prefs.adp[id])}`);
          if (prefs.staleNews.includes(id)) bits.push('stale');
          return (
            <button
              type="button"
              class="flex min-h-14 w-full items-center gap-2 border-b border-app-border px-1 text-left active:bg-app-surface"
              onClick={() => setSelId(id)}
            >
              <span class="min-w-0 flex-1 truncate font-semibold">{abbrevName(p.name, 24)}</span>
              <span class="num shrink-0 text-sm text-accent">{bits.join(' · ')}</span>
            </button>
          );
        })}
        {activeIds.length === 0 && <p class="py-2 text-sm text-app-dim">None yet — search a player above.</p>}
      </section>

      <section class="mt-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="min-h-14 rounded-lg border border-app-border bg-app-surface px-4 font-bold"
          onClick={doExport}
        >
          Export prefs JSON
        </button>
        <label class="flex min-h-14 cursor-pointer items-center rounded-lg border border-app-border bg-app-surface px-4 font-bold">
          Import prefs JSON
          <input
            type="file"
            accept="application/json,.json"
            class="hidden"
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              doImport(input.files?.[0] ?? null);
              input.value = '';
            }}
          />
        </label>
        {importErr && <span class="text-sm font-semibold">Import failed: {importErr}</span>}
      </section>
    </div>
  );
}
