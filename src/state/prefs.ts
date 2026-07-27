// prefs.ts — the PREP layer: user data that must survive independently of
// draft state (tags, per-player overrides, tier edits, strategy choice).
// Separate localStorage key 'dp:prefs:v1' with SYNCHRONOUS save on every
// change — a rebuilt board.json or a RESET_DRAFT must never clobber prep
// work. Shape mirrors public/data/overrides.json, keyed by the STABLE player
// `id` (not `idx`) so prefs survive a board rebuild that reorders players.
//
// applyPrefs(board, prefs) is PURE (no storage, no clock) and is used by both
// the prep preview (PrepScreen derives live) and the live app (LiveApp applies
// prefs to the fetched board once, before createStore boot):
//   - projections[id] = delta → proj.halfPpr += delta and eff moves by
//     delta·(gamesExpected/17) — the eff formula's exact sensitivity.
//   - adp[id] = mu → replaces adp.mu (divergence recomputed, source 'override').
//   - staleNews ∋ id → adp.sigmaFinal × 1.35 (plan's σ cascade) + 'stale-news' flag.
//   - tierOverride[id] = t → wins over the board tier; board.tiers membership
//     is regrouped for that position (moved-into groups marked edited:true;
//     boundary stats of edited groups are cleared, not faked).
//   - tags[id] = {tag, note} → p.tag/p.tagNote plus the tag name pushed into
//     p.flags (so the live TARGETS filter sees prep targets); the note prints
//     verbatim on sheet S10.
//
// Export/import stays SEPARATE from the draft-state portable envelope:
// exportPrefsJson / importPrefsJson ('dp-prefs' envelope).
//
// Erasable TS only (plain annotations) — node --test runs this file directly.

import { tierLetter } from '../../shared/format.js';

export type TagName = 'target' | 'value' | 'avoid' | 'never';

export interface TagEntry {
  tag: TagName;
  note: string;
}

export interface Prefs {
  v: 1;
  /** id → half-PPR projection DELTA in season points. */
  projections: Record<string, number>;
  /** id → ADP mu override (absolute pick number). */
  adp: Record<string, number>;
  /** ids whose news is stale — σ_final inflated ×1.35. */
  staleNews: string[];
  /** id → tier number (per-position); wins over the board tier. */
  tierOverride: Record<string, number>;
  /** id → tag + one-line note (note prints verbatim on S10). */
  tags: Record<string, TagEntry>;
  /** [[leadId, backupId], …] handcuff pairs. */
  handcuffs: [string, string][];
  /** chosen strategy name (also mirrored into league via SET_LEAGUE). */
  strategy: string | null;
}

export const PREFS_KEY = 'dp:prefs:v1';
export const STALE_SIGMA_MULT = 1.35;
export const TAG_NAMES: TagName[] = ['target', 'value', 'avoid', 'never'];

export function emptyPrefs(): Prefs {
  return {
    v: 1,
    projections: {},
    adp: {},
    staleNews: [],
    tierOverride: {},
    tags: {},
    handcuffs: [],
    strategy: null,
  };
}

export function isEmptyPrefs(p: Prefs): boolean {
  return (
    Object.keys(p.projections).length === 0 &&
    Object.keys(p.adp).length === 0 &&
    p.staleNews.length === 0 &&
    Object.keys(p.tierOverride).length === 0 &&
    Object.keys(p.tags).length === 0 &&
    p.handcuffs.length === 0 &&
    p.strategy == null
  );
}

// ---------------------------------------------------------------------------
// Validation — corrupt or foreign data must never take down prep or boot.
// ---------------------------------------------------------------------------

function numRecord(o: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : NaN;
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

/** Coerce anything into a valid Prefs — silently drops invalid entries. */
export function normalizePrefs(raw: unknown): Prefs {
  const p = emptyPrefs();
  if (!raw || typeof raw !== 'object') return p;
  const o = raw as Record<string, unknown>;

  p.projections = numRecord(o.projections);
  p.adp = numRecord(o.adp);

  if (Array.isArray(o.staleNews)) {
    p.staleNews = [...new Set(o.staleNews.filter((x) => typeof x === 'string' || typeof x === 'number').map(String))];
  }

  const tiers = numRecord(o.tierOverride);
  for (const [id, t] of Object.entries(tiers)) {
    const ti = Math.trunc(t);
    if (ti >= 1 && ti <= 26) p.tierOverride[id] = ti;
  }

  if (o.tags && typeof o.tags === 'object' && !Array.isArray(o.tags)) {
    for (const [id, v] of Object.entries(o.tags as Record<string, unknown>)) {
      const e = v as Record<string, unknown> | null;
      if (e && typeof e === 'object' && TAG_NAMES.includes(e.tag as TagName)) {
        p.tags[id] = { tag: e.tag as TagName, note: typeof e.note === 'string' ? e.note : '' };
      }
    }
  }

  if (Array.isArray(o.handcuffs)) {
    for (const pair of o.handcuffs) {
      if (Array.isArray(pair) && pair.length === 2) {
        p.handcuffs.push([String(pair[0]), String(pair[1])]);
      }
    }
  }

  if (typeof o.strategy === 'string' && o.strategy.length > 0) p.strategy = o.strategy;
  return p;
}

// ---------------------------------------------------------------------------
// Persistence — synchronous localStorage on every change (same discipline as
// the draft store: iPad Safari discards tabs with zero warning).
// ---------------------------------------------------------------------------

export interface PrefsStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): PrefsStorageLike | null {
  try {
    const s = (globalThis as any).localStorage;
    return s && typeof s.getItem === 'function' ? (s as PrefsStorageLike) : null;
  } catch {
    return null;
  }
}

export function loadPrefs(storage: PrefsStorageLike | null = defaultStorage()): Prefs {
  if (!storage) return emptyPrefs();
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return emptyPrefs();
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return emptyPrefs();
  }
}

/** SYNCHRONOUS write — called on every prefs mutation, never debounced. */
export function savePrefs(prefs: Prefs, storage: PrefsStorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* quota/private mode — prep still works in-memory */
  }
}

// ---------------------------------------------------------------------------
// Pure mutation helpers — each returns a NEW Prefs (never mutates the input),
// dropping entries that revert to the default so prefs stay minimal.
// ---------------------------------------------------------------------------

export function setProjDelta(p: Prefs, id: string, delta: number): Prefs {
  const projections = { ...p.projections };
  if (Number.isFinite(delta) && delta !== 0) projections[id] = delta;
  else delete projections[id];
  return { ...p, projections };
}

export function setAdpOverride(p: Prefs, id: string, mu: number | null): Prefs {
  const adp = { ...p.adp };
  if (mu != null && Number.isFinite(mu) && mu > 0) adp[id] = mu;
  else delete adp[id];
  return { ...p, adp };
}

export function toggleStaleNews(p: Prefs, id: string): Prefs {
  const has = p.staleNews.includes(id);
  return { ...p, staleNews: has ? p.staleNews.filter((x) => x !== id) : [...p.staleNews, id] };
}

/** tier === null (or the player's base tier, when known) clears the override. */
export function setTierOverride(p: Prefs, id: string, tier: number | null, baseTier?: number): Prefs {
  const tierOverride = { ...p.tierOverride };
  const t = tier == null ? NaN : Math.trunc(tier);
  if (Number.isFinite(t) && t >= 1 && t !== baseTier) tierOverride[id] = t;
  else delete tierOverride[id];
  return { ...p, tierOverride };
}

export function setTag(p: Prefs, id: string, tag: TagName | null, note: string = ''): Prefs {
  const tags = { ...p.tags };
  if (tag && TAG_NAMES.includes(tag)) tags[id] = { tag, note };
  else delete tags[id];
  return { ...p, tags };
}

export function setStrategy(p: Prefs, strategy: string | null): Prefs {
  return { ...p, strategy };
}

// ---------------------------------------------------------------------------
// Export / import — its OWN envelope, deliberately separate from the draft
// portable envelope (prep data outlives any single draft).
// ---------------------------------------------------------------------------

export function exportPrefsJson(prefs: Prefs, now: () => number = Date.now): string {
  return JSON.stringify(
    { kind: 'dp-prefs', v: 1, savedAt: new Date(now()).toISOString(), prefs },
    null,
    2,
  );
}

/** Accepts the 'dp-prefs' envelope or a bare prefs object; throws on garbage. */
export function importPrefsJson(json: string): Prefs {
  let o: any;
  try {
    o = JSON.parse(json);
  } catch {
    throw new Error('not valid JSON');
  }
  if (!o || typeof o !== 'object') throw new Error('not a prefs object');
  const body = o.kind === 'dp-prefs' ? o.prefs : o;
  if (!body || typeof body !== 'object') throw new Error('no prefs payload found');
  const normalized = normalizePrefs(body);
  if (o.kind !== 'dp-prefs' && isEmptyPrefs(normalized)) {
    throw new Error('no recognizable prefs fields (projections/adp/tags/tierOverride/…)');
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// applyPrefs — PURE derivation of the effective board.
// ---------------------------------------------------------------------------

const round1 = (x: number): number => Math.round(x * 10) / 10;

interface BoardLike {
  players: any[];
  tiers?: any[];
  [k: string]: unknown;
}

/**
 * Apply the prep layer to a board. Pure: never mutates `board`, returns the
 * SAME object when prefs are empty. Precedence: tierOverride > board tier;
 * projection deltas move both proj.halfPpr and eff; staleNews inflates
 * adp.sigmaFinal ×1.35; tags land in flags so live filters see them.
 */
export function applyPrefs<T extends BoardLike>(board: T, prefs: Prefs): T {
  if (!board || !Array.isArray(board.players) || isEmptyPrefs(prefs)) return board;

  const stale = new Set(prefs.staleNews);
  const touchedPos = new Set<string>();

  const players = board.players.map((p) => {
    const id = String(p?.id ?? '');
    let q = p;
    const clone = () => {
      if (q === p) {
        q = {
          ...p,
          proj: p.proj ? { ...p.proj } : p.proj,
          adp: p.adp ? { ...p.adp } : p.adp,
          flags: Array.isArray(p.flags) ? [...p.flags] : [],
        };
      }
      return q;
    };

    const delta = prefs.projections[id];
    if (Number.isFinite(delta) && delta !== 0) {
      clone();
      q.projDelta = delta;
      if (q.proj) q.proj.halfPpr = round1((p.proj?.halfPpr ?? 0) + delta);
      const g = Number.isFinite(p.gamesExpected) ? p.gamesExpected : 17;
      if (Number.isFinite(p.eff)) q.eff = round1(p.eff + delta * (g / 17));
    }

    const mu = prefs.adp[id];
    if (Number.isFinite(mu) && q.adp !== undefined) {
      clone();
      if (q.adp) {
        q.adp.mu = mu;
        if (Number.isFinite(q.adp.espnMu)) q.adp.divergence = round1(mu - q.adp.espnMu);
        q.adp.sigmaSource = 'override';
      }
    }

    if (stale.has(id)) {
      clone();
      if (q.adp && Number.isFinite(q.adp.sigmaFinal)) {
        q.adp.sigmaFinal = round1(q.adp.sigmaFinal * STALE_SIGMA_MULT);
      }
      if (!q.flags.includes('stale-news')) q.flags.push('stale-news');
    }

    const t = prefs.tierOverride[id];
    if (Number.isFinite(t) && t >= 1 && t !== p.tier) {
      clone();
      q.tier = t;
      q.tierLetter = tierLetter(t);
      touchedPos.add(p.pos);
    }

    const tag = prefs.tags[id];
    if (tag && tag.tag) {
      clone();
      q.tag = tag.tag;
      q.tagNote = tag.note ?? '';
      if (!q.flags.includes(tag.tag)) q.flags.push(tag.tag);
    }

    return q;
  });

  // Regroup board.tiers for positions with tier overrides. Boundary stats of
  // edited groups are CLEARED (edited:true), never faked — TierSep is a
  // statistical statement about the original clustering.
  let tiers = board.tiers;
  if (Array.isArray(tiers) && touchedPos.size > 0) {
    const byIdx = new Map(players.map((pl) => [pl.idx, pl]));
    const out: any[] = [];
    const positions: string[] = [];
    for (const g of tiers) if (!positions.includes(g.pos)) positions.push(g.pos);

    for (const pos of positions) {
      const groups = tiers.filter((g) => g.pos === pos);
      if (!touchedPos.has(pos)) {
        out.push(...groups);
        continue;
      }
      const byTier = new Map<number, any>();
      for (const g of groups) byTier.set(g.tier, { ...g, members: [] as number[] });
      for (const g of groups) {
        for (const idx of g.members) {
          const pl = byIdx.get(idx);
          const target = Number.isFinite(pl?.tier) ? pl.tier : g.tier;
          if (!byTier.has(target)) {
            byTier.set(target, {
              pos,
              tier: target,
              letter: tierLetter(target),
              members: [] as number[],
              cliffPoints: null,
              meanGap: null,
              tierSep: null,
              edited: true,
            });
          }
          const tg = byTier.get(target);
          tg.members.push(idx);
          if (target !== g.tier) {
            tg.edited = true;
            tg.cliffPoints = null;
            tg.meanGap = null;
            tg.tierSep = null;
          }
        }
      }
      const rebuilt = [...byTier.values()]
        .filter((g) => g.members.length > 0)
        .sort((a, b) => a.tier - b.tier);
      for (const g of rebuilt) {
        g.members.sort((a: number, b: number) => {
          const ea = byIdx.get(a)?.eff ?? -Infinity;
          const eb = byIdx.get(b)?.eff ?? -Infinity;
          return eb - ea;
        });
        // a group that LOST members is also edited — its boundary stats moved
        const orig = groups.find((og) => og.tier === g.tier);
        if (orig && orig.members.length !== g.members.length) g.edited = true;
      }
      out.push(...rebuilt);
    }
    tiers = out;
  }

  return { ...board, players, tiers, prefsApplied: true } as T;
}
