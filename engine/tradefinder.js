// tradefinder.js — trade SUGGESTIONS for the in-season platform: positional
// needs detection + a pruned search over 1-for-1 / 2-for-1 packages against
// every other league roster. PURE: no DOM, no fetch, no globals, no
// Date.now(); the league shape (slots/flexEligible) always rides in via ctx.
//
// All point math delegates to engine/week.js + engine/trade.js — this module
// only GENERATES and FILTERS candidates. Every suggestion's numbers are
// evaluateTrade()'s numbers: the cheap screening pass computes
// rosValue(after) − rosValue(before) over the SAME arrays evaluateTrade
// builds, so the ranking metric equals a.rosDelta bit-for-bit and the full
// (expensive) evaluateTrade runs only for the final maxResults survivors.

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
    of 1/BAND_RATIO (= 2×) of each other. Deliberately broad — the real filter
    is minMyGain + plausibility afterwards; the band only removes hopeless
    "scrub for stud" packages before any lineup math runs. */
const BAND_RATIO = 0.5;

export const NOTE_THEY_GAIN = 'they gain too';
export const NOTE_MARKET = 'they win the market view';
export const NOTE_FAIR_BAND = 'inside the fairness band';

/** Remaining-window value of one player: Σ weekEff over fromWeek..endWeek.
    Used ONLY for pruning/ranking candidates — never shown as a verdict. */
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
 *      marginal realism).
 *   3. Band prune — min(ΣrosW(give), ΣrosW(get)) ≥ BAND_RATIO ×
 *      max(...): sides within a factor of 2 of each other. No lineup math.
 *   4. Cheap my-side screen — ONE rosValue(myAfter) per survivor; the
 *      resulting myGain is exactly evaluateTrade().a.rosDelta (identical
 *      arrays + math). Drop when myGain < minMyGain.
 *   5. Plausibility — theirGain ≥ −fairness × myGain (they lose at most a
 *      fair fraction of what I win) OR their marketDelta ≥ 0 (they win the
 *      FantasyCalc view; null fc never satisfies this branch). A trade
 *      nobody accepts is noise.
 * Full evaluateTrade (4 rosValue passes + playoff/week/depth/bye) then runs
 * ONLY for the top maxResults after ranking by myGain desc (ties: smaller
 * package first, then generation order — deterministic).
 *
 * COMPLEXITY: with cap C = 12 and P partners, candidate packages per partner
 * ≤ C² (1-1) + 2·C·C(C−1)/2 (2-1 both ways) ≈ C³ ≈ 1.7k, so ≤ ~1.7k·P band
 * checks (O(1) each after the O(C·W) window sums), a rosValue only for band
 * survivors, a second rosValue only for minMyGain survivors, and ≤ maxResults
 * full evaluateTrade calls total.
 *
 * @param {object[]} myRoster  players: {pos, weekly, fc?, bye?, ...} — the
 *        result's give/get arrays hold these SAME references (identity),
 *        ready to feed straight back into evaluateTrade / UI send-sets.
 * @param {{id: *, label?: string, roster: object[]}[]} partners
 * @param {{fromWeek: number, endWeek: number, playoffWeeks?: number[],
 *          slots: Object<string, number>, flexEligible: string[]}} ctx
 *        (same ctx shape evaluateTrade takes)
 * @param {{targetPos?: string|null, maxPackage?: number, maxResults?: number,
 *          minMyGain?: number, fairness?: number}} opts
 *        targetPos set ⇒ every suggestion's GET side includes that position.
 * @returns {{partnerId: *, give: object[], get: object[], my: object,
 *            their: object, fairnessNote: string}[]}  my/their are
 *          evaluateTrade SideResults (my = a = my side), ranked myGain desc,
 *          capped at maxResults.
 */
export function findTrades(myRoster, partners, ctx, opts = {}) {
  const targetPos =
    typeof opts.targetPos === 'string' && opts.targetPos.length > 0 ? opts.targetPos : null;
  const maxPackage = Math.max(1, Math.min(2, opts.maxPackage ?? 2));
  const maxResults = opts.maxResults ?? 20;
  const minMyGain = opts.minMyGain ?? 2;
  const fairness = opts.fairness ?? 0.6;
  const { fromWeek, endWeek, slots, flexEligible } = ctx;

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

  const packagesOf = (list) => {
    const packs = list.map((p) => [p]);
    if (maxPackage >= 2) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) packs.push([list[i], list[j]]);
      }
    }
    return packs;
  };

  const packSum = (pack) => {
    let s = 0;
    for (const p of pack) s += rosW(p);
    return s;
  };

  const myBefore = rosValue(myRoster, fromWeek, endWeek, slots, flexEligible);
  const givePacks = packagesOf(candidatesOf(myRoster, null));

  const prelim = [];
  for (const partner of partners) {
    const roster = Array.isArray(partner?.roster) ? partner.roster : [];
    if (roster.length === 0) continue;
    let getPacks = packagesOf(candidatesOf(roster, targetPos));
    if (targetPos) getPacks = getPacks.filter((pk) => pk.some((p) => p.pos === targetPos));
    if (getPacks.length === 0) continue;
    const theirBefore = rosValue(roster, fromWeek, endWeek, slots, flexEligible);

    for (const give of givePacks) {
      const sGive = packSum(give);
      for (const get of getPacks) {
        if (give.length > 1 && get.length > 1) continue; // no 2-for-2
        const sGet = packSum(get);
        if (Math.min(sGive, sGet) < BAND_RATIO * Math.max(sGive, sGet)) continue;

        const myAfter = [...myRoster.filter((p) => !give.includes(p)), ...get];
        const myGain = rosValue(myAfter, fromWeek, endWeek, slots, flexEligible) - myBefore;
        if (!(myGain >= minMyGain)) continue;

        const theirAfter = [...roster.filter((p) => !get.includes(p)), ...give];
        const theirGain =
          rosValue(theirAfter, fromWeek, endWeek, slots, flexEligible) - theirBefore;

        // Partner's market view: Σ fc they receive (my give) − Σ fc they
        // send (their get); null when any involved fc is missing — the
        // explicit !== null below matters (null >= 0 is true in JS).
        let theirMarket = 0;
        for (const p of [...give, ...get]) {
          if (!p.fc || typeof p.fc.value !== 'number') {
            theirMarket = null;
            break;
          }
        }
        if (theirMarket !== null) {
          for (const p of give) theirMarket += p.fc.value;
          for (const p of get) theirMarket -= p.fc.value;
        }

        const plausible =
          theirGain >= -fairness * myGain || (theirMarket !== null && theirMarket >= 0);
        if (!plausible) continue;

        prelim.push({ partnerId: partner.id, roster, give, get, myGain, theirGain, theirMarket });
      }
    }
  }

  prelim.sort(
    (x, y) =>
      y.myGain - x.myGain ||
      x.give.length + x.get.length - (y.give.length + y.get.length),
  );

  return prelim.slice(0, maxResults).map((c) => {
    const { a, b } = evaluateTrade(
      { roster: myRoster, sends: c.give },
      { roster: c.roster, sends: c.get },
      ctx,
    );
    const fairnessNote =
      c.theirGain > 0
        ? NOTE_THEY_GAIN
        : c.theirMarket !== null && c.theirMarket >= 0
          ? NOTE_MARKET
          : NOTE_FAIR_BAND;
    return { partnerId: c.partnerId, give: c.give, get: c.get, my: a, their: b, fairnessNote };
  });
}
