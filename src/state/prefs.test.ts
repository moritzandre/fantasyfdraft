// prefs.test.ts — the prep layer: applyPrefs purity + delta application +
// staleNews sigma + tierOverride precedence/regrouping, mutation helpers,
// persistence round-trip, import validation.
// Run: node --test "src/state/*.test.ts"   (Node 24 strip-types — erasable TS only)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFS_KEY,
  STALE_SIGMA_MULT,
  applyPrefs,
  emptyPrefs,
  exportPrefsJson,
  importPrefsJson,
  isEmptyPrefs,
  loadPrefs,
  normalizePrefs,
  savePrefs,
  setAdpOverride,
  setProjDelta,
  setTag,
  setTierOverride,
  setStrategy,
  toggleStaleNews,
} from './prefs.ts';
import type { Prefs, PrefsStorageLike } from './prefs.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBoard() {
  const mk = (idx: number, id: string, pos: string, tier: number, eff: number, halfPpr: number) => ({
    idx,
    id,
    name: `P${idx}`,
    pos,
    team: 'DET',
    bye: 6,
    proj: { halfPpr, rec: 50 },
    eff,
    gamesExpected: 17,
    sigmaProj: 60,
    adp: { mu: idx + 1, sd: 2, espnMu: idx + 2, divergence: -1, sigmaFinal: 2, sigmaSource: 'ffc_stdev' },
    tier,
    tierLetter: String.fromCharCode(64 + tier),
    posRank: idx + 1,
    overallRank: idx + 1,
    flags: [] as string[],
  });
  return {
    buildHash: 'testhash',
    players: [
      mk(0, 'a', 'RB', 1, 290, 330),
      mk(1, 'b', 'RB', 1, 260, 300),
      mk(2, 'c', 'RB', 2, 220, 250),
      mk(3, 'd', 'WR', 1, 240, 270),
    ],
    tiers: [
      { pos: 'RB', tier: 1, letter: 'A', members: [0, 1], cliffPoints: 40, meanGap: 10, tierSep: 1.2 },
      { pos: 'RB', tier: 2, letter: 'B', members: [2], cliffPoints: 20, meanGap: 5, tierSep: 0.8 },
      { pos: 'WR', tier: 1, letter: 'A', members: [3], cliffPoints: 30, meanGap: 8, tierSep: 1.1 },
    ],
  };
}

function fakeStorage(): PrefsStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

// ---------------------------------------------------------------------------
// applyPrefs
// ---------------------------------------------------------------------------

test('applyPrefs: empty prefs returns the SAME board object', () => {
  const board = makeBoard();
  assert.equal(applyPrefs(board, emptyPrefs()), board);
});

test('applyPrefs: projection delta moves halfPpr and eff by delta·g/17', () => {
  const board = makeBoard();
  const prefs = setProjDelta(emptyPrefs(), 'a', 20);
  const out = applyPrefs(board, prefs);
  assert.equal(out.players[0].proj.halfPpr, 350); // 330 + 20
  assert.equal(out.players[0].eff, 310); // 290 + 20·(17/17)
  assert.equal(out.players[0].projDelta, 20);
  // untouched player is the same reference; original board unmutated
  assert.equal(out.players[1], board.players[1]);
  assert.equal(board.players[0].proj.halfPpr, 330);
  assert.equal(board.players[0].eff, 290);
});

test('applyPrefs: projection delta scales by gamesExpected', () => {
  const board = makeBoard();
  (board.players[0] as any).gamesExpected = 8.5; // half a season
  const out = applyPrefs(board, setProjDelta(emptyPrefs(), 'a', 20));
  assert.equal(out.players[0].eff, 300); // 290 + 20·(8.5/17)
  assert.equal(out.players[0].proj.halfPpr, 350); // season projection moves fully
});

test('applyPrefs: staleNews inflates adp.sigmaFinal ×1.35 and flags the player', () => {
  const board = makeBoard();
  const out = applyPrefs(board, toggleStaleNews(emptyPrefs(), 'b'));
  assert.equal(out.players[1].adp.sigmaFinal, 2.7); // 2 × 1.35
  assert.ok(out.players[1].flags.includes('stale-news'));
  assert.equal(STALE_SIGMA_MULT, 1.35);
  // sigmaProj and mu untouched
  assert.equal(out.players[1].sigmaProj, 60);
  assert.equal(out.players[1].adp.mu, 2);
  assert.equal(board.players[1].adp.sigmaFinal, 2);
});

test('applyPrefs: ADP override replaces mu, recomputes divergence, marks source', () => {
  const board = makeBoard();
  const out = applyPrefs(board, setAdpOverride(emptyPrefs(), 'c', 12));
  assert.equal(out.players[2].adp.mu, 12);
  assert.equal(out.players[2].adp.divergence, 8); // 12 − espnMu 4
  assert.equal(out.players[2].adp.sigmaSource, 'override');
  assert.equal(board.players[2].adp.mu, 3);
});

test('applyPrefs: tierOverride wins over the board tier and regroups tiers', () => {
  const board = makeBoard();
  const prefs = setTierOverride(emptyPrefs(), 'b', 2); // b: tier 1 → 2
  const out = applyPrefs(board, prefs);
  assert.equal(out.players[1].tier, 2);
  assert.equal(out.players[1].tierLetter, 'B');
  const rb1 = out.tiers.find((g: any) => g.pos === 'RB' && g.tier === 1);
  const rb2 = out.tiers.find((g: any) => g.pos === 'RB' && g.tier === 2);
  assert.deepEqual(rb1.members, [0]);
  // members sorted by eff desc: b (260) ahead of c (220)
  assert.deepEqual(rb2.members, [1, 2]);
  assert.equal(rb1.edited, true); // lost a member
  assert.equal(rb2.edited, true); // gained one — boundary stats cleared
  assert.equal(rb2.tierSep, null);
  // WR groups untouched — same reference
  const wr1 = out.tiers.find((g: any) => g.pos === 'WR');
  assert.equal(wr1, board.tiers[2]);
  // original board's tiers unmutated
  assert.deepEqual(board.tiers[0].members, [0, 1]);
});

test('applyPrefs: tierOverride can create a NEW tier group', () => {
  const board = makeBoard();
  const out = applyPrefs(board, setTierOverride(emptyPrefs(), 'c', 3)); // beyond last RB tier
  const rb3 = out.tiers.find((g: any) => g.pos === 'RB' && g.tier === 3);
  assert.ok(rb3);
  assert.deepEqual(rb3.members, [2]);
  assert.equal(rb3.letter, 'C');
  assert.equal(rb3.edited, true);
  // emptied tier-2 group is dropped
  assert.equal(out.tiers.some((g: any) => g.pos === 'RB' && g.tier === 2), false);
});

test('applyPrefs: tags land on the player AND in flags (live TARGETS filter)', () => {
  const board = makeBoard();
  const out = applyPrefs(board, setTag(emptyPrefs(), 'd', 'target', 'league winner upside'));
  assert.equal(out.players[3].tag, 'target');
  assert.equal(out.players[3].tagNote, 'league winner upside');
  assert.ok(out.players[3].flags.includes('target'));
  assert.deepEqual(board.players[3].flags, []);
});

test('applyPrefs: all layers stack on one player', () => {
  const board = makeBoard();
  let p = emptyPrefs();
  p = setProjDelta(p, 'a', -17);
  p = toggleStaleNews(p, 'a');
  p = setAdpOverride(p, 'a', 5);
  p = setTag(p, 'a', 'avoid', 'holdout risk');
  const out = applyPrefs(board, p);
  const a = out.players[0];
  assert.equal(a.proj.halfPpr, 313);
  assert.equal(a.eff, 273);
  assert.equal(a.adp.mu, 5);
  assert.equal(a.adp.sigmaFinal, 2.7);
  assert.ok(a.flags.includes('stale-news') && a.flags.includes('avoid'));
});

// ---------------------------------------------------------------------------
// Mutation helpers keep prefs minimal
// ---------------------------------------------------------------------------

test('helpers: reverting an edit removes the entry entirely', () => {
  let p = emptyPrefs();
  p = setProjDelta(p, 'a', 10);
  p = setProjDelta(p, 'a', 0);
  assert.equal('a' in p.projections, false);

  p = setAdpOverride(p, 'a', 12);
  p = setAdpOverride(p, 'a', null);
  assert.equal('a' in p.adp, false);

  p = toggleStaleNews(p, 'a');
  p = toggleStaleNews(p, 'a');
  assert.deepEqual(p.staleNews, []);

  p = setTierOverride(p, 'a', 2);
  p = setTierOverride(p, 'a', null);
  assert.equal('a' in p.tierOverride, false);

  // setting the override back to the base tier also clears it
  p = setTierOverride(p, 'a', 1, 1);
  assert.equal('a' in p.tierOverride, false);

  p = setTag(p, 'a', 'never');
  p = setTag(p, 'a', null);
  assert.equal('a' in p.tags, false);

  p = setStrategy(p, 'anchor_rb');
  assert.equal(p.strategy, 'anchor_rb');
  p = setStrategy(p, null);
  assert.equal(isEmptyPrefs(p), true);
});

test('helpers: never mutate their input', () => {
  const p0 = emptyPrefs();
  setProjDelta(p0, 'a', 10);
  setTag(p0, 'a', 'value');
  toggleStaleNews(p0, 'a');
  assert.equal(isEmptyPrefs(p0), true);
});

// ---------------------------------------------------------------------------
// Persistence + envelope
// ---------------------------------------------------------------------------

test('save/load round-trip through storage, key dp:prefs:v1', () => {
  const storage = fakeStorage();
  let p = setTag(emptyPrefs(), 'a', 'target', 'my guy');
  p = setProjDelta(p, 'b', -12);
  p = setStrategy(p, 'zero_rb_mod');
  savePrefs(p, storage);
  assert.ok(storage.data.has(PREFS_KEY));
  const back = loadPrefs(storage);
  assert.deepEqual(back, p);
});

test('loadPrefs survives corrupt storage', () => {
  const storage = fakeStorage();
  storage.data.set(PREFS_KEY, '{not json');
  assert.equal(isEmptyPrefs(loadPrefs(storage)), true);
  assert.equal(isEmptyPrefs(loadPrefs(null)), true);
});

test('normalizePrefs drops invalid entries, keeps valid ones', () => {
  const p = normalizePrefs({
    projections: { a: 10, b: 'nope', c: NaN },
    adp: { a: 12.5 },
    staleNews: ['x', 3, null, 'x'],
    tierOverride: { a: 2, b: 0, c: 99 },
    tags: { a: { tag: 'target', note: 'n' }, b: { tag: 'GOAT' }, c: null },
    handcuffs: [['l', 'h'], 'nope', ['only-one']],
    strategy: 42,
  });
  assert.deepEqual(p.projections, { a: 10 });
  assert.deepEqual(p.adp, { a: 12.5 });
  assert.deepEqual(p.staleNews, ['x', '3']);
  assert.deepEqual(p.tierOverride, { a: 2 });
  assert.deepEqual(Object.keys(p.tags), ['a']);
  assert.deepEqual(p.handcuffs, [['l', 'h']]);
  assert.equal(p.strategy, null);
});

test('export/import round-trip via the dp-prefs envelope', () => {
  let p = setTierOverride(emptyPrefs(), 'a', 2);
  p = setTag(p, 'b', 'never', 'ACL in January');
  const json = exportPrefsJson(p, () => 0);
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, 'dp-prefs');
  assert.equal(parsed.v, 1);
  assert.deepEqual(importPrefsJson(json), p);
});

test('importPrefsJson rejects garbage', () => {
  assert.throws(() => importPrefsJson('not json'), /valid JSON/);
  assert.throws(() => importPrefsJson('42'), /not a prefs object/);
  assert.throws(() => importPrefsJson('{"hello":"world"}'), /no recognizable prefs fields/);
});
