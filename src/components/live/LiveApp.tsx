// LiveApp.tsx — the root Preact island (<LiveApp client:only="preact">).
// Boot: load profiles + mode → fetch the ACTIVE profile's board
// (BASE_URL-aware) → validateBoard → bootPersistedStore against the
// (profile, mode) CONTEXT (persist.ts namespacing — practice and other
// leagues never touch the real draft's keys) → hash router (default #/hub).
// Amber banner when the board is >10 days old or (default profile only) its
// configFingerprint diverges from config/league.json; a second banner marks
// practice mode. The Install Gate blocks #/live mutations on a touch device
// outside standalone mode (desktop dev is never gated).

import { useEffect, useMemo, useState } from 'preact/hooks';
import { validateBoard } from '../../../shared/schema.js';
import leagueDefault from '../../../config/league.json';
import leagueRaw from '../../../config/league.json?raw';
import type { Board, DraftState, LeagueConfig, Store } from '../../state/store';
import { bootPersistedStore } from '../../state/persist';
import { applyPrefs, loadPrefs } from '../../state/prefs';
import {
  DEFAULT_PROFILE_ID,
  ctxFor,
  loadProfiles,
  saveProfiles,
} from '../../state/profiles';
import type { ProfilesState } from '../../state/profiles';
import { getMode, setMode } from '../../state/mode';
import type { AppMode } from '../../state/mode';
import { loadStrategies, safeStrategyName } from '../../state/strategies';
import { acceptUpdate, isUpdatePending } from '../../pwa';
import '../../styles/live.css';
import GuideScreen from './GuideScreen';
import HubScreen from './HubScreen';
import NavBar from './NavBar';
import InstallGate, { gateApplies } from './InstallGate';
import LeagueScreen from './LeagueScreen';
import LiveScreen from './LiveScreen';
import PickLog from './PickLog';
import PlanBSheet from './PlanBSheet';
import ReadyCheck from './ReadyCheck';
import ReviewScreen from './ReviewScreen';
import SetupScreen from './SetupScreen';
import SimLab from './SimLab';
import SyncPanel from './SyncPanel';
import PrepScreen from '../prep/PrepScreen';

const DEFAULT_ROUTE = '#/hub';
const ROUTES = new Set([
  '#/hub', '#/ready', '#/setup', '#/prep', '#/live', '#/league', '#/review', '#/log', '#/planb', '#/sync',
  '#/guide', '#/sim',
]);

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

function useStoreState(store: Store): DraftState {
  const [s, setS] = useState(store.getState());
  useEffect(() => store.subscribe(setS), [store]);
  return s;
}

/** sha256(config/league.json)[:8] — must equal board.configFingerprint. */
async function leagueFingerprint(): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(leagueRaw));
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 8);
  } catch {
    return null; // insecure context / old Safari — skip the check, never block
  }
}

interface StoreAppProps {
  board: Board;
  rawBoard: Board;
  store: Store;
  profiles: ProfilesState;
  mode: AppMode;
  onProfiles(next: ProfilesState): void;
  onMode(next: AppMode): void;
}

function StoreApp({ board, rawBoard, store, profiles, mode, onProfiles, onMode }: StoreAppProps) {
  const s = useStoreState(store);
  const route = useRoute();
  const [fpMismatch, setFpMismatch] = useState(false);
  // A new build is waiting (registerType 'prompt' — never auto-swapped).
  // Initialized from isUpdatePending() because the SW event can fire before
  // this island mounts; the banner button IS the prompt.
  const [swUpdate, setSwUpdate] = useState(() => isUpdatePending());
  useEffect(() => {
    const onUpdate = () => setSwUpdate(true);
    document.addEventListener('dp:sw-update-available', onUpdate);
    return () => document.removeEventListener('dp:sw-update-available', onUpdate);
  }, []);
  const [acked, setAcked] = useState(() => {
    try {
      return sessionStorage.getItem('dp:browser-ack') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    // The fingerprint ties board.json to config/league.json — it only means
    // something for the profile the board was built for (the default one).
    if (profiles.activeId !== DEFAULT_PROFILE_ID) return;
    leagueFingerprint().then((fp) => {
      if (fp && board.configFingerprint && fp !== board.configFingerprint) setFpMismatch(true);
    });
  }, [profiles.activeId]);

  useEffect(() => {
    const screen = route.slice(2) || 'ready';
    if (s.ui.lastScreen !== screen) store.dispatch({ type: 'SET_UI', ui: { lastScreen: screen } });
  }, [route]);

  // Boot guard: a persisted strategy name that no longer resolves (deleted
  // from strategies.json) is reverted to balanced VISIBLY at boot — the
  // alternative is resolveStrategy throwing mid-draft in RecCards.
  useEffect(() => {
    loadStrategies().then((reg) => {
      const current = store.getState().league.strategy;
      const safe = safeStrategyName(current, reg);
      if (safe !== (current ?? 'balanced')) {
        store.dispatch({ type: 'SET_LEAGUE', league: { strategy: safe } });
      }
    });
  }, [store]);

  const ageDays = board.builtAt
    ? Math.floor((Date.now() - Date.parse(board.builtAt)) / 86_400_000)
    : null;
  const stale = ageDays !== null && ageDays > 10;

  const ack = () => {
    try {
      sessionStorage.setItem('dp:browser-ack', '1');
    } catch {
      /* private mode */
    }
    setAcked(true);
  };
  const gated = route === '#/live' && gateApplies() && !acked;

  const activeProfile = profiles.profiles.find((p) => p.id === profiles.activeId);

  // The persistent bottom nav shows everywhere EXCEPT the pick-clock cockpit
  // (#/live keeps its full height + own panel tabs; TopBar/League navigate
  // out). The padding class keeps every screen's tail scrollable above it.
  const showNav = route !== '#/live';

  return (
    <div
      class={`lv-app ${s.ui.grayscalePreview ? 'grayscale-preview' : ''} ${
        showNav ? 'lv-app-navpad' : ''
      }`}
    >
      {swUpdate && (
        <button
          type="button"
          class="lv-clock-up block h-14 w-full px-4 text-[15px] font-bold"
          onClick={acceptUpdate}
        >
          ⬆ New version ready — tap to reload
        </button>
      )}
      {mode === 'practice' && route !== '#/hub' && (
        <a href="#/hub" class="lv-clock-near block px-4 py-2 text-[15px] font-semibold">
          ⚑ PRACTICE MODE{activeProfile ? ` — ${activeProfile.name}` : ''} — real draft state is
          untouched. Tap to switch.
        </a>
      )}
      {(stale || fpMismatch) && (
        <div class="lv-clock-near px-4 py-2 text-[15px] font-semibold">
          ⚠ {stale && `Board is ${ageDays} days old — rebuild before draft day.`}{' '}
          {fpMismatch && 'Board was built against a DIFFERENT league config — rebuild board.json.'}
        </div>
      )}
      {route === '#/hub' && (
        <HubScreen s={s} profiles={profiles} mode={mode} onProfiles={onProfiles} onMode={onMode} />
      )}
      {route === '#/ready' && (
        <>
          {mode === 'practice' && (
            <div class="mx-auto max-w-xl px-4 pt-4">
              <button
                class="lv-bye-alert flex min-h-14 w-full items-center justify-center rounded-xl px-4 text-center font-bold"
                onClick={() => onMode('real')}
              >
                ✕ PRACTICE mode is ON — tap to switch to REAL before drafting
              </button>
            </div>
          )}
          <ReadyCheck s={s} store={store} board={board} />
          <div class="mx-auto max-w-xl px-4 pb-16">
            <a
              href="#/prep"
              class="flex min-h-14 items-center justify-center rounded-xl border border-app-border bg-app-surface font-bold"
            >
              Prep mode — board · tiers · tags · overrides · strategy · rehearsal
            </a>
          </div>
        </>
      )}
      {route === '#/setup' && <SetupScreen s={s} store={store} />}
      {route === '#/prep' && <PrepScreen s={s} store={store} board={rawBoard} />}
      {route === '#/live' &&
        (gated ? (
          <InstallGate variant="gate" onAck={ack} />
        ) : (
          <LiveScreen s={s} store={store} board={board} mode={mode} />
        ))}
      {route === '#/league' && <LeagueScreen s={s} store={store} board={board} />}
      {route === '#/review' && <ReviewScreen s={s} store={store} board={board} />}
      {route === '#/log' && <PickLog s={s} store={store} board={board} />}
      {route === '#/sync' && <SyncPanel s={s} store={store} board={board} mode={mode} />}
      {route === '#/planb' && <PlanBSheet s={s} store={store} board={board} />}
      {route === '#/guide' && <GuideScreen />}
      {route === '#/sim' && <SimLab s={s} store={store} board={board} />}
      {showNav && <NavBar route={route} />}
    </div>
  );
}

export default function LiveApp() {
  const [board, setBoard] = useState<Board | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  // Profiles + mode live OUTSIDE the store: together they select WHICH
  // persisted store context boots. The default profile in real mode is the
  // legacy context — a pre-hub install keeps its state untouched.
  const [profiles, setProfiles] = useState<ProfilesState>(() =>
    loadProfiles(leagueDefault as unknown as Partial<LeagueConfig>),
  );
  const [mode, setModeState] = useState<AppMode>(() => getMode());
  const onProfiles = (next: ProfilesState) => {
    saveProfiles(next);
    setProfiles(next);
  };
  const onMode = (next: AppMode) => {
    setMode(next);
    setModeState(next);
  };

  const activeProfile = profiles.profiles.find((p) => p.id === profiles.activeId)
    ?? profiles.profiles[0];
  const boardFile = activeProfile.board || 'board.json';
  const ctx = ctxFor(activeProfile.id, mode === 'practice');

  useEffect(() => {
    let cancelled = false;
    setBoard(null);
    fetch(import.meta.env.BASE_URL + 'data/' + boardFile)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${boardFile} HTTP ${r.status}`))))
      .then((b) => {
        const problems = validateBoard(b);
        if (problems.length > 0) throw new Error(`${boardFile} invalid: ${problems[0]}`);
        if (!cancelled) setBoard(b);
      })
      .catch((e) => setFatal(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [boardFile]);

  // The prep layer (tags, overrides, tier edits — src/state/prefs.ts) is
  // applied to the fetched board ONCE, before createStore boot: live and prep
  // preview derive from the same pure applyPrefs.
  const applied = useMemo(() => (board ? applyPrefs(board, loadPrefs()) : null), [board]);

  // bootPersistedStore is async (IDB tier read at boot) — the store arrives
  // one microtask after the board; localStorage restore still wins by max-rev.
  // Re-runs whenever the (profile, mode) context changes: each context boots
  // its OWN store against its own keys; the old store is dropped first so a
  // stray dispatch can never land in the wrong context.
  const [store, setStore] = useState<Store | null>(null);
  useEffect(() => {
    if (!applied) return;
    let cancelled = false;
    setStore(null);
    const league = {
      ...(leagueDefault as unknown as LeagueConfig),
      ...activeProfile.league,
    } as LeagueConfig;
    bootPersistedStore({ board: applied, league }, undefined, ctx)
      .then((st) => {
        if (!cancelled) setStore(st);
      })
      .catch((e) => setFatal(String((e as any)?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [applied, ctx]);

  if (fatal) {
    return (
      <main class="mx-auto max-w-xl px-6 py-16">
        <h1 class="text-2xl font-bold">Board failed to load</h1>
        <p class="mt-2 text-app-dim">{fatal}</p>
        <p class="mt-4 text-sm text-app-dim">
          Run <code>npm run board</code>, rebuild, redeploy — or fall back to the printed kit.
        </p>
      </main>
    );
  }
  if (!board || !applied || !store) {
    return <p class="px-6 py-16 text-center text-app-dim">Loading board…</p>;
  }
  return (
    <StoreApp
      board={applied}
      rawBoard={board}
      store={store}
      profiles={profiles}
      mode={mode}
      onProfiles={onProfiles}
      onMode={onMode}
    />
  );
}
