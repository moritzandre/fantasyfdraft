// BigBoard.tsx — sheet S4/S5 "Master Big Board": 4 columns × 50 rows = 200
// players per page, 8.5pt/1.15, tabular numerals. Static-rendered by
// src/pages/sheets/[sheet].astro at build time with ZERO client JS; the same
// component hydrates in-app for the Plan B sheet, so paper and screen cannot
// disagree.
//
// Row = rank · tier letter (boxed) · tier-weighted left border · name (≤16
// chars via shared/format.js) · pos-rank · team · bye · half-PPR proj · VBD ·
// ADP · ADP-delta arrow · 5mm pen checkbox (shrunk from 8mm after the Phase-1
// laser proof clipped names; the reclaimed 3mm went to the name cell — see
// .bb-row in print.css). Between tiers a labelled rule:
// "RB TIER B → C · cliff 21 pts" — rendered where a POSITION starts a new
// tier in overall order, from that position's board.tiers record (tiers are
// per-position: on the mixed-position overall list adjacent letters differ
// nearly every row, so a naive letter-change rule would print ~35 breaks in
// the top 60 and shove ~14 rows off every column). Weak boundaries
// (TierSep < 1.0) print as the dashed "treat as one tier" rule.
//
// Encoding discipline: ALL tier/position channels come from tokens.css custom
// properties (via the .tier-* / .pos-* classes in print.css) — no hardcoded
// colors here. Tier is readable three independent ways in grayscale:
// luminance band + the letter + left-border weight.
//
// VBD = eff − eff(replacement), replacement = the baselinesPrior.r[pos]-th
// player at that position (the flex-adjusted last starter), clamped to the
// worst listed player when the board is shorter than r_p (the 20-player
// fixture). All VBD runs on eff, never raw projections — bench depth prices
// as a call option, not zero.

import { abbrevName, fmtInt, fmtAdp, adpArrow } from '../../../shared/format.js';

const ROWS_PER_COL = 50;
const COLS_PER_PAGE = 4;
const PER_PAGE = ROWS_PER_COL * COLS_PER_PAGE;

/** Slice `arr` into consecutive chunks of `n`. */
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** eff of the last starter per position, from baselinesPrior.r (clamped). */
function replacementEff(players: any[], r: Record<string, number>) {
  const byPos: Record<string, number[]> = {};
  for (const p of players) (byPos[p.pos] ??= []).push(p.eff);
  for (const effs of Object.values(byPos)) effs.sort((a, b) => b - a);
  const repl: Record<string, number> = {};
  for (const [pos, effs] of Object.entries(byPos)) {
    const idx = Math.min((r[pos] ?? effs.length) - 1, effs.length - 1);
    repl[pos] = effs[Math.max(0, idx)];
  }
  return repl;
}

function Row({ p, vbd }: { p: any; vbd: number }) {
  const delta = p.adp?.mu != null ? p.adp.mu - p.overallRank : null;
  return (
    <div class={`bb-row tier-${p.tierLetter.toLowerCase()}`} data-pos={p.pos}>
      <span class="num bb-rank">{p.overallRank}</span>
      <span class="bb-tier">{p.tierLetter}</span>
      <span class="bb-name">{abbrevName(p.name)}</span>
      <span class={`num bb-pos pos-${p.pos.toLowerCase()}`}>
        {p.pos[0]}
        {p.posRank}
      </span>
      <span class="bb-pos">{p.team}</span>
      <span class="num bb-num">{p.bye}</span>
      <span class="num bb-num">{fmtInt(p.proj.halfPpr)}</span>
      <span class="num bb-num">{fmtInt(vbd)}</span>
      <span class="num bb-num">{fmtAdp(p.adp?.mu)}</span>
      <span class="bb-arrow">{adpArrow(delta)}</span>
      <span class="bb-cb">
        <span />
      </span>
    </div>
  );
}

function HeadRow() {
  return (
    <div class="bb-row bb-headrow">
      <span class="bb-rank">#</span>
      <span>T</span>
      <span>Player</span>
      <span>Pos</span>
      <span>Tm</span>
      <span class="bb-num">By</span>
      <span class="bb-num">Pts</span>
      <span class="bb-num">VBD</span>
      <span class="bb-num">ADP</span>
      <span class="bb-arrow">±</span>
      <span class="bb-cb">✗</span>
    </div>
  );
}

export default function BigBoard({
  board,
  league,
  skillOnly = false,
}: {
  board: any;
  league: any;
  /** Drop K/DST rows (they live on the S15 K/DST sheet). Default false —
      the classic S4/S5 output is byte-identical without the prop. */
  skillOnly?: boolean;
}) {
  const players = [...board.players]
    .filter((p) => !skillOnly || (p.pos !== 'K' && p.pos !== 'DST'))
    .sort((a, b) => a.overallRank - b.overallRank);
  const repl = replacementEff(players, board.baselinesPrior?.r ?? {});
  const pages = chunk(players, PER_PAGE);

  // Tier-break rules, keyed by the player idx that OPENS a new tier of his
  // position in overall order. Label + cliff + weak flag come from the
  // PREVIOUS tier's record (its cliffPoints/tierSep describe this boundary).
  const tierRec = new Map<string, any>(
    (board.tiers ?? []).map((t: any) => [`${t.pos}:${t.tier}`, t])
  );
  const breakBefore = new Map<number, { label: string; weak: boolean }>();
  const lastTierByPos: Record<string, number> = {};
  for (const p of players) {
    const prevTier = lastTierByPos[p.pos];
    if (prevTier != null && p.tier !== prevTier) {
      const prev = tierRec.get(`${p.pos}:${prevTier}`);
      breakBefore.set(p.idx, {
        label: `${p.pos} tier ${prev?.letter ?? '?'} → ${p.tierLetter} · cliff ${fmtInt(prev?.cliffPoints)} pts`,
        weak: (prev?.tierSep ?? 1) < 1.0,
      });
    }
    lastTierByPos[p.pos] = p.tier;
  }

  return (
    <>
      {pages.map((page, pi) => (
        <section class="sheet">
          <header class="sheet-head">
            <h1>Master Big Board{skillOnly ? ' — skill only' : ''} · S4</h1>
            <p class="sheet-meta">
              {league.teams}-team half-PPR · slot {league.slot} · VBD on eff (injury-adjusted) ·
              ▲ market takes him later than my rank (value) · ▼ earlier (reach to get him) ·
              cliff = VBD pts lost across the tier break · ✗ = strike out by pen
              {skillOnly ? ' · K/DST removed — see the S15 K/DST sheet' : ''}
            </p>
          </header>
          <div class="bb-grid">
            {chunk(page, ROWS_PER_COL).map((col) => (
              <div class="bb-col">
                <HeadRow />
                {col.map((p) => {
                  const brk = breakBefore.get(p.idx);
                  return (
                    <>
                      {brk && (
                        <div class={`bb-tierbreak${brk.weak ? ' weak' : ''}`}>{brk.label}</div>
                      )}
                      <Row p={p} vbd={p.eff - repl[p.pos]} />
                    </>
                  );
                })}
              </div>
            ))}
          </div>
          <footer class="sheet-foot">
            snapshot {board.buildHash} · {String(board.builtAt ?? '').slice(0, 10)} · slot{' '}
            {league.slot} · {league.teams}-team half-PPR · p{pi + 1}/{pages.length} · S4
          </footer>
        </section>
      ))}
    </>
  );
}
