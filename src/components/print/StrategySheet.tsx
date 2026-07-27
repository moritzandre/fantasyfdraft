// StrategySheet.tsx — sheet S16, ONE page per STRATEGY per SLOT
// (sheets/s<slot>/strategy-<name>/). The registry emits one for every
// built-in (engine/strategy.js STRATEGIES) plus every valid custom spec in
// public/data/strategies.json — the `strategy` prop arrives pre-resolved
// (label/blurb included), so this component re-encodes nothing.
//
//   1  the slot's round plan: pick number + gap-after per round, long-gap
//      rounds banded dark (κ = kappaLongGap — where tier cliffs cost you)
//   2  the multiplier round-table: m_p(r) per position × round, straight
//      from multiplierFor() — the same table StrategyTab renders on screen
//   3  hard constraints as chips + the overrideDelta rule box
//   4  the modal pick-1 boards from mc.branchesBySlot[slot], each with the
//      engine's top-3 viewed through THIS strategy's lens: ×m_p(R1) rescores
//      the balanced score, ⊘ marks a first pick its constraints would refuse
//
// HONESTY FOOTNOTE (printed): mc.json recommendations are computed under the
// BALANCED engine; the lens column is a first-order re-weighting, not a
// re-simulation. The durable value of this sheet is the multiplier table and
// the round plan. mc.json is optional at build time (banner when absent).
//
// Styles: .ss-* block in print.css (one block per sheet).

import { gapsAfter, kappaForRound, myPicks } from '../../../engine/picks.js';
import { isCompliant, multiplierFor } from '../../../engine/strategy.js';
import { fmt1, fmtInt } from '../../../shared/format.js';
import Foot from './Foot';

const POS_ORDER = ['QB', 'RB', 'WR', 'TE'];

function constraintText(c: any): string {
  return c.type === 'max'
    ? `≤${c.limit} ${c.pos} through R${c.through}`
    : `≥${c.need} ${c.pos} by R${c.by}`;
}

export default function StrategySheet({
  board,
  league,
  slot,
  mc,
  strategy,
}: {
  board: any;
  league: any;
  slot?: number;
  mc?: any;
  strategy: any;
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
  const rounds = Array.from({ length: league.rounds }, (_, i) => i + 1);
  const longGap = rounds.map((r) => kappaForRound(r, lg) > 1.0);
  const P1 = picks[0];

  const label = strategy.label ?? strategy.name;
  const posRows = POS_ORDER.filter((pos) => (strategy.multipliers?.[pos] ?? []).length > 0);
  const byIdx = new Map<number, any>(board.players.map((p: any) => [p.idx, p]));

  const branchList: any[] = mc?.branchesBySlot?.[String(s)] ?? [];
  const mismatch =
    mc && mc.buildHash !== board.buildHash ? 'MC hash mismatch — re-run simulate + rebuild' : undefined;

  /** Top-3 of one branch through this strategy's lens (first pick = round 1). */
  const lensRec = (b: any, i: number) => {
    const r = b.recommend?.[i];
    if (!r) return null;
    const p = byIdx.get(r.idx);
    const pos = p?.pos ?? '?';
    const m = p ? multiplierFor(strategy, pos, 1) : 1.0;
    const ok = p
      ? isCompliant(strategy, {}, 1, pos, (by: number) => by - 1)
      : true;
    return {
      name: b.recNames?.[i] ?? String(r.idx),
      pos,
      score: r.score,
      m,
      adj: r.score * m,
      ok,
    };
  };

  return (
    <section class="sheet ss">
      <header class="sheet-head">
        <h1>
          Strategy Sheet · S16 · {label} — slot {s}
        </h1>
        <p class="sheet-meta">
          {strategy.blurb ? `${strategy.blurb} · ` : ''}priors, not handcuffs — a{' '}
          {strategy.overrideDelta ?? 20}+ pt off-plan edge is surfaced, never silently obeyed ·
          m(POS) multiplies the full score; it never adds points
        </p>
      </header>
      {!mc && (
        <div class="ss-warn">
          mc.json not built — run `node tools/simulate.mjs`, then `npm run build`. The modal-board
          section below is empty until then; the round plan and multiplier table are complete.
        </div>
      )}

      <div class="ss-h">Round plan — slot {s} of {league.teams} (dark = long-gap wait, κ {fmt1(lg.kappaLongGap)})</div>
      <div class="ss-gapstrip num">
        {rounds.map((r) => {
          const g = r - 1 < gaps.length ? gaps[r - 1] : null;
          return (
            <div class={`ss-gapcell ${g == null ? '' : longGap[r - 1] ? 'lg' : 'sg'}`}>
              R{r}
              <b>{picks[r - 1]}</b>
              <span class="g">{g == null ? 'END' : `+${g}`}</span>
            </div>
          );
        })}
      </div>

      <div class="ss-h">Score multipliers m(POS) by round — blank rounds are pure tier discipline</div>
      {posRows.length === 0 ? (
        <p class="ss-none">
          No multipliers — {label} is pure tier discipline in every round; only the constraints
          below (if any) shape the picks.
        </p>
      ) : (
        <div class="ss-mult num">
          <div class="ss-mrow ss-mhd">
            <span class="lbl" />
            {rounds.map((r) => (
              <span class={longGap[r - 1] ? 'lgr' : ''}>R{r}</span>
            ))}
          </div>
          {posRows.map((pos) => (
            <div class="ss-mrow" data-pos={pos}>
              <span class="lbl">{pos}</span>
              {rounds.map((r) => {
                const m = multiplierFor(strategy, pos, r);
                return (
                  <span class={`${m > 1 ? 'up' : m < 1 ? 'dn' : ''}${longGap[r - 1] ? ' lgr' : ''}`}>
                    {m === 1 ? '·' : m.toFixed(2)}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div class="ss-h">Hard constraints</div>
      <div class="ss-chips">
        {(strategy.constraints ?? []).length === 0 ? (
          <span class="ss-none">none — the shape above is the whole strategy</span>
        ) : (
          strategy.constraints.map((c: any) => <span class="ss-chip num">{constraintText(c)}</span>)
        )}
      </div>
      <div class="ss-override">
        <b>Override rule</b> — if the best off-plan player beats the best compliant player by more
        than {strategy.overrideDelta ?? 20} pts, take the player, not the plan. The app surfaces
        exactly this conflict; on paper, that gap is your permission slip.
      </div>

      <div class="ss-h">
        The {branchList.length || '—'} modal pick-{P1} boards (MC{mc ? `, ${mc.sims} sims` : ''}) —
        balanced top-3 through the {label} lens
      </div>
      <div class="ss-brrow ss-brhd">
        <span>p</span>
        <span>board by pick {P1}</span>
        <span>top-3: name POS balanced → ×m lens (⊘ = constraint refuses it)</span>
      </div>
      {branchList.map((b: any) => (
        <div class="ss-brrow num">
          <span>{Math.round(b.probability * 100)}%</span>
          <span>{b.narrative}</span>
          <span class="ss-top3">
            {[0, 1, 2]
              .map((i) => lensRec(b, i))
              .filter(Boolean)
              .map((r: any, i: number) => (
                <>
                  {i > 0 ? ' · ' : ''}
                  <b>{r.name}</b> {r.pos} {fmtInt(r.score)}
                  {r.m !== 1 ? ` → ${fmtInt(r.adj)} (×${r.m.toFixed(2)})` : ''}
                  {r.ok ? '' : ' ⊘'}
                </>
              ))}
          </span>
        </div>
      ))}
      {branchList.length === 0 && (
        <div class="ss-brrow">
          <span>—</span>
          <span>no branch data — build mc.json</span>
          <span />
        </div>
      )}
      <p class="ss-footnote">
        Honesty note: the branch recommendations above are computed by the BALANCED engine
        (mc.json); ×m re-weights those scores through this strategy first-order — it is not a
        re-simulation. The durable value of this sheet is the multiplier table and the round plan.
      </p>

      <Foot
        board={board}
        league={league}
        slot={s}
        pageId="S16"
        extra={[`strategy ${strategy.name}`, mismatch].filter(Boolean).join(' · ')}
      />
    </section>
  );
}
