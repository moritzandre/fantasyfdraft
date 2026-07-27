// portable.ts — export/import JSON envelope for draft state.
//
//   { v: 1, exportedAt, buildHash, state }
//
// Rules:
//   - Round-trip must be LOSSLESS (league / picks / pickCursor / ui).
//   - Wrong envelope version, wrong schemaVersion, or wrong shape ⇒ REJECT.
//   - buildHash mismatch ⇒ WARNING flag in the result, never a rejection —
//     the user may import prep made against an older board on purpose.
//
// The accepted state feeds the store via { type: 'IMPORT_STATE', state }.
// Erasable TypeScript only.

import type { DraftState, LeagueConfig, PickEntry, PortableState, Source, UiState } from './store.ts';

export interface PortableEnvelope {
  v: 1;
  exportedAt: string;
  buildHash: string;
  state: PortableState;
}

export interface ImportResult {
  ok: boolean;
  state: PortableState | null; // present iff ok
  errors: string[]; // non-empty iff !ok
  warnings: string[]; // e.g. buildHash mismatch — import proceeds
  buildHashMismatch: boolean;
}

const SOURCES = new Set(['manual', 'sleeper', 'sim']);

const UI_DEFAULTS: UiState = {
  posFilter: 'ALL',
  searchText: '',
  showFive: true,
  grayscalePreview: false,
  lastScreen: 'ready',
  rehearsalDone: false,
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportState(s: DraftState, exportedAt?: string): PortableEnvelope {
  return {
    v: 1,
    exportedAt: exportedAt ?? new Date().toISOString(),
    buildHash: s.buildHash,
    state: {
      rev: s.rev,
      schemaVersion: 1,
      buildHash: s.buildHash,
      league: { ...s.league },
      picks: s.picks.map((p) => ({ ...p })),
      pickCursor: s.pickCursor,
      ui: { ...s.ui },
    },
  };
}

/** Pretty JSON for the Export button / file download. */
export function exportJson(s: DraftState, exportedAt?: string): string {
  return JSON.stringify(exportState(s, exportedAt), null, 2);
}

// ---------------------------------------------------------------------------
// Import — validate hard, warn soft.
// ---------------------------------------------------------------------------

function fail(errors: string[]): ImportResult {
  return { ok: false, state: null, errors, warnings: [], buildHashMismatch: false };
}

function isInt(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x);
}

/** Validate an envelope (object or JSON string). `currentBuildHash` is the
    running board's hash — a mismatch is flagged, never fatal. */
export function importEnvelope(raw: unknown, currentBuildHash?: string): ImportResult {
  let env: any = raw;
  if (typeof raw === 'string') {
    try {
      env = JSON.parse(raw);
    } catch {
      return fail(['not valid JSON']);
    }
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return fail(['envelope is not an object']);
  }
  if (env.v !== 1) return fail([`unsupported envelope version: ${String(env.v)}`]);

  const st: any = env.state;
  if (!st || typeof st !== 'object' || Array.isArray(st)) return fail(['missing state object']);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (st.schemaVersion !== 1) {
    errors.push(`unsupported state schemaVersion: ${String(st.schemaVersion)}`);
  }

  // --- league
  const lg: any = st.league;
  if (!lg || typeof lg !== 'object' || Array.isArray(lg)) {
    errors.push('state.league missing');
  } else {
    if (!isInt(lg.teams) || lg.teams < 2 || lg.teams > 32) errors.push('league.teams invalid');
    if (!isInt(lg.rounds) || lg.rounds < 1 || lg.rounds > 30) errors.push('league.rounds invalid');
    if (!isInt(lg.slot) || lg.slot < 1 || (isInt(lg.teams) && lg.slot > lg.teams)) {
      errors.push('league.slot invalid (must be 1..teams)');
    }
    if (typeof lg.snake !== 'boolean') errors.push('league.snake invalid');
    if (!lg.roster || typeof lg.roster !== 'object' || Array.isArray(lg.roster)) {
      errors.push('league.roster invalid');
    }
  }

  // --- picks
  const picksRaw: any = st.picks;
  const cleanPicks: PickEntry[] = [];
  if (!Array.isArray(picksRaw)) {
    errors.push('state.picks is not an array');
  } else {
    const total =
      lg && isInt(lg.teams) && isInt(lg.rounds) ? lg.teams * lg.rounds : Number.MAX_SAFE_INTEGER;
    const seenN = new Set<number>();
    const seenIdx = new Set<number>();
    for (let i = 0; i < picksRaw.length; i++) {
      const p: any = picksRaw[i];
      if (!p || typeof p !== 'object') {
        errors.push(`picks[${i}] is not an object`);
        break;
      }
      if (!isInt(p.n) || p.n < 1 || p.n > total) {
        errors.push(`picks[${i}].n out of range: ${String(p.n)}`);
        break;
      }
      if (!isInt(p.idx) || p.idx < 0) {
        errors.push(`picks[${i}].idx invalid: ${String(p.idx)}`);
        break;
      }
      if (seenN.has(p.n)) {
        errors.push(`duplicate pick number ${p.n}`);
        break;
      }
      if (seenIdx.has(p.idx)) {
        errors.push(`player idx ${p.idx} drafted twice`);
        break;
      }
      seenN.add(p.n);
      seenIdx.add(p.idx);
      const source: Source = SOURCES.has(p.source) ? p.source : 'manual';
      if (!SOURCES.has(p.source)) warnings.push(`picks[${i}].source "${String(p.source)}" coerced to manual`);
      cleanPicks.push({
        n: p.n,
        idx: p.idx,
        source,
        ts: typeof p.ts === 'number' && Number.isFinite(p.ts) ? p.ts : 0,
      });
    }
  }

  // --- pickCursor
  if (!isInt(st.pickCursor) || st.pickCursor < 1) errors.push('state.pickCursor invalid');

  // --- ui (forgiving: unknown keys pass through, missing keys defaulted)
  if (st.ui !== undefined && (typeof st.ui !== 'object' || st.ui === null || Array.isArray(st.ui))) {
    errors.push('state.ui invalid');
  }

  if (errors.length > 0) return { ok: false, state: null, errors, warnings, buildHashMismatch: false };

  // --- buildHash: WARNING on mismatch, never a rejection
  const bh =
    typeof env.buildHash === 'string' && env.buildHash
      ? env.buildHash
      : typeof st.buildHash === 'string'
        ? st.buildHash
        : '';
  const mismatch = Boolean(currentBuildHash && bh && bh !== currentBuildHash);
  if (mismatch) {
    warnings.push(
      `buildHash mismatch: export is from board ${bh}, current board is ${currentBuildHash} — importing anyway`,
    );
  }

  const total = (st.league.teams as number) * (st.league.rounds as number);
  const state: PortableState = {
    rev: isInt(st.rev) && st.rev >= 0 ? st.rev : 0,
    schemaVersion: 1,
    buildHash: bh,
    league: { ...(st.league as LeagueConfig) },
    picks: cleanPicks.sort((a, b) => a.n - b.n),
    pickCursor: Math.min(st.pickCursor as number, total + 1),
    ui: { ...UI_DEFAULTS, ...(st.ui as Partial<UiState> | undefined) },
  };

  return { ok: true, state, errors: [], warnings, buildHashMismatch: mismatch };
}
