// StrategyBrief.tsx — sheets S2–S3, the "Strategy Brief" for THIS slot's first
// pick. SLOT-DEPENDENT, two portrait pages.
//
//   p1 (S2)  the first-pick decision tree: three branches — (A) last elite RB,
//            (B) best deep-tier WR, (C) elite TE — each with the CHECKABLE
//            condition (tier counts + tierSurvival straight from mc.json at
//            that overall pick) and the CoW logic in plain English. Plus the
//            check strip: E[left] / P(≥1) / hold-to-next for the tiers the
//            decision actually turns on.
//   p2 (S3)  the four strategy round-shapes side by side, annotated with the
//            slot's gap structure (long-gap rounds — where κ = kappaLongGap —
//            banded dark); the ~10 modal pre-first-pick boards from
//            mc.branchesBySlot[slot], each with the engine's recommended pick,
//            top-3 and EVLoss; the boxed OVERRIDE RULE; the half-PPR reminder.
//
// mc.json is OPTIONAL at build time (the [...slug].astro registry resolves it
// via import.meta.glob): when absent every MC number renders "—" and a banner
// says how to build it — the sheet never lies with stale or invented numbers.
// A buildHash mismatch between mc.json and board.json is surfaced in the foot.
//
// All numbers here are read from mc.json / board.tiers — computed by the SAME
// engine the live app runs, so this printed tree cannot contradict the screen.
// Styles are component-local (<style> below): sb-* classes only, layered on
// print.css's .sheet chrome — print.css itself is owned by another workstream.

import { myPicks, gapsAfter, kappaForRound } from '../../../engine/picks.js';
import { STRATEGIES, multiplierFor } from '../../../engine/strategy.js';
import { fmt1, fmtInt } from '../../../shared/format.js';
import Foot from './Foot';

const CSS = `
.sb { font-size: 9pt; }
.sb-warn {
  border: 1.5pt dashed #000; padding: 1.5mm; margin: 1mm 0 2mm;
  font-size: 9pt; font-weight: 700;
}
.sb-pickline { font-size: 10pt; margin-bottom: 2mm; }
.sb-start {
  border: 1.5pt solid #000; background: #ececec; text-align: center;
  font-size: 10pt; font-weight: 700; letter-spacing: 0.04em;
  padding: 1.2mm 0; text-transform: uppercase;
}
.sb-else { text-align: center; font-size: 7.5pt; color: #333; padding: 0.6mm 0; }
.sb-branch { border: 1pt solid #000; border-left: 3pt solid #000; padding: 1.5mm 2mm; break-inside: avoid; }
.sb-branch h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.03em; }
.sb-check { font-size: 9.5pt; font-weight: 700; margin-top: 0.6mm; }
.sb-cbx {
  display: inline-block; width: 3.4mm; height: 3.4mm; border: 0.75pt solid #000;
  vertical-align: -0.6mm; margin-right: 1.2mm; background: #fff;
}
.sb-mc { font-size: 8pt; color: #222; margin-top: 0.5mm; }
.sb-cow { font-size: 8.5pt; margin-top: 0.7mm; line-height: 1.3; }
.sb-act { font-size: 9.5pt; font-weight: 700; margin-top: 0.8mm; }
.sb-h {
  font-size: 8pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: #333; border-bottom: 0.5pt solid #000; margin: 2.5mm 0 1mm;
}
.sb-strip { border: 0.75pt solid #000; }
.sb-strip-row {
  display: grid; grid-template-columns: 34mm 1fr 1fr 1fr 1fr 1fr;
  font-size: 8pt; line-height: 1.45; align-items: center;
  border-bottom: 0.5pt solid #bbb; padding-left: 1.5mm;
}
.sb-strip-row:last-child { border-bottom: none; }
.sb-strip-hd { font-size: 6.5pt; font-weight: 700; text-transform: uppercase; color: #333; }
.sb-strip-row > span { text-align: right; padding-right: 2mm; }
.sb-strip-row > span:first-child { text-align: left; font-weight: 700; }
.sb-cowbox { border: 0.75pt solid #000; padding: 1.2mm 2mm; font-size: 8pt; margin-top: 2.5mm; line-height: 1.35; }
.sb-gapstrip { display: grid; grid-template-columns: repeat(16, 1fr); gap: 0.6mm; margin-bottom: 1mm; }
.sb-gapcell { border: 0.5pt solid #000; text-align: center; padding: 0.4mm 0; font-size: 7pt; }
.sb-gapcell b { display: block; font-size: 9pt; }
.sb-gapcell .g { display: block; font-size: 6.5pt; margin-top: 0.3mm; }
.sb-gapcell.lg .g { background: #3a3a3a; color: #fff; font-weight: 700; }
.sb-gapcell.sg .g { background: #e8e8e8; }
.sb-strats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.6mm; }
.sb-strat { border: 0.75pt solid #000; padding: 1mm 1.2mm; }
.sb-strat h3 { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.03em; }
.sb-strat .blurb { font-size: 6.5pt; color: #333; line-height: 1.25; min-height: 6mm; }
.sb-mini { display: grid; grid-template-columns: 7mm repeat(16, 1fr); margin-top: 0.6mm; }
.sb-mini span {
  border: 0.25pt solid #ccc; font-size: 5.5pt; text-align: center; line-height: 2.8mm;
  overflow: hidden;
}
.sb-mini span.lbl { border: none; font-weight: 700; font-size: 5.5pt; text-align: left; }
.sb-mini span.up { background: #d7d7d7; font-weight: 700; }
.sb-mini span.dn { background: #fff; color: #555; }
.sb-mini span.lgr { border-bottom: 1.2pt solid #000; }
.sb-cons { font-size: 6.5pt; margin-top: 0.7mm; line-height: 1.35; }
.sb-cons b { text-transform: uppercase; font-size: 6pt; }
.sb-modal-hd, .sb-modal-row {
  display: grid; grid-template-columns: 9mm 1fr 62mm 13mm;
  font-size: 7.5pt; line-height: 1.25; align-items: center;
  border-bottom: 0.5pt solid #bbb; padding: 0.5mm 0;
}
.sb-modal-hd { font-size: 6pt; font-weight: 700; text-transform: uppercase; color: #333; border-bottom: 1pt solid #000; }
.sb-modal-row > span:first-child, .sb-modal-hd > span:first-child { text-align: right; padding-right: 1.5mm; font-weight: 700; }
.sb-modal-row .ev, .sb-modal-hd .ev { text-align: right; padding-right: 1mm; font-weight: 700; }
.sb-modal-row .top3 { padding-right: 1mm; }
.sb-boxes { display: grid; grid-template-columns: 1fr 1fr; gap: 2mm; margin-top: 2.5mm; }
.sb-box { border: 1.5pt solid #000; padding: 1.5mm 2mm; font-size: 9pt; line-height: 1.3; }
.sb-box b { display: block; font-size: 10pt; text-transform: uppercase; letter-spacing: 0.04em; }
`;

/** Probability as a printed percent — "—" when MC data is absent entirely,
    "<1%" for a pruned-to-zero row (tierSurvival prunes below 0.005). */
function pct(x: number | null): string {
  if (x == null) return '—';
  if (x < 0.01) return '<1%';
  if (x > 0.99 && x < 1) return '>99%';
  return `${Math.round(x * 100)}%`;
}

export default function StrategyBrief({
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
  const [P1, P2, P3] = picks;
  const rounds = Array.from({ length: league.rounds }, (_, i) => i + 1);
  const kappa1 = kappaForRound(1, lg);

  // ── mc.json lookups (all tolerate mc === null) ──────────────────────────
  const ts = (pick: number, pos: string, tier: number) =>
    mc?.byPick?.[String(pick)]?.tierSurvival?.find((t: any) => t.pos === pos && t.tier === tier) ??
    null;
  /** P(≥1 of pos-tier left at pick). null = no MC at all; a missing row with
      MC present means the tier was pruned ⇒ ≈0. */
  const hold = (pick: number, pos: string, tier: number): number | null => {
    if (!mc) return null;
    return ts(pick, pos, tier)?.pAtLeast1 ?? 0;
  };
  const hold2 = (pick: number, pos: string, tier: number): number | null => {
    if (!mc) return null;
    return ts(pick, pos, tier)?.pAtLeast2 ?? 0;
  };
  const exp1 = (pos: string, tier: number): string => {
    if (!mc) return '—';
    return fmt1(ts(P1, pos, tier)?.expected ?? 0);
  };
  const tierRec = (pos: string, tier: number) =>
    board.tiers.find((t: any) => t.pos === pos && t.tier === tier) ?? null;
  const cliff = (pos: string, tier: number): string => fmtInt(tierRec(pos, tier)?.cliffPoints);

  // Deep WR tier = the first tier past A still ≥6 expected at P1 (the depth
  // that funds "the second WR can wait"). Falls back to tier 2 with no MC.
  const wrRows: any[] = mc
    ? (mc.byPick?.[String(P1)]?.tierSurvival ?? [])
        .filter((t: any) => t.pos === 'WR')
        .sort((a: any, b: any) => a.tier - b.tier)
    : [];
  const wrDeep = wrRows.find((t: any) => t.tier > 1 && t.expected >= 6) ?? null;
  const wrDeepTier = wrDeep?.tier ?? 2;
  const wrDeepLetter = tierRec('WR', wrDeepTier)?.letter ?? 'B';

  const branches = [
    {
      key: 'A',
      title: 'A · Last elite RB',
      check: `A Tier-A RB is still on the board at pick ${P1}`,
      mcLine: `MC @ pick ${P1}: E[Tier-A RBs left] = ${exp1('RB', 1)} · P(≥1) = ${pct(hold(P1, 'RB', 1))}`,
      cow:
        `CoW: he survives to pick ${P2} with P = ${pct(hold(P2, 'RB', 1))} — waiting risks the ` +
        `full A→B cliff (${cliff('RB', 1)} pts). (1 − survival) × cliff ≈ the whole cliff.`,
      act: `TAKE HIM. The last elite RB does not live through a ${gaps[0]}-pick wait.`,
    },
    {
      key: 'B',
      title: 'B · Best deep-tier WR',
      check: `No Tier-A RB left — or a Tier-A WR clearly outranks the best RB`,
      mcLine:
        `MC @ pick ${P1}: E[Tier-A WRs left] = ${exp1('WR', 1)} · P(≥2) = ${pct(hold2(P1, 'WR', 1))} · ` +
        `Tier ${wrDeepLetter} behind is ${mc ? fmt1(wrDeep?.expected ?? 0) : '—'} deep`,
      cow:
        `CoW: the ELITE WR is the scarce asset — Tier A holds to pick ${P2} with only P = ` +
        `${pct(hold(P2, 'WR', 1))}. The ${wrDeepLetter}-tier depth behind him is exactly why your ` +
        `SECOND WR can wait: E[best WR at ${P2}] barely drops.`,
      act: `Take the best Tier-A WR now; plan RB/RB or RB/TE at picks ${P2} and ${P3}.`,
    },
    {
      key: 'C',
      title: 'C · Elite TE',
      check: `RB and WR Tier A both gone (or only tied, sub-45-rec options left)`,
      mcLine: `MC @ pick ${P1}: TE Tier A P(≥1) = ${pct(hold(P1, 'TE', 1))} · holds to ${P2} with P = ${pct(hold(P2, 'TE', 1))}`,
      cow:
        `CoW: if the hold probability to pick ${P2} is high, the elite TE WAITS — CoW ≈ 0 and ` +
        `taking him now burns the RB/WR cliff instead. Take him at ${P1} only when the hold drops ` +
        `under ~60% (cliff to next TE tier: ${cliff('TE', 1)} pts — the 2-FLEX elite-TE edge).`,
      act: `Default: pass, and let branch A or B decide — the tree exists for the day the room breaks it.`,
    },
  ];

  const stripRows = [
    ['RB Tier A', 'RB', 1],
    ['RB Tier B', 'RB', 2],
    ['WR Tier A', 'WR', 1],
    ['WR Tier B', 'WR', 2],
    ['TE Tier A', 'TE', 1],
  ] as [string, string, number][];

  const branchList: any[] = mc?.branchesBySlot?.[String(s)] ?? [];
  const mismatch = mc && mc.buildHash !== board.buildHash ? 'MC hash mismatch — re-run simulate + rebuild' : undefined;
  const warn = !mc && (
    <div class="sb-warn">
      mc.json not built — run `node tools/simulate.mjs`, then `npm run build`. Every MC number on
      this sheet reads "—" until then.
    </div>
  );

  const STRAT_BLURB: Record<string, string> = {
    balanced: 'Pure tier discipline, no multipliers. Most robust default.',
    anchor_rb: 'One elite RB, then pass-catchers; RB again R6–9.',
    zero_rb_mod: 'No RB before R4 — load WR/TE while the room burns RBs.',
    robust_rb: '2 RB by R3, 3 by R5 — volume early (weakest from a late slot).',
  };

  return (
    <>
      <style>{CSS}</style>

      {/* ── p1 / S2 — the first-pick decision tree ─────────────────────────── */}
      <section class="sheet sb">
        <header class="sheet-head">
          <h1>Strategy Brief · S2 · Slot {s} — the pick-{P1} decision tree</h1>
          <p class="sheet-meta">
            tick the first condition that is TRUE, top to bottom — the MC numbers are the printed
            form of the same engine the app runs · CoW = cost of waiting
          </p>
        </header>
        {warn}
        <p class="sb-pickline">
          You pick at <b>{P1}</b>, then <b>{P2}</b> (gap {gaps[0]}
          {kappa1 > 1 ? ` — LONG side, κ ${fmt1(kappa1)}: weight CoW up` : ` — short side, κ 1.0`}
          ), then <b>{P3}</b> (gap {gaps[1]}).
        </p>

        <div class="sb-start">On the clock at pick {P1} — check in order</div>
        {branches.map((b, i) => (
          <>
            {i > 0 && <div class="sb-else">— else ↓ —</div>}
            <div class="sb-branch">
              <h2>{b.title}</h2>
              <div class="sb-check">
                <span class="sb-cbx" />
                {b.check}
              </div>
              <div class="sb-mc num">{b.mcLine}</div>
              <div class="sb-cow">{b.cow}</div>
              <div class="sb-act">→ {b.act}</div>
            </div>
          </>
        ))}

        <div class="sb-h">The check strip — what the room leaves you (MC, {mc ? mc.sims : '—'} sims)</div>
        <div class="sb-strip num">
          <div class="sb-strip-row sb-strip-hd">
            <span>tier</span>
            <span>E[left] @ {P1}</span>
            <span>P(≥1) @ {P1}</span>
            <span>P(≥1) @ {P2}</span>
            <span>P(≥2) @ {P2}</span>
            <span>cliff below</span>
          </div>
          {stripRows.map(([label, pos, tier]) => (
            <div class="sb-strip-row">
              <span>{label}</span>
              <span>{exp1(pos, tier)}</span>
              <span>{pct(hold(P1, pos, tier))}</span>
              <span>{pct(hold(P2, pos, tier))}</span>
              <span>{pct(hold2(P2, pos, tier))}</span>
              <span>{cliff(pos, tier)} pts</span>
            </div>
          ))}
        </div>

        <div class="sb-cowbox">
          <b>CoW, one line:</b> CoW(i) = (1 − survival to your next pick) × (his value now − the
          best you'd expect at that position when pick {P2} comes back around). A tier cliff IS the
          drop in that expectation — there is no separate cliff bonus, here or in the app. κ ={' '}
          {fmt1(lg.kappaLongGap)} multiplies CoW before a wait longer than {league.teams} picks.
        </div>

        <Foot board={board} league={league} slot={s} pageId="S2" page={1} pages={2} extra={mismatch} />
      </section>

      {/* ── p2 / S3 — round shapes + the modal boards ──────────────────────── */}
      <section class="sheet sb">
        <header class="sheet-head">
          <h1>Strategy Brief · S3 · Slot {s} — round shapes &amp; the modal boards</h1>
          <p class="sheet-meta">
            dark gap cells = long-side waits (κ {fmt1(lg.kappaLongGap)} — take the one that will be
            gone) · m(POS) = score multiplier; heavy underline marks long-gap rounds
          </p>
        </header>
        {warn}

        <div class="sb-h">Your gap structure — slot {s} of {league.teams}</div>
        <div class="sb-gapstrip num">
          {rounds.map((r) => {
            const g = r - 1 < gaps.length ? gaps[r - 1] : null;
            const long = g != null && kappaForRound(r, lg) > 1.0;
            return (
              <div class={`sb-gapcell ${g == null ? '' : long ? 'lg' : 'sg'}`}>
                R{r}
                <b>{picks[r - 1]}</b>
                <span class="g">{g == null ? 'END' : `+${g}`}</span>
              </div>
            );
          })}
        </div>

        <div class="sb-h">The four strategies — priors, not handcuffs</div>
        <div class="sb-strats">
          {Object.values(STRATEGIES).map((st: any) => {
            const posRows = Object.keys(st.multipliers);
            return (
              <div class="sb-strat">
                <h3>{st.name.replace(/_/g, ' ')}</h3>
                <div class="blurb">{STRAT_BLURB[st.name] ?? ''}</div>
                {posRows.length === 0 ? (
                  <div class="sb-mini">
                    <span class="lbl">m</span>
                    {rounds.map((r) => (
                      <span class={kappaForRound(r, lg) > 1.0 ? 'lgr' : ''}>·</span>
                    ))}
                  </div>
                ) : (
                  posRows.map((pos) => (
                    <div class="sb-mini num">
                      <span class="lbl">{pos}</span>
                      {rounds.map((r) => {
                        const m = multiplierFor(st, pos, r);
                        const lgr = kappaForRound(r, lg) > 1.0 ? ' lgr' : '';
                        return (
                          <span class={(m > 1 ? 'up' : m < 1 ? 'dn' : '') + lgr}>
                            {m === 1 ? '·' : m.toFixed(2).replace(/^1\./, '1.').replace('0.', '.')}
                          </span>
                        );
                      })}
                    </div>
                  ))
                )}
                <div class="sb-cons">
                  <b>hard:</b>{' '}
                  {st.constraints.length === 0
                    ? 'none'
                    : st.constraints
                        .map((c: any) =>
                          c.type === 'max'
                            ? `≤${c.limit} ${c.pos} thru R${c.through}`
                            : `≥${c.need} ${c.pos} by R${c.by}`,
                        )
                        .join(' · ')}
                </div>
              </div>
            );
          })}
        </div>

        <div class="sb-h">
          The {branchList.length || '~10'} modal pick-{P1} boards (MC{mc ? `, ${mc.sims} sims` : ''}) — engine
          recommendation on each
        </div>
        <div class="sb-modal-hd">
          <span>p</span>
          <span>board by pick {P1}</span>
          <span>engine top-3 (score)</span>
          <span class="ev">if wait</span>
        </div>
        {branchList.map((b: any) => (
          <div class="sb-modal-row num">
            <span>{Math.round(b.probability * 100)}%</span>
            <span>{b.narrative}</span>
            <span class="top3">
              {b.recommend
                .map((r: any, i: number) => `${b.recNames?.[i] ?? r.idx} (${Math.round(r.score)})`)
                .join(' · ')}
              {b.recommend[0]?.isTie ? ' — tie' : ''}
            </span>
            <span class="ev">−{fmtInt(Math.max(0, b.recommend[0]?.evLossIfWait ?? 0))}</span>
          </div>
        ))}
        {branchList.length === 0 && (
          <div class="sb-modal-row">
            <span>—</span>
            <span>no branch data — build mc.json</span>
            <span />
            <span />
          </div>
        )}

        <div class="sb-boxes">
          <div class="sb-box">
            <b>Override rule</b>
            If the off-strategy best beats the compliant best by more than{' '}
            {league.overrideDelta ?? 20} pts, the app SURFACES the conflict — it never silently
            obeys the strategy. On paper: a {league.overrideDelta ?? 20}+ pt gap to the shape above
            means take the player, not the plan.
          </div>
          <div class="sb-box">
            <b>Half-PPR reminder</b>
            No RB under 45 projected receptions in rounds 1–3 — his value is TD variance, not
            catches (hatched on the tier sheets). Elite TE and pass-catching RBs are worth MORE
            here than standard advice assumes: this league starts ~63 RB/WR every week.
          </div>
        </div>

        <Foot board={board} league={league} slot={s} pageId="S3" page={2} pages={2} extra={mismatch} />
      </section>
    </>
  );
}
