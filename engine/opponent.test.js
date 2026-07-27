import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOpponentCtx, makeDraftSim, OPP_DEFAULT_PARAMS } from './opponent.js';
import { xorshift128plus } from './mc.js';
import { defineStrategy } from './strategy.js';
import { slotForPick } from './picks.js';

// ── Synthetic board: dense idx in ADP order, skill early, K/DST late ────────
const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
const POS_IDX = Object.fromEntries(POS.map((p, i) => [p, i]));

function synthBoard() {
  // Repeating skill pattern RB,WR,RB,WR,QB,TE… then all K, then all DST —
  // mirrors real ADP structure well enough for the sampler.
  const skill = [];
  for (let i = 0; i < 35; i++) skill.push('RB', 'WR', 'RB', 'WR', 'QB', 'TE');
  const posSeq = [...skill, ...Array(15).fill('K'), ...Array(15).fill('DST')];
  const teams = ['DAL', 'PHI', 'KC', 'DET', 'SF', 'BUF', 'MIA', 'GB'];
  const players = posSeq.map((pos, idx) => ({
    idx,
    id: String(idx),
    name: `P${idx}`,
    short: `P${idx}`,
    pos,
    team: teams[idx % teams.length],
    bye: 5 + (idx % 10),
    eff: 400 - idx,
    sigmaProj: 55,
    proj: { halfPpr: 400 - idx, rec: 60 },
    adp: { mu: idx + 1, sigmaFinal: 3 + idx * 0.05 },
  }));
  return { buildHash: 'testtest', players };
}

const LEAGUE = {
  teams: 12, slot: 8, rounds: 16, snake: true,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
  flexEligible: ['RB', 'WR', 'TE'],
};

const NEUTRAL_OPP = {
  seats: Array.from({ length: 12 }, (_, i) => ({
    seat: i + 1, name: '', adpDiscipline: 0.5, positionBias: {}, homerTeams: [], reachRounds: [],
  })),
};

function freshSim(opponents = NEUTRAL_OPP, params = {}) {
  const ctx = makeOpponentCtx(synthBoard(), LEAGUE, opponents, params);
  return { ctx, sim: makeDraftSim(ctx) };
}

test('opponent: same seed ⇒ identical 192-pick sequence', () => {
  const runOnce = (seed) => {
    const { sim } = freshSim();
    const rng = xorshift128plus(seed);
    sim.reset();
    sim.drawSeatState(rng);
    const rec = [];
    sim.run(1, 192, rng, { record: rec });
    return rec;
  };
  assert.deepEqual(runOnce(20260824), runOnce(20260824));
  assert.notDeepEqual(runOnce(20260824), runOnce(1));
});

test('opponent: realism caps hold over many drafts; K/DST always filled', () => {
  const { ctx, sim } = freshSim();
  const rng = xorshift128plus(7);
  for (let s = 0; s < 200; s++) {
    sim.reset();
    sim.drawSeatState(rng);
    sim.run(1, 192, rng, {});
    for (let seat = 1; seat <= 12; seat++) {
      const c = (pos) => sim.counts[seat * 6 + POS_IDX[pos]];
      assert.ok(c('K') === 1, `seat ${seat}: K count ${c('K')}`);
      assert.ok(c('DST') === 1, `seat ${seat}: DST count ${c('DST')}`);
      assert.ok(c('QB') <= ctx.params.caps.QB, `seat ${seat}: QB cap`);
      assert.ok(c('TE') <= ctx.params.caps.TE, `seat ${seat}: TE cap`);
      assert.ok(c('RB') <= ctx.params.caps.RB && c('WR') <= ctx.params.caps.WR);
    }
  }
});

test('opponent: need mask restricts to unfilled skill starters, lifts in bench mode', () => {
  const { sim } = freshSim();
  sim.reset();
  // Empty roster, mask forced on: every candidate is a skill position.
  const d0 = sim.pickDistribution(1, 5, { needMask: 'on', jitter: 1 });
  assert.ok(d0.length > 0);
  const board = synthBoard();
  for (const { idx } of d0) assert.ok(['QB', 'RB', 'WR', 'TE'].includes(board.players[idx].pos));
  // Fill seat 1's skill starters completely (1QB 2RB 2WR 1TE + 2 FLEX) —
  // mask must lift (bench mode ⇒ K/DST reachable if in window).
  sim.reset();
  // Pattern: idx 0=RB 1=WR 2=RB 3=WR 4=QB 5=TE 6=RB 7=WR …
  // Applied at seat 1's actual snake picks (1, 24, 25, …) — applyPick
  // attributes by pick number.
  const fills = [4, 0, 2, 1, 3, 5, 6, 7]; // QB,2RB,2WR,TE + FLEX RB,WR — all starters
  const seat1Picks = [1, 24, 25, 48, 49, 72, 73, 96];
  fills.forEach((idx, k) => sim.applyPick(idx, seat1Picks[k]));
  const dFull = sim.pickDistribution(1, 9, { needMask: 'on', jitter: 1 });
  const dFree = sim.pickDistribution(1, 9, { needMask: 'off', jitter: 1 });
  assert.deepEqual(dFull, dFree); // mask lifted ⇒ identical to unmasked
});

test('opponent: applyEntries is n-aware — holes attribute to the right seats', () => {
  const { sim } = freshSim();
  sim.reset();
  // Picks 1 and 3 recorded, pick 2 is a hole (off-board), pick 20 jumps ahead.
  sim.applyEntries([
    { n: 1, idx: 0 },            // seat 1 (RB)
    { n: 3, idx: 1 },            // seat 3 (WR)
    { n: 20, idx: 2 },           // snake round 2 → seat 5 (RB)
    { n: 2, idx: null },         // hole: skipped entirely
  ]);
  assert.equal(sim.counts[slotForPick(1, 12, true) * 6 + POS_IDX.RB], 1);
  assert.equal(sim.counts[slotForPick(3, 12, true) * 6 + POS_IDX.WR], 1);
  assert.equal(sim.counts[slotForPick(20, 12, true) * 6 + POS_IDX.RB], 1);
  assert.equal(sim.taken[0] + sim.taken[1] + sim.taken[2], 3);
  assert.equal(sim.draftedAt[2], 20);
});

test('opponent: pickDistribution sums to 1 and matches sampling frequencies', () => {
  const { sim } = freshSim();
  sim.reset();
  const dist = sim.pickDistribution(1, 1, { jitter: 1 });
  const total = dist.reduce((a, d) => a + d.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `probs sum to ${total}`);
  // Empirical check: jitter must match the distribution's jitter — use a
  // sim whose drawn jitter we overwrite is not possible, so draw with the
  // seat's default jitter (1 — freshly constructed sims start at 1).
  const rng = xorshift128plus(99);
  const freq = new Map();
  const DRAWS = 20000;
  for (let k = 0; k < DRAWS; k++) {
    const idx = sim.samplePick(1, 1, rng);
    freq.set(idx, (freq.get(idx) ?? 0) + 1);
  }
  for (const { idx, p } of dist.slice(0, 5)) {
    const emp = (freq.get(idx) ?? 0) / DRAWS;
    assert.ok(Math.abs(emp - p) < 0.02, `idx ${idx}: p=${p.toFixed(4)} emp=${emp.toFixed(4)}`);
  }
});

test('opponent: forced picks via pickFor consume no rng', () => {
  const { sim } = freshSim();
  sim.reset();
  sim.drawSeatState(xorshift128plus(5)); // seat state from its own stream
  const rngA = xorshift128plus(42);
  sim.run(1, 3, rngA, { pickFor: (p) => p - 1 }); // force idx 0,1,2
  const rngB = xorshift128plus(42);
  assert.equal(rngA.next(), rngB.next());
  assert.equal(sim.taken[0] + sim.taken[1] + sim.taken[2], 3);
});

test('opponent: no archetype mix ⇒ no extra rng draws, no seat archetypes', () => {
  const { sim } = freshSim();
  const N = 12;
  const rng1 = xorshift128plus(123);
  sim.reset();
  sim.drawSeatState(rng1);
  // Reference stream: jitter = N normals (2 uniforms each) + N needAware.
  const rng2 = xorshift128plus(123);
  for (let k = 0; k < 3 * N; k++) rng2.next();
  assert.equal(rng1.next(), rng2.next());
  for (let s = 1; s <= N; s++) assert.equal(sim.seatArchetypeName(s), null);
});

// ── Archetypes ──────────────────────────────────────────────────────────────

test('archetypes: mix proportions are honored across draws', () => {
  const { sim } = freshSim(
    { ...NEUTRAL_OPP, archetypes: { mix: { balanced: 0.5, zero_rb_mod: 0.3, robust_rb: 0.2 } } },
  );
  const rng = xorshift128plus(2024);
  const tally = { balanced: 0, zero_rb_mod: 0, robust_rb: 0 };
  const DRAWS = 2000;
  for (let k = 0; k < DRAWS; k++) {
    sim.drawSeatState(rng);
    for (let s = 1; s <= 12; s++) tally[sim.seatArchetypeName(s)]++;
  }
  const n = DRAWS * 12;
  assert.ok(Math.abs(tally.balanced / n - 0.5) < 0.02);
  assert.ok(Math.abs(tally.zero_rb_mod / n - 0.3) < 0.02);
  assert.ok(Math.abs(tally.robust_rb / n - 0.2) < 0.02);
});

test('archetypes: zero_rb seats draft no RB in rounds 1-3 (soft constraint)', () => {
  const { sim } = freshSim(
    { ...NEUTRAL_OPP, archetypes: { mix: { zero_rb_mod: 1 } } },
  );
  const board = synthBoard();
  const rng = xorshift128plus(31);
  for (let s = 0; s < 30; s++) {
    sim.reset();
    sim.drawSeatState(rng);
    const rec = [];
    sim.run(1, 36, rng, { record: rec }); // rounds 1-3
    for (const idx of rec) assert.notEqual(board.players[idx].pos, 'RB');
  }
});

test('archetypes: min constraints force the position when the runway runs out', () => {
  // robust_rb: ≥2 RB by R3 — a seat with 0 RB entering round 2 must go RB
  // in rounds 2 AND 3 (deficit 2 = picks left 2).
  const { sim } = freshSim(
    { ...NEUTRAL_OPP, archetypes: { mix: { robust_rb: 1 } } },
  );
  const board = synthBoard();
  sim.reset();
  sim.drawSeatState(xorshift128plus(8));
  // Give seat 1 a WR at pick 1 (their R1 pick), then ask for their R2 pick.
  sim.applyPick(1, 1); // idx 1 = WR
  const dist = sim.pickDistribution(1, 2, { jitter: 1, needMask: 'off' });
  for (const { idx } of dist) assert.equal(board.players[idx].pos, 'RB');
});

test('archetypes: multipliers tilt the sampling distribution', () => {
  const wrTilt = defineStrategy({
    name: 'wr_tilt_test',
    multipliers: { WR: [{ from: 1, to: 3, m: 2.0 }] },
  });
  const mkDist = (mix) => {
    const { sim } = freshSim(
      { ...NEUTRAL_OPP, ...(mix ? { archetypes: { mix } } : {}) },
      mix ? { strategies: { wr_tilt_test: wrTilt } } : {},
    );
    sim.reset();
    if (mix) sim.drawSeatState(xorshift128plus(4)); // mix {x:1} ⇒ deterministic assign
    return sim.pickDistribution(1, 1, { jitter: 1 });
  };
  const board = synthBoard();
  const wrMass = (dist) => dist.filter(({ idx }) => board.players[idx].pos === 'WR')
    .reduce((a, d) => a + d.p, 0);
  const base = wrMass(mkDist(null));
  const tilted = wrMass(mkDist({ wr_tilt_test: 1 }));
  assert.ok(tilted > base * 1.3, `WR mass ${base.toFixed(3)} → ${tilted.toFixed(3)}`);
});

test('archetypes: unknown name in the mix throws at ctx creation (fail fast)', () => {
  assert.throws(() => freshSim(
    { ...NEUTRAL_OPP, archetypes: { mix: { not_a_strategy: 1 } } },
  ));
});

test('params: overrides cascade defaults ← opponents.params ← explicit', () => {
  const ctx = makeOpponentCtx(
    synthBoard(), LEAGUE,
    { ...NEUTRAL_OPP, params: { tauScale: 2.0, window: 30 } },
    { window: 25 },
  );
  assert.equal(ctx.tauScale, 2.0);        // from opponents.params
  assert.equal(ctx.window, 25);           // explicit wins
  assert.equal(ctx.tauWindow, OPP_DEFAULT_PARAMS.tauWindow); // default
});
