import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTrades,
  positionalNeeds,
  NOTE_MARKET,
  NOTE_MARKET_LOSS,
  NOTE_PREMIUM,
  NOTE_THEY_GAIN,
  NOTE_VALUE_EVEN,
  noteNeedsFit,
  TIER_RANK,
} from './tradefinder.js';

// ---------------------------------------------------------------------------
// Main fixture — 2 partners, no FLEX so every lineup is hand-computable
// (constant weekly lines over 4 weeks: ros delta = weekly delta × 4; the
// 'likely' ros tolerance = 1 pt/wk × 4 weeks = 4, doubled to 8 on needs-fit).
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

// Alpha: ONE live RB for two RB slots (positionalNeeds: RB severity 2) and a
// TE surplus — the natural "my spare RB for their spare TE" partner.
// Before-lineup 11 + 0 + 8 = 19/wk (ros 76).
const p1RB1 = mk('p1RB1', 'RB', 11, 35);
const p1TE1 = mk('p1TE1', 'TE', 8, 22);
const p1TE2 = mk('p1TE2', 'TE', 6, 12);
const p1TE3 = mk('p1TE3', 'TE', 4, 6);

// Beta: owns the market-stud RB and exactly one startable TE.
// Before-lineup 15 + 9 + 7 = 31/wk (ros 124). No positional needs.
const p2RB1 = mk('p2RB1', 'RB', 15, 50);
const p2RB2 = mk('p2RB2', 'RB', 9, 28);
const p2TE1 = mk('p2TE1', 'TE', 7, 18);

const PARTNERS = [
  { id: 1, label: 'Alpha', roster: [p1RB1, p1TE1, p1TE2, p1TE3] },
  { id: 2, label: 'Beta', roster: [p2RB1, p2RB2, p2TE1] },
];

const ALL_TIERS = { minTier: 'longshot', maxResults: 100 };

const sameSet = (arr, expected) =>
  arr.length === expected.length && expected.every((p) => arr.includes(p));

const findResult = (results, give, get) =>
  results.find((r) => sameSet(r.give, give) && sameSet(r.get, get));

// ---------------------------------------------------------------------------
// findTrades — hard gates
// ---------------------------------------------------------------------------

test('empty partners (or empty rosters) → []', () => {
  assert.deepEqual(findTrades(MY, [], CTX), []);
  assert.deepEqual(findTrades(MY, [{ id: 1, roster: [] }], CTX), []);
  assert.deepEqual(findTrades([], PARTNERS, CTX), []);
});

test('star-swap guard: stud-for-two-fillers is gone at every tier', () => {
  const results = findTrades(MY, PARTNERS, CTX, ALL_TIERS);
  // The old finder ranked "myRB2+myRB3 for Beta's stud" #1 (+20 ros for me,
  // fc 55 for 50 = "they win the market view"). Best received fc is 30 <
  // 0.65 × 50 = 32.5 — nobody trades their #1 RB for two mid pieces.
  assert.equal(findResult(results, [myRB2, myRB3], [p2RB1]), undefined);
  // A lone bench filler for the stud dies the same way (25 < 32.5).
  assert.equal(findResult(results, [myRB3], [p2RB1]), undefined);
  // But a package HEADLINED by a near-stud (fc 40 ≥ 32.5) may pass the guard:
  const headlined = findResult(results, [myRB1, myRB3], [p2RB1]);
  assert.ok(headlined, 'star guard admits a package with a matching headliner');
});

test('startability: stripping the only startable TE is hard-rejected even market-fair', () => {
  const results = findTrades(MY, PARTNERS, CTX, ALL_TIERS);
  // myRB3 (fc 25) for Beta's only TE (fc 18): Beta WINS the market view by
  // +7 — the old finder accepted it via the market escape. Beta would end
  // with zero startable TEs: hard-rejected at every tier.
  assert.equal(findResult(results, [myRB3], [p2TE1]), undefined);
  // Same when the TE leaves inside a 1-for-2 package.
  assert.equal(findResult(results, [myRB1], [p2RB1, p2TE1]), undefined);
  // And Beta never sends BOTH RBs for one (2 slots, 1 live body left).
  assert.equal(findResult(results, [myRB1], [p2RB1, p2RB2]), undefined);
});

// ---------------------------------------------------------------------------
// findTrades — tiers
// ---------------------------------------------------------------------------

test("mutually-need-fitting fair trade ranks 'likely' and #1", () => {
  const results = findTrades(MY, PARTNERS, CTX);
  assert.ok(results.length > 0);

  // Hand-computed best: my bench RB (8/wk, fc 25) for Alpha's spare TE
  // (8/wk, fc 22). Me: TE 5→8 = +3/wk → +12 ros. Alpha: fills the empty RB
  // slot AND keeps a TE starter — 11+8+6 = 25 vs 19 → +24 ros; market +3.
  const top = results[0];
  assert.equal(top.partnerId, 1);
  assert.ok(sameSet(top.give, [myRB3]));
  assert.ok(sameSet(top.get, [p1TE1]));
  assert.equal(top.tier, 'likely');
  assert.equal(top.my.rosDelta, 12);
  assert.equal(top.their.rosDelta, 24);
  assert.ok(top.why.includes(noteNeedsFit('RB')), 'why names the RB need it fills');
  assert.ok(top.why.includes(NOTE_MARKET));
  assert.ok(top.why.includes(NOTE_THEY_GAIN));
});

test('tiers are ordered likely > stretch, myGain ranks within a tier', () => {
  const results = findTrades(MY, PARTNERS, CTX);
  // No longshots at the default minTier.
  assert.ok(results.every((r) => r.tier !== 'longshot'));
  // Tier ranks never increase down the list.
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(TIER_RANK[results[i].tier] <= TIER_RANK[results[i - 1].tier]);
  }
  // The +12 stretch consolidation ranks BELOW a +4 likely trade.
  const stretch12 = findResult(results, [myRB1, myRB3], [p2RB1]);
  assert.ok(stretch12);
  assert.equal(stretch12.tier, 'stretch');
  assert.equal(stretch12.my.rosDelta, 12);
  assert.equal(stretch12.their.rosDelta, -12);
  const likely4 = findResult(results, [myRB2], [p1TE1]);
  assert.ok(likely4);
  assert.equal(likely4.tier, 'likely');
  assert.equal(likely4.my.rosDelta, 4);
  assert.ok(results.indexOf(stretch12) > results.indexOf(likely4));
});

test("modest-premium trade (my +8, their market −4%) is 'stretch'", () => {
  // Dedicated fixture at market scale: I upgrade my TE by 2/wk (+8 ros);
  // the partner eats a 4-point market premium on a 100-value package —
  // inside MARKET_TOL = max(2, 8% × 100) = 8, but not ≥ 0 ⇒ never 'likely'.
  const sRB1 = mk('sRB1', 'RB', 12, 400);
  const sRB2 = mk('sRB2', 'RB', 10, 300);
  const sTE1 = mk('sTE1', 'TE', 5, 96);
  const tRB1 = mk('tRB1', 'RB', 11, 380);
  const tRB2 = mk('tRB2', 'RB', 9, 250);
  const tTE1 = mk('tTE1', 'TE', 7, 100);
  const tTE2 = mk('tTE2', 'TE', 6, 90);
  const results = findTrades(
    [sRB1, sRB2, sTE1],
    [{ id: 9, roster: [tRB1, tRB2, tTE1, tTE2] }],
    CTX,
  );
  const r = findResult(results, [sTE1], [tTE1]);
  assert.ok(r, 'premium trade shows at the default minTier');
  assert.equal(r.tier, 'stretch');
  assert.equal(r.my.rosDelta, 8);
  assert.equal(r.their.marketDelta, -4); // −4% of the 100-value package
  assert.ok(r.why.includes(NOTE_PREMIUM));
});

test("longshot: market says they lose, my model says fair — hidden by default", () => {
  // 1 RB for 2 TEs: Alpha nets +16 ros in MY model but pays 9 on a 34-value
  // market package (beyond MARKET_TOL 2.72) — old-style plausible, market no.
  const withLongshots = findTrades(MY, PARTNERS, CTX, ALL_TIERS);
  const ls = findResult(withLongshots, [myRB3], [p1TE1, p1TE2]);
  assert.ok(ls);
  assert.equal(ls.tier, 'longshot');
  assert.equal(ls.my.rosDelta, 12);
  assert.equal(ls.their.rosDelta, 16);
  assert.ok(ls.why.includes(NOTE_MARKET_LOSS));

  // Default (minTier 'stretch') and 'likely' hide it.
  assert.equal(findResult(findTrades(MY, PARTNERS, CTX), [myRB3], [p1TE1, p1TE2]), undefined);
  const likelyOnly = findTrades(MY, PARTNERS, CTX, { minTier: 'likely', maxResults: 100 });
  assert.ok(likelyOnly.every((r) => r.tier === 'likely'));
  assert.equal(findResult(likelyOnly, [myRB1, myRB3], [p2RB1]), undefined); // stretch gone too
});

test('a trade failing even the longshot band is dropped entirely', () => {
  const results = findTrades(MY, PARTNERS, CTX, ALL_TIERS);
  // Straight TE swap myTE1→p1TE1: Alpha loses the market by 12 (tol 2) AND
  // loses 8 ros — outside −fairness × myGain = −7.2. Nobody accepts.
  assert.equal(findResult(results, [myTE1], [p1TE1]), undefined);
});

// ---------------------------------------------------------------------------
// findTrades — fc-null fallback (windowed-ros parity replaces the market)
// ---------------------------------------------------------------------------

test('fc-null fallback: parity plays the market test', () => {
  const nRB1 = mk('nRB1', 'RB', 12, null);
  const nRB2 = mk('nRB2', 'RB', 10, null);
  const nRB3 = mk('nRB3', 'RB', 8, null);
  const nTE1 = mk('nTE1', 'TE', 5, null);
  const qRB1 = mk('qRB1', 'RB', 11, null);
  const qTE1 = mk('qTE1', 'TE', 8, null);
  const qTE2 = mk('qTE2', 'TE', 6, null);
  const me = [nRB1, nRB2, nRB3, nTE1];
  const them = [{ id: 5, roster: [qRB1, qTE1, qTE2] }];

  // Equal-window swap (32 vs 32, parity 1 ≥ 0.9) that fills their RB hole:
  // 'likely' through the fallback path, flagged as value-based.
  const results = findTrades(me, them, CTX);
  const r = findResult(results, [nRB3], [qTE1]);
  assert.ok(r);
  assert.equal(r.tier, 'likely');
  assert.equal(r.my.rosDelta, 12);
  assert.equal(r.their.rosDelta, 24);
  assert.equal(r.my.marketDelta, null); // fc never fabricated
  assert.ok(r.why.includes(NOTE_VALUE_EVEN));
  assert.ok(r.why.includes(noteNeedsFit('RB')));

  // Parity 20/32 = 0.625 < 0.75 AND outside the longshot ros band → gone
  // everywhere (my weak TE for their starter, nothing real coming back).
  const all = findTrades(me, them, CTX, ALL_TIERS);
  assert.equal(findResult(all, [nTE1], [qTE1]), undefined);
});

// ---------------------------------------------------------------------------
// findTrades — pruning, options
// ---------------------------------------------------------------------------

test('pruning never drops the known-best hand-computed trades', () => {
  const results = findTrades(MY, PARTNERS, CTX, { maxResults: 100 });
  // The likely win-win survives the candidate cap + band prune…
  assert.ok(findResult(results, [myRB3], [p1TE1]));
  // …and so does the star-headlined stretch consolidation.
  assert.ok(findResult(results, [myRB1, myRB3], [p2RB1]));
});

test('targeted mode only returns trades receiving the target pos', () => {
  const results = findTrades(MY, PARTNERS, CTX, { targetPos: 'TE' });
  assert.ok(results.length > 0);
  for (const r of results) {
    assert.ok(r.get.some((p) => p.pos === 'TE'), 'every GET side includes a TE');
  }
  // The RB consolidation is out of scope in TE mode; the win-win is in.
  assert.equal(findResult(results, [myRB1, myRB3], [p2RB1]), undefined);
  assert.ok(findResult(results, [myRB3], [p1TE1]));
});

test('minMyGain and maxResults are respected', () => {
  const strict = findTrades(MY, PARTNERS, CTX, { minMyGain: 10 });
  // Exactly the three +12 survivors clear 10: two likely, one stretch.
  assert.equal(strict.length, 3);
  for (const r of strict) assert.ok(r.my.rosDelta >= 10);
  assert.ok(findResult(strict, [myRB3], [p1TE1]));
  assert.ok(findResult(strict, [myRB3, myTE1], [p1TE1]));
  assert.ok(findResult(strict, [myRB1, myRB3], [p2RB1]));

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
