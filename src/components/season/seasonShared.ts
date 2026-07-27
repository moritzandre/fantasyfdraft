// seasonShared.ts — tiny shared glue for the Season island: id→player
// resolution, formatting, team labels, sync-info hook. NO math here — all
// lineup/trade math lives in engine/week.js + engine/trade.js; these helpers
// only translate between store shapes and what the screens render.

import { useEffect, useState } from 'preact/hooks';
import type { SeasonState, SeasonStore } from '../../state/season';
import type { MergedSeason, ResolvedPlayer } from '../../state/seasonMerge';
import type { LeagueProfile } from '../../state/profiles';
import type { LeagueConfig } from '../../state/store';
import { leagueSyncManager } from '../../sync/league';
import type { ManagedLeagueSyncInfo } from '../../sync/league';

/** Props every season screen receives from SeasonApp. */
export interface SeasonScreenProps {
  ss: SeasonState;
  store: SeasonStore;
  merged: MergedSeason;
  board: any; // validated board.json — sigmaProj source for weekly bands
  season: any | null; // raw season.json (teams/opp, builtAt, endWeek) or null
  profile: LeagueProfile;
  slots: Record<string, number>; // starter slots (BN stripped)
  flexEligible: string[];
}

/** Starter slots from the profile's league shape — BN never starts. */
export function slotsFrom(league: LeagueConfig): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(league.roster ?? {})) {
    if (k !== 'BN' && typeof v === 'number' && v > 0) out[k] = v;
  }
  return out;
}

/** Resolve sleeper ids against the merged board+season universe. Sleeper
    pads empty starter slots with '0' — those are silently skipped; real ids
    that resolve to nothing come back in `missing` (rendered as id chips). */
export function resolveIds(
  merged: MergedSeason,
  ids: string[],
): { players: ResolvedPlayer[]; missing: string[] } {
  const players: ResolvedPlayer[] = [];
  const missing: string[] = [];
  for (const id of ids ?? []) {
    if (!id || id === '0') continue;
    const p = merged.resolve(id);
    if (p) players.push(p);
    else missing.push(id);
  }
  return { players, missing };
}

/** Display name for a synced roster: team name > owner name > Roster N. */
export function teamLabel(ss: SeasonState, rosterId: number): string {
  const r = ss.rosters.find((x) => x.rosterId === rosterId);
  if (!r) return `Roster ${rosterId}`;
  const u = ss.users[r.ownerId];
  return u?.teamName ?? u?.name ?? `Roster ${rosterId}`;
}

/** Opponent string ('@LAC', 'SEA', null on bye) from season.json teams. */
export function oppFor(season: any, team: string, week: number): string | null {
  const opp = season?.teams?.[team]?.opp?.[week - 1];
  return typeof opp === 'string' && opp.length > 0 ? opp : null;
}

/** σ_proj for a merged player — board players only. Extras (idx null) have
    no σ_proj, so their weekly bands are simply skipped by the callers. */
export function sigmaFor(board: any, p: ResolvedPlayer): number | null {
  if (p.idx === null) return null;
  const direct = board?.players?.[p.idx];
  const bp =
    direct && direct.idx === p.idx
      ? direct
      : board?.players?.find((x: any) => x?.idx === p.idx);
  const s = bp?.sigmaProj;
  return typeof s === 'number' && Number.isFinite(s) ? s : null;
}

export function fmt1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

export function signed1(n: number): string {
  return `${n < 0 ? '−' : '+'}${fmt1(Math.abs(n))}`;
}

export function signedInt(n: number): string {
  return `${n < 0 ? '−' : '+'}${Math.round(Math.abs(n))}`;
}

export function agoLabel(ts: number | null): string {
  if (ts === null) return 'never';
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** Subscribe to the app-wide league sync manager (header dot + LeaguePanel
    share the same instance — sync survives route changes). */
export function useLeagueSyncInfo(): ManagedLeagueSyncInfo {
  const [info, setInfo] = useState(leagueSyncManager.getInfo());
  useEffect(() => leagueSyncManager.subscribe(setInfo), []);
  return info;
}
