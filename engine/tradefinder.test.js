import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTrades,
  positionalNeeds,
  NOTE_THEY_GAIN,
  NOTE_MARKET,
} from './tradefinder.js';

// ---------------------------------------------------------------------------
// findTrades fixture — 2 partners, no FLEX so every lineup is hand-computable
// (constant weekly lines over 4 weeks: ros delta = weekly delta × 4).
//
// League: {RB: 2, TE: 1}. My before-lineup: 12 + 10 + 5 = 27/wk (ros 108).
// I have an RB surplus (myRB3 rides the bench) and a weak TE.
// ---------------------------------------------------------------------------

const SLOTS = { RB: 2, TE: 1 };
const CTX = { fromWeek: 1, endWeek: 4, playoffWeeks: [], slots: SLOTS, flexEligible: [] };

const mk = (name, pos, pts, fcVal) => ({
  name,
  pos,
  weekly: [pts, pts, pts, pts],
  fc: fcVal == null ? null : { value: fcVal },
});

const myRB1 = mk('myRB1', 'RB', 12, 40);
const myRB2 = mk('myRB2', 'RB', 10, 30);
const myRB3 = mk('myRB3', 'RB', 8, 25);
const myTE1 = mk('myTE1', 'TE', 5, 10);
const MY = [myRB1, myRB2, myRB3, myTE1];

// Alpha: thin at RB behind their RB1, but TWO startable TEs — the natural
// "my spare RB for their spare TE" partner. Before-lineup 11 + 4 + 8 = 23/wk.
const p1RB1 = mk('p1RB1', 'RB', 11, 35);
const p1RB2 = mk('p1RB2', 'RB', 4, 8);
const p1TE1 = mk('p1TE1', 'TE', 8, 22);
const p1TE2 = mk('p1TE2', 'TE', 6, 12);

// Beta: a stud RB they would only move in a consolidation deal.
// Before-lineup 15 + 9 + 7 = 31/wk.
const p2RB1 = mk('p2RB1', 'RB', 15, 50);
const p2RB2 = mk('p2RB2', 'RB', 9, 28);
const p2TE1 = mk('p2TE1', 'TE', 7, 18);

const PARTNERS = [
  { id: 1, label: 'Alpha', roster: [p1RB1, p1RB2, p1TE1, p1TE2] },
  { id: 2, label: 'Beta', roster: [p2RB1, p2RB2, p2TE1] },
];

const sameSet = (arr, expected) =>
  arr.length === expected.length && expected.every((p) => arr.includes(p));

const findResult = (results, give, get) =>
  results.find((r) => sameSet(r.give, give) && sameSet(r.get, get));

// ---------------------------------------------------------------------------
// findTrades
// ---------------------------------------------------------------------------

test('empty partners (or empty rosters) → []', () => {
  assert.deepEqual(findTrades(MY, [], CTX), []);
  assert.deepEqual(findTrades(MY, [{ id: 1, roster: [] }], CTX), []);
  assert.deepEqual(findTrades([], PARTNERS, CTX), []);
});

test('2-for-1 appears when it beats every 1-for-1', () => {
  const results = findTrades(MY, PARTNERS, CTX);
  assert.ok(results.length > 0);

  // Hand-computed best: send myRB2+myRB3 for Beta's stud. My RBs 15+12 vs
  // 12+10 → +5/wk → +20 ros. Beta loses 20 ros but wins the market view
  // (receives fc 55 for fc 50) — plausible via the market branch.
  const top = results[0];
  assert.equal(top.partnerId, 2);
  assert.ok(sameSet(top.give, [myRB2, myRB3]));
  assert.ok(sameSet(top.get, [p2RB1]));
  assert.equal(top.my.rosDelta, 20);
  assert.equal(top.their.rosDelta, -20);
  assert.equal(top.fairnessNote, NOTE_MARKET);

  // …and it outranks the best surviving 1-for-1.
  const best1for1 = results.find((r) => r.give.length === 1 && r.get.length === 1);
  assert.ok(best1for1);
  assert.ok(best1for1.my.rosDelta < top.my.rosDelta);
});

test('a lopsided trade the partner clearly loses is filtered', () => {
  const results = findTrades(MY, PARTNERS, CTX);
  // myRB3 (bench) for Beta's stud would be my best trade (+20) — but Beta
  // loses 28 ros AND the market view (fc 25 for fc 50): nobody accepts it.
  assert.equal(findResult(results, [myRB3], [p2RB1]), undefined);
  // Straight TE swap myTE1→p1TE1: Alpha's loss (−8) is just outside the
  // fairness band (−0.6 × 12 = −7.2) and they lose the market — filtered.
  assert.equal(findResult(results, [myTE1], [p1TE1]), undefined);
});

test('pruning never drops the known-best hand-computed trades', () => {
  const results = findTrades(MY, PARTNERS, CTX, { maxResults: 100 });
  // Overall best (2-for-1, +20) survives the candidate cap + band prune:
  assert.ok(findResult(results, [myRB2, myRB3], [p2RB1]));
  // Best 1-for-1 (spare RB for Alpha's spare TE, a mutual win) survives too:
  const winWin = findResult(results, [myRB3], [p1TE1]);
  assert.ok(winWin);
  assert.equal(winWin.partnerId, 1);
  assert.equal(winWin.my.rosDelta, 12); // TE 5→8 = +3/wk × 4
  assert.equal(winWin.their.rosDelta, 8); // RB 11+8 vs 11+4, TE 8→6 = +2/wk
  assert.equal(winWin.fairnessNote, NOTE_THEY_GAIN);
});

test('targeted mode only returns trades receiving the target pos', () => {
  const results = findTrades(MY, PARTNERS, CTX, { targetPos: 'TE' });
  assert.ok(results.length > 0);
  for (const r of results) {
    assert.ok(r.get.some((p) => p.pos === 'TE'), 'every GET side includes a TE');
  }
  // The RB consolidation blockbuster is out of scope in TE mode.
  assert.equal(findResult(results, [myRB2, myRB3], [p2RB1]), undefined);
  // The TE win-win is still in.
  assert.ok(findResult(results, [myRB3], [p1TE1]));
});

test('market-plausible trade carries the market fairness note', () => {
  const results = findTrades(MY, PARTNERS, CTX, { maxResults: 100 });
  // myRB3 for Beta's TE: Beta loses 28 ros (outside the band) but receives
  // fc 25 for fc 18 → plausible ONLY via the market branch.
  const r = findResult(results, [myRB3], [p2TE1]);
  assert.ok(r);
  assert.equal(r.my.rosDelta, 8); // TE 5→7 = +2/wk × 4
  assert.equal(r.their.rosDelta, -28); // their only TE walks; myRB3 rides pine
  assert.equal(r.fairnessNote, NOTE_MARKET);
});

test('minMyGain and maxResults are respected', () => {
  const strict = findTrades(MY, PARTNERS, CTX, { minMyGain: 15 });
  assert.equal(strict.length, 1); // only the +20 consolidation clears 15
  for (const r of strict) assert.ok(r.my.rosDelta >= 15);

  const capped = findTrades(MY, PARTNERS, CTX, { maxResults: 3 });
  assert.equal(capped.length, 3);
});

// ---------------------------------------------------------------------------
// positionalNeeds
// ---------------------------------------------------------------------------

const NSLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 };
const NCTX = { fromWeek: 1, endWeek: 4, slots: NSLOTS, flexEligible: ['RB', 'WR', 'TE'] };
const body = (pos, pts) => ({ pos, weekly: [pts, pts, pts, pts] });

test('positionalNeeds: thin depth fires; real cover and non-flex depth do not', () => {
  const roster = [
    body('QB', 18), // 1 live body, non-flex → no depth check → fine
    body('RB', 14),
    body('RB', 11),
    body('RB', 2), // bench scrub: 2 < ½ × 12.5 — NOT cover
    body('RB', 0), // zero line (injured/out): not a live body at all
    body('WR', 13),
    body('WR', 12),
    body('WR', 7), // 7 ≥ ½ × 12.5 = 6.25 → real cover → WR fine
    body('WR', 6),
    body('TE', 3), // lone TE, no cover behind → thin
  ];
  assert.deepEqual(positionalNeeds(roster, NCTX), [
    { pos: 'RB', severity: 1 },
    { pos: 'TE', severity: 1 },
  ]);
});

test('positionalNeeds: starter shortfall outranks thinness', () => {
  const roster = [
    // no QB at all, no TE at all
    body('RB', 14),
    body('RB', 11),
    body('RB', 2),
    body('WR', 13),
    body('WR', 12),
    body('WR', 7),
  ];
  assert.deepEqual(positionalNeeds(roster, NCTX), [
    { pos: 'TE', severity: 3 }, // missing starter (2) + missing flex cover (1)
    { pos: 'QB', severity: 2 }, // missing starter only — QB never depth-flagged
    { pos: 'RB', severity: 1 },
  ]);
});
