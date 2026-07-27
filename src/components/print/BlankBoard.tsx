// BlankBoard.tsx — sheet S13 "Blank Draft Board". SLOT-DEPENDENT, LANDSCAPE.
// The pure-analog fallback, and how runs are spotted by eye.
//
// teams columns × rounds rows in EXPLICIT mm (cells are fixed-mm, never
// percentages, so the board is dimensionally identical on A4 and Letter).
// Cell width is the planned 21mm; cell HEIGHT is 11mm, not the planned 15mm —
// 16 rounds × 15mm = 240mm cannot fit the 210mm-high landscape safe box, and
// one page beats two (the whole point is seeing runs at a glance). 11mm still
// takes a handwritten surname.
//
// My column: tinted + outlined, and EVERY one of my cells is preprinted with
// its overall pick number (derived via engine/picks.js pickNumber — never the
// slot-8 constants). Snake arrows on every round row show pick direction.
// Header row: blank write-in lines for opponent names; my column pre-labelled.

import { pickNumber } from '../../../engine/picks.js';
import Foot from './Foot';

export default function BlankBoard({
  board,
  league,
  slot,
}: {
  board: any;
  league: any;
  slot?: number;
}) {
  const s = slot ?? league.slot;
  const T = league.teams;
  const R = league.rounds;
  const snake = league.snake !== false;
  const cols = Array.from({ length: T }, (_, i) => i + 1);
  const rows = Array.from({ length: R }, (_, i) => i + 1);
  const colTemplate = { 'grid-template-columns': `7mm repeat(${T}, 21mm)` };

  return (
    <section class="sheet landscape blk">
      <header class="sheet-head">
        <h1>Blank Draft Board · S13 · Slot {s}</h1>
        <p class="sheet-meta">
          write every pick in its cell — a position run is a visible streak · arrows = snake
          direction · my column tinted, my cells preprinted with their overall pick number ·
          header line = opponent name
        </p>
      </header>

      <div class="blk-hrow" style={colTemplate}>
        <span class="blk-corner" />
        {cols.map((c) => (
          <span class={`blk-hcell${c === s ? ' blk-mine' : ''}`}>
            {c === s ? (
              <b>ME · slot {s}</b>
            ) : (
              <>
                <span class="blk-slotno num">{c}</span>
                <span class="blk-line" />
              </>
            )}
          </span>
        ))}
      </div>
      {rows.map((r) => {
        const ltr = !snake || r % 2 === 1; // odd rounds pick left→right
        return (
          <div class="blk-row" style={colTemplate}>
            <span class="blk-rlabel">
              <span class="num">R{r}</span>
              <span class="blk-arrow">{ltr ? '→' : '←'}</span>
            </span>
            {cols.map((c) => (
              <span class={`blk-cell${c === s ? ' blk-mine' : ''}`}>
                {c === s ? <span class="blk-pick num">{pickNumber(r, s, T, snake)}</span> : null}
              </span>
            ))}
          </div>
        );
      })}

      <Foot board={board} league={league} slot={s} pageId="S13" />
    </section>
  );
}
