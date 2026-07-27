// TierSheet.tsx — sheets S6–S9, the positional tier sheets (RB / WR / TE /
// QB+K+DST). Slot-independent, one portrait page each.
//
// Per-tier cards headed "TIER B — 5 players — cliff to C: 18 pts (TierSep
// 1.4)" straight from board.tiers — the cliff-in-points is the entire answer
// to "do I need one NOW". If board.tiers still carry provisional:true (the MC
// workstream's Ckmeans overwrite hasn't landed) the tiers render anyway and
// the footer says "provisional tiers".
//
// Boundary with TierSep < 1.0 → dashed WEAK BREAK rule ("treat as one tier"):
// that break is projection noise, not signal.
//
// Discriminator column per position (the one number that adjudicates within
// the tier):
//   RB  projected receptions — sub-45 hatched (the half-PPR two-down-back
//       filter made physical; see the hard rule: no sub-45-rec RB in R1–3)
//   WR  targets (tgt)
//   TE  gap-to-next-TE in eff points (positional cliff, player-resolution)
//   QB  gap-to-QB18 in eff points (how far above the streaming floor)
//
// The QB sheet (kdst=true) appends a compressed 12-line K/DST block — "last
// two rounds only", no per-player analysis, because their VORP doesn't earn it.
//
// Page budget: rows are capped per position (deep catch-all tiers are cut with
// a "+N more" note) so each sheet stays one page — .sheet clips overflow.

import { abbrevName, fmtInt, fmtAdp, fmtSigned } from '../../../shared/format.js';
import Foot from './Foot';

// Page budget per position sheet, in ROW UNITS (one unit ≈ one 8pt row).
// Card chrome spends from the same budget — each tier card costs 2 units
// (header + margin) and each weak-break rule 1 — so the sheet stays one page
// whether board.tiers arrives as many small tiers or one merged blob.
// Deep catch-all tiers get cut with a "+N more" note.
const CAPS: Record<string, number> = { RB: 58, WR: 58, TE: 40, QB: 32 };
const DISC_LABEL: Record<string, string> = { RB: 'Rec', WR: 'Tgt', TE: 'Δ next', QB: 'Δ QB18' };

/** Discriminator cell for `p`; posPlayers is the position sorted by posRank. */
function disc(p: any, pos: string, posPlayers: any[]): { text: string; hatch: boolean } {
  if (pos === 'RB') {
    const rec = p.proj?.rec;
    return { text: fmtInt(rec), hatch: rec != null && rec < 45 };
  }
  if (pos === 'WR') return { text: fmtInt(p.proj?.tgt), hatch: false };
  if (pos === 'TE') {
    const next = posPlayers[p.posRank]; // sorted by posRank ⇒ [posRank-1] is p
    return { text: next ? fmtInt(p.eff - next.eff) : '—', hatch: false };
  }
  const qb18 = posPlayers[17];
  return { text: qb18 ? fmtSigned(p.eff - qb18.eff) : '—', hatch: false };
}

function TierRows({ board, pos }: { board: any; pos: string }) {
  const posPlayers = board.players
    .filter((p: any) => p.pos === pos)
    .sort((a: any, b: any) => a.posRank - b.posRank);
  const byIdx = new Map<number, any>(board.players.map((p: any) => [p.idx, p]));
  const tiers = [...board.tiers]
    .filter((t: any) => t.pos === pos)
    .sort((a: any, b: any) => a.tier - b.tier);

  let budget = CAPS[pos] ?? 40;
  const cards: any[] = [];
  for (let i = 0; i < tiers.length && budget > 3; i++) {
    const t = tiers[i];
    const weak = i > 0 && tiers[i - 1].tierSep < 1.0;
    budget -= 2 + (weak ? 1 : 0); // card header + margin (+ weak-break rule)
    const members = t.members
      .map((idx: number) => byIdx.get(idx))
      .filter(Boolean)
      .sort((a: any, b: any) => a.posRank - b.posRank);
    const shown = members.slice(0, budget);
    budget -= shown.length;
    cards.push({ t, next: tiers[i + 1] ?? null, shown, more: members.length - shown.length });
  }

  return (
    <>
      <div class="tc-row tc-hd">
        <span>{pos} rk</span>
        <span>Player</span>
        <span>Tm</span>
        <span>By</span>
        <span class="tc-num">Pts</span>
        <span class="tc-num">ADP</span>
        <span class="tc-num">{DISC_LABEL[pos]}</span>
        <span class="tc-cbh">✗</span>
      </div>
      {cards.map(({ t, next, shown, more }: any, i: number) => (
        <>
          {i > 0 && cards[i - 1].t.tierSep < 1.0 && (
            <div class="tc-break">
              weak break (TierSep {cards[i - 1].t.tierSep.toFixed(1)}) — treat as one tier
            </div>
          )}
          <div class="tier-card">
            <div class={`tc-head tier-${t.letter.toLowerCase()}`}>
              Tier {t.letter} — {t.members.length} players
              {next
                ? ` — cliff to ${next.letter}: ${fmtInt(t.cliffPoints)} pts (TierSep ${t.tierSep.toFixed(1)})`
                : ''}
            </div>
            {shown.map((p: any) => {
              const d = disc(p, pos, posPlayers);
              return (
                <div class="tc-row">
                  <span class="num">
                    {pos}
                    {p.posRank}
                  </span>
                  <span class="tc-name">{abbrevName(p.name, 22)}</span>
                  <span>{p.team}</span>
                  <span class="num">{p.bye}</span>
                  <span class="num tc-num">{fmtInt(p.proj?.halfPpr)}</span>
                  <span class="num tc-num">{fmtAdp(p.adp?.mu)}</span>
                  <span class={`num tc-num${d.hatch ? ' hatch45' : ''}`}>{d.text}</span>
                  <span class="tc-cb">
                    <span />
                  </span>
                </div>
              );
            })}
            {more > 0 && <div class="tc-more">+ {more} more below the printed line</div>}
          </div>
        </>
      ))}
    </>
  );
}

/** Compressed 12-line K/DST block: two columns, "last two rounds only". */
function KdstBlock({ board }: { board: any }) {
  const top = (pos: string) =>
    board.players
      .filter((p: any) => p.pos === pos)
      .sort((a: any, b: any) => a.posRank - b.posRank)
      .slice(0, 12);
  const ks = top('K');
  const dsts = top('DST');
  return (
    <div class="kdst-block">
      <div class="tc-head">K / DST — last two rounds only, never earlier</div>
      {ks.map((k: any, i: number) => {
        const d = dsts[i];
        return (
          <div class="kdst-row">
            <span class="num">{i + 1}</span>
            <span class="tc-name">
              {abbrevName(k?.name ?? '—', 20)} {k ? `· ${k.team}` : ''}
            </span>
            <span class="num tc-num">{fmtAdp(k?.adp?.mu)}</span>
            <span class="num">{i + 1}</span>
            <span class="tc-name">{d ? d.name : '—'}</span>
            <span class="num tc-num">{fmtAdp(d?.adp?.mu)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function TierSheet({
  board,
  league,
  positions,
  kdst,
  pageId,
  title,
}: {
  board: any;
  league: any;
  positions: string[];
  kdst?: boolean;
  pageId: string;
  title: string;
}) {
  const provisional = board.tiers.some(
    (t: any) => (positions.includes(t.pos) || (kdst && (t.pos === 'K' || t.pos === 'DST'))) && t.provisional
  );
  return (
    <section class="sheet ts">
      <header class="sheet-head">
        <h1>
          {title} · {pageId}
        </h1>
        <p class="sheet-meta">
          cliff = pts lost across the tier break (do I need one NOW) · TierSep &lt; 1.0 = break is
          projection noise, treat as one tier · {DISC_LABEL[positions[0]]} ={' '}
          {positions[0] === 'RB'
            ? 'projected receptions, sub-45 hatched (fails the half-PPR R1–3 filter)'
            : positions[0] === 'WR'
              ? 'projected targets'
              : positions[0] === 'TE'
                ? 'eff-pts gap to the next TE'
                : 'eff-pts above QB18 (streaming floor)'}{' '}
          · ✗ = strike out by pen
        </p>
      </header>
      {positions.map((pos) => (
        <TierRows board={board} pos={pos} />
      ))}
      {kdst && <KdstBlock board={board} />}
      <Foot
        board={board}
        league={league}
        pageId={pageId}
        extra={provisional ? 'provisional tiers' : undefined}
      />
    </section>
  );
}
