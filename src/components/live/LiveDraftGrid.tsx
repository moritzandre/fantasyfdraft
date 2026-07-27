// LiveDraftGrid.tsx — the live rounds×teams draft board (screen sibling of
// the print BlankBoard, percent-based instead of fixed-mm). Position runs
// show up as vertical color streaks, exactly like the paper S13 board fills
// in. My column is tinted; the cursor cell pulses. Display-only — cells are
// not tap targets, so 52px row height applies, not the 56px control rule.

import { useMemo } from 'preact/hooks';
import { pickNumber } from '../../../engine/picks.js';
import type { Board, DraftState } from '../../state/store';
import { abbrevName } from '../../../shared/format.js';
import { seatName } from '../../state/opponents';
import type { OpponentsFile } from '../../state/opponents';

export default function LiveDraftGrid({
  s,
  board,
  opp,
}: {
  s: DraftState;
  board: Board;
  opp: OpponentsFile | null;
}) {
  const N = s.league.teams;
  const R = s.league.rounds;

  const byPickNo = useMemo(() => {
    const m = new Map<number, any>();
    for (const p of s.picks) {
      if (p.idx >= 0 && board.players[p.idx]) m.set(p.n, board.players[p.idx]);
    }
    return m;
  }, [s.rev]);

  return (
    <div class="mt-2 overflow-x-auto rounded-lg border border-app-border">
      <table class="w-full border-collapse text-center text-xs">
        <thead>
          <tr class="bg-app-surface">
            <th class="sticky left-0 z-10 bg-app-surface px-1 py-2 text-app-dim">R</th>
            {Array.from({ length: N }, (_, i) => i + 1).map((slot) => (
              <th
                class={`min-w-16 px-1 py-2 ${
                  slot === s.league.slot ? 'lv-grid-me font-extrabold' : 'font-bold'
                }`}
              >
                {seatName(opp, slot, s.league.slot)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: R }, (_, r) => r + 1).map((round) => (
            <tr class="border-t border-app-border">
              <td class="num sticky left-0 z-10 bg-app-surface px-1 py-1 font-bold text-app-dim">
                {round}
              </td>
              {Array.from({ length: N }, (_, i) => i + 1).map((slot) => {
                const n = pickNumber(round, slot, N, s.league.snake);
                const player = byPickNo.get(n);
                const isCursor = n === s.pickCursor;
                return (
                  <td
                    class={`h-[52px] px-1 align-middle ${
                      slot === s.league.slot ? 'lv-grid-me' : ''
                    } ${player ? `lv-cell-${player.pos.toLowerCase()}` : ''} ${
                      isCursor ? 'lv-grid-cursor' : ''
                    }`}
                  >
                    {player ? (
                      <span class={`inline-block max-w-full truncate lv-pos-${player.pos.toLowerCase()}`}>
                        {abbrevName(player.name)}
                      </span>
                    ) : (
                      <span class="num text-app-dim/60">{n}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
