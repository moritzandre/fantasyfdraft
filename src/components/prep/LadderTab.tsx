// LadderTab.tsx — the forward simulator: the tab that literally answers "what
// should I do from slot S". For the CURRENT league.slot it renders each of my
// picks as an expandable card:
//   · expected surviving pool — the top board names with their MC availability
//     (mc.json byPick[pick].pAvail, keyed by overall pick — slot-general per
//     the plan amendment) NEXT TO the live engine's closed-form logistic
//     survival for the same pick. Agreement = confidence; a divergence > 15
//     points is highlighted — that is the model telling you the ROOM (opponent
//     model, runs, seat tendencies) disagrees with raw ADP.
//   · best-available-by-position percentile bands (p10–p90 of eff points).
//   · tier-survival bars — only the contested tiers (P(≥1) < 99.5% or
//     P(≥2) < 95%); safe tiers are summarized, not listed.
// Below the ladder: the branch explorer — mc.branchesBySlot[slot] as tappable
// cards one level deep: "if you take X at your first pick → the board at your
// second looks like …", every recommendation the UNCHANGED engine's output.
//
// Degrades gracefully: mc.json missing → banner naming the command; a
// buildHash mismatch with the board → amber warning (numbers may be stale).
// Closed-form survival uses the DERIVED board (prefs applied) — exactly what
// the live engine will see — so an ADP override you typed in Overrides shows
// up here as deliberate CF-vs-MC divergence.

import { useEffect, useState } from 'preact/hooks';
import { gapsAfter, kappaForRound, myPicks } from '../../../engine/picks.js';
import { survivalAt } from '../../../engine/survival.js';
import { abbrevName, fmt1, fmtAdp, tierLetter } from '../../../shared/format.js';
import type { PrepCtx } from './PrepScreen';

const POS = ['RB', 'WR', 'TE', 'QB'];
/** CF-vs-MC availability gap (in probability points) worth flagging. */
const DIVERGE = 0.15;

interface PoolRow {
  idx: number;
  name: string;
  pos: string;
  posRank: number;
  tier: number;
  adp: number | null;
  mcP: number;
  cfP: number;
}

/** Top surviving names at overall `pick`: board order, MC availability ≥ 5%. */
function poolRows(mc: any, board: any, pick: number, limit = 10): PoolRow[] {
  const pAvail = mc.byPick?.[String(pick)]?.pAvail ?? {};
  const rows: PoolRow[] = [];
  for (const [k, prob] of Object.entries(pAvail)) {
    const p = board.players[Number(k)];
    if (!p || (prob as number) < 0.05) continue;
    rows.push({
      idx: p.idx,
      name: p.name,
      pos: p.pos,
      posRank: p.posRank,
      tier: p.tier,
      adp: p.adp?.mu ?? null,
      mcP: prob as number,
      cfP:
        p.adp?.mu != null
          ? survivalAt(pick, p.adp.mu, p.adp.sigmaFinal ?? p.adp.sd ?? 6)
          : 1,
    });
  }
  rows.sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));
  return rows.slice(0, limit);
}

function Pct({ x }: { x: number }) {
  return <>{x < 0.01 ? '<1' : x > 0.99 ? '>99' : Math.round(x * 100)}%</>;
}

function Bar({ p, cls }: { p: number; cls?: string }) {
  return (
    <span class="relative block h-2 w-full overflow-hidden rounded bg-app-bg">
      <span
        class={`absolute inset-y-0 left-0 rounded ${cls ?? 'bg-accent'}`}
        style={`width:${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`}
      />
    </span>
  );
}

export default function LadderTab({ ctx }: { ctx: PrepCtx }) {
  const { s, derived } = ctx;
  const l = s.league;
  // 'loading' → fetching; null → missing/unreadable; object → mc.json data.
  const [mc, setMc] = useState<any>('loading');
  const [openPick, setOpenPick] = useState<number | null>(null);
  const [openBranch, setOpenBranch] = useState<number | null>(null);

  useEffect(() => {
    fetch(import.meta.env.BASE_URL + 'data/mc.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setMc(j))
      .catch(() => setMc(null));
  }, []);

  const picks = myPicks(l);
  const gaps = gapsAfter(picks);

  if (mc === 'loading') {
    return <p class="px-3 py-6 text-center text-sm text-app-dim">Loading mc.json …</p>;
  }
  if (!mc) {
    return (
      <div class="mx-auto max-w-2xl px-3 py-6">
        <div class="rounded-xl border-2 border-dashed border-app-border bg-app-surface p-4">
          <p class="text-[17px] font-bold">mc.json not found</p>
          <p class="mt-1 text-sm text-app-dim">
            The ladder needs the offline Monte Carlo. Run{' '}
            <code class="rounded bg-app-bg px-1 font-bold">node tools/simulate.mjs</code>, then{' '}
            <code class="rounded bg-app-bg px-1 font-bold">npm run build</code> and redeploy.
            Everything else in the app works without it.
          </p>
        </div>
      </div>
    );
  }

  const mismatch = mc.buildHash !== derived.buildHash;
  const branches: any[] = mc.branchesBySlot?.[String(l.slot)] ?? [];
  const [P1, P2] = picks;

  return (
    <div class="mx-auto max-w-2xl px-3 pb-16">
      <p class="py-2 text-sm text-app-dim">
        Slot <b class="text-app-text">{l.slot}</b> · MC = {mc.sims} simulated rooms (seed {mc.seed}
        ) · CF = the live engine's closed-form survival on the same board.{' '}
        <b class="text-app-text">Agreement is the confidence signal</b> — a highlighted gap {'>'}{' '}
        {Math.round(DIVERGE * 100)} pts means the simulated room disagrees with raw ADP there.
      </p>
      {mismatch && (
        <div class="lv-clock-near mb-2 rounded-lg px-3 py-2 text-sm font-bold">
          mc.json snapshot {mc.buildHash} ≠ board {derived.buildHash} — re-run{' '}
          node tools/simulate.mjs; these numbers may be stale.
        </div>
      )}

      <h2 class="pb-1 text-xs font-bold tracking-widest text-app-dim">
        THE LADDER — YOUR {picks.length} PICKS
      </h2>
      {picks.map((p, i) => {
        const open = openPick === p;
        const bp = mc.byPick?.[String(p)];
        const g = i < gaps.length ? gaps[i] : null;
        const long = g != null && kappaForRound(i + 1, l) > 1.0;
        const rows = bp ? poolRows(mc, derived, p) : [];
        const meanGap =
          rows.length > 0
            ? rows.reduce((a, r) => a + Math.abs(r.mcP - r.cfP), 0) / rows.length
            : 0;
        const contested = bp
          ? bp.tierSurvival
              .filter(
                (t: any) => POS.includes(t.pos) && (t.pAtLeast1 < 0.995 || t.pAtLeast2 < 0.95),
              )
              .slice(0, 10)
          : [];
        return (
          <section class="mb-2 rounded-xl border border-app-border bg-app-surface">
            <button
              type="button"
              class="num flex min-h-14 w-full items-center gap-2 px-3 text-left"
              onClick={() => setOpenPick(open ? null : p)}
            >
              <span class="w-12 shrink-0 text-xl font-bold">{p}</span>
              <span class="w-10 shrink-0 text-xs text-app-dim">R{i + 1}</span>
              <span
                class={`w-14 shrink-0 rounded px-1 text-center text-xs font-bold ${
                  g == null ? 'text-app-dim' : long ? 'lv-clock-near' : 'border border-app-border'
                }`}
              >
                {g == null ? 'END' : `+${g}`}
              </span>
              <span class="min-w-0 flex-1 truncate text-xs text-app-dim">
                {bp
                  ? POS.map((pos) => `${pos} ${Math.round(bp.bestAvailByPos?.[pos]?.p50 ?? 0)}`).join(' · ')
                  : 'no MC data for this pick'}
              </span>
              <span class="shrink-0 text-app-dim">{open ? '▾' : '▸'}</span>
            </button>

            {open && bp && (
              <div class="border-t border-app-border px-3 pb-3">
                <h3 class="pt-2 text-xs font-bold tracking-widest text-app-dim">
                  BEST AVAILABLE BY POSITION — EFF PTS (p10 · p50 · p90)
                </h3>
                {POS.map((pos) => {
                  const b = bp.bestAvailByPos?.[pos];
                  if (!b) return null;
                  const max = Math.max(...POS.map((q) => bp.bestAvailByPos?.[q]?.p90 ?? 0), 1);
                  return (
                    <div class="num flex items-center gap-2 py-1 text-sm">
                      <span class="w-8 shrink-0 font-bold">{pos}</span>
                      <span class="relative block h-3 flex-1 overflow-hidden rounded bg-app-bg">
                        <span
                          class="absolute inset-y-0 rounded bg-accent opacity-40"
                          style={`left:${(b.p10 / max) * 100}%; width:${Math.max(1, ((b.p90 - b.p10) / max) * 100)}%`}
                        />
                        <span
                          class="absolute inset-y-0 w-1 bg-accent"
                          style={`left:${(b.p50 / max) * 100}%`}
                        />
                      </span>
                      <span class="w-28 shrink-0 text-right text-xs text-app-dim">
                        {Math.round(b.p10)} · <b class="text-app-text">{Math.round(b.p50)}</b> ·{' '}
                        {Math.round(b.p90)}
                      </span>
                    </div>
                  );
                })}

                <h3 class="pt-3 text-xs font-bold tracking-widest text-app-dim">
                  LIKELY STILL THERE — MC vs CLOSED FORM (mean Δ {Math.round(meanGap * 100)} pts)
                </h3>
                <div class="num grid grid-cols-[1fr_3.5rem_3rem_3rem] items-center gap-x-2 text-xs text-app-dim">
                  <span />
                  <span class="text-right">adp</span>
                  <span class="text-right">MC</span>
                  <span class="text-right">CF</span>
                </div>
                {rows.map((r) => {
                  const div = Math.abs(r.mcP - r.cfP) > DIVERGE;
                  return (
                    <div
                      class={`num grid min-h-9 grid-cols-[1fr_3.5rem_3rem_3rem] items-center gap-x-2 border-b border-app-border text-sm ${
                        div ? 'lv-clock-near rounded px-1' : ''
                      }`}
                    >
                      <span class="min-w-0 truncate">
                        <b>{abbrevName(r.name, 20)}</b>{' '}
                        <span class="text-xs text-app-dim">
                          {r.pos}
                          {r.posRank} · {tierLetter(r.tier)}
                        </span>
                      </span>
                      <span class="text-right text-app-dim">{fmtAdp(r.adp)}</span>
                      <span class="text-right font-bold">
                        <Pct x={r.mcP} />
                      </span>
                      <span class={`text-right ${div ? 'font-bold' : 'text-app-dim'}`}>
                        <Pct x={r.cfP} />
                      </span>
                    </div>
                  );
                })}
                {rows.length === 0 && (
                  <p class="py-1 text-sm text-app-dim">Everyone notable is gone by this pick.</p>
                )}

                <h3 class="pt-3 text-xs font-bold tracking-widest text-app-dim">
                  TIER SURVIVAL AT PICK {p} — CONTESTED TIERS ONLY
                </h3>
                {contested.map((t: any) => (
                  <div class="num flex items-center gap-2 py-1 text-sm">
                    <span class="w-14 shrink-0 font-bold">
                      {t.pos} {tierLetter(t.tier)}
                    </span>
                    <span class="flex-1">
                      <Bar p={t.pAtLeast1} />
                    </span>
                    <span class="w-40 shrink-0 text-right text-xs text-app-dim">
                      ≥1: <b class="text-app-text"><Pct x={t.pAtLeast1} /></b> · ≥2:{' '}
                      <Pct x={t.pAtLeast2} /> · E {fmt1(t.expected)}
                    </span>
                  </div>
                ))}
                {contested.length === 0 && (
                  <p class="py-1 text-sm text-app-dim">
                    Every tier is safe here — nothing worth sweating at pick {p}.
                  </p>
                )}
              </div>
            )}
            {open && !bp && (
              <p class="border-t border-app-border px-3 py-2 text-sm text-app-dim">
                mc.json has no data for overall pick {p} — it was built for a different league
                shape. Re-run node tools/simulate.mjs.
              </p>
            )}
          </section>
        );
      })}

      <h2 class="pb-1 pt-4 text-xs font-bold tracking-widest text-app-dim">
        BRANCH EXPLORER — THE {branches.length} MODAL PICK-{P1} BOARDS
      </h2>
      <p class="pb-2 text-sm text-app-dim">
        Tap a board the room is likely to hand you. Inside: the engine's shortlist on that exact
        board, and one level deeper — <b class="text-app-text">"if you take the recommendation at{' '}
        {P1}, the board at {P2} looks like …"</b>
      </p>
      {branches.map((b: any, bi: number) => {
        const open = openBranch === bi;
        const r0 = b.recommend?.[0];
        return (
          <section class="mb-2 rounded-xl border border-app-border bg-app-surface">
            <button
              type="button"
              class="flex min-h-14 w-full items-center gap-2 px-3 text-left"
              onClick={() => setOpenBranch(open ? null : bi)}
            >
              <span class="num w-12 shrink-0 text-lg font-bold">
                {Math.round(b.probability * 100)}%
              </span>
              <span class="min-w-0 flex-1 truncate text-sm">{b.narrative}</span>
              <span class="shrink-0 text-app-dim">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              <div class="border-t border-app-border px-3 pb-3">
                <h3 class="pt-2 text-xs font-bold tracking-widest text-app-dim">
                  ENGINE SHORTLIST ON THIS BOARD
                </h3>
                {(b.recommend ?? []).map((r: any, ri: number) => (
                  <div class="num flex min-h-9 items-center gap-2 border-b border-app-border text-sm">
                    <span class="w-6 shrink-0 text-app-dim">{ri + 1}.</span>
                    <span class="min-w-0 flex-1 truncate font-bold">
                      {b.recNames?.[ri] ?? `idx ${r.idx}`}
                      {r.isTie && <span class="pl-1 text-xs font-normal text-app-dim">(tie)</span>}
                    </span>
                    <span class="shrink-0 text-xs text-app-dim">
                      score {Math.round(r.score)} · wait costs {fmt1(Math.max(0, r.evLossIfWait))}
                    </span>
                  </div>
                ))}
                <h3 class="pt-3 text-xs font-bold tracking-widest text-app-dim">
                  IF YOU TAKE {(b.recNames?.[0] ?? 'REC #1').toUpperCase()} AT {P1} → THE BOARD AT{' '}
                  {P2}
                </h3>
                {(b.children ?? []).map((c: any) => (
                  <div class="num flex min-h-9 items-center gap-2 border-b border-app-border text-sm">
                    <span class="w-10 shrink-0 font-bold">{Math.round(c.probability * 100)}%</span>
                    <span class="min-w-0 flex-1 truncate text-app-dim">{c.narrative}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
      {branches.length === 0 && (
        <p class="py-2 text-sm text-app-dim">
          No branch data for slot {l.slot} in mc.json — re-run node tools/simulate.mjs.
        </p>
      )}
    </div>
  );
}
