import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  survivalAt, conditionedSurvival, plackettLuceSurvival,
  poissonBinomialPMF, tierSurvivalStats, orderedBestAvailExpectation,
} from './survival.js';

const FIX = JSON.parse(
  readFileSync(new URL('../tests/fixtures/engineFixtures.json', import.meta.url), 'utf8'),
);

test('logistic survival: S(μ)=0.5 and the hand-computed tail point', () => {
  const f = FIX.logistic;
  assert.equal(survivalAt(f.atMu.P, f.mu, f.sigma), f.atMu.S);
  assert.ok(Math.abs(survivalAt(f.past.P, f.mu, f.sigma) - f.past.S) < f.past.tol);
});

test('Bayes conditioning: a player past his μ keeps falling', () => {
  // mu=30, already alive at pick 50 (20 picks past ADP). Conditioned survival
  // to 59 must EXCEED the unconditional S(59) — that he lasted this long is
  // evidence the room does not want him.
  const cond = conditionedSurvival(59, 50, 30, 6);
  const uncond = survivalAt(59, 30, 6);
  assert.ok(cond > uncond, `cond=${cond} uncond=${uncond}`);
  // And it is exactly the ratio S(59)/S(50), clamped to 1.
  assert.ok(Math.abs(cond - uncond / survivalAt(50, 30, 6)) < 1e-12);
  assert.ok(cond <= 1);
});

test('Plackett-Luce calibration: Σ(1−s_i) == G within 0.5 on a 30-player window', () => {
  const mus = Array.from({ length: 30 }, (_, i) => i + 1);
  const G = 9;
  const s = plackettLuceSurvival(mus, 3, G);
  const takes = s.reduce((a, x) => a + (1 - x), 0);
  assert.ok(Math.abs(takes - G) <= 0.5, `Σ(1−s)=${takes}`);
  for (const x of s) assert.ok(x >= 0 && x <= 1);
  // The likeliest-picked player must be the least likely to survive.
  assert.ok(s[0] < s[29]);
});

test('Poisson-binomial PMF: fixtures and brute-force enumeration at n=12', () => {
  for (const c of FIX.poissonBinomial.cases) {
    const pmf = poissonBinomialPMF(c.ps);
    c.pmf.forEach((p, k) => assert.ok(Math.abs(pmf[k] - p) < 1e-12));
  }
  // Deterministic pseudo-random probs, then enumerate all 4096 subsets.
  const ps = Array.from({ length: 12 }, (_, i) => ((i * 37 + 11) % 97) / 97);
  const pmf = poissonBinomialPMF(ps);
  const brute = new Array(13).fill(0);
  for (let mask = 0; mask < 4096; mask++) {
    let prob = 1, k = 0;
    for (let i = 0; i < 12; i++) {
      if (mask & (1 << i)) { prob *= ps[i]; k++; } else prob *= 1 - ps[i];
    }
    brute[k] += prob;
  }
  brute.forEach((p, k) => assert.ok(Math.abs(pmf[k] - p) < 1e-12, `k=${k}`));
});

test('tier survival stats: hand-computed pair', () => {
  const f = FIX.tierSurvival;
  const st = tierSurvivalStats(f.survivals);
  assert.ok(Math.abs(st.pAtLeastOne - f.pAtLeastOne) < 1e-12);
  assert.ok(Math.abs(st.pAtLeastTwo - f.pAtLeastTwo) < 1e-12);
  assert.ok(Math.abs(st.expected - f.expected) < 1e-12);
});

test('orderedBestAvailExpectation: hand-computed chain + floor', () => {
  const f = FIX.orderedBestAvail;
  assert.ok(Math.abs(orderedBestAvailExpectation(f.candidates, f.floor) - f.expected) < 1e-12);
  // Nobody survives -> you hold the floor.
  const dead = f.candidates.map((c) => ({ ...c, survival: 0 }));
  assert.equal(orderedBestAvailExpectation(dead, f.allDeadFloor), f.allDeadFloor);
  // Unsorted input is re-sorted defensively — same answer.
  const shuffled = [f.candidates[2], f.candidates[0], f.candidates[1]];
  assert.ok(Math.abs(orderedBestAvailExpectation(shuffled, f.floor) - f.expected) < 1e-12);
});
