// RosterRail.tsx — MY TEAM. Starter slot boxes fill as drafted; the EMPTY
// boxes ARE the needs display. Bench count · 18-week bye strip (hatch, never
// red; badge at ≥3 same-bye starters) · my remaining picks with the next
// highlighted and its gap-after annotated (the seat asymmetry made visible) ·
// Slack counter (amber ≤1) · Export/Import JSON as an inline panel.

import { useMemo, useState } from 'preact/hooks';
import { myPicks } from '../../../engine/picks.js';
import { abbrevName } from '../../../shared/format.js';
import type { Board, DraftState, Store } from '../../state/store';
import { selectors } from '../../state/store';
import { exportJson, importEnvelope } from '../../state/portable';

interface SlotBox {
  label: string;
  pos: string; // 'FLEX' or a real position
  player: any | null;
}

/** Greedy slot fill in draft order: dedicated slot first, then FLEX, then bench. */
export function fillSlots(roster: any[], league: DraftState['league']) {
  const slots: SlotBox[] = [];
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    for (let i = 0; i < (league.roster[pos] ?? 0); i++) slots.push({ label: pos, pos, player: null });
  }
  for (let i = 0; i < (league.roster.FLEX ?? 0); i++) slots.push({ label: 'FLEX', pos: 'FLEX', player: null });
  for (const pos of ['K', 'DST']) {
    for (let i = 0; i < (league.roster[pos] ?? 0); i++) slots.push({ label: pos, pos, player: null });
  }
  const bench: any[] = [];
  for (const p of roster) {
    let box = slots.find((b) => b.player === null && b.pos === p.pos);
    if (!box && league.flexEligible.includes(p.pos)) {
      box = slots.find((b) => b.player === null && b.pos === 'FLEX');
    }
    if (box) box.player = p;
    else bench.push(p);
  }
  return { slots, bench };
}

export default function RosterRail({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const { dispatch } = store;
  const roster = useMemo(() => selectors.myRoster(s, board), [s.rev]);
  const { slots, bench } = useMemo(() => fillSlots(roster, s.league), [s.rev]);

  const unfilled = slots.filter((b) => b.player === null).length;
  const mine = myPicks(s.league);
  const remaining = mine.filter((p) => p >= s.pickCursor);
  const slack = remaining.length - unfilled;

  // Bye counts across STARTERS only (bench byes are free by definition).
  const byeCount: Record<number, number> = {};
  for (const b of slots) {
    if (b.player?.bye) byeCount[b.player.bye] = (byeCount[b.player.bye] ?? 0) + 1;
  }

  const [panel, setPanel] = useState<'none' | 'export' | 'import'>('none');
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');
  const [importWarn, setImportWarn] = useState('');
  const [copied, setCopied] = useState(false);

  // Export/import go through portable.ts — versioned envelope, hard validation,
  // buildHash mismatch surfaced as an amber warning (never a rejection).
  const exportText = () => exportJson(s);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — the textarea is selectable by hand */
    }
  };
  const applyImport = () => {
    const res = importEnvelope(importText, s.buildHash);
    if (!res.ok || !res.state) {
      setImportErr(`Import failed: ${res.errors.join(' · ')}`);
      return;
    }
    dispatch({ type: 'IMPORT_STATE', state: res.state });
    setImportErr('');
    setImportWarn(res.warnings.join(' · '));
    setPanel('none');
    setImportText('');
  };

  return (
    <div class="p-2">
      <h2 class="px-1 pb-1 text-xs font-bold tracking-widest text-app-dim">MY TEAM</h2>

      {/* Starter boxes — the empty ones ARE the needs widget */}
      <div class="flex flex-col gap-1">
        {slots.map((b) => (
          <div
            class={`flex min-h-[52px] items-center gap-2 rounded-lg border px-2 ${
              b.player
                ? 'border-app-border bg-app-surface'
                : `border-dashed lv-slot-${b.pos.toLowerCase()}`
            }`}
          >
            <span
              class={`num w-11 shrink-0 rounded text-center text-[12px] font-bold ${
                b.player
                  ? `lv-posc lv-posc-${b.pos.toLowerCase()}`
                  : `lv-post lv-post-${b.pos.toLowerCase()}`
              }`}
            >
              {b.label}
            </span>
            {b.player ? (
              <span class="min-w-0 flex-1 truncate text-[15px] font-semibold">
                {abbrevName(b.player.name)}
                <span class="num ml-2 text-xs text-app-dim">
                  {b.player.team} · bye {b.player.bye ?? '—'}
                </span>
              </span>
            ) : (
              <span class="text-[15px] text-app-dim">—</span>
            )}
          </div>
        ))}
      </div>

      <div class="num mt-2 flex items-center justify-between px-1 text-sm">
        <span class="text-app-dim">
          Bench {bench.length}/{s.league.roster.BN ?? 0}
        </span>
        <span
          class={`rounded px-2 py-1 font-bold ${
            slack <= 1 ? 'lv-clock-near' : 'text-app-dim'
          }`}
          title="remaining picks − unfilled starter slots"
        >
          Slack {slack}
        </span>
      </div>
      {bench.length > 0 && (
        <div class="px-1 pt-1 text-xs text-app-dim">
          {bench.map((p) => abbrevName(p.name, 14)).join(' · ')}
        </div>
      )}

      {/* 18-week bye strip — hatched, never red */}
      <h3 class="px-1 pt-3 pb-1 text-xs font-bold tracking-widest text-app-dim">STARTER BYES</h3>
      <div class="grid grid-cols-9 gap-0.5">
        {Array.from({ length: 18 }, (_, i) => i + 1).map((wk) => {
          const c = byeCount[wk] ?? 0;
          return (
            <div
              class={`num relative flex h-9 flex-col items-center justify-center rounded border border-app-border text-[11px] ${
                c > 0 ? 'lv-bye-hatch' : ''
              } ${c >= 3 ? 'lv-bye-alert' : ''}`}
              title={`week ${wk}: ${c} starter${c === 1 ? '' : 's'} on bye`}
            >
              <span class="text-app-dim">{wk}</span>
              {c > 0 && <span class="font-bold leading-none">{c}</span>}
              {c >= 3 && (
                <span class="num absolute -top-1.5 -right-1.5 rounded-full bg-app-text px-1 text-[10px] font-bold text-app-bg">
                  {c}!
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* My remaining picks, gap-after annotated */}
      <h3 class="px-1 pt-3 pb-1 text-xs font-bold tracking-widest text-app-dim">MY PICKS</h3>
      <div class="flex flex-wrap gap-1 px-1">
        {mine.map((p, i) => {
          const gap = i < mine.length - 1 ? mine[i + 1] - p : null;
          const past = p < s.pickCursor;
          const next = p === remaining[0];
          return (
            <span
              class={`num rounded px-1.5 py-1 text-[13px] ${
                next
                  ? 'bg-accent font-bold text-app-bg'
                  : past
                    ? 'text-app-dim line-through opacity-50'
                    : 'border border-app-border text-app-text'
              }`}
            >
              {p}
              {gap !== null && <span class={next ? 'opacity-80' : 'text-app-dim'}> +{gap}</span>}
            </span>
          );
        })}
      </div>

      {/* Export / Import — inline panel, never a modal */}
      <div class="mt-3 flex gap-2 px-1">
        <button
          type="button"
          class="min-h-14 flex-1 rounded-lg border border-app-border bg-app-surface font-semibold"
          onClick={() => setPanel(panel === 'export' ? 'none' : 'export')}
        >
          Export JSON
        </button>
        <button
          type="button"
          class="min-h-14 flex-1 rounded-lg border border-app-border bg-app-surface font-semibold"
          onClick={() => setPanel(panel === 'import' ? 'none' : 'import')}
        >
          Import JSON
        </button>
      </div>
      {importWarn && (
        <div class="lv-clock-near mt-2 rounded-lg px-3 py-2 text-sm font-semibold">
          ⚠ {importWarn}
        </div>
      )}
      {panel === 'export' && (
        <div class="mt-2 px-1">
          <textarea
            readonly
            rows={6}
            class="w-full rounded-lg border border-app-border bg-app-bg p-2 font-mono text-[17px]"
            value={exportText()}
            onFocus={(e: any) => e.currentTarget.select()}
          />
          <button
            type="button"
            class="mt-1 min-h-14 w-full rounded-lg border border-app-border bg-app-surface font-semibold"
            onClick={() => copy(exportText())}
          >
            {copied ? 'Copied ✓' : 'Copy to clipboard'}
          </button>
        </div>
      )}
      {panel === 'import' && (
        <div class="mt-2 px-1">
          <textarea
            rows={6}
            placeholder="Paste a DraftPrep export…"
            class="w-full rounded-lg border border-app-border bg-app-bg p-2 font-mono text-[17px]"
            value={importText}
            onInput={(e: any) => setImportText(e.currentTarget.value)}
          />
          {importErr && <p class="py-1 text-sm font-semibold">{importErr}</p>}
          <button
            type="button"
            class="mt-1 min-h-14 w-full rounded-lg border border-app-border bg-app-surface font-semibold"
            onClick={applyImport}
          >
            Apply import (undoable via pick log)
          </button>
        </div>
      )}
    </div>
  );
}
