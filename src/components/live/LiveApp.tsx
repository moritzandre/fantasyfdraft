// LiveApp.tsx — the root Preact island (<LiveApp client:only="preact">).
// Boot: fetch board.json (BASE_URL-aware) → validateBoard → bootPersistedStore
// (three-tier restore + synchronous localStorage persist, persist.ts) → hash router
// (#/ready · #/setup · #/live · #/log · #/planb; default #/ready).
// Amber banner when the board is >10 days old or its configFingerprint
// diverges from config/league.json. Grayscale preview class is wired to
// ui.grayscalePreview. The Install Gate blocks #/live mutations on a touch
// device outside standalone mode (desktop dev is never gated).

import { useEffect, useState } from 'preact/hooks';
import { validateBoard } from '../../../shared/schema.js';
import leagueDefault from '../../../config/league.json';
import leagueRaw from '../../../config/league.json?raw';
import type { Board, DraftState, LeagueConfig, Store } from '../../state/store';
import { bootPersistedStore } from '../../state/persist';
import '../../styles/live.css';
import InstallGate, { gateApplies } from './InstallGate';
import LiveScreen from './LiveScreen';
import PickLog from './PickLog';
import PlanBSheet from './PlanBSheet';
import ReadyCheck from './ReadyCheck';
import SetupScreen from './SetupScreen';

const DEFAULT_ROUTE = '#/ready';
const ROUTES = new Set(['#/ready', '#/setup', '#/live', '#/log', '#/planb']);

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

function StoreApp({ board, store }: { board: Board; store: Store }) {
  const s = useStoreState(store);
  const route = useRoute();
  const [fpMismatch, setFpMismatch] = useState(false);
  const [acked, setAcked] = useState(() => {
    try {
      return sessionStorage.getItem('dp:browser-ack') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    leagueFingerprint().then((fp) => {
      if (fp && board.configFingerprint && fp !== board.configFingerprint) setFpMismatch(true);
    });
  }, []);

  useEffect(() => {
    const screen = route.slice(2) || 'ready';
    if (s.ui.lastScreen !== screen) store.dispatch({ type: 'SET_UI', ui: { lastScreen: screen } });
  }, [route]);

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

  return (
    <div class={`lv-app ${s.ui.grayscalePreview ? 'grayscale-preview' : ''}`}>
      {(stale || fpMismatch) && (
        <div class="lv-clock-near px-4 py-2 text-[15px] font-semibold">
          ⚠ {stale && `Board is ${ageDays} days old — rebuild before draft day.`}{' '}
          {fpMismatch && 'Board was built against a DIFFERENT league config — rebuild board.json.'}
        </div>
      )}
      {route === '#/ready' && <ReadyCheck s={s} store={store} board={board} />}
      {route === '#/setup' && <SetupScreen s={s} store={store} />}
      {route === '#/live' &&
        (gated ? <InstallGate variant="gate" onAck={ack} /> : <LiveScreen s={s} store={store} board={board} />)}
      {route === '#/log' && <PickLog s={s} store={store} board={board} />}
      {route === '#/planb' && <PlanBSheet s={s} store={store} board={board} />}
    </div>
  );
}

export default function LiveApp() {
  const [board, setBoard] = useState<Board | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    fetch(import.meta.env.BASE_URL + 'data/board.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`board.json HTTP ${r.status}`))))
      .then((b) => {
        const problems = validateBoard(b);
        if (problems.length > 0) throw new Error(`board.json invalid: ${problems[0]}`);
        setBoard(b);
      })
      .catch((e) => setFatal(String(e?.message ?? e)));
  }, []);

  // bootPersistedStore is async (IDB tier read at boot) — the store arrives
  // one microtask after the board; localStorage restore still wins by max-rev.
  const [store, setStore] = useState<Store | null>(null);
  useEffect(() => {
    if (!board) return;
    let cancelled = false;
    bootPersistedStore({ board, league: leagueDefault as unknown as LeagueConfig })
      .then((st) => {
        if (!cancelled) setStore(st);
      })
      .catch((e) => setFatal(String((e as any)?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [board]);

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
  if (!board || !store) {
    return <p class="px-6 py-16 text-center text-app-dim">Loading board…</p>;
  }
  return <StoreApp board={board} store={store} />;
}
