// SeasonApp.tsx — the SEASON island root (<SeasonApp client:only="preact">,
// src/pages/season.astro) — the draft app's sibling PAGE for the in-season
// platform: lineup coach, waivers, sandbox-first Trade Desk and league panel.
//
// Boot: load profiles (READ-ONLY — league switching lives on the draft app's
// Hub) → fetch the active profile's board + season overlay (season.json for
// the default profile, season.<id>.json otherwise; a 404 / parse failure /
// board-hash mismatch degrades to board-only weekly lines via
// mergeSeason(board, null-ish) — never a hard failure) → createSeasonStore
// per profile → own hash router (#/coach default · #/waivers · #/trade ·
// #/league). League sync is on-demand (leagueSyncManager); offline the
// persisted season store is the cache and the dot just shows the error.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { validateBoard } from '../../../shared/schema.js';
import leagueDefault from '../../../config/league.json';
import type { LeagueConfig } from '../../state/store';
import { DEFAULT_PROFILE_ID, loadProfiles } from '../../state/profiles';
import type { LeagueProfile } from '../../state/profiles';
import { createSeasonStore, seasonSelectors } from '../../state/season';
import type { SeasonState, SeasonStore } from '../../state/season';
import { mergeSeason } from '../../state/seasonMerge';
import type { MergedSeason } from '../../state/seasonMerge';
import { leagueSyncManager } from '../../sync/league';
import '../../styles/live.css';
import { slotsFrom, useLeagueSyncInfo } from './seasonShared';
import LeaguePanel from './LeaguePanel';
import TradeDesk from './TradeDesk';
import Waivers from './Waivers';
import WeekCoach from './WeekCoach';

const DEFAULT_ROUTE = '#/coach';
const ROUTES = new Set(['#/coach', '#/waivers', '#/trade', '#/league']);

// [href, label, lv-tool-* hue class] — the hue only colors the active state.
const TABS: Array<[string, string, string]> = [
  // First entry jumps back to the draft app's Hub — a full href, never
  // matched as the active route (symmetry with the draft app's NavBar).
  [import.meta.env.BASE_URL + '#/hub', '⌂ Hub', 'lv-tool-hub'],
  ['#/coach', 'Coach', 'lv-tool-season'],
  ['#/waivers', 'Waivers', 'lv-tool-season'],
  ['#/trade', 'Trade', 'lv-tool-season'],
  ['#/league', 'League', 'lv-tool-season'],
];

function useRoute(): string {
  const [route, setRoute] = useState(
    typeof location !== 'undefined' && ROUTES.has(location.hash) ? location.hash : DEFAULT_ROUTE,
  );
  useEffect(() => {
    const on = () => setRoute(ROUTES.has(location.hash) ? location.hash : DEFAULT_ROUTE);
    if (!ROUTES.has(location.hash)) location.replace(DEFAULT_ROUTE);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function useSeasonState(store: SeasonStore): SeasonState {
  const [s, setS] = useState(store.getState());
  useEffect(() => store.subscribe(setS), [store]);
  return s;
}

/** Header sync dot — never colour-only (label text beside it). */
function SyncDot() {
  const info = useLeagueSyncInfo();
  let label = 'IDLE';
  let cls = 'border-app-border bg-app-border';
  let style: Record<string, string> | undefined;
  if (info.status === 'live') {
    label = 'LIVE';
    cls = 'border-emerald-600 bg-emerald-500';
  } else if (info.status === 'syncing') {
    label = 'SYNC';
    cls = 'lv-clock-near border-transparent';
  } else if (info.status === 'error') {
    label = 'ERROR';
    cls = 'border-red-600';
    style = {
      backgroundImage: 'repeating-linear-gradient(45deg,#dc2626 0 2px,transparent 2px 4px)',
    };
  }
  return (
    <button
      type="button"
      class="flex h-14 min-w-14 shrink-0 flex-col items-center justify-center rounded-lg border border-app-border bg-app-surface px-1"
      onClick={() => {
        location.hash = '#/league';
      }}
      title="League sync — tap to configure"
      aria-label={`League sync: ${label}`}
    >
      <span class={`h-3 w-3 rounded-full border ${cls}`} style={style} />
      <span class="mt-0.5 text-[10px] tracking-wide text-app-dim">{label}</span>
    </button>
  );
}

export default function SeasonApp() {
  // Profiles are read once — this page never edits them; the Hub does.
  const profiles = useMemo(
    () => loadProfiles(leagueDefault as unknown as Partial<LeagueConfig>),
    [],
  );
  const profile =
    profiles.profiles.find((p) => p.id === profiles.activeId) ?? profiles.profiles[0];
  const boardFile = profile.board || 'board.json';
  const seasonFile =
    profile.id === DEFAULT_PROFILE_ID ? 'season.json' : `season.${profile.id}.json`;

  const [data, setData] = useState<{ board: any; season: any | null } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.BASE_URL;
    (async () => {
      const res = await fetch(base + 'data/' + boardFile);
      if (!res.ok) throw new Error(`${boardFile} HTTP ${res.status}`);
      const board = await res.json();
      const problems = validateBoard(board);
      if (problems.length > 0) throw new Error(`${boardFile} invalid: ${problems[0]}`);
      // Season overlay is BEST-EFFORT: 404 / offline / bad JSON ⇒ null ⇒
      // mergeSeason degrades to board-only weekly lines. Never fatal.
      let season: any | null = null;
      try {
        const sRes = await fetch(base + 'data/' + seasonFile);
        if (sRes.ok) season = await sRes.json();
      } catch {
        season = null;
      }
      if (!cancelled) setData({ board, season });
    })().catch((e) => {
      if (!cancelled) setFatal(String((e as Error)?.message ?? e));
    });
    return () => {
      cancelled = true;
    };
  }, [boardFile, seasonFile]);

  const store = useMemo(() => createSeasonStore({ profileId: profile.id }), [profile.id]);

  // A previously connected league resumes syncing on page load; offline the
  // refresh fails visibly (dot) and the persisted store stays the cache.
  useEffect(() => {
    const id = store.getState().leagueId;
    if (id) leagueSyncManager.start(store, id);
    return () => leagueSyncManager.stop();
  }, [store]);

  const merged = useMemo(
    () => (data ? mergeSeason(data.board, data.season) : null),
    [data],
  );

  if (fatal) {
    return (
      <main class="mx-auto max-w-xl px-6 py-16">
        <h1 class="text-2xl font-bold">Season page failed to load</h1>
        <p class="mt-2 text-app-dim">{fatal}</p>
        <p class="mt-4 text-sm text-app-dim">
          The board file is required. Run <code>npm run board</code>, rebuild, redeploy —
          or head back to the <a class="underline" href={import.meta.env.BASE_URL}>draft app</a>.
        </p>
      </main>
    );
  }
  if (!data || !merged) {
    return <p class="px-6 py-16 text-center text-app-dim">Loading season…</p>;
  }
  return <SeasonShell store={store} data={data} merged={merged} profile={profile} />;
}

function SeasonShell({
  store,
  data,
  merged,
  profile,
}: {
  store: SeasonStore;
  data: { board: any; season: any | null };
  merged: MergedSeason;
  profile: LeagueProfile;
}) {
  const ss = useSeasonState(store);
  const route = useRoute();

  useEffect(() => {
    const screen = route.slice(2) || 'coach';
    if (ss.ui.lastScreen !== screen) {
      store.dispatch({ type: 'SET_SEASON_UI', ui: { lastScreen: screen } });
    }
  }, [route]);

  const league = { ...(leagueDefault as unknown as LeagueConfig), ...profile.league };
  const slots = slotsFrom(league);
  const flexEligible = (league.flexEligible as string[] | undefined) ?? ['RB', 'WR', 'TE'];

  const week = seasonSelectors.currentWeek(ss);
  const setWeek = (w: number) => store.dispatch({ type: 'SET_WEEK_OVERRIDE', week: w });

  // Data-age badge: season.json builtAt (amber past 8 days — waiver/lineup
  // advice on stale projections is worse than knowing it's stale).
  const season = merged.degraded ? null : data.season;
  const ageDays = season?.builtAt
    ? Math.floor((Date.now() - Date.parse(season.builtAt)) / 86_400_000)
    : null;

  const screenProps = {
    ss,
    store,
    merged,
    board: data.board,
    season,
    profile,
    slots,
    flexEligible,
  };

  return (
    <div class="lv-app">
      <header class="lv-topbar flex items-center gap-2 px-2">
        <a
          href={import.meta.env.BASE_URL + '#/hub'}
          class="flex h-14 shrink-0 items-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Hub
        </a>
        <div class="min-w-0 flex-1 px-1 leading-tight">
          <div class="truncate font-bold">{profile.name}</div>
          <div class="truncate text-[11px] uppercase tracking-wide text-app-dim">
            Season{ss.leagueName ? ` · ${ss.leagueName}` : ''}
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1" aria-label="Week selector">
          <button
            type="button"
            class="num h-14 w-14 rounded-lg border border-app-border bg-app-bg text-xl"
            onClick={() => setWeek(week - 1)}
            aria-label="Previous week"
          >
            −
          </button>
          <button
            type="button"
            class={`num h-14 min-w-14 rounded-lg border px-1 text-lg font-bold ${
              ss.weekOverride !== null ? 'border-accent' : 'border-transparent'
            }`}
            onClick={() => store.dispatch({ type: 'SET_WEEK_OVERRIDE', week: null })}
            title={
              ss.weekOverride !== null
                ? 'Week override on — tap to follow the synced week'
                : 'The synced NFL week'
            }
          >
            W{week}
          </button>
          <button
            type="button"
            class="num h-14 w-14 rounded-lg border border-app-border bg-app-bg text-xl"
            onClick={() => setWeek(week + 1)}
            aria-label="Next week"
          >
            +
          </button>
        </div>

        <SyncDot />

        {merged.degraded ? (
          <span
            class="lv-clock-near shrink-0 rounded px-2 py-1 text-[11px] font-bold"
            title="season.json missing or built against another board — weekly lines fall back to the draft board"
          >
            BOARD DATA
          </span>
        ) : (
          ageDays !== null && (
            <span
              class={`num shrink-0 rounded px-2 py-1 text-[11px] font-bold ${
                ageDays > 8 ? 'lv-clock-near' : 'border border-app-border text-app-dim'
              }`}
              title={`season.json built ${ageDays} day${ageDays === 1 ? '' : 's'} ago (week ${season.week})`}
            >
              {ageDays}d
            </span>
          )
        )}
      </header>

      <div class="pb-24">
        {route === '#/coach' && <WeekCoach {...screenProps} />}
        {route === '#/waivers' && <Waivers {...screenProps} />}
        {route === '#/trade' && <TradeDesk {...screenProps} />}
        {route === '#/league' && <LeaguePanel {...screenProps} />}
      </div>

      <nav
        class="fixed inset-x-0 bottom-0 z-40 flex border-t border-app-border bg-app-surface"
        style={{
          height: 'calc(64px + env(safe-area-inset-bottom))',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {TABS.map(([hash, label, tool]) => (
          <a
            key={hash}
            href={hash}
            class={`lv-navitem ${tool} flex h-full flex-1 items-center justify-center text-[15px] font-bold ${
              route === hash ? '' : 'text-app-dim'
            }`}
            aria-current={route === hash ? 'page' : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}
