// ByeGrid.tsx — sheet S12 "Bye-Week & SoS Grid". Slot-independent, LANDSCAPE.
//
// 32 NFL teams × weeks 1–18. Bye cells carry the 45° hatch (never color-only).
// Two SoS shading bands from board.teams: weeks 1–13 tinted by sosEarly
// tercile, weeks 15–17 by sosPlayoff tercile (darker = tougher by
// market-implied spread; the raw number prints in its own column so the shade
// never has to be trusted alone). Right margin: how many of MY top-100 board
// players play for each NFL team — where my draft capital is concentrated.
// Bottom quarter: an 18-col × 10-row working grid (one row per starter slot)
// whose columns ALIGN with the week grid above — hand-write drafted players
// into their bye column; three marks in one column is a clash you can SEE.

import Foot from './Foot';

const WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);
const SLOT_LABELS = ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLX1', 'FLX2', 'K', 'DST'];

/** Tercile class for value v within values; darker = larger (tougher). */
function terciler(values: number[]): (v: number) => string {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0 || sorted[0] === sorted[n - 1]) return () => '';
  const q1 = sorted[Math.floor(n / 3)];
  const q2 = sorted[Math.floor((2 * n) / 3)];
  return (v: number) => (v >= q2 ? 'sos-hard' : v >= q1 ? 'sos-mid' : '');
}

export default function ByeGrid({ board, league }: { board: any; league: any }) {
  const teams = Object.entries(board.teams ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)) as [
    string,
    any,
  ][];
  const clsEarly = terciler(teams.map(([, t]) => t.sosEarly ?? 0));
  const clsPlayoff = terciler(teams.map(([, t]) => t.sosPlayoff ?? 0));

  const myCount: Record<string, number> = {};
  for (const p of board.players) {
    if (p.overallRank <= 100) myCount[p.team] = (myCount[p.team] ?? 0) + 1;
  }

  return (
    <section class="sheet landscape bg">
      <header class="sheet-head">
        <h1>Bye-Week &amp; SoS Grid · S12</h1>
        <p class="sheet-meta">
          hatch = bye · shading = market-implied SoS tercile, darker = tougher (weeks 1–13 from
          sosEarly, 15–17 from sosPlayoff; raw numbers in the E/P columns) · T100 = my top-100
          board players on that team · bottom grid: hand-write drafted players into their bye
          column — 3 in one column = clash
        </p>
      </header>

      <div class="bg-row bg-hd">
        <span>Tm</span>
        <span class="num">E</span>
        {WEEKS.map((w) => (
          <span class="num">{w}</span>
        ))}
        <span class="num">P</span>
        <span class="num">T100</span>
      </div>
      {teams.map(([abbr, t]) => (
        <div class="bg-row">
          <span class="bg-team">{abbr}</span>
          <span class="num bg-sosnum">{t.sosEarly?.toFixed(1) ?? '—'}</span>
          {WEEKS.map((w) => {
            const bye = w === t.bye;
            const cls = bye
              ? 'bg-bye'
              : w <= 13
                ? clsEarly(t.sosEarly ?? 0)
                : w >= 15 && w <= 17
                  ? clsPlayoff(t.sosPlayoff ?? 0)
                  : '';
            return <span class={`bg-cell ${cls}`}>{bye ? 'B' : ''}</span>;
          })}
          <span class="num bg-sosnum">{t.sosPlayoff?.toFixed(1) ?? '—'}</span>
          <span class="num bg-count">{myCount[abbr] ?? ''}</span>
        </div>
      ))}

      <div class="bgw">
        <div class="bg-row bg-hd">
          <span class="bgw-label">MY TEAM ↓</span>
          <span />
          {WEEKS.map((w) => (
            <span class="num">{w}</span>
          ))}
          <span />
          <span />
        </div>
        {SLOT_LABELS.map((label) => (
          <div class="bg-row bgw-row">
            <span class="bgw-label">{label}</span>
            <span />
            {WEEKS.map(() => (
              <span class="bgw-cell" />
            ))}
            <span />
            <span />
          </div>
        ))}
      </div>

      <Foot board={board} league={league} pageId="S12" />
    </section>
  );
}
