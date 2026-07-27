// strategy.js — the four draft strategies as priors, not handcuffs (plan,
// "Strategy layer"). PURE: no DOM, no fetch, no globals, no Date.now().
//
// Each strategy is (i) multiplicative priors m_p(r) on the score, (ii) hard
// min/max position counts by round, (iii) a 20-point override: when the
// unconstrained best beats the compliant best by more than overrideDelta the
// engine SURFACES the conflict (strategyCompliant:false +
// strategyConflictPoints) rather than silently obeying. Never scripted pick
// sequences.
//
//   balanced     — identity. Pure tier discipline; most robust from slot 8.
//   anchor_rb    — m_RB(1)=1.15, m_RB(2..5)=0.70, m_RB(6..9)=1.20;
//                  exactly 1 RB through R4, ≥3 RB by R9.
//   zero_rb_mod  — no RB in R1–3, allowed R4+. (Strict Zero RB is weaker in
//                  half-PPR: the reception bonus funding it is halved.)
//   robust_rb    — m_RB(r≤3)=1.25; ≥2 RB by R3, ≥3 by R5. Weakest at slot 8.
//
// Constraint encoding:
//   {pos, type:'max', through, limit}  — count_pos may not exceed `limit`
//                                         while round ≤ `through`
//   {pos, type:'min', by, need}       — count_pos must reach `need` by the
//                                         END of round `by` (a pick is
//                                         non-compliant if it makes that
//                                         infeasible given remaining picks)

export const STRATEGIES = {
  balanced: {
    name: 'balanced',
    multipliers: {},
    constraints: [],
    overrideDelta: 20,
  },
  anchor_rb: {
    name: 'anchor_rb',
    multipliers: {
      RB: [
        { from: 1, to: 1, m: 1.15 },
        { from: 2, to: 5, m: 0.70 },
        { from: 6, to: 9, m: 1.20 },
      ],
    },
    constraints: [
      { pos: 'RB', type: 'min', by: 1, need: 1 },   // the anchor
      { pos: 'RB', type: 'max', through: 4, limit: 1 },
      { pos: 'RB', type: 'min', by: 9, need: 3 },
    ],
    overrideDelta: 20,
  },
  zero_rb_mod: {
    name: 'zero_rb_mod',
    multipliers: {},
    constraints: [
      { pos: 'RB', type: 'max', through: 3, limit: 0 },
    ],
    overrideDelta: 20,
  },
  robust_rb: {
    name: 'robust_rb',
    multipliers: {
      RB: [{ from: 1, to: 3, m: 1.25 }],
    },
    constraints: [
      { pos: 'RB', type: 'min', by: 3, need: 2 },
      { pos: 'RB', type: 'min', by: 5, need: 3 },
    ],
    overrideDelta: 20,
  },
};

/** Look a strategy up by name; unknown names throw — a typo must not
    silently fall back to balanced mid-draft. */
export function getStrategy(name) {
  const s = STRATEGIES[name ?? 'balanced'];
  if (!s) throw new Error(`unknown strategy: ${name}`);
  return s;
}

/** m_p(r) — 1.0 anywhere no rule applies. */
export function multiplierFor(strategy, pos, round) {
  for (const rule of strategy.multipliers[pos] ?? []) {
    if (round >= rule.from && round <= rule.to) return rule.m;
  }
  return 1.0;
}

/**
 * Would picking `pos` in `round` keep the strategy satisfiable?
 *
 * max: violated outright if the pick pushes count_pos past the limit while
 *      the constraint window is still open.
 * min: violated if, AFTER this pick, the picks remaining before the deadline
 *      can no longer cover the deficit — i.e. spending this pick elsewhere
 *      strands the minimum.
 *
 * @param {Object<string, number>} counts  my current position counts.
 * @param {number} round  round of the pick being considered.
 * @param {string} pos  position being considered.
 * @param {(byRound: number) => number} futurePicksThrough  number of MY picks
 *        AFTER the current one in rounds ≤ byRound.
 */
export function isCompliant(strategy, counts, round, pos, futurePicksThrough) {
  for (const c of strategy.constraints) {
    const have = counts[c.pos] ?? 0;
    if (c.type === 'max') {
      if (round <= c.through && pos === c.pos && have + 1 > c.limit) return false;
    } else { // min
      if (round > c.by) continue; // deadline passed — nothing to protect
      const deficit = c.need - have - (pos === c.pos ? 1 : 0);
      if (deficit > futurePicksThrough(c.by)) return false;
    }
  }
  return true;
}
