// tradefinder.js — trade SUGGESTIONS for the in-season platform: positional
// needs detection + a pruned search over 1-for-1 / 2-for-1 / 1-for-2
// packages against every other league roster, gated by a REALISM model of
// what the other manager would plausibly accept. PURE: no DOM, no fetch, no
// globals, no Date.now(); the league shape (slots/flexEligible) always rides
// in via ctx.
//
// All point math delegates to engine/week.js + engine/trade.js — this module
// only GENERATES, GATES and TIERS candidates. Every suggestion's numbers are
// evaluateTrade()'s numbers: the cheap screening pass computes
// rosValue(after) − rosValue(before) over the SAME arrays evaluateTrade
// builds, so the ranking metric equals a.rosDelta bit-for-bit and the full
// (expensive) evaluateTrade runs only for the final maxResults survivors.
//
// THE REALISM MODEL — a trade "can happen" only when the OTHER manager would
// plausibly say yes while I still squeeze value:
//
//   HARD GATES (failing either drops the candidate at ANY tier):
//   · STARTABILITY — the partner never gives their last startable player at
//     a position: for every position they send from, liveAfter ≥
//     min(liveBefore, slots[pos]) (live = windowed value > 0; players they
//     receive count), and they never go net-negative in live bodies at a
//     position they already NEED (positionalNeeds severity > 0).
//   · STAR SWAP — nobody trades a stud for quantity: the best player the
//     partner SENDS must be roughly matched by the best player they RECEIVE,
//     bestReceived ≥ STAR_RATIO × bestSent — FantasyCalc values when every
//     involved player has one, windowed-ros values otherwise.
//
//   LIKELIHOOD TIERS — managers think in MARKET value, not my projections;
//   theirMarket = Σ fc received − Σ fc sent, from the PARTNER's seat:
//   · 'likely'   — theirMarket ≥ 0 (they break even or win the market) AND
//                  theirGain ≥ −LIKELY_ROS_TOL_PER_WEEK × weeks in MY model
//                  (the tolerance DOUBLES when they receive a position they
//                  need — filling a hole buys goodwill).
//   · 'stretch'  — theirMarket ≥ −MARKET_TOL, where MARKET_TOL =
//                  max(MARKET_TOL_MIN, MARKET_TOL_PCT × larger package's
//                  market value): they pay at most a modest premium — the
//                  squeeze zone.
//   · 'longshot' — market says they lose beyond the tolerance, but MY model
//                  has the deal inside the classic fairness band
//                  (theirGain ≥ −fairness × myGain). The old "they win the
//                  market view" escape lives HERE at best — never 'likely'.
//   fc-null FALLBACK (any involved player without an fc value): the market
//   view is replaced by windowed-ros parity min(ΣW)/max(ΣW) of the two
//   packages — ≥ FALLBACK_PARITY_LIKELY plays the 'likely' market test,
//   ≥ FALLBACK_PARITY the 'stretch' one.

import { evaluateTrade } from './trade.js';
import { rosValue, weekEff } from './week.js';

/** Per-roster candidate cap: only the top N players by remaining-window
    value enter package generation. */
const CANDIDATE_CAP = 12;
/** Targeted mode force-includes the partner's top N target-pos players even
    when they fall outside CANDIDATE_CAP (a startable TE can be a roster's
    #13 asset). */
const TARGET_EXTRA = 3;
/** Band prune: the two sides' summed windowed values must be within a factor
    of 1/BAND_RATIO (= 2×) of each other. Deliberately broad — the realism
    gates are the real filter; the band only removes hopeless "scrub for
    stud" packages before any lineup math runs. */
const BAND_RATIO = 0.5;

// ---- Realism thresholds (exported: tests + UI copy read these) -----------

/** Market tolerance: fraction of the LARGER package's market value the
    partner will eat as a premium and still listen ('stretch'). */
export const MARKET_TOL_PCT = 0.08;
/** Absolute floor of the market tolerance (fc units) so tiny packages keep
    a non-zero band. */
export const MARKET_TOL_MIN = 2;
/** Star-swap guard: best player received must be ≥ this fraction of the
    best player sent (per side of the partner). */
export const STAR_RATIO = 0.65;
/** fc-null fallback: windowed-ros parity (min/max of the package sums)
    required to play the 'stretch' market test… */
export const FALLBACK_PARITY = 0.75;
/** …and the tighter parity required to play the 'likely' market test. */
export const FALLBACK_PARITY_LIKELY = 0.9;
/** 'likely' ros tolerance: pts per horizon week the partner may lose in MY
    model and still plausibly accept (doubled on a needs-fit). */
export const LIKELY_ROS_TOL_PER_WEEK = 1;

/** Tier ordering — higher is more plausible. */
export const TIER_RANK = { longshot: 0, stretch: 1, likely: 2 };

// ---- WHY fragments (engine names them so UI + tests share one source) ----

export const NOTE_THEY_GAIN = 'they gain too';
export const NOTE_MARKET = 'they win the market view';
export const NOTE_MARKET_FAIR = 'market fair';
export const NOTE_PREMIUM = 'they pay a small premium';
export const NOTE_MARKET_LOSS = 'market says they lose';
export const NOTE_VALUE_EVEN = 'near-even by value';
export const NOTE_VALUE_GAP = 'uneven by value';
export const NOTE_SURPLUS = 'from their depth';
/** Dynamic needs-fit fragment, e.g. "fills their TE need". */
export const noteNeedsFit = (pos) => `fills their ${pos} need`;

/** Remaining-window value of one player: Σ weekEff over fromWeek..endWeek.
    Used ONLY for pruning/gating/ranking candidates — never shown as a
    verdict. */
function windowSum(p, fromWeek, endWeek) {
  let s = 0;
  for (let w = fromWeek; w <= endWeek; w += 1) s += weekEff(p.weekly, w);
  return s;
}

/**
 * Weak spots on a roster — weekly-based. HEURISTIC (documented, deliberately
 * structural: no absolute point thresholds, so it is scoring-scale free):
 *
 *   For each position with dedicated starter slots (slots[pos] > 0, FLEX
 *   excluded), rank the roster's players at that position by average weekly
 *   points over ctx.fromWeek..ctx.endWeek (weekEff; byes/missing weeks count
 *   0). A LIVE BODY is a player whose window average is > 0 — the same
 *   startable-body convention engine/trade.js uses for depthDelta.
 *
 *   STARTER SHORTFALL — dedicated slots with no live body to fill them.
 *     Each missing starter adds 2 severity (an empty lineup hole).
 *   THIN DEPTH — flex-eligible positions are additionally expected to carry
 *     their share of the FLEX slots as bench cover:
 *     ceil(slots.FLEX / |flexEligible|) extra live bodies beyond the
 *     dedicated slots. A bench body only counts as COVER when its weekly
 *     average is at least HALF the average of the position's live starters —
 *     a 2-pt handcuff behind 14-pt starters is not cover. Each missing cover
 *     body adds 1 severity. Non-flex positions (QB/K/DST in this league) are
 *     never flagged for depth — nobody rosters a backup K; a genuine QB
 *     starter shortfall still fires.
 *
 * @param {object[]} myRoster players: {pos, weekly: number[]}
 * @param {{fromWeek: number, endWeek: number, slots: Object<string, number>,
 *          flexEligible: string[]}} ctx
 * @returns {{pos: string, severity: number}[]} severity > 0 only,
 *          sorted severity desc, then pos asc (deterministic).
 */
export function positionalNeeds(myRoster, ctx) {
  const { fromWeek, endWeek, slots, flexEligible } = ctx;
  const weeks = Math.max(1, endWeek - fromWeek + 1);
  const flexShare =
    flexEligible.length > 0 ? Math.ceil((slots.FLEX ?? 0) / flexEligible.length) : 0;

  const out = [];
  for (const [pos, need] of Object.entries(slots)) {
    if (pos === 'FLEX' || !(need > 0)) continue;
    const avgs = myRoster
      .filter((p) => p.pos === pos)
      .map((p) => windowSum(p, fromWeek, endWeek) / weeks)
      .filter((a) => a > 0)
      .sort((x, y) => y - x);
    const starters = avgs.slice(0, need);
    let severity = 2 * (need - starters.length);
    if (flexEligible.includes(pos) && flexShare > 0) {
      const bar =
        starters.length > 0 ? starters.reduce((a, b) => a + b, 0) / starters.length : 0;
      const cover = avgs.slice(need).filter((a) => a >= bar / 2).length;
      severity += Math.max(0, flexShare - cover);
    }
    if (severity > 0) out.push({ pos, severity });
  }
  return out.sort((x, y) => y.severity - x.severity || (x.pos < y.pos ? -1 : 1));
}

/**
 * Find plausible trades between my roster and every partner roster.
 *
 * CANDIDATE GENERATION + PRUNING (in order, before any full evaluation):
 *   1. Candidate cap — each roster contributes only its top CANDIDATE_CAP
 *      (12) players by remaining-window value (Σ weekEff fromWeek..endWeek);
 *      zero-value players never enter. Targeted mode additionally
 *      force-includes the partner's top TARGET_EXTRA (3) target-pos players.
 *   2. Package shapes — 1-for-1, 2-for-1 and 1-for-2 only (maxPackage caps
 *      a side at 2; 2-for-2 is never generated: combinatorial blowup for
 *      marginal realism). Pack stats (Σ/max windowed value, Σ/max fc) are
 *      precomputed ONCE per pack, so every per-pair gate below is O(1).
 *   3. Star-swap hard gate — bestReceived ≥ STAR_RATIO × bestSent for the
 *      partner (fc units when every involved player has fc, ros otherwise).
 *   4. Band prune — min(ΣrosW(give), ΣrosW(get)) ≥ BAND_RATIO × max(...).
 *   5. Market precheck — the perceived-value test bounds the BEST tier the
 *      candidate can reach, so tiers below opts.minTier are cut here,
 *      before any lineup math (with the default minTier 'stretch' every
 *      market-implausible pair dies without a single rosValue call).
 *   6. Startability hard gate — per-position live-body floors (see header).
 *   7. Cheap my-side screen — ONE rosValue(myAfter) per survivor; the
 *      resulting myGain is exactly evaluateTrade().a.rosDelta (identical
 *      arrays + math). Drop when myGain < minMyGain.
 *   8. theirGain + tier assignment (see header); drop when tier < minTier.
 * Full evaluateTrade (4 rosValue passes + playoff/week/depth/bye) then runs
 * ONLY for the top maxResults after ranking by tier desc (likely > stretch >
 * longshot), then myGain desc, then smaller package, then generation order —
 * deterministic.
 *
 * COMPLEXITY: with cap C = 12 and P partners, candidate packages per partner
 * ≤ C² (1-1) + 2·C·C(C−1)/2 (2-1 both ways) ≈ C³ ≈ 1.7k, so ≤ ~1.7k·P O(1)
 * gate checks (after the O(C·W) window sums), a rosValue only for gate
 * survivors, a second rosValue only for minMyGain survivors, and ≤
 * maxResults full evaluateTrade calls total. Measured on the real 2026
 * board+season data (12 × 16-man rosters, 11 partners, W1–17): ~145 ms
 * median for the default call, ~200 ms with minTier 'longshot' +
 * maxResults 30 — well inside the 1 s budget.
 *
 * @param {object[]} myRoster  players: {pos, weekly, fc?, bye?, ...} — the
 *        result's give/get arrays hold these SAME references (identity),
 *        ready to feed straight back into evaluateTrade / UI send-sets.
 * @param {{id: *, label?: string, roster: object[]}[]} partners
 * @param {{fromWeek: number, endWeek: number, playoffWeeks?: number[],
 *          slots: Object<string, number>, flexEligible: string[]}} ctx
 *        (same ctx shape evaluateTrade takes)
 * @param {{targetPos?: string|null, maxPackage?: number, maxResults?: number,
 *          minMyGain?: number, fairness?: number,
 *          minTier?: 'likely'|'stretch'|'longshot'}} opts
 *        targetPos set ⇒ every suggestion's GET side includes that position.
 *        minTier (default 'stretch') hides less-plausible tiers: 'stretch'
 *        shows likely+stretch, 'longshot' shows everything.
 * @returns {{partnerId: *, give: object[], get: object[], my: object,
 *            their: object, tier: 'likely'|'stretch'|'longshot',
 *            why: string[]}[]}  my/their are evaluateTrade SideResults
 *          (my = a = my side); `why` is ≤3 human fragments (needs-fit,
 *          market view, mutual gain / surplus) built from the NOTE_*
 *          constants above.
 */
export function findTrades(myRoster, partners, ctx, opts = {}) {
  const targetPos =
    typeof opts.targetPos === 'string' && opts.targetPos.length > 0 ? opts.targetPos : null;
  const maxPackage = Math.max(1, Math.min(2, opts.maxPackage ?? 2));
  const maxResults = opts.maxResults ?? 20;
  const minMyGain = opts.minMyGain ?? 2;
  const fairness = opts.fairness ?? 0.6;
  const minRank = TIER_RANK[opts.minTier] ?? TIER_RANK.stretch;
  const { fromWeek, endWeek, slots, flexEligible } = ctx;
  const weeks = Math.max(1, endWeek - fromWeek + 1);

  if (!Array.isArray(myRoster) || myRoster.length === 0) return [];
  if (!Array.isArray(partners) || partners.length === 0) return [];

  const wCache = new Map(); // player ref → windowed value (identity-keyed)
  const rosW = (p) => {
    let v = wCache.get(p);
    if (v === undefined) {
      v = windowSum(p, fromWeek, endWeek);
      wCache.set(p, v);
    }
    return v;
  };

  const candidatesOf = (roster, wantPos) => {
    const live = roster.filter((p) => rosW(p) > 0).sort((a, b) => rosW(b) - rosW(a));
    const picked = live.slice(0, CANDIDATE_CAP);
    if (wantPos) {
      const have = new Set(picked);
      let seen = 0;
      for (const p of live) {
        if (p.pos !== wantPos) continue;
        seen += 1;
        if (seen > TARGET_EXTRA) break;
        if (!have.has(p)) {
          picked.push(p);
          have.add(p);
        }
      }
    }
    return picked;
  };

  /** Pack + its screening stats, computed once: windowed sum/max and fc
      sum/max (fcAll false when any member lacks an fc value). */
  const packStats = (pack) => {
    let sumW = 0;
    let maxW = 0;
    let sumFc = 0;
    let maxFc = 0;
    let fcAll = true;
    for (const p of pack) {
      const w = rosW(p);
      sumW += w;
      if (w > maxW) maxW = w;
      if (p.fc && typeof p.fc.value === 'number') {
        sumFc += p.fc.value;
        if (p.fc.value > maxFc) maxFc = p.fc.value;
      } else {
        fcAll = false;
      }
    }
    return { pack, sumW, maxW, sumFc, maxFc, fcAll };
  };

  const packagesOf = (list) => {
    const packs = list.map((p) => packStats([p]));
    if (maxPackage >= 2) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          packs.push(packStats([list[i], list[j]]));
        }
      }
    }
    return packs;
  };

  const myBefore = rosValue(myRoster, fromWeek, endWeek, slots, flexEligible);
  const givePacks = packagesOf(candidatesOf(myRoster, null));

  const prelim = [];
  for (const partner of partners) {
    const roster = Array.isArray(partner?.roster) ? partner.roster : [];
    if (roster.length === 0) continue;
    let getPacks = packagesOf(candidatesOf(roster, targetPos));
    if (targetPos) getPacks = getPacks.filter((s) => s.pack.some((p) => p.pos === targetPos));
    if (getPacks.length === 0) continue;
    const theirBefore = rosValue(roster, fromWeek, endWeek, slots, flexEligible);

    // Partner-side realism inputs, once per partner: live-body counts per
    // position over the FULL roster (not the candidate slice) + their needs.
    const liveCount = {};
    for (const p of roster) {
      if (rosW(p) > 0) liveCount[p.pos] = (liveCount[p.pos] ?? 0) + 1;
    }
    const partnerNeeds = positionalNeeds(roster, ctx);
    const needSet = new Set(partnerNeeds.map((n) => n.pos));

    for (const g of givePacks) {
      for (const t of getPacks) {
        if (g.pack.length > 1 && t.pack.length > 1) continue; // no 2-for-2

        // STAR-SWAP hard gate — O(1) on pack stats, before everything else.
        const fcUnits = g.fcAll && t.fcAll;
        if (fcUnits ? g.maxFc < STAR_RATIO * t.maxFc : g.maxW < STAR_RATIO * t.maxW) continue;

        // Band prune.
        if (Math.min(g.sumW, t.sumW) < BAND_RATIO * Math.max(g.sumW, t.sumW)) continue;

        // PERCEIVED-VALUE precheck: bounds the best reachable tier, so
        // excluded tiers cut here — before any rosValue runs.
        let theirMarket = null; // partner's seat: Σ fc received − Σ fc sent
        let marketTol = 0;
        let marketOk;
        let marketLikely;
        if (fcUnits) {
          theirMarket = g.sumFc - t.sumFc;
          marketTol = Math.max(MARKET_TOL_MIN, MARKET_TOL_PCT * Math.max(g.sumFc, t.sumFc));
          marketOk = theirMarket >= -marketTol;
          marketLikely = theirMarket >= 0;
        } else {
          const parity = Math.min(g.sumW, t.sumW) / Math.max(g.sumW, t.sumW);
          marketOk = parity >= FALLBACK_PARITY;
          marketLikely = parity >= FALLBACK_PARITY_LIKELY;
        }
        if (!marketOk && minRank >= TIER_RANK.stretch) continue;
        if (!marketLikely && minRank >= TIER_RANK.likely) continue;

        // STARTABILITY hard gate: net live-body change per position from the
        // partner's seat (every pack member is live by construction).
        const netByPos = {};
        for (const p of t.pack) netByPos[p.pos] = (netByPos[p.pos] ?? 0) - 1;
        for (const p of g.pack) netByPos[p.pos] = (netByPos[p.pos] ?? 0) + 1;
        let startableOk = true;
        for (const pos in netByPos) {
          const net = netByPos[pos];
          if (net >= 0) continue;
          const before = liveCount[pos] ?? 0;
          // Never below the starter requirement (or below where they already
          // were), and never net-negative at a position they already need.
          if (before + net < Math.min(before, slots[pos] ?? 0) || needSet.has(pos)) {
            startableOk = false;
            break;
          }
        }
        if (!startableOk) continue;

        const give = g.pack;
        const get = t.pack;
        const myAfter = [...myRoster.filter((p) => !give.includes(p)), ...get];
        const myGain = rosValue(myAfter, fromWeek, endWeek, slots, flexEligible) - myBefore;
        if (!(myGain >= minMyGain)) continue;

        const theirAfter = [...roster.filter((p) => !get.includes(p)), ...give];
        const theirGain =
          rosValue(theirAfter, fromWeek, endWeek, slots, flexEligible) - theirBefore;

        // Needs-fit bonus: they RECEIVE a position they need (partnerNeeds is
        // severity-sorted, so the first hit is the worst hole).
        let needsFitPos = null;
        for (const n of partnerNeeds) {
          if (give.some((p) => p.pos === n.pos)) {
            needsFitPos = n.pos;
            break;
          }
        }

        // TIER (see header): likely → stretch → longshot, else drop.
        const rosTol = LIKELY_ROS_TOL_PER_WEEK * weeks * (needsFitPos ? 2 : 1);
        let tier;
        if (marketLikely && theirGain >= -rosTol) tier = 'likely';
        else if (marketOk) tier = 'stretch';
        else if (theirGain >= -fairness * myGain) tier = 'longshot';
        else continue;
        if (TIER_RANK[tier] < minRank) continue;

        // Surplus note: every position they send from keeps starters + 1
        // cover afterwards — they dealt from depth, not from the lineup.
        let surplus = true;
        for (const p of get) {
          const after = (liveCount[p.pos] ?? 0) + (netByPos[p.pos] ?? 0);
          if (after < (slots[p.pos] ?? 0) + 1) {
            surplus = false;
            break;
          }
        }

        prelim.push({
          partnerId: partner.id,
          roster,
          give,
          get,
          myGain,
          theirGain,
          theirMarket,
          marketTol,
          marketOk,
          fcUnits,
          tier,
          needsFitPos,
          surplus,
        });
      }
    }
  }

  prelim.sort(
    (x, y) =>
      TIER_RANK[y.tier] - TIER_RANK[x.tier] ||
      y.myGain - x.myGain ||
      x.give.length + x.get.length - (y.give.length + y.get.length),
  );

  return prelim.slice(0, maxResults).map((c) => {
    const { a, b } = evaluateTrade(
      { roster: myRoster, sends: c.give },
      { roster: c.roster, sends: c.get },
      ctx,
    );
    const why = [];
    if (c.needsFitPos) why.push(noteNeedsFit(c.needsFitPos));
    if (c.fcUnits) {
      if (c.theirMarket >= c.marketTol) why.push(NOTE_MARKET);
      else if (c.theirMarket >= 0) why.push(NOTE_MARKET_FAIR);
      else if (c.theirMarket >= -c.marketTol) why.push(NOTE_PREMIUM);
      else why.push(NOTE_MARKET_LOSS);
    } else {
      why.push(c.marketOk ? NOTE_VALUE_EVEN : NOTE_VALUE_GAP);
    }
    if (c.theirGain > 0) why.push(NOTE_THEY_GAIN);
    if (c.surplus) why.push(NOTE_SURPLUS);
    return {
      partnerId: c.partnerId,
      give: c.give,
      get: c.get,
      my: a,
      their: b,
      tier: c.tier,
      why: why.slice(0, 3),
    };
  });
}
