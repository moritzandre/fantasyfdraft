// OpsCard.tsx — sheet S1 "Draft-Day Ops Card". SLOT-DEPENDENT, portrait, 11pt
// base. The one page that lives on top of the stack: league summary, MY PICKS
// as a grid (each cell pick# / round / gap-after, short-gap banded light,
// long-gap dark), THE RULES at 14pt GENERATED from the gap structure (never
// prose — the plan amendment: rule copy is templated from gapsAfter() so every
// slot 1..N gets ITS rules, not slot 8's), emergency procedures, 60mm notes.
//
// Rule generation:
//   maxGap − minGap ≥ 6  → the asymmetry pair, with the round lists computed:
//     "Rounds 1, 3, 5 … 15 (gap 9): take the best player"
//     "Rounds 2, 4, 6 … 14 (gap 15): take the one that will be gone"
//   else                 → "Gaps nearly even (11/13) — pure tier discipline"
//   turn slots (1 / N)   → "You pick in PAIRS — plan two picks at once"
//   always               → never-chase-a-run + "K and DST at picks X and Y,
//                          never earlier" with X,Y = myPicks(league).slice(-2)
//                          (derived, never the slot-8 constants 176/185).

import { myPicks, gapsAfter } from '../../../engine/picks.js';
import Foot from './Foot';

/** "1, 3, 5 … 15" when the list is a clean arithmetic run, plain join else. */
function fmtRounds(rs: number[]): string {
  if (rs.length > 4) {
    const d = rs[1] - rs[0];
    if (rs.every((v, i) => v === rs[0] + i * d)) {
      return `${rs[0]}, ${rs[1]}, ${rs[2]} … ${rs[rs.length - 1]}`;
    }
  }
  return rs.join(', ');
}

const ROSTER_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST', 'BN'];

export default function OpsCard({ board, league, slot }: { board: any; league: any; slot?: number }) {
  const s = slot ?? league.slot;
  const lg = { teams: league.teams, slot: s, rounds: league.rounds, snake: league.snake !== false };
  const picks = myPicks(lg);
  const gaps = gapsAfter(picks);
  const minG = Math.min(...gaps);
  const maxG = Math.max(...gaps);
  const [kPick, dstPick] = picks.slice(-2);

  const rules: string[] = [];
  if (maxG - minG >= 6) {
    const shortRounds: number[] = [];
    const longRounds: number[] = [];
    gaps.forEach((g, i) => (g === maxG ? longRounds : shortRounds).push(i + 1));
    rules.push(`Rounds ${fmtRounds(shortRounds)} (gap ${minG}): take the best player`);
    rules.push(`Rounds ${fmtRounds(longRounds)} (gap ${maxG}): take the one that will be gone`);
  } else {
    rules.push(`Gaps nearly even (${minG}/${maxG}) — pure tier discipline`);
  }
  if (s === 1 || s === league.teams) rules.push('You pick in PAIRS — plan two picks at once');
  rules.push('Never chase a run — a run makes the other positions cheaper');
  rules.push(`K and DST at picks ${kPick} and ${dstPick}, never earlier`);

  const roster = ROSTER_ORDER.filter((k) => league.roster?.[k]).map(
    (k) => `${league.roster[k]}${k}`
  );

  return (
    <section class="sheet oc">
      <header class="sheet-head">
        <h1>Draft-Day Ops Card · S1 · Slot {s}</h1>
        <p class="sheet-meta">
          the top page of the stack — picks, rules, and what to do when something breaks
        </p>
      </header>

      <div class="oc-section">
        <div class="oc-h">League</div>
        <p class="oc-league">
          {league.teams}-team half-PPR · snake · drafting from slot {s} · {league.rounds} rounds ·{' '}
          {league.teams * league.rounds} total picks
          <br />
          Roster {roster.join(' / ')} · flex: {(league.flexEligible ?? []).join('/')} · tie
          threshold ε {league.epsilonPoints} pts · strategy override at {league.overrideDelta} pts
        </p>
      </div>

      <div class="oc-section">
        <div class="oc-h">My picks — gap-after banded (light = short wait, dark = long wait)</div>
        <div class="oc-grid">
          {picks.map((p, i) => {
            const g = i < gaps.length ? gaps[i] : null;
            const long = g != null && g === maxG && maxG !== minG;
            const cls = g == null ? 'oc-end' : long ? 'oc-long' : 'oc-short';
            return (
              <div class={`oc-cell ${cls}`}>
                <div class="oc-pick num">{p}</div>
                <div class="oc-round">R{i + 1}</div>
                <div class="oc-gap num">{g == null ? 'END' : `gap ${g}`}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div class="oc-section">
        <div class="oc-h">The rules</div>
        <ul class="oc-rules">
          {rules.map((r) => (
            <li>{r}</li>
          ))}
        </ul>
      </div>

      <div class="oc-section">
        <div class="oc-h">Emergency procedures</div>
        <ol class="oc-emergency">
          <li>
            <b>Shortlist blank / engine error</b> → open PLAN B: the printed tier sheet on-screen,
            drafted players struck through. Keep drafting from tiers.
          </li>
          <li>
            <b>App or iPad dead</b> → this card + Big Board + Blank Board. Strike names by pen;
            runs show up as streaks on the blank board.
          </li>
          <li>
            <b>Sync dot grey</b> → sync died, nothing else changed. Tap picks in manually;
            re-align with the Pick # stepper — two taps.
          </li>
          <li>
            <b>Looked away N picks</b> → Catch-up mode: multi-select everyone gone, one commit, in
            ADP order.
          </li>
          <li>
            <b>Mis-tap</b> → UNDO, top bar, always enabled. Never rebuild state from memory — read
            the pick log.
          </li>
          <li>
            <b>On the clock and frozen</b> → best remaining tier letter at the thinnest position.
            No K/DST before pick {kPick}.
          </li>
        </ol>
      </div>

      <div class="oc-section">
        <div class="oc-h">Notes</div>
        <div class="oc-notes" />
      </div>

      <Foot board={board} league={league} slot={s} pageId="S1" />
    </section>
  );
}
