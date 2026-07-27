// PdfBuilder.tsx — "PRINT / PDF BUILDER", the no-CLI print path, hosted at
// the top of Plan B (#/planb). It composes the STATIC sheet routes
// (BASE_URL + 'sheets/[s<slot>/]<id>/?paper=..&mode=..') and opens them in a
// new tab: from there the browser's own print dialog (Ctrl+P, or iPad
// share-sheet → Print) saves the PDF. tools/make_pdfs.py remains the batch
// path that renders the whole kit via headless Chrome.
//
// SHEET_LIST mirrors the registry in src/pages/sheets/[...slug].astro — the
// same keep-in-sync convention tools/make_pdfs.py already documents for
// SLOT_SHEETS/PRESETS. Strategy sheets (S16) are dynamic: one static route
// exists per strategy name (built-ins + strategies.json; NOT local editor
// drafts — routes are baked at build time, which the caption states), chosen
// here with the picker.
//
// iPad rules apply: every control ≥56px (min-h-14), selects at 17px so iOS
// never zooms, no confirm dialogs.

import { useEffect, useState } from 'preact/hooks';
import { loadStrategies, strategyList } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';
import type { DraftState } from '../../state/store';

/** Keep in sync with the SHEETS registry in src/pages/sheets/[...slug].astro
    (strategy-* ids are appended there dynamically and handled below). */
const SHEET_LIST: { id: string; title: string; slotted?: boolean }[] = [
  { id: 'ops-card', title: 'S1 · Draft-Day Ops Card', slotted: true },
  { id: 'strategy-brief', title: 'S2–S3 · Strategy Brief', slotted: true },
  { id: 'big-board', title: 'S4 · Master Big Board' },
  { id: 'big-board-skill', title: 'S4 · Big Board — skill only (no K/DST)' },
  { id: 'tiers-rb', title: 'S6 · RB Tiers' },
  { id: 'tiers-wr', title: 'S7 · WR Tiers' },
  { id: 'tiers-te', title: 'S8 · TE Tiers' },
  { id: 'tiers-qb-k-dst', title: 'S9 · QB + K/DST Tiers' },
  { id: 'targets-fades', title: 'S10 · Targets / Fades / Late Darts', slotted: true },
  { id: 'handcuff-map', title: 'S11 · Handcuff & Contingency Map' },
  { id: 'bye-grid', title: 'S12 · Bye-Week & SoS Grid' },
  { id: 'blank-board', title: 'S13 · Blank Draft Board', slotted: true },
  { id: 'pace-card', title: 'S14 · Round-by-Round Pace Card', slotted: true },
  { id: 'kdst-sheet', title: 'S15 · K / DST Tiers', slotted: true },
];

const seg = (active: boolean) =>
  `min-h-14 flex-1 rounded-lg border px-3 text-[17px] font-semibold ${
    active ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-bg'
  }`;

export default function PdfBuilder({ s }: { s: DraftState }) {
  const [open, setOpen] = useState(false);
  const [paper, setPaper] = useState<'a4' | 'letter'>('a4');
  const [mode, setMode] = useState<'color' | 'gray'>('color');
  const [slot, setSlot] = useState<number>(s.league.slot);
  const [strategy, setStrategy] = useState<string>(s.league.strategy ?? 'balanced');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  useEffect(() => {
    loadStrategies().then(setRegistry);
  }, []);

  const strategyRow = {
    id: `strategy-${strategy}`,
    title: `S16 · Strategy Sheet — ${strategy}`,
    slotted: true,
  };
  const rows = [...SHEET_LIST, strategyRow];

  const base = (import.meta as any).env?.BASE_URL ?? '/';
  const urlFor = (id: string, slotted?: boolean) =>
    `${base}sheets/${slotted ? `s${slot}/` : ''}${id}/?paper=${paper}&mode=${mode}`;
  const openSheet = (id: string, slotted?: boolean) =>
    window.open(urlFor(id, slotted), '_blank', 'noopener');

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openSelected = () => {
    for (const r of rows) if (selected.has(r.id)) openSheet(r.id, r.slotted);
  };

  const teams = s.league.teams;
  return (
    <section class="border-b border-app-border bg-app-surface text-app-text">
      <button
        type="button"
        class="flex min-h-14 w-full items-center gap-2 px-3 text-left"
        onClick={() => setOpen(!open)}
      >
        <span class="text-[17px] font-bold">🖨 Print / PDF builder</span>
        <span class="min-w-0 flex-1 truncate text-sm text-app-dim">
          open any sheet print-ready — no CLI needed
        </span>
        <span class="text-app-dim">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div class="px-3 pb-3">
          <p class="pb-2 text-sm text-app-dim">
            Each button opens the sheet as a print-ready page in a new tab: press{' '}
            <b class="text-app-text">Ctrl+P</b> (iPad: share-sheet → Print), pick{' '}
            <b class="text-app-text">Save as PDF</b>, keep margins at "None".{' '}
            <code>tools/make_pdfs.py</code> still batch-renders the whole kit via headless Chrome.
            Strategy sheets exist for the strategies baked at the last build (built-ins +
            strategies.json); local editor drafts need a rebuild first.
          </p>

          <div class="flex flex-col gap-2">
            <div class="flex gap-2">
              <button type="button" class={seg(paper === 'a4')} onClick={() => setPaper('a4')}>
                A4
              </button>
              <button type="button" class={seg(paper === 'letter')} onClick={() => setPaper('letter')}>
                Letter
              </button>
              <button type="button" class={seg(mode === 'color')} onClick={() => setMode('color')}>
                Color
              </button>
              <button type="button" class={seg(mode === 'gray')} onClick={() => setMode('gray')}>
                Gray
              </button>
            </div>
            <div class="flex gap-2">
              <label class="flex min-h-14 flex-1 items-center gap-2 rounded-lg border border-app-border bg-app-bg px-3">
                <span class="text-sm text-app-dim">Slot</span>
                <select
                  class="min-h-10 flex-1 bg-app-bg text-[17px] font-semibold text-app-text"
                  value={String(slot)}
                  onChange={(e) => setSlot(Number((e.target as HTMLSelectElement).value))}
                >
                  {Array.from({ length: teams }, (_, i) => i + 1).map((n) => (
                    <option value={String(n)}>
                      {n}
                      {n === s.league.slot ? ' (mine)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label class="flex min-h-14 flex-1 items-center gap-2 rounded-lg border border-app-border bg-app-bg px-3">
                <span class="text-sm text-app-dim">Strategy</span>
                <select
                  class="min-h-10 min-w-0 flex-1 bg-app-bg text-[17px] font-semibold text-app-text"
                  value={strategy}
                  onChange={(e) => setStrategy((e.target as HTMLSelectElement).value)}
                >
                  {strategyList(registry).map((m) => (
                    <option value={m.name}>{m.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div class="mt-2 flex flex-col gap-1">
            {rows.map((r) => (
              <div class="flex gap-1">
                <button
                  type="button"
                  class={`flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 text-left ${
                    selected.has(r.id) ? 'border-accent bg-app-bg' : 'border-app-border bg-app-bg'
                  }`}
                  onClick={() => toggle(r.id)}
                >
                  <span class={`text-[17px] ${selected.has(r.id) ? 'text-accent' : 'text-app-dim'}`}>
                    {selected.has(r.id) ? '☑' : '☐'}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-[15px] font-semibold">{r.title}</span>
                  {r.slotted && <span class="shrink-0 text-xs text-app-dim">s{slot}</span>}
                </button>
                <button
                  type="button"
                  class="min-h-14 min-w-14 shrink-0 rounded-lg border border-app-border bg-app-bg px-3 font-bold"
                  onClick={() => openSheet(r.id, r.slotted)}
                >
                  Open ↗
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            class="mt-2 min-h-14 w-full rounded-lg border border-accent bg-app-bg px-3 text-[17px] font-bold text-accent disabled:opacity-40"
            disabled={selected.size === 0}
            onClick={openSelected}
          >
            Open {selected.size || 'selected'} sheet{selected.size === 1 ? '' : 's'} in tabs
          </button>
          <p class="pt-1 text-xs text-app-dim">
            Opening several at once may trip the pop-up blocker — allow pop-ups for this site or
            use the per-sheet Open buttons.
          </p>
        </div>
      )}
    </section>
  );
}
