// PrepScreen.tsx — S2 Prep, the tabbed prep-mode host (#/prep). Eight tabs:
// Board · Tiers · Tags · Overrides · Strategy · Strategies+ · Ladder · Rehearsal.
// Owns the ONE prefs instance: loadPrefs at mount, every mutation
// goes through update() which saves SYNCHRONOUSLY (dp:prefs:v1) before
// re-rendering. `board` here is the RAW fetched board; `derived` is
// applyPrefs(board, prefs) recomputed live so every tab previews exactly what
// the live screen will see after its next boot. All controls ≥56px; text
// inputs ≥17px (iOS zoom); tables are virtualization-free, rows use
// content-visibility via Tailwind arbitrary properties.

import { useMemo, useState } from 'preact/hooks';
import type { Board, DraftState, Store } from '../../state/store';
import { applyPrefs, loadPrefs, savePrefs } from '../../state/prefs';
import type { Prefs } from '../../state/prefs';
import BoardTab from './BoardTab';
import TiersTab from './TiersTab';
import TagsTab from './TagsTab';
import OverridesTab from './OverridesTab';
import StrategyTab from './StrategyTab';
import StrategyEditorTab from './StrategyEditorTab';
import LadderTab from './LadderTab';
import RehearsalTab from './RehearsalTab';

export interface PrepCtx {
  s: DraftState;
  store: Store;
  /** RAW board.json (validated, prefs NOT applied). */
  board: Board;
  /** applyPrefs(board, prefs) — what live will see after its next boot. */
  derived: Board;
  prefs: Prefs;
  /** Mutate prefs: update((p) => setTag(p, id, 'target')) — saves synchronously. */
  update: (fn: (p: Prefs) => Prefs) => void;
}

const TABS: [string, string][] = [
  ['board', 'Board'],
  ['tiers', 'Tiers'],
  ['tags', 'Tags'],
  ['overrides', 'Overrides'],
  ['strategy', 'Strategy'],
  ['editor', 'Strategies+'],
  ['ladder', 'Ladder'],
  ['rehearsal', 'Rehearsal'],
];

export default function PrepScreen({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const [tab, setTab] = useState('board');
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());

  const update = (fn: (p: Prefs) => Prefs) => {
    setPrefs((prev) => {
      const next = fn(prev);
      savePrefs(next); // SYNCHRONOUS — before anything re-renders
      return next;
    });
  };

  const derived = useMemo(() => applyPrefs(board, prefs), [board, prefs]);
  const ctx: PrepCtx = { s, store, board, derived, prefs, update };

  const edits =
    Object.keys(prefs.projections).length +
    Object.keys(prefs.adp).length +
    prefs.staleNews.length +
    Object.keys(prefs.tierOverride).length +
    Object.keys(prefs.tags).length;

  return (
    <div class="flex min-h-dvh flex-col">
      <div class="lv-blurbar sticky top-0 z-30 border-b border-app-border">
        <div class="flex items-center gap-2 px-3 pt-2">
          <a
            href="#/ready"
            class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-bg px-3 font-bold"
          >
            ← Ready
          </a>
          <h1 class="flex-1 text-lg font-bold">Prep</h1>
          <span class="num text-xs text-app-dim">
            {edits > 0 ? `${edits} edits — live applies them at next launch` : 'no edits yet'}
          </span>
        </div>
        <div class="flex gap-1 overflow-x-auto px-3 py-2">
          {TABS.map(([id, label]) => (
            <button
              type="button"
              class={`min-h-14 shrink-0 rounded-lg border px-4 text-[15px] font-bold ${
                tab === id
                  ? 'border-accent bg-accent text-app-bg'
                  : 'border-app-border bg-app-bg text-app-text'
              }`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div class="min-h-0 flex-1">
        {tab === 'board' && <BoardTab ctx={ctx} />}
        {tab === 'tiers' && <TiersTab ctx={ctx} />}
        {tab === 'tags' && <TagsTab ctx={ctx} />}
        {tab === 'overrides' && <OverridesTab ctx={ctx} />}
        {tab === 'strategy' && <StrategyTab ctx={ctx} />}
        {tab === 'editor' && <StrategyEditorTab ctx={ctx} />}
        {tab === 'ladder' && <LadderTab ctx={ctx} />}
        {tab === 'rehearsal' && <RehearsalTab ctx={ctx} />}
      </div>
    </div>
  );
}
