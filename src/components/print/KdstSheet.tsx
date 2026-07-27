// KdstSheet.tsx — sheet S15 "K / DST": kickers and defenses ONLY, fully
// separated from the skill sheets. One portrait page, SLOT-DEPENDENT for a
// single reason: the reminder box carries the slot's ACTUAL last-two pick
// numbers, computed with myPicks(league).slice(-2) — the K/DST scheduling
// invariant, never constants.
//
// Layout: the reminder banner up top, then two clean tier tables side by
// side (K left, DST right): posRank · tier letter (boxed) · name · team ·
// bye · half-PPR proj · ADP · pen checkbox. Rows carry the standard tier-*
// classes, so the three redundant grayscale tier channels (luminance band +
// letter + left-border weight) work here exactly as on the big board.
// Between tiers the labelled break rule; TierSep is not printed — K/DST
// tiers don't earn the analysis (their VORP doesn't either).
//
// Styles: .kd-* block in print.css (one block per sheet). tokens.css owns
// every tier/pos channel; no hardcoded colors here.

import { abbrevName, fmtAdp, fmtInt } from '../../../shared/format.js';
import { myPicks, roundForPick } from '../../../engine/picks.js';
import Foot from './Foot';

function PosTable({ board, pos, label }: { board: any; pos: string; label: string }) {
  const players = board.players
    .filter((p: any) => p.pos === pos)
    .sort((a: any, b: any) => a.posRank - b.posRank);
  return (
    <div class="kd-table">
      <div class="kd-title">{label}</div>
      <div class="kd-row kd-hd">
        <span class="kd-num">#</span>
        <span>T</span>
        <span>Player</span>
        <span>Tm</span>
        <span class="kd-num">By</span>
        <span class="kd-num">Pts</span>
        <span class="kd-num">ADP</span>
        <span class="kd-cbh">✗</span>
      </div>
      {players.map((p: any, i: number) => (
        <>
          {i > 0 && p.tier !== players[i - 1].tier && (
            <div class="kd-tierbreak">
              {pos} tier {players[i - 1].tierLetter} → {p.tierLetter}
            </div>
          )}
          <div class={`kd-row tier-${p.tierLetter.toLowerCase()}`} data-pos={p.pos}>
            <span class="num kd-num">{p.posRank}</span>
            <span class="kd-tier">{p.tierLetter}</span>
            <span class="kd-name">{abbrevName(p.name, 20)}</span>
            <span>{p.team}</span>
            <span class="num kd-num">{p.bye}</span>
            <span class="num kd-num">{fmtInt(p.proj?.halfPpr)}</span>
            <span class="num kd-num">{fmtAdp(p.adp?.mu)}</span>
            <span class="kd-cb">
              <span />
            </span>
          </div>
        </>
      ))}
    </div>
  );
}

export default function KdstSheet({
  board,
  league,
  slot,
}: {
  board: any;
  league: any;
  slot?: number;
}) {
  const s = slot ?? league.slot;
  const lg = { teams: league.teams, slot: s, rounds: league.rounds, snake: league.snake !== false };
  const [pA, pB] = myPicks(lg).slice(-2); // the K/DST rule — always the last two
  return (
    <section class="sheet kd">
      <header class="sheet-head">
        <h1>K / DST Tiers · S15 · Slot {s}</h1>
        <p class="sheet-meta">
          kickers and defenses only — they never share a page with skill players · tier = luminance
          band + letter + left-border weight (survives B&amp;W) · ✗ = strike out by pen
        </p>
      </header>
      <div class="kd-remind">
        K + DST = YOUR LAST TWO PICKS — pick {pA} (R{roundForPick(pA, league.teams)}) and pick{' '}
        {pB} (R{roundForPick(pB, league.teams)}). Never earlier.
        <span class="kd-remind-sub">
          Their VORP never beats a bench dart before then. One of each, order by whoever tops these
          tables when pick {pA} arrives — then stream by matchup all season.
        </span>
      </div>
      <div class="kd-cols">
        <PosTable board={board} pos="K" label="Kickers" />
        <PosTable board={board} pos="DST" label="Defenses / Special Teams" />
      </div>
      <Foot board={board} league={league} slot={s} pageId="S15" />
    </section>
  );
}
