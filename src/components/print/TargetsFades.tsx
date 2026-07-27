// TargetsFades.tsx — sheet S10 "Targets / Fades / Late Darts", three columns.
// MILDLY slot-dependent: columns 1–2 are pure board-vs-market, but the LATE
// DARTS windows are anchored to MY last-five pick numbers, so the sheet lives
// on the slotted route (sheets/s<slot>/targets-fades).
//
//   col 1 MY GUYS  — market takes him ≥8 picks LATER than my rank
//                    (adp.mu − overallRank ≥ 8); the prep-tab tag reason (from
//                    overrides.json) prints verbatim under the name if present,
//                    sorted by expected round so the list reads in draft order.
//   col 2 FADES    — market takes him ≥8 picks EARLIER than my rank
//                    (overallRank − adp.mu ≥ 8): to get him I must reach.
//   col 3 LATE DARTS — players whose ADP falls in the pick windows around my
//                    last five picks, grouped per pick number.
//
// Bottom strip: ADP arbitrage — |FFC − ESPN ADP divergence| > 15, the spots
// where the two markets themselves disagree (room-dependent value).
// 6mm write-in boxes under each column for the night-before pen pass.

import { abbrevName, fmtAdp, fmtSigned } from '../../../shared/format.js';
import { myPicks } from '../../../engine/picks.js';
import Foot from './Foot';

const SKIP = new Set(['K', 'DST']);

export default function TargetsFades({
  board,
  league,
  slot,
  overrides,
}: {
  board: any;
  league: any;
  slot?: number;
  overrides?: any;
}) {
  const s = slot ?? league.slot;
  const teams = league.teams;
  const picks = myPicks({ teams, slot: s, rounds: league.rounds, snake: league.snake !== false });
  const tags = overrides?.tags ?? {};
  const withAdp = board.players.filter((p: any) => p.adp?.mu != null && !SKIP.has(p.pos));

  const myGuys = withAdp
    .filter((p: any) => p.adp.mu - p.overallRank >= 8 && p.adp.mu <= 170)
    .sort((a: any, b: any) => b.adp.mu - b.overallRank - (a.adp.mu - a.overallRank))
    .slice(0, 30)
    .sort((a: any, b: any) => a.adp.mu - b.adp.mu);

  const fades = withAdp
    .filter((p: any) => p.overallRank - p.adp.mu >= 8 && p.overallRank <= 170)
    .sort((a: any, b: any) => b.overallRank - b.adp.mu - (a.overallRank - a.adp.mu))
    .slice(0, 30)
    .sort((a: any, b: any) => a.adp.mu - b.adp.mu);

  // Late-dart windows: midpoints between my last five picks; the first window
  // opens half a round before the first of them, the last runs past the draft.
  const late = picks.slice(-5);
  const bounds = [late[0] - Math.floor(teams / 2)];
  for (let i = 0; i < late.length - 1; i++) bounds.push((late[i] + late[i + 1]) / 2);
  bounds.push(teams * league.rounds + 30);
  const groups = late.map((pick: number, i: number) => ({
    pick,
    round: Math.ceil(pick / teams),
    players: withAdp
      .filter((p: any) => p.adp.mu >= bounds[i] && p.adp.mu < bounds[i + 1])
      .sort((a: any, b: any) => b.adp.mu - b.overallRank - (a.adp.mu - a.overallRank))
      .slice(0, 7),
  }));

  const arb = withAdp
    .filter((p: any) => Math.abs(p.adp.divergence ?? 0) > 15 && p.adp.mu <= 140)
    .sort(
      (a: any, b: any) => Math.abs(b.adp.divergence ?? 0) - Math.abs(a.adp.divergence ?? 0)
    )
    .slice(0, 10);

  const Row = ({ p, delta }: { p: any; delta: number }) => {
    const reason = tags[String(p.idx)]?.reason;
    return (
      <div class="tf-row" data-pos={p.pos}>
        <span class="tf-name">{abbrevName(p.name, 20)}</span>
        <span>
          {p.pos}
          {p.posRank}
        </span>
        <span class="num">R{Math.ceil(p.adp.mu / teams)}</span>
        <span class="num tf-delta">{fmtSigned(delta)}</span>
        {reason ? <span class="tf-reason">{reason}</span> : null}
      </div>
    );
  };

  const WriteIns = () => (
    <>
      <div class="tf-writein" />
      <div class="tf-writein" />
      <div class="tf-writein" />
    </>
  );

  return (
    <section class="sheet tf">
      <header class="sheet-head">
        <h1>Targets / Fades / Late Darts · S10 · Slot {s}</h1>
        <p class="sheet-meta">
          ± = my rank vs market ADP in picks (＋ = market takes him later — value) · R# = expected
          round at ADP · late darts grouped by MY pick numbers · blank rules = write-ins
        </p>
      </header>
      <div class="tf-cols">
        <div>
          <div class="tf-col-h">My guys — market is late on them</div>
          {myGuys.map((p: any) => (
            <Row p={p} delta={p.adp.mu - p.overallRank} />
          ))}
          <WriteIns />
        </div>
        <div>
          <div class="tf-col-h">Fades — market is early, let someone reach</div>
          {fades.map((p: any) => (
            <Row p={p} delta={p.adp.mu - p.overallRank} />
          ))}
          <WriteIns />
        </div>
        <div>
          <div class="tf-col-h">Late darts — by my pick windows</div>
          {groups.map((g: any) => (
            <>
              <div class="tf-gh num">
                MY PICK {g.pick} · R{g.round}
              </div>
              {g.players.map((p: any) => (
                <div class="tf-row" data-pos={p.pos}>
                  <span class="tf-name">{abbrevName(p.name, 20)}</span>
                  <span>
                    {p.pos}
                    {p.posRank}
                  </span>
                  <span class="num">{fmtAdp(p.adp.mu)}</span>
                  <span class="num tf-delta">{fmtSigned(p.adp.mu - p.overallRank)}</span>
                </div>
              ))}
            </>
          ))}
          <WriteIns />
        </div>
      </div>
      <div class="tf-arb">
        <div class="tf-col-h">ADP arbitrage — FFC vs ESPN disagree by &gt;15 picks</div>
        <p class="tf-arb-list">
          {arb.length === 0
            ? 'none flagged at this snapshot'
            : arb.map((p: any, i: number) => (
                <>
                  {i > 0 ? ' · ' : ''}
                  <b>{abbrevName(p.name, 18)}</b> FFC {fmtAdp(p.adp.mu)}/ESPN{' '}
                  {fmtAdp(p.adp.espnMu)}
                </>
              ))}
        </p>
      </div>
      <Foot board={board} league={league} slot={s} pageId="S10" />
    </section>
  );
}
