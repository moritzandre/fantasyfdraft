import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { recommend } from './index.js';

const LEAGUE = {
  teams: 12, slot: 8, rounds: 16, snake: true,
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 },
  flexEligible: ['RB', 'WR', 'TE'],
  epsilonPoints: 4, kappaLongGap: 1.3, overrideDelta: 20,
};

const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB'];

/** Synthetic board: descending eff per position, ADP = overall eff rank. */
function synthBoard(counts = { QB: 8, RB: 18, WR: 18, TE: 8, K: 4, DST: 4 }) {
  const spec = {
    QB: { top: 320, step: 12 }, RB: { top: 300, step: 10 }, WR: { top: 290, step: 9 },
    TE: { top: 250, step: 15 }, K: { top: 140, step: 5 }, DST: { top: 130, step: 5 },
  };
  const raw = [];
  for (const [pos, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      raw.push({
        pos,
        eff: spec[pos].top - spec[pos].step * i,
        rec: pos === 'RB' ? 50 : pos === 'WR' ? 80 : 0,
      });
    }
  }
  raw.sort((a, b) => b.eff - a.eff);
  return {
    schema: 1,
    players: raw.map((p, i) => ({
      idx: i, name: `${p.pos}#${i}`, pos: p.pos, team: TEAMS[i % 12],
      bye: 5 + (i % 10), proj: { halfPpr: p.eff, rec: p.rec },
      sigmaProj: 20, eff: p.eff,
      adp: { mu: i + 1, sigmaFinal: 6 },
    })),
  };
}

const idxOf = (board, pos, nth = 0) =>
  board.players.filter((p) => p.pos === pos)[nth].idx;

/** picks for overall picks 1..n avoiding given idxs (fills with worst players). */
function fillerPicks(board, n, avoid = new Set()) {
  const picks = [];
  for (let i = board.players.length - 1; i >= 0 && picks.length < n; i--) {
    if (!avoid.has(i)) picks.push(i);
  }
  return picks;
}

const termsSum = (t) => t.mv + t.cow + t.scarcity - t.bye - t.stack - t.risk;

test('recommend() end-to-end smoke: 5 recs, terms sum to score, no K/DST before R15', () => {
  const board = synthBoard();
  // Picks 1-7 by the other teams: the 7 best players go, my pick 8 is live.
  const picks = board.players.slice(0, 7).map((p) => p.idx);
  const res = recommend(board, LEAGUE, { picks }, { now: () => performance.now() });

  assert.equal(res.recommendations.length, 5);
  res.recommendations.forEach((rec, i) => {
    assert.equal(rec.rank, i + 1);
    assert.ok(Math.abs(termsSum(rec.terms) - rec.score) < 1e-9, 'terms must sum to score');
    const pos = board.players[rec.idx].pos;
    assert.ok(!['K', 'DST'].includes(pos), 'K/DST must not surface before round 15');
    assert.equal(typeof rec.headline, 'string');
    assert.ok(rec.survivalToNextPick >= 0 && rec.survivalToNextPick <= 1);
    assert.equal(rec.strategyCompliant, true);
  });
  assert.equal(res.diagnostics.currentPick, 8);
  assert.equal(res.diagnostics.round, 1);
  assert.equal(res.diagnostics.kappa, 1.0); // odd round = short gap
  assert.equal(res.slack, 6); // 16 picks − 10 starter slots
  // 60 players is shallower than league starter demand, so the flex water
  // level is legitimately 0 here — deep-pool thetaStar is covered in
  // baselines.test.js on the 400-player pool.
  assert.ok(res.thetaStar >= 0);
  assert.ok(res.diagnostics.computeMs != null);
});

test('RB with projected rec < 45 is suppressed in rounds 1-3', () => {
  const board = synthBoard();
  // Make the single best player a low-reception RB.
  const rb0 = idxOf(board, 'RB', 0);
  board.players[rb0].proj.rec = 22;
  board.players[rb0].eff += 100;
  const picks = fillerPicks(board, 7, new Set([rb0]));
  const res = recommend(board, LEAGUE, { picks });
  assert.ok(!res.recommendations.some((r) => r.idx === rb0), 'sub-45-rec RB surfaced in R1');
});

test('REGRESSION: no additive cliff term — score delta is exactly κ_r·ΔCoW', () => {
  // Two boards identical except the SECOND-best WR's ADP: in board A he
  // survives to my next pick, in board B his tier evaporates before it.
  // Everything the candidate's score is made of except E[BestAvail] is
  // untouched, so the top WR's score may move ONLY through the CoW term.
  const mk = (muB) => {
    const board = synthBoard();
    const wr0 = idxOf(board, 'WR', 0);
    board.players[wr0].eff = 400; // guarantee the candidate tops the shortlist
    board.players[wr0].proj.halfPpr = 400;
    const wr1 = idxOf(board, 'WR', 1);
    board.players[wr1].adp.mu = muB;
    return board;
  };
  const boardHold = mk(120); // WR2 not going anywhere
  const boardGone = mk(9);   // WR2 evaporating right now
  const wr0 = idxOf(boardHold, 'WR', 0);
  // 7 picks, ≤2 per position in any window so no run flag can fire.
  const picks = [
    idxOf(boardHold, 'QB', 7), idxOf(boardHold, 'RB', 17), idxOf(boardHold, 'TE', 7),
    idxOf(boardHold, 'QB', 6), idxOf(boardHold, 'RB', 16), idxOf(boardHold, 'TE', 6),
    idxOf(boardHold, 'K', 3),
  ];

  const a = recommend(boardHold, LEAGUE, { picks });
  const b = recommend(boardGone, LEAGUE, { picks });
  const recA = a.recommendations.find((r) => r.idx === wr0);
  const recB = b.recommendations.find((r) => r.idx === wr0);
  assert.ok(recA && recB, 'top WR must be shortlisted in both states');

  // Every non-CoW term identical…
  for (const k of ['mv', 'scarcity', 'bye', 'stack', 'risk']) {
    assert.ok(Math.abs(recA.terms[k] - recB.terms[k]) < 1e-12, `terms.${k} moved`);
  }
  // …and the full score delta equals the CoW-term delta exactly. Any hidden
  // CliffBonus/NeedMultiplier would break this identity.
  const dScore = recB.score - recA.score;
  const dCow = recB.terms.cow - recA.terms.cow;
  assert.ok(Math.abs(dScore - dCow) < 1e-9, `Δscore=${dScore} vs κΔCoW=${dCow}`);
  assert.ok(dScore > 0, 'an evaporating tier must raise urgency');
});

test('ε-tie: two candidates ~3 points apart both report isTie', () => {
  const board = synthBoard();
  const wr0 = idxOf(board, 'WR', 0);
  const wr1 = idxOf(board, 'WR', 1);
  // Same player twice, 3 eff points apart, both certain to survive (huge μ):
  // CoW ≈ 0 for both, so the score gap ≈ Δmv = 3 < ε = 4. Effs far above the
  // rest of the board so these two ARE ranks 1 and 2.
  board.players[wr0].eff = 400; board.players[wr0].proj.halfPpr = 400;
  board.players[wr1].eff = 397; board.players[wr1].proj.halfPpr = 397;
  board.players[wr0].adp.mu = 150; board.players[wr1].adp.mu = 150;
  board.players[wr0].team = 'ARI'; board.players[wr1].team = 'GB'; // no stack term
  const picks = fillerPicks(board, 7, new Set([wr0, wr1]));
  const res = recommend(board, LEAGUE, { picks });
  const r0 = res.recommendations[0];
  const r1 = res.recommendations[1];
  assert.ok(Math.abs(r0.score - r1.score) < 4, 'setup: gap must be under ε');
  assert.equal(r0.isTie, true);
  assert.equal(r1.isTie, true);
});

test('K/DST are hard-scheduled: surface exactly from round 15 when unfilled', () => {
  const board = synthBoard({ QB: 30, RB: 70, WR: 70, TE: 30, K: 20, DST: 20 });
  const nonKdst = board.players.filter((p) => !['K', 'DST'].includes(p.pos)).map((p) => p.idx);
  const picks = nonKdst.slice(0, 175); // picks 1-175 all skill players
  const res = recommend(board, LEAGUE, { picks });
  assert.equal(res.diagnostics.currentPick, 176); // my R15 pick
  assert.ok(res.recommendations.length > 0);
  for (const rec of res.recommendations) {
    assert.ok(['K', 'DST'].includes(board.players[rec.idx].pos));
    assert.match(rec.headline, /Hard-scheduled/);
  }
});

test('strategy: anchor_rb blocks the 2nd RB in round 3 end-to-end', () => {
  const board = synthBoard({ QB: 10, RB: 20, WR: 20, TE: 10 });
  const myRb = idxOf(board, 'RB', 10);
  const myWr = idxOf(board, 'WR', 10);
  // 31 picks; mine (picks 8 and 17 → indices 7 and 16) are an RB and a WR.
  const filler = fillerPicks(board, 31, new Set([myRb, myWr]));
  const picks = filler.slice(0, 31);
  picks[7] = myRb;
  picks[16] = myWr;
  const res = recommend(board, LEAGUE, { picks, strategy: 'anchor_rb' });
  assert.equal(res.diagnostics.round, 3);
  for (const rec of res.recommendations) {
    assert.notEqual(board.players[rec.idx].pos, 'RB');
    assert.equal(rec.strategyCompliant, true);
  }
});

test('strategy: override surfaces when unconstrained best wins by >20', () => {
  const board = synthBoard();
  const rb0 = idxOf(board, 'RB', 0);
  board.players[rb0].eff = 400; board.players[rb0].proj.halfPpr = 400; // dwarfs the field
  const picks = fillerPicks(board, 7, new Set([rb0]));
  const res = recommend(board, LEAGUE, { picks, strategy: 'zero_rb_mod' });
  const offStrategy = res.recommendations.find((r) => !r.strategyCompliant);
  assert.ok(offStrategy, 'conflict must be surfaced, not silently obeyed');
  assert.equal(offStrategy.idx, rb0);
  assert.ok(offStrategy.strategyConflictPoints > 20);
  assert.ok(res.diagnostics.strategyConflictPoints > 20);

  // Small edge -> stays suppressed and everything shown is compliant.
  const board2 = synthBoard();
  const res2 = recommend(board2, LEAGUE, { picks: fillerPicks(board2, 7), strategy: 'zero_rb_mod' });
  for (const rec of res2.recommendations) {
    assert.equal(rec.strategyCompliant, true);
    assert.notEqual(board2.players[rec.idx].pos, 'RB');
  }
});

test('performance: <5ms per recommend() at n=400', () => {
  const board = synthBoard({ QB: 40, RB: 120, WR: 140, TE: 40, K: 30, DST: 30 });
  const picks = board.players.slice(0, 7).map((p) => p.idx);
  // Warm up, then time the median of 21 runs.
  const times = [];
  for (let i = 0; i < 24; i++) {
    const res = recommend(board, LEAGUE, { picks }, { now: () => performance.now() });
    if (i >= 3) times.push(res.diagnostics.computeMs);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  // Hard assert with slack for cold CI machines; the plan target is <5 ms.
  assert.ok(median < 25, `median computeMs=${median.toFixed(2)}`);
  console.log(`recommend() n=400 median computeMs=${median.toFixed(3)} (target <5)`);
});

test('recommend() is slot-general: turn slot 1 works end-to-end', () => {
  // Same synthetic board, but drafting from slot 1 (the turn). Verifies no
  // slot-8 assumption survives anywhere in the recommend() pipeline.
  const board = synthBoard();
  const slot1 = { ...LEAGUE, slot: 1 };

  // Pick 1: on the clock immediately, empty log. Round 1 precedes the 23-gap
  // long wait at slot 1, so kappa must be the LONG weight (inverse of slot 8).
  const r1 = recommend(board, slot1, { picks: [] }, {});
  assert.equal(r1.diagnostics.currentPick, 1);
  assert.equal(r1.diagnostics.round, 1);
  assert.equal(r1.diagnostics.kappa, 1.3);
  assert.equal(r1.recommendations.length, 5);

  // After my pick + 22 opponents, my round-2 pick 24 is on the clock and is
  // followed by the 1-gap turn pair: short weight.
  const picks2 = [idxOf(board, 'RB', 0), ...fillerPicks(board, 22, new Set([idxOf(board, 'RB', 0)]))];
  const r2 = recommend(board, slot1, { picks: picks2 }, {});
  assert.equal(r2.diagnostics.currentPick, 24);
  assert.equal(r2.diagnostics.round, 2);
  assert.equal(r2.diagnostics.kappa, 1.0);
});

// ── Sparse replay (entries/cursor) + force-scored extras ────────────────────

test('dense picks ≡ sparse entries when the log has no holes', () => {
  const board = synthBoard();
  const picks = board.players.slice(0, 20).map((p) => p.idx);
  const dense = recommend(board, LEAGUE, { picks }, {});
  const sparse = recommend(board, LEAGUE, {
    entries: picks.map((idx, k) => ({ n: k + 1, idx })),
    cursor: 21,
  }, {});
  assert.deepEqual(sparse.recommendations, dense.recommendations);
  assert.deepEqual(sparse.diagnostics, dense.diagnostics);
  assert.deepEqual(sparse.replacementIndices, dense.replacementIndices);
  assert.equal(sparse.slack, dense.slack);
  assert.deepEqual(sparse.runFlags, dense.runFlags);
});

test('entries attribute picks by n — a hole never shifts later picks', () => {
  const board = synthBoard();
  const qb = idxOf(board, 'QB', 0);
  // Same player recorded as MY pick (n=8, slot 8) vs the seat before me
  // (n=7, slot 7), both with a hole at n=2 and the cursor at 10. Only the
  // n=8 version fills one of MY starter slots.
  const mine = recommend(board, LEAGUE, {
    entries: [{ n: 8, idx: qb }, { n: 2, idx: null }], cursor: 10,
  }, {});
  const theirs = recommend(board, LEAGUE, {
    entries: [{ n: 7, idx: qb }, { n: 2, idx: null }], cursor: 10,
  }, {});
  assert.equal(mine.slack, theirs.slack + 1);
});

test('cursor drives currentPick/round/myNextPick', () => {
  const board = synthBoard();
  const res = recommend(board, LEAGUE, { entries: [], cursor: 17 }, {});
  assert.equal(res.diagnostics.currentPick, 17);
  assert.equal(res.diagnostics.round, 2);
  assert.equal(res.diagnostics.onClock, true);   // pick 17 is slot 8''s R2 pick
  assert.equal(res.diagnostics.myNextPick, 32);  // the rung after 17
});

test('includeIdxs force-scores through the same pipeline; shortlist untouched', () => {
  const board = synthBoard();
  const picks = board.players.slice(0, 7).map((p) => p.idx);
  const te3 = idxOf(board, 'TE', 3); // far outside the shortlist at pick 8
  const base = recommend(board, LEAGUE, { picks }, {});
  const res = recommend(board, LEAGUE, { picks }, { includeIdxs: [te3, picks[0]] });
  assert.deepEqual(res.recommendations, base.recommendations);
  assert.equal(res.scoredExtras.length, 1);       // picks[0] is taken — skipped
  const ex = res.scoredExtras[0];
  assert.equal(ex.idx, te3);
  assert.equal(ex.forced, true);
  assert.ok(Math.abs(termsSum(ex.terms) - ex.score) < 1e-9, 'extras terms must sum to score');
  assert.ok(ex.score <= res.recommendations[0].score, 'a filtered-out player cannot outscore the top rec');
  assert.deepEqual(base.scoredExtras, []);
});
