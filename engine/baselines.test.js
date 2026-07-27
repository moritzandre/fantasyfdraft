import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeBaselines, ppRem } from './baselines.js';

const FIX = JSON.parse(
  readFileSync(new URL('../tests/fixtures/engineFixtures.json', import.meta.url), 'utf8'),
);

test('ppRem: 1-based, 0 beyond the pool', () => {
  assert.equal(ppRem([50, 40, 30], 1), 50);
  assert.equal(ppRem([50, 40, 30], 3), 30);
  assert.equal(ppRem([50, 40, 30], 4), 0);
  assert.equal(ppRem([], 1), 0);
});

test('water-filling: hand-computed small case', () => {
  const f = FIX.waterFilling;
  const res = computeBaselines(f.poolByPos, f.demand, f.flexRemaining, f.flexEligible);
  assert.deepEqual(res.r, f.expected.r);
  assert.deepEqual(res.flexAlloc, f.expected.flexAlloc);
  assert.equal(res.thetaStar, f.expected.thetaStar);
});

// Synthetic 400-player pool. TE drops 15 pts/rank so TE13 (120) is far below
// where the RB/WR fill line ends (~240s) — TE must never reach the flex.
function bigPool() {
  const gen = (count, top, step) => Array.from({ length: count }, (_, i) => top - step * i);
  return {
    QB: gen(40, 380, 6),
    RB: gen(120, 320, 2.2),
    WR: gen(140, 310, 2.0),
    TE: gen(40, 300, 15),
    K: gen(30, 140, 2),
    DST: gen(30, 130, 2),
  };
}
const DEMAND = { QB: 12, RB: 24, WR: 24, TE: 12 };
const FLEX = ['RB', 'WR', 'TE'];

test('water-filling invariants on the 400-player 2-FLEX pool', () => {
  const { r, flexAlloc, thetaStar } = computeBaselines(bigPool(), DEMAND, 24, FLEX);

  // Σ_p flexAlloc == 24 — every flex slot is awarded somewhere, always.
  assert.equal(flexAlloc.RB + flexAlloc.WR + flexAlloc.TE, 24);

  // TE never reaches the flex ⇒ r_TE stays at the dedicated demand N·S_TE.
  assert.equal(r.TE, 12);
  assert.equal(flexAlloc.TE, 0);

  // QB is not flex-eligible ⇒ keeps the lower baseline by construction.
  assert.equal(r.QB, 12);

  // The 2-FLEX league starts RB/WR far deeper than 1-flex advice assumes.
  assert.ok(r.RB > 24 && r.WR > 24, `r_RB=${r.RB}, r_WR=${r.WR}`);
  assert.ok(thetaStar > 0);
});

test('water-filling: r_p monotone in demand', () => {
  const base = computeBaselines(bigPool(), DEMAND, 24, FLEX);
  const more = computeBaselines(bigPool(), { ...DEMAND, RB: 26 }, 24, FLEX);
  assert.ok(more.r.RB >= base.r.RB + 2 - 2, 'raising d_RB may not lower r_RB');
  assert.ok(more.r.RB >= base.r.RB, `r_RB fell: ${base.r.RB} -> ${more.r.RB}`);
  // And with more flex demand the fill line only deepens.
  const moreFlex = computeBaselines(bigPool(), DEMAND, 30, FLEX);
  for (const pos of FLEX) assert.ok(moreFlex.r[pos] >= base.r[pos], pos);
});
