// TagsTab.tsx — Target / Value / Avoid / Never tags + a one-line note per
// player. The note prints VERBATIM on sheet S10 (Targets/Fades), so it is the
// reason you'll read on paper at 17:30 on draft day — write it like that.
// Searchable player list; tap a row to expand the tag chips + note input
// (17px — anything under 16px zooms the iOS viewport). Every change saves
// synchronously via prefs (dp:prefs:v1).

import { useMemo, useState } from 'preact/hooks';
import { abbrevName, fmtAdp } from '../../../shared/format.js';
import { setTag, TAG_NAMES } from '../../state/prefs';
import type { TagName } from '../../state/prefs';
import type { PrepCtx } from './PrepScreen';

const SLICE = 100;

const TAG_LABEL: Record<TagName, string> = {
  target: '★ Target',
  value: '▲ Value',
  avoid: '▽ Avoid',
  never: '✕ Never',
};

export default function TagsTab({ ctx }: { ctx: PrepCtx }) {
  const { board, prefs, update } = ctx;
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [filterTagged, setFilterTagged] = useState(false);

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return board.players
      .filter((p: any) => {
        if (filterTagged && !prefs.tags[String(p.id)]) return false;
        if (query && !`${p.name} ${p.team} ${p.pos}`.toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a: any, b: any) => a.overallRank - b.overallRank);
  }, [board, q, filterTagged, prefs]);

  const shown = showAll ? rows : rows.slice(0, SLICE);
  const taggedCount = Object.keys(prefs.tags).length;

  return (
    <div class="mx-auto max-w-2xl px-3 pb-16">
      <div class="lv-blurbar sticky top-0 z-10 flex items-center gap-2 py-2">
        <input
          type="search"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="Search player to tag"
          class="h-14 min-w-0 flex-1 rounded-lg border border-app-border bg-app-surface px-3 text-[17px]"
        />
        <button
          type="button"
          class={`num min-h-14 shrink-0 rounded-lg border px-3 text-sm font-bold ${
            filterTagged ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-surface'
          }`}
          onClick={() => setFilterTagged(!filterTagged)}
        >
          Tagged ({taggedCount})
        </button>
      </div>
      <p class="pb-2 text-xs text-app-dim">
        The note prints verbatim on sheet S10 — write the reason you'll want to read on the clock.
      </p>

      {shown.map((p: any) => {
        const id = String(p.id);
        const entry = prefs.tags[id];
        const open = openId === id;
        return (
          <div class="border-b border-app-border [contain-intrinsic-size:auto_56px] [content-visibility:auto]">
            <button
              type="button"
              class={`flex min-h-14 w-full items-center gap-2 px-1 text-left active:bg-app-surface ${
                open ? 'bg-app-surface' : ''
              }`}
              onClick={() => setOpenId(open ? null : id)}
            >
              <span class="num w-9 shrink-0 text-right text-sm text-app-dim">{p.overallRank}</span>
              <span class="min-w-0 flex-1 truncate text-[16px] font-semibold">{abbrevName(p.name, 22)}</span>
              <span class="num shrink-0 text-sm text-app-dim">
                {p.pos}
                {p.posRank} · {p.team} · adp {fmtAdp(p.adp?.mu)}
              </span>
              {entry && (
                <span class="shrink-0 rounded border border-accent px-1.5 py-0.5 text-xs font-bold text-accent">
                  {TAG_LABEL[entry.tag]}
                </span>
              )}
            </button>

            {open && (
              <div class="bg-app-surface px-2 pb-3">
                <div class="flex flex-wrap gap-1 py-2">
                  {TAG_NAMES.map((t) => (
                    <button
                      type="button"
                      class={`min-h-14 flex-1 rounded-lg border px-2 text-[15px] font-bold ${
                        entry?.tag === t
                          ? 'border-accent bg-accent text-app-bg'
                          : 'border-app-border bg-app-bg'
                      }`}
                      onClick={() => update((pf) => setTag(pf, id, entry?.tag === t ? null : t, entry?.note ?? ''))}
                    >
                      {TAG_LABEL[t]}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={entry?.note ?? ''}
                  disabled={!entry}
                  placeholder={entry ? 'Why — prints on S10' : 'Pick a tag first, then write the reason'}
                  maxLength={80}
                  onInput={(e) => {
                    const note = (e.target as HTMLInputElement).value;
                    if (entry) update((pf) => setTag(pf, id, entry.tag, note));
                  }}
                  class="h-14 w-full rounded-lg border border-app-border bg-app-bg px-3 text-[17px] disabled:opacity-50"
                />
              </div>
            )}
          </div>
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
      {rows.length === 0 && <p class="p-4 text-app-dim">No players match.</p>}
    </div>
  );
}
