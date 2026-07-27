// BigBoard.tsx — sheet S4/S5 "Master Big Board": 4 columns × 50 rows = 200
// players per page, 8.5pt/1.15, tabular numerals. Static-rendered by
// src/pages/sheets/[sheet].astro at build time with ZERO client JS; the same
// component hydrates in-app for the Plan B sheet, so paper and screen cannot
// disagree.
//
// Row = rank · tier letter (boxed) · tier-weighted left border · name (≤16
// chars via shared/format.js) · pos-rank · team · bye · half-PPR proj · VBD ·
// ADP · ADP-delta arrow · 8mm pen checkbox. Between tiers a labelled rule:
// "TIER B → C · cliff 21 pts" — the cliff is the VBD drop across the
// boundary (NOT raw eff: on a mixed-position board a QB's raw points tower
// over a RB's, so only the above-replacement drop says what waiting costs).
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
    <div class={`bb-row tier-${p.tierLetter.toLowerCase()}`}>
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

export default function BigBoard({ board, league }: { board: any; league: any }) {
  const players = [...board.players].sort((a, b) => a.overallRank - b.overallRank);
  const repl = replacementEff(players, board.baselinesPrior?.r ?? {});
  const pages = chunk(players, PER_PAGE);

  return (
    <>
      {pages.map((page, pi) => (
        <section class="sheet">
          <header class="sheet-head">
            <h1>Master Big Board · S4</h1>
            <p class="sheet-meta">
              {league.teams}-team half-PPR · slot {league.slot} · VBD on eff (injury-adjusted) ·
              ▲ market takes him later than my rank (value) · ▼ earlier (reach to get him) ·
              cliff = VBD pts lost across the tier break · ✗ = strike out by pen
            </p>
          </header>
          <div class="bb-grid">
            {chunk(page, ROWS_PER_COL).map((col) => (
              <div class="bb-col">
                <HeadRow />
                {col.map((p, i) => {
                  const prev = i > 0 ? col[i - 1] : null;
                  const breakHere = prev && prev.tierLetter !== p.tierLetter;
                  const vbd = (q: any) => q.eff - repl[q.pos];
                  return (
                    <>
                      {breakHere && (
                        <div class="bb-tierbreak">
                          Tier {prev.tierLetter} → {p.tierLetter} · cliff{' '}
                          {fmtInt(Math.max(0, vbd(prev) - vbd(p)))} pts
                        </div>
                      )}
                      <Row p={p} vbd={vbd(p)} />
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
