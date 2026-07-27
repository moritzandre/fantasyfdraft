// PaceCard.tsx — sheet S14 "Round-by-Round Pace Card". SLOT-DEPENDENT, one
// portrait page. This is what turns the strategy brief into NAMED players: one
// row per MY pick with pick# · round · gap-after (long-gap banded dark, same
// convention as S1) · mc.json bestAvailByPos p10·p50·p90 (eff points — what
// the best remaining RB/WR/TE/QB will be worth when the pick comes around) ·
// a target archetype DERIVED from the active strategy's round shape (never
// hand-scripted prose: multipliers + still-open constraints, else the roster
// phase) · three blank name slots to fill in the night before · GOT tick box.
//
// mc.json optional (import.meta.glob in the registry): absent ⇒ percentile
// cells read "—" and a banner names the command. K/DST rows come from
// myPicks(league).slice(-2) — derived, never the slot-8 constants.
// Styles are component-local (pc-* classes) on top of print.css's .sheet.

import { myPicks, gapsAfter, kappaForRound } from '../../../engine/picks.js';
import { getStrategy, multiplierFor } from '../../../engine/strategy.js';
import Foot from './Foot';

const CSS = `
.pc { font-size: 9pt; }
.pc-warn {
  border: 1.5pt dashed #000; padding: 1.5mm; margin: 1mm 0 2mm;
  font-size: 9pt; font-weight: 700;
}
.pc-hd, .pc-row {
  display: grid;
  grid-template-columns: 9mm 6mm 9mm 16mm 16mm 16mm 16mm 1fr 13mm 13mm 13mm 7mm;
  align-items: center;
  border-bottom: 0.5pt solid #999;
  break-inside: avoid;
  page-break-inside: avoid;
}
.pc-hd {
  font-size: 5.5pt; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.02em; color: #333; border-bottom: 1pt solid #000;
  line-height: 1.2; padding-bottom: 0.5mm;
}
.pc-hd > span, .pc-row > span { padding: 0 0.6mm; }
.pc-row { min-height: 15mm; } /* handwriting-height rows — measured to fill the page with ~9mm slack */
.pc-pick { font-size: 13pt; font-weight: 700; text-align: right; }
.pc-rd { font-size: 7pt; color: #333; text-align: center; }
.pc-gap { font-size: 7.5pt; font-weight: 700; text-align: center; padding: 0.6mm 0; }
.pc-gap.lg { background: #3a3a3a; color: #fff; }
.pc-gap.sg { background: #e8e8e8; }
.pc-gap.end { color: #666; }
.pc-pcts { font-size: 6.4pt; text-align: center; line-height: 1.25; }
.pc-pcts b { display: block; font-size: 7.5pt; }
.pc-arch { font-size: 7pt; line-height: 1.2; }
.pc-slot { border-bottom: 0.5pt solid #000; height: 6.5mm; margin: 0 0.6mm; }
.pc-cb { display: flex; justify-content: center; }
.pc-cb > span { width: 3.4mm; height: 3.4mm; border: 0.75pt solid #000; background: #fff; }
`;

const POS = ['RB', 'WR', 'TE', 'QB'];

/** p10·p50·p90 of best-available eff points for `pos` at overall `pick`. */
function pcts(mc: any, pick: number, pos: string) {
  const b = mc?.byPick?.[String(pick)]?.bestAvailByPos?.[pos];
  if (!b) return { mid: '—', band: '' };
  return { mid: String(Math.round(b.p50)), band: `${Math.round(b.p10)}–${Math.round(b.p90)}` };
}

/** Target archetype for round r, derived from the strategy round-shape:
    active multipliers + still-open hard constraints, layered on the roster
    phase. K/DST rows are handled by the caller (hard-scheduled picks). */
function archetype(strat: any, r: number, rounds: number): string {
  const parts: string[] = [];
  for (const pos of Object.keys(strat.multipliers)) {
    const m = multiplierFor(strat, pos, r);
    if (m > 1) parts.push(`${pos}↑ ×${m.toFixed(2)}`);
    else if (m < 1) parts.push(`${pos}↓ ×${m.toFixed(2)}`);
  }
  for (const c of strat.constraints) {
    if (c.type === 'max' && r <= c.through) {
      parts.push(c.limit === 0 ? `no ${c.pos}` : `≤${c.limit} ${c.pos} thru R${c.through}`);
    } else if (c.type === 'min' && r <= c.by) {
      parts.push(`≥${c.need} ${c.pos} by R${c.by}`);
    }
  }
  const phase =
    r <= 2
      ? 'Elite tier — BPA (RB/WR; TE if last elite)'
      : r <= 5
        ? 'Starters — best tier, watch the cliffs'
        : r <= 9
          ? 'Flex + QB window — take the ceiling'
          : 'Bench call options — upside, handcuffs, late darts';
  return parts.length ? `${phase} · ${parts.join(' · ')}` : phase;
}

export default function PaceCard({
  board,
  league,
  slot,
  mc,
}: {
  board: any;
  league: any;
  slot?: number;
  mc?: any;
}) {
  const s = slot ?? league.slot;
  const lg = {
    teams: league.teams,
    slot: s,
    rounds: league.rounds,
    snake: league.snake !== false,
    kappaLongGap: league.kappaLongGap ?? 1.3,
  };
  const picks = myPicks(lg);
  const gaps = gapsAfter(picks);
  const [kPick, dstPick] = picks.slice(-2);
  const stratName = league.strategy ?? 'balanced';
  const strat = getStrategy(stratName);
  const mismatch =
    mc && mc.buildHash !== board.buildHash ? 'MC hash mismatch — re-run simulate + rebuild' : undefined;

  return (
    <>
      <style>{CSS}</style>
      <section class="sheet pc">
        <header class="sheet-head">
          <h1>Round-by-Round Pace Card · S14 · Slot {s}</h1>
          <p class="sheet-meta">
            fill the three name slots the night before — the pace card turns the brief into named
            players · p50 large, p10–p90 under it = best-available eff pts by position when YOUR
            pick comes around (MC{mc ? `, ${mc.sims} sims` : ''}) · dark gap = long wait, κ{' '}
            {(league.kappaLongGap ?? 1.3).toFixed(1)} · archetype derived from the{' '}
            {stratName.replace(/_/g, ' ')} round shape
          </p>
        </header>
        {!mc && (
          <div class="pc-warn">
            mc.json not built — run `node tools/simulate.mjs`, then `npm run build`. Percentile
            columns read "—" until then.
          </div>
        )}

        <div class="pc-hd">
          <span style="text-align:right">pick</span>
          <span style="text-align:center">rd</span>
          <span style="text-align:center">gap</span>
          <span style="text-align:center">RB best-avail</span>
          <span style="text-align:center">WR best-avail</span>
          <span style="text-align:center">TE best-avail</span>
          <span style="text-align:center">QB best-avail</span>
          <span>target archetype</span>
          <span style="text-align:center">name 1</span>
          <span style="text-align:center">name 2</span>
          <span style="text-align:center">name 3</span>
          <span style="text-align:center">got</span>
        </div>

        {picks.map((p, i) => {
          const r = i + 1;
          const g = i < gaps.length ? gaps[i] : null;
          const long = g != null && kappaForRound(r, lg) > 1.0;
          const arch =
            p === kPick
              ? 'K — hard-scheduled, never earlier'
              : p === dstPick
                ? 'DST — hard-scheduled, never earlier'
                : archetype(strat, r, league.rounds);
          return (
            <div class="pc-row num">
              <span class="pc-pick">{p}</span>
              <span class="pc-rd">R{r}</span>
              <span class={`pc-gap ${g == null ? 'end' : long ? 'lg' : 'sg'}`}>
                {g == null ? 'END' : `+${g}`}
              </span>
              {POS.map((pos) => {
                const v = pcts(mc, p, pos);
                return (
                  <span class="pc-pcts">
                    <b>{v.mid}</b>
                    {v.band}
                  </span>
                );
              })}
              <span class="pc-arch">{arch}</span>
              <span class="pc-slot" />
              <span class="pc-slot" />
              <span class="pc-slot" />
              <span class="pc-cb">
                <span />
              </span>
            </div>
          );
        })}

        <Foot board={board} league={league} slot={s} pageId="S14" extra={mismatch} />
      </section>
    </>
  );
}
