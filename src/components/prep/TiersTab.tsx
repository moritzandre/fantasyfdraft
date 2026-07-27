// TiersTab.tsx — per-position tier editor. Each tier is a card; each boundary
// shows its cliff (points) and TierSep, and a TierSep < 1.0 boundary is
// labelled "weak break — treat as one tier" (that break is projection noise).
// Drag is overkill on an iPad under prep conditions: ▲/▼ buttons move a
// player across a boundary (writes prefs.tierOverride, keyed by stable id);
// MERGE on a boundary folds the lower tier into the upper (and renumbers the
// rest so letters stay contiguous); SPLIT between two players inside a tier
// opens a new boundary there. Edited groups lose their boundary stats
// (cleared, never faked) — simulate.mjs recomputes real ones.

import { useMemo, useState } from 'preact/hooks';
import { abbrevName, fmt1, fmtAdp, fmtInt, tierLetter } from '../../../shared/format.js';
import { setTierOverride } from '../../state/prefs';
import type { Prefs } from '../../state/prefs';
import type { PrepCtx } from './PrepScreen';

const POSITIONS = ['RB', 'WR', 'TE', 'QB', 'K', 'DST'];

export default function TiersTab({ ctx }: { ctx: PrepCtx }) {
  const { board, derived, prefs, update } = ctx;
  const [pos, setPos] = useState('RB');

  const rawById = useMemo(() => {
    const m = new Map<number, any>();
    for (const p of board.players) m.set(p.idx, p);
    return m;
  }, [board]);
  const derById = useMemo(() => {
    const m = new Map<number, any>();
    for (const p of derived.players) m.set(p.idx, p);
    return m;
  }, [derived]);

  const groups = useMemo(
    () =>
      (Array.isArray(derived.tiers) ? (derived.tiers as any[]) : [])
        .filter((g) => g.pos === pos)
        .sort((a, b) => a.tier - b.tier),
    [derived, pos],
  );

  const overriddenIds = useMemo(() => {
    const ids = new Set(Object.keys(prefs.tierOverride));
    let n = 0;
    for (const g of groups) for (const idx of g.members) if (ids.has(String(rawById.get(idx)?.id))) n += 1;
    return n;
  }, [prefs, groups, rawById]);

  /** Move one player to `toTier` (base-tier-aware so reverts clear cleanly). */
  const movePlayer = (idx: number, toTier: number) => {
    const raw = rawById.get(idx);
    if (!raw) return;
    update((p) => setTierOverride(p, String(raw.id), toTier, raw.tier));
  };

  /** MERGE the boundary below `upper`: lower tier joins it, rest renumber −1. */
  const mergeBoundary = (upperTier: number) => {
    update((p0) => {
      let p: Prefs = p0;
      for (const g of groups) {
        if (g.tier <= upperTier) continue;
        const to = g.tier - 1;
        for (const idx of g.members) {
          const raw = rawById.get(idx);
          if (raw) p = setTierOverride(p, String(raw.id), to, raw.tier);
        }
      }
      return p;
    });
  };

  /** SPLIT group `tier` before member position `at`: tail + all lower groups +1. */
  const splitAt = (tier: number, at: number) => {
    update((p0) => {
      let p: Prefs = p0;
      for (const g of groups) {
        if (g.tier < tier) continue;
        const start = g.tier === tier ? at : 0;
        for (let i = start; i < g.members.length; i++) {
          const raw = rawById.get(g.members[i]);
          if (raw) p = setTierOverride(p, String(raw.id), g.tier + 1, raw.tier);
        }
      }
      return p;
    });
  };

  const resetPos = () => {
    update((p0) => {
      let p: Prefs = p0;
      for (const [id] of Object.entries(p0.tierOverride)) {
        const player = board.players.find((pl: any) => String(pl.id) === id);
        if (player?.pos === pos) p = setTierOverride(p, id, null);
      }
      return p;
    });
  };

  return (
    <div class="mx-auto max-w-3xl px-3 pb-16">
      <div class="lv-blurbar sticky top-0 z-10 flex gap-1 py-2">
        {POSITIONS.map((x) => (
          <button
            type="button"
            class={`num min-h-14 flex-1 rounded-lg border text-[15px] font-bold ${
              pos === x ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-surface'
            }`}
            onClick={() => setPos(x)}
          >
            {x}
          </button>
        ))}
      </div>

      <div class="flex items-center justify-between py-1">
        <p class="text-xs text-app-dim">
          ▲/▼ move across a boundary · MERGE folds a weak break · SPLIT opens a new one. Labels stay
          frozen once the draft starts.
        </p>
        {overriddenIds > 0 && (
          <button
            type="button"
            class="min-h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-3 text-sm font-bold"
            onClick={resetPos}
          >
            Reset {pos} ({overriddenIds})
          </button>
        )}
      </div>

      {groups.map((g, gi) => {
        const next = groups[gi + 1];
        const weak = Number.isFinite(g.tierSep) && g.tierSep < 1.0 && next;
        return (
          <>
            <section class={`rounded-lg border bg-app-surface ${g.edited ? 'border-accent' : 'border-app-border'}`}>
              <header class="flex items-baseline gap-2 border-b border-app-border px-3 py-2">
                <span class={`lv-chip-${String(g.letter ?? tierLetter(g.tier)).toLowerCase()} num rounded px-2 py-0.5 text-sm font-bold`}>
                  TIER {g.letter ?? tierLetter(g.tier)}
                </span>
                <span class="num text-sm text-app-dim">
                  {g.members.length} player{g.members.length === 1 ? '' : 's'}
                  {next && Number.isFinite(g.cliffPoints) && (
                    <> — cliff to {next.letter ?? tierLetter(next.tier)}: {fmtInt(g.cliffPoints)} pts (TierSep {fmt1(g.tierSep)})</>
                  )}
                  {g.edited && ' — edited, stats recompute at next simulate run'}
                  {g.provisional && !g.edited && ' — provisional'}
                </span>
              </header>

              {g.members.map((idx: number, mi: number) => {
                const p = derById.get(idx);
                if (!p) return null;
                const raw = rawById.get(idx);
                const overridden = raw && Number.isFinite(prefs.tierOverride[String(raw.id)]);
                return (
                  <>
                    {mi > 0 && (
                      <div class="flex justify-end border-t border-dashed border-app-border/60 pr-2">
                        <button
                          type="button"
                          class="min-h-14 px-3 text-xs font-bold text-app-dim"
                          onClick={() => splitAt(g.tier, mi)}
                          title={`Split TIER ${g.letter} before ${p.name}`}
                        >
                          ✂ split here
                        </button>
                      </div>
                    )}
                    <div class="flex min-h-14 items-center gap-2 px-2 py-1 [contain-intrinsic-size:auto_56px] [content-visibility:auto]">
                      <span class="num w-8 shrink-0 text-right text-sm text-app-dim">{p.overallRank}</span>
                      <span class="min-w-0 flex-1 truncate text-[16px] font-semibold">
                        {abbrevName(p.name, 20)}
                        {overridden && <span class="ml-1 text-accent" title="tier override active">●</span>}
                      </span>
                      <span class="num w-14 shrink-0 text-right text-sm">{fmtInt(p.eff)} eff</span>
                      <span class="num w-14 shrink-0 text-right text-sm text-app-dim">adp {fmtAdp(p.adp?.mu)}</span>
                      <button
                        type="button"
                        class="min-h-14 min-w-14 rounded-lg border border-app-border bg-app-bg text-lg font-bold disabled:opacity-30"
                        disabled={g.tier <= 1}
                        onClick={() => movePlayer(idx, g.tier - 1)}
                        title="Move up one tier"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        class="min-h-14 min-w-14 rounded-lg border border-app-border bg-app-bg text-lg font-bold"
                        onClick={() => movePlayer(idx, g.tier + 1)}
                        title="Move down one tier"
                      >
                        ▼
                      </button>
                    </div>
                  </>
                );
              })}
            </section>

            {next && (
              <div class="flex items-center gap-2 py-1 pl-4">
                <span class={`text-xs ${weak ? 'font-bold' : 'text-app-dim'}`}>
                  {weak
                    ? `⚠ weak break — treat as one tier (TierSep ${fmt1(g.tierSep)} < 1.0)`
                    : Number.isFinite(g.tierSep)
                      ? `boundary — TierSep ${fmt1(g.tierSep)}`
                      : 'boundary — edited'}
                </span>
                <button
                  type="button"
                  class={`min-h-14 rounded-lg border px-4 text-sm font-bold ${
                    weak ? 'lv-clock-near border-transparent' : 'border-app-border bg-app-surface'
                  }`}
                  onClick={() => mergeBoundary(g.tier)}
                >
                  MERGE {g.letter ?? tierLetter(g.tier)}+{next.letter ?? tierLetter(next.tier)}
                </button>
              </div>
            )}
          </>
        );
      })}
      {groups.length === 0 && <p class="p-4 text-app-dim">No tiers for {pos}.</p>}
    </div>
  );
}
