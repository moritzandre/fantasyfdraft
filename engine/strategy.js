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

// ── Custom strategies (validated data, same shape as the built-ins) ─────────
//
// A spec is pure data: multipliers + constraints + overrideDelta ONLY. The
// key whitelist below is the structural guard for the no-additive-terms rule:
// a custom strategy cannot express bonuses, cliff terms or need multipliers,
// so Score = m·(MV + κ·CoW + Scarcity − Bye − Stack − Risk) stays exact.
// Specs live in public/data/strategies.json and double as opponent
// archetypes in engine/opponent.js.

const SPEC_KEYS = ['name', 'label', 'blurb', 'multipliers', 'constraints', 'overrideDelta'];
const MULT_KEYS = ['from', 'to', 'm'];
const CON_KEYS = ['pos', 'type', 'through', 'limit', 'by', 'need'];
const MULT_POS = ['QB', 'RB', 'WR', 'TE']; // K/DST bypass the optimizer — a
// multiplier there would be a silent no-op, so it is rejected instead.

const isInt = (v) => Number.isInteger(v);

/**
 * Validate one strategy spec. Returns a list of human-readable errors;
 * empty ⇒ valid. Never throws.
 * @param {object} spec
 * @param {{rounds?: number, reservedNames?: string[]}} [opts]
 */
export function validateStrategy(spec, opts = {}) {
  const rounds = opts.rounds ?? 16;
  const reserved = opts.reservedNames ?? Object.keys(STRATEGIES);
  const errs = [];
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['spec must be a plain object'];
  }
  for (const k of Object.keys(spec)) {
    if (!SPEC_KEYS.includes(k)) {
      errs.push(`unknown key "${k}" — only name/label/blurb/multipliers/constraints/overrideDelta are allowed`);
    }
  }
  if (typeof spec.name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(spec.name)) {
    errs.push('name must be a string matching ^[a-z][a-z0-9_]{0,31}$');
  } else if (reserved.includes(spec.name)) {
    errs.push(`name "${spec.name}" is reserved (built-in strategy)`);
  }
  if (spec.label !== undefined && typeof spec.label !== 'string') errs.push('label must be a string');
  if (spec.blurb !== undefined && typeof spec.blurb !== 'string') errs.push('blurb must be a string');

  // Multipliers: {POS: [{from, to, m}]}, pos ∈ QB/RB/WR/TE, ranges within
  // [1, rounds], non-overlapping per position, 0.25 ≤ m ≤ 2.5 (m near 0
  // would zero scores and break tie semantics — bans belong in constraints).
  const mults = spec.multipliers ?? {};
  if (mults === null || typeof mults !== 'object' || Array.isArray(mults)) {
    errs.push('multipliers must be an object keyed by position');
  } else {
    for (const [pos, rules] of Object.entries(mults)) {
      if (!MULT_POS.includes(pos)) { errs.push(`multipliers.${pos}: position must be one of ${MULT_POS.join('/')}`); continue; }
      if (!Array.isArray(rules)) { errs.push(`multipliers.${pos} must be an array of {from, to, m}`); continue; }
      const seen = [];
      for (const rule of rules) {
        if (rule === null || typeof rule !== 'object') { errs.push(`multipliers.${pos}: each rule must be {from, to, m}`); continue; }
        for (const k of Object.keys(rule)) {
          if (!MULT_KEYS.includes(k)) errs.push(`multipliers.${pos}: unknown rule key "${k}"`);
        }
        if (!isInt(rule.from) || !isInt(rule.to) || rule.from < 1 || rule.to > rounds || rule.from > rule.to) {
          errs.push(`multipliers.${pos}: need integers 1 ≤ from ≤ to ≤ ${rounds}`);
        }
        if (typeof rule.m !== 'number' || !(rule.m >= 0.25 && rule.m <= 2.5)) {
          errs.push(`multipliers.${pos}: m must be in [0.25, 2.5]`);
        }
        if (isInt(rule.from) && isInt(rule.to)) seen.push([rule.from, rule.to]);
      }
      seen.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < seen.length; i++) {
        if (seen[i][0] <= seen[i - 1][1]) errs.push(`multipliers.${pos}: round ranges overlap`);
      }
    }
  }

  // Constraints: the two encodings documented at the top of this file.
  const cons = spec.constraints ?? [];
  if (!Array.isArray(cons)) {
    errs.push('constraints must be an array');
  } else {
    for (const c of cons) {
      if (c === null || typeof c !== 'object') { errs.push('each constraint must be an object'); continue; }
      for (const k of Object.keys(c)) {
        if (!CON_KEYS.includes(k)) errs.push(`constraint: unknown key "${k}"`);
      }
      if (!MULT_POS.includes(c.pos)) errs.push(`constraint pos must be one of ${MULT_POS.join('/')}`);
      if (c.type === 'max') {
        if (!isInt(c.through) || c.through < 1 || c.through > rounds) errs.push(`max constraint: need integer 1 ≤ through ≤ ${rounds}`);
        if (!isInt(c.limit) || c.limit < 0) errs.push('max constraint: need integer limit ≥ 0');
        if ('by' in c || 'need' in c) errs.push('max constraint takes through/limit, not by/need');
      } else if (c.type === 'min') {
        if (!isInt(c.by) || c.by < 1 || c.by > rounds) errs.push(`min constraint: need integer 1 ≤ by ≤ ${rounds}`);
        if (!isInt(c.need) || c.need < 1) errs.push('min constraint: need integer need ≥ 1');
        if (isInt(c.by) && isInt(c.need) && c.need > c.by) errs.push(`min constraint: need ${c.need} cannot be met by round ${c.by} (one pick per round)`);
        if ('through' in c || 'limit' in c) errs.push('min constraint takes by/need, not through/limit');
      } else {
        errs.push('constraint type must be "min" or "max"');
      }
    }
    // Cross-checks only over well-formed constraints.
    const ok = cons.filter((c) => c && MULT_POS.includes(c.pos)
      && ((c.type === 'max' && isInt(c.through) && isInt(c.limit))
        || (c.type === 'min' && isInt(c.by) && isInt(c.need))));
    // min vs max on the same position: picks of pos attainable by round B are
    // limit (window open through T) plus one per round after T.
    for (const mn of ok.filter((c) => c.type === 'min')) {
      for (const mx of ok.filter((c) => c.type === 'max' && c.pos === mn.pos)) {
        const attainable = mx.limit + Math.max(0, mn.by - mx.through);
        if (mn.need > attainable) {
          errs.push(`${mn.pos}: min ${mn.need} by R${mn.by} is infeasible under max ${mx.limit} through R${mx.through}`);
        }
      }
    }
    // Pigeonhole across positions: at any deadline R, the sum of binding
    // minimums cannot exceed R picks.
    const deadlines = [...new Set(ok.filter((c) => c.type === 'min').map((c) => c.by))];
    for (const R of deadlines) {
      const perPos = {};
      for (const c of ok) {
        if (c.type === 'min' && c.by <= R) perPos[c.pos] = Math.max(perPos[c.pos] ?? 0, c.need);
      }
      const total = Object.values(perPos).reduce((a, v) => a + v, 0);
      if (total > R) errs.push(`minimums sum to ${total} by round ${R} — more than ${R} picks exist`);
    }
  }

  if (spec.overrideDelta !== undefined
    && (typeof spec.overrideDelta !== 'number' || !(spec.overrideDelta > 0 && spec.overrideDelta <= 100))) {
    errs.push('overrideDelta must be a number in (0, 100]');
  }
  return errs;
}

/** Validate + normalize + deep-freeze one spec. Throws on invalid. */
export function defineStrategy(spec, opts = {}) {
  const errs = validateStrategy(spec, opts);
  if (errs.length) throw new Error(`invalid strategy${spec?.name ? ` "${spec.name}"` : ''}: ${errs.join('; ')}`);
  const multipliers = {};
  for (const [pos, rules] of Object.entries(spec.multipliers ?? {})) {
    multipliers[pos] = rules
      .map((r) => Object.freeze({ from: r.from, to: r.to, m: r.m }))
      .sort((a, b) => a.from - b.from);
    Object.freeze(multipliers[pos]);
  }
  const constraints = (spec.constraints ?? []).map((c) => Object.freeze(
    c.type === 'max'
      ? { pos: c.pos, type: 'max', through: c.through, limit: c.limit }
      : { pos: c.pos, type: 'min', by: c.by, need: c.need },
  ));
  return Object.freeze({
    name: spec.name,
    label: spec.label ?? spec.name,
    blurb: spec.blurb ?? '',
    multipliers: Object.freeze(multipliers),
    constraints: Object.freeze(constraints),
    overrideDelta: spec.overrideDelta ?? 20,
  });
}

/**
 * Built-ins first, then a caller-supplied registry of defined custom
 * strategies. Unknown names STILL throw (the getStrategy typo invariant);
 * any fallback must happen at boot, visibly — never silently mid-draft.
 * @param {string|null|undefined} name
 * @param {Object<string, object>|null} [registry]  name → defineStrategy()
 *        output (e.g. loaded from public/data/strategies.json).
 */
export function resolveStrategy(name, registry = null) {
  const n = name ?? 'balanced';
  const s = STRATEGIES[n] ?? (registry ? registry[n] : undefined);
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
