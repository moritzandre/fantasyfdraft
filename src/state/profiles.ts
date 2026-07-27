// profiles.ts — league profiles: the hub's registry of leagues this app
// serves. Each profile owns an independent draft-state CONTEXT (see
// persist.ts snapshotKey) plus its sync ids and board reference. The
// DEFAULT profile in real mode maps to the LEGACY context '' — a
// pre-profiles install keeps its persisted draft state with zero
// migration.
//
// Storage: one synchronous localStorage key 'dp:profiles:v1' (registry) +
// 'dp:activeProfile:v1' (active id). Erasable TS, injectable storage,
// `node --test` clean.

import type { LeagueConfig } from './store.ts';
import type { StorageLike } from './persist.ts';

export const PROFILES_KEY = 'dp:profiles:v1';
export const ACTIVE_KEY = 'dp:activeProfile:v1';
export const DEFAULT_PROFILE_ID = 'default';

export interface LeagueProfile {
  id: string;                      // ^[a-z0-9][a-z0-9-]{0,31}$
  name: string;                    // display label
  league: Partial<LeagueConfig>;   // seed config for a fresh draft in this profile
  board: string;                   // data file under data/, e.g. 'board.json'
  sleeperLeagueId: string | null;
  sleeperDraftId: string | null;
}

export interface ProfilesState {
  v: 1;
  profiles: LeagueProfile[];
  activeId: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function defaultStorage(): StorageLike | null {
  const g: any = globalThis as any;
  try {
    const s = g.localStorage;
    if (s && typeof s.getItem === 'function') return s as StorageLike;
  } catch {
    /* private mode */
  }
  return null;
}

export function makeDefaultProfile(league: Partial<LeagueConfig>): LeagueProfile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: 'My league',
    league,
    board: 'board.json',
    sleeperLeagueId: null,
    sleeperDraftId: null,
  };
}

function normalizeProfile(raw: any): LeagueProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null;
  return {
    id: raw.id,
    name: raw.name,
    league: raw.league && typeof raw.league === 'object' ? raw.league : {},
    board: typeof raw.board === 'string' && raw.board.length > 0 ? raw.board : 'board.json',
    sleeperLeagueId: typeof raw.sleeperLeagueId === 'string' ? raw.sleeperLeagueId : null,
    sleeperDraftId: typeof raw.sleeperDraftId === 'string' ? raw.sleeperDraftId : null,
  };
}

/** Load the registry; a missing/corrupt blob yields the default profile
    seeded from `defaultLeague` (config/league.json — the caller imports
    it). The default profile is ALWAYS present and always first. */
export function loadProfiles(
  defaultLeague: Partial<LeagueConfig>,
  storage: StorageLike | null = defaultStorage(),
): ProfilesState {
  let profiles: LeagueProfile[] = [];
  let activeId = DEFAULT_PROFILE_ID;
  if (storage) {
    try {
      const raw = JSON.parse(storage.getItem(PROFILES_KEY) ?? 'null');
      if (raw && raw.v === 1 && Array.isArray(raw.profiles)) {
        profiles = raw.profiles.map(normalizeProfile).filter(Boolean) as LeagueProfile[];
      }
    } catch {
      profiles = [];
    }
    try {
      const a = storage.getItem(ACTIVE_KEY);
      if (a) activeId = a;
    } catch {
      /* swallow */
    }
  }
  if (!profiles.some((p) => p.id === DEFAULT_PROFILE_ID)) {
    profiles = [makeDefaultProfile(defaultLeague), ...profiles];
  } else {
    profiles = [
      ...profiles.filter((p) => p.id === DEFAULT_PROFILE_ID),
      ...profiles.filter((p) => p.id !== DEFAULT_PROFILE_ID),
    ];
  }
  if (!profiles.some((p) => p.id === activeId)) activeId = DEFAULT_PROFILE_ID;
  return { v: 1, profiles, activeId };
}

export function saveProfiles(
  state: ProfilesState,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PROFILES_KEY, JSON.stringify({ v: 1, profiles: state.profiles }));
    storage.setItem(ACTIVE_KEY, state.activeId);
  } catch {
    /* quota / private mode — profiles stay in memory for the session */
  }
}

/** Pure: add or replace a profile (default profile's id/board are pinned). */
export function upsertProfile(state: ProfilesState, profile: LeagueProfile): ProfilesState {
  const norm = normalizeProfile(profile);
  if (!norm) return state;
  const exists = state.profiles.some((p) => p.id === norm.id);
  return {
    ...state,
    profiles: exists
      ? state.profiles.map((p) => (p.id === norm.id ? norm : p))
      : [...state.profiles, norm],
  };
}

/** Pure: remove a profile. The default profile cannot be removed; removing
    the active one activates the default. NOTE: the profile's persisted
    draft contexts are NOT wiped here — call persist.clearPersisted for
    ctxFor(id, false) and ctxFor(id, true) when the user confirms. */
export function removeProfile(state: ProfilesState, id: string): ProfilesState {
  if (id === DEFAULT_PROFILE_ID) return state;
  return {
    ...state,
    profiles: state.profiles.filter((p) => p.id !== id),
    activeId: state.activeId === id ? DEFAULT_PROFILE_ID : state.activeId,
  };
}

export function setActiveProfile(state: ProfilesState, id: string): ProfilesState {
  return state.profiles.some((p) => p.id === id) ? { ...state, activeId: id } : state;
}

/** The persistence context for (profile, mode) — see persist.ts. Default
    profile + real mode ⇒ '' (the legacy keys). */
export function ctxFor(profileId: string, practice: boolean): string {
  const parts: string[] = [];
  if (profileId !== DEFAULT_PROFILE_ID) parts.push(`p-${profileId}`);
  if (practice) parts.push('mock');
  return parts.join(':');
}

/** Slugify a display name into a fresh profile id (avoiding collisions). */
export function newProfileId(name: string, existing: LeagueProfile[]): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (!base || !ID_RE.test(base)) base = 'league';
  const taken = new Set(existing.map((p) => p.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
