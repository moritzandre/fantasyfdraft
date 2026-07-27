// opponents.test.ts — the opponents loader + LOCAL room layer
// (dp:opponents-local:v1): save/load round-trip, the deep-merge semantics
// (mix replace / archetypes off / params shallow / seats by number), cache
// invalidation, degradation on a broken file.
// Run: node --test "src/state/*.test.ts"   (Node strip-types — erasable TS only)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_OPPONENTS_KEY,
  applyLocalOpponents,
  invalidateOpponents,
  loadLocalOpponents,
  loadOpponents,
  saveLocalOpponents,
  seatName,
} from './opponents.ts';
import type { OpponentsFile, OppStorageLike } from './opponents.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeStorage(): OppStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeFetch(body: unknown, ok = true): (url: string) => Promise<Response> {
  return () =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      json: () => Promise.resolve(body),
    } as unknown as Response);
}

const FILE: OpponentsFile = {
  archetypes: { mix: { balanced: 0.6, robust_rb: 0.4 } },
  params: { archetypeGamma: 3, earlyTauThrough: 2 },
  seats: [
    { seat: 1, name: '', adpDiscipline: 0.5, positionBias: { RB: 1.2 }, homerTeams: ['DAL'], reachRounds: [1] },
    { seat: 2, name: 'Bo', adpDiscipline: 0.7, positionBias: {}, homerTeams: [], reachRounds: [] },
  ],
};

// ---------------------------------------------------------------------------
// Local storage round-trip
// ---------------------------------------------------------------------------

test('opponents: local save/load round-trips; null clears; corrupt is null', () => {
  const st = fakeStorage();
  assert.equal(loadLocalOpponents(st), null, 'empty storage ⇒ null');

  const patch = { archetypes: { mix: { balanced: 1 } }, seats: [{ seat: 3, name: 'Zed' }] };
  saveLocalOpponents(patch, st);
  assert.ok(st.data.has(LOCAL_OPPONENTS_KEY), 'writes the versioned key');
  assert.deepEqual(loadLocalOpponents(st), patch, 'round-trip');

  saveLocalOpponents(null, st);
  assert.equal(loadLocalOpponents(st), null, 'null clears the layer');

  st.data.set(LOCAL_OPPONENTS_KEY, '{not json');
  assert.equal(loadLocalOpponents(st), null, 'corrupt JSON ⇒ null, never a throw');
  st.data.set(LOCAL_OPPONENTS_KEY, '[1,2]');
  assert.equal(loadLocalOpponents(st), null, 'non-object ⇒ null');

  assert.equal(loadLocalOpponents(null), null, 'no storage (Node) ⇒ null');
  saveLocalOpponents(patch, null); // must not throw
});

// ---------------------------------------------------------------------------
// Merge semantics
// ---------------------------------------------------------------------------

test('opponents: mix REPLACES the file mix; explicit null turns archetypes OFF', () => {
  const replaced = applyLocalOpponents(FILE, { archetypes: { mix: { wr_heavy: 1 } } });
  assert.deepEqual(replaced.archetypes, { mix: { wr_heavy: 1 } }, 'no blending with the file mix');

  const offA = applyLocalOpponents(FILE, { archetypes: null });
  assert.equal(offA.archetypes, null, 'patch.archetypes null ⇒ off');
  const offB = applyLocalOpponents(FILE, { archetypes: { mix: null } });
  assert.equal(offB.archetypes, null, 'patch mix null ⇒ off');

  const untouched = applyLocalOpponents(FILE, { params: { tauScale: 2 } });
  assert.deepEqual(untouched.archetypes, FILE.archetypes, 'absent key leaves the file mix');
  assert.deepEqual(applyLocalOpponents(FILE, null), FILE, 'null patch is identity');
});

test('opponents: params shallow-merge over file params', () => {
  const m = applyLocalOpponents(FILE, { params: { earlyTauScale: 0.5, archetypeGamma: 1 } });
  assert.deepEqual(m.params, { archetypeGamma: 1, earlyTauThrough: 2, earlyTauScale: 0.5 });
  assert.deepEqual(FILE.params, { archetypeGamma: 3, earlyTauThrough: 2 }, 'file object untouched');
});

test('opponents: seats merge by seat number — name/adpDiscipline/archetype only', () => {
  const m = applyLocalOpponents(FILE, {
    seats: [
      { seat: 1, archetype: 'zero_rb_mod', adpDiscipline: 0.9 },
      { seat: 2, name: 'Cat', archetype: null }, // null archetype = clear
      { seat: 5, name: 'New', archetype: 'wr_heavy' }, // seat not in the file
    ],
  });
  const s1 = m.seats!.find((x) => x.seat === 1)!;
  assert.equal(s1.archetype, 'zero_rb_mod');
  assert.equal(s1.adpDiscipline, 0.9);
  assert.deepEqual(s1.positionBias, { RB: 1.2 }, 'untouched tendency fields survive');
  assert.deepEqual(s1.homerTeams, ['DAL']);
  const s2 = m.seats!.find((x) => x.seat === 2)!;
  assert.equal(s2.name, 'Cat');
  assert.ok(!('archetype' in s2), 'archetype null clears the key');
  assert.equal(s2.adpDiscipline, 0.7, 'unpatched field keeps the file value');
  const s5 = m.seats!.find((x) => x.seat === 5)!;
  assert.equal(s5.archetype, 'wr_heavy');
  assert.equal(FILE.seats!.length, 2, 'file seats untouched');
  assert.ok(!('archetype' in FILE.seats![0]!), 'file seat objects not mutated');
});

// ---------------------------------------------------------------------------
// loadOpponents: file ⊕ local + cache invalidation
// ---------------------------------------------------------------------------

test('opponents: loadOpponents merges the local patch; invalidateOpponents re-merges', async () => {
  invalidateOpponents();
  const st = fakeStorage();
  const fetchFn = fakeFetch(FILE);

  const plain = await loadOpponents(fetchFn, '/', st);
  assert.deepEqual(plain.archetypes, FILE.archetypes, 'no local layer ⇒ file as-is');

  saveLocalOpponents({ archetypes: null, seats: [{ seat: 2, archetype: 'robust_rb' }] }, st);
  const cached = await loadOpponents(fetchFn, '/', st);
  assert.deepEqual(cached.archetypes, FILE.archetypes, 'session cache served until invalidated');

  invalidateOpponents();
  const merged = await loadOpponents(fetchFn, '/', st);
  assert.equal(merged.archetypes, null, 'invalidate ⇒ the saved patch applies');
  assert.equal(merged.seats!.find((x) => x.seat === 2)!.archetype, 'robust_rb');
  assert.equal(seatName(merged, 2), 'Bo', 'seatName still resolves on the merged room');
  invalidateOpponents();
});

test('opponents: a failed fetch still applies the local patch over neutral seats', async () => {
  invalidateOpponents();
  const st = fakeStorage();
  saveLocalOpponents({ seats: [{ seat: 4, name: 'Solo', archetype: 'balanced' }] }, st);
  const merged = await loadOpponents(fakeFetch(null, false), '/', st);
  assert.deepEqual(merged.seats, [{ seat: 4, name: 'Solo', archetype: 'balanced' }]);
  invalidateOpponents();
});
