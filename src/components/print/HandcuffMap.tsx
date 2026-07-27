// HandcuffMap.tsx — sheet S11 "Handcuff & Contingency Map". Slot-independent.
//
// Left: one row per NFL team whose LEAD RB sits inside the top 60 by ADP —
// lead → handcuff → second body, each with ADP. Depth is derived from the
// board (same-team RBs ordered by ADP), overridden by explicit pairs in
// overrides.json handcuffs ([starterIdx, handcuffIdx]) when depth-chart truth
// beats market order.
// Right strip: "if I draft X, his handcuff is Y at ~pick Z" — the actionable
// sentence, one per lead back.
// Bottom: blank MY RBs / MY HANDCUFF / GOT HIM? table for the live pen pass.

import { abbrevName, fmtAdp } from '../../../shared/format.js';
import Foot from './Foot';

export default function HandcuffMap({
  board,
  league,
  overrides,
}: {
  board: any;
  league: any;
  overrides?: any;
}) {
  const byIdx = new Map<number, any>(board.players.map((p: any) => [p.idx, p]));
  const cuffOverride = new Map<number, number>(
    (overrides?.handcuffs ?? []).map((pair: number[]) => [pair[0], pair[1]])
  );

  const byTeam: Record<string, any[]> = {};
  for (const p of board.players) {
    if (p.pos === 'RB' && p.adp?.mu != null) (byTeam[p.team] ??= []).push(p);
  }
  for (const depth of Object.values(byTeam)) depth.sort((a, b) => a.adp.mu - b.adp.mu);

  const rows = Object.entries(byTeam)
    .filter(([, depth]) => depth[0].adp.mu <= 60)
    .map(([team, depth]) => {
      const lead = depth[0];
      const ovrIdx = cuffOverride.get(lead.idx);
      const cuff = (ovrIdx != null ? byIdx.get(ovrIdx) : null) ?? depth[1] ?? null;
      const second = depth.find((p) => p !== lead && p !== cuff) ?? null;
      return { team, lead, cuff, second, overridden: ovrIdx != null };
    })
    .sort((a, b) => a.lead.adp.mu - b.lead.adp.mu);

  const name = (p: any, max = 16) => (p ? abbrevName(p.name, max) : '—');

  return (
    <section class="sheet hc">
      <header class="sheet-head">
        <h1>Handcuff &amp; Contingency Map · S11</h1>
        <p class="sheet-meta">
          NFL teams whose lead RB is top-60 by ADP · depth = same-team RBs by market order,
          override pairs from prep marked * · (n) = ADP · ~pick Z = when the cuff goes
        </p>
      </header>
      <div class="hc-wrap">
        <div>
          <div class="hc-row hc-hd">
            <span>Tm</span>
            <span>Lead back</span>
            <span>Handcuff</span>
            <span>Second body</span>
          </div>
          {rows.map((r) => (
            <div class="hc-row">
              <span>{r.team}</span>
              <span>
                {name(r.lead)} <span class="hc-adp num">({fmtAdp(r.lead.adp.mu)})</span>
              </span>
              <span>
                {name(r.cuff)}
                {r.overridden ? '*' : ''}{' '}
                {r.cuff ? <span class="hc-adp num">({fmtAdp(r.cuff.adp?.mu)})</span> : null}
              </span>
              <span>
                {name(r.second)}{' '}
                {r.second ? <span class="hc-adp num">({fmtAdp(r.second.adp?.mu)})</span> : null}
              </span>
            </div>
          ))}
        </div>
        <div class="hc-strip">
          <div class="hc-hd2">If I draft him → get this cuff</div>
          <ul>
            {rows.slice(0, 16).map((r) => (
              <li>
                {name(r.lead, 14)} → <b>{name(r.cuff, 14)}</b>
                {r.cuff?.adp?.mu != null ? (
                  <>
                    {' '}
                    at ~pick <span class="num">{Math.round(r.cuff.adp.mu)}</span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div class="hc-blank">
        <div class="hc-brow hc-bhd">
          <span>MY RBs</span>
          <span>MY HANDCUFF</span>
          <span>GOT HIM?</span>
        </div>
        <div class="hc-brow" />
        <div class="hc-brow" />
        <div class="hc-brow" />
        <div class="hc-brow" />
        <div class="hc-brow" />
        <div class="hc-brow" />
        <div class="hc-brow" />
        <div class="hc-brow" />
      </div>
      <Foot board={board} league={league} pageId="S11" />
    </section>
  );
}
