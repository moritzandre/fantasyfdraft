import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bestLineup, marginalValue } from './lineup.js';

const FIX = JSON.parse(
  readFileSync(new URL('../tests/fixtures/engineFixtures.json', import.meta.url), 'utf8'),
);

test('bestLineup: hand-computed 7-man roster', () => {
  const f = FIX.lineup;
  assert.equal(bestLineup(f.roster, f.slots, f.flexEligible).total, f.expectedTotal);
  assert.equal(
    bestLineup([...f.roster, f.addPlayer], f.slots, f.flexEligible).total,
    f.expectedTotalAfter,
  );
});

test('bestLineup: flex takes the best leftovers across positions', () => {
  const roster = [
    { pos: 'RB', eff: 50 }, { pos: 'RB', eff: 40 }, { pos: 'RB', eff: 35 },
    { pos: 'WR', eff: 45 }, { pos: 'WR', eff: 30 }, { pos: 'WR', eff: 28 },
    { pos: 'TE', eff: 33 }, { pos: 'TE', eff: 32 },
  ];
  const slots = { RB: 2, WR: 2, TE: 1, FLEX: 2 };
  const { total } = bestLineup(roster, slots, ['RB', 'WR', 'TE']);
  // Dedicated: 50+40 + 45+30 + 33 = 198; leftovers 35, 28, 32 -> flex 35+32.
  assert.equal(total, 265);
});

test('marginalValue: hand-computed vs replacement padding', () => {
  const f = FIX.marginalValue;
  const mv = marginalValue(f.candidate, [], f.slots, f.flexEligible, f.replacement);
  assert.equal(mv, f.expectedMV);
});

test('marginalValue: a filled position collapses toward the flex water level', () => {
  const f = FIX.marginalValue;
  const roster = [
    { pos: 'QB', eff: 90 }, // QB slot already filled well above replacement
  ];
  // A second QB can never start (QB not flex-eligible): MV must be 0.
  const mv = marginalValue({ pos: 'QB', eff: 80 }, roster, f.slots, f.flexEligible, f.replacement);
  assert.equal(mv, 0);
});
