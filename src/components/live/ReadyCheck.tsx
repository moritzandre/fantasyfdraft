// ReadyCheck.tsx — S0, the screen you open the night before. Every row is a
// pass/fail glyph + a one-line remedy: board hash+age, service worker,
// standalone mode, storage.persist(), wake-lock availability, last save
// rev/ts, and the literal airplane-mode-rehearsal checkbox (persisted in ui
// state). Continue → #/setup or #/live.

import { useEffect, useState } from 'preact/hooks';
import type { Board, DraftState, Store } from '../../state/store';
import { acceptUpdate, isUpdatePending } from '../../pwa';
import { wakeLockAvailable } from '../../ui/wakelock';
import InstallGate, { gateApplies, isStandalone } from './InstallGate';
import { lastSaveInfo } from '../../state/persist';

function Row({
  ok,
  label,
  detail,
  remedy,
  onTap,
}: {
  ok: boolean | null;
  label: string;
  detail: string;
  remedy?: string;
  onTap?: () => void;
}) {
  const glyph = ok === null ? '…' : ok ? '✓' : '✗';
  const body = (
    <>
      <span
        class={`num flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg font-bold ${
          ok === null ? 'bg-app-bg text-app-dim' : ok ? 'lv-clock-up' : 'lv-clock-near'
        }`}
      >
        {glyph}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block font-semibold">{label}</span>
        <span class="block truncate text-sm text-app-dim">{detail}</span>
        {ok === false && remedy && <span class="block text-sm">→ {remedy}</span>}
      </span>
    </>
  );
  const cls = 'flex min-h-14 w-full items-center gap-3 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-left';
  return onTap ? (
    <button type="button" class={cls} onClick={onTap}>
      {body}
    </button>
  ) : (
    <div class={cls}>{body}</div>
  );
}

export default function ReadyCheck({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const { dispatch } = store;
  const [swOk, setSwOk] = useState<boolean | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [swUpdate, setSwUpdate] = useState(() => isUpdatePending());

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistration()
        .then((r) => setSwOk(!!r))
        .catch(() => setSwOk(false));
    } else setSwOk(false);

    if (navigator.storage?.persisted) {
      navigator.storage.persisted().then(setPersisted).catch(() => setPersisted(false));
    } else setPersisted(false);

    const onUpdate = () => setSwUpdate(true);
    document.addEventListener('dp:sw-update-available', onUpdate);
    return () => document.removeEventListener('dp:sw-update-available', onUpdate);
  }, []);

  const requestPersist = async () => {
    try {
      if (navigator.storage?.persist) setPersisted(await navigator.storage.persist());
    } catch {
      setPersisted(false);
    }
  };

  const ageDays = board.builtAt
    ? Math.floor((Date.now() - Date.parse(board.builtAt)) / 86_400_000)
    : null;
  const boardFresh = ageDays !== null && ageDays <= 10;
  const standalone = isStandalone();
  const save = lastSaveInfo();
  const wl = wakeLockAvailable();

  return (
    <main class="mx-auto flex max-w-xl flex-col gap-2 px-4 pb-16 pt-4">
      <h1 class="text-2xl font-bold">Ready check</h1>
      <p class="pb-2 text-sm text-app-dim">
        Run this the night before. Every ✗ has a one-line fix — none of them can be fixed on the
        pick clock.
      </p>

      {gateApplies() && <InstallGate variant="banner" />}
      {swUpdate && (
        <Row
          ok={false}
          label="New build available"
          detail="This install is still running the previous build. Reload when you choose — never mid-draft."
          remedy="Tap this row to reload into the new version"
          onTap={acceptUpdate}
        />
      )}

      <Row
        ok={boardFresh}
        label={`Board ${board.buildHash}`}
        detail={
          ageDays === null
            ? 'no build timestamp'
            : `built ${String(board.builtAt).slice(0, 10)} — ${ageDays}d old`
        }
        remedy="Re-run npm run board + build + deploy, then reload"
      />
      <Row
        ok={swOk}
        label="Service worker"
        detail={swOk ? 'registered — offline shell cached' : 'not registered'}
        remedy="Open over HTTPS (Pages URL), hard-reload once online"
      />
      <Row
        ok={standalone}
        label="Standalone mode"
        detail={standalone ? 'running from the Home Screen icon' : 'running in a browser tab'}
        remedy="Share → Add to Home Screen, launch from the icon"
      />
      <Row
        ok={persisted}
        label="Persistent storage"
        detail={
          persisted === null
            ? 'checking…'
            : persisted
              ? 'storage.persist() granted'
              : 'not granted — tap to request'
        }
        remedy="Tap this row; if still denied, install to Home Screen first"
        onTap={requestPersist}
      />
      <Row
        ok={wl}
        label="Wake lock"
        detail={wl ? 'available — screen stays on during #/live' : 'unavailable'}
        remedy="Set iPad Auto-Lock to Never (Settings → Display) as the fallback"
      />
      <Row
        ok={save !== null}
        label="Last save"
        detail={
          save
            ? `rev ${save.rev}${save.savedAt ? ` · ${new Date(save.savedAt).toLocaleString()}` : ''}`
            : 'nothing persisted yet'
        }
        remedy="Make any change (e.g. set your slot) and this row goes green"
      />

      {/* The literal airplane-mode rehearsal checkbox — a human gate */}
      <button
        type="button"
        class="flex min-h-14 w-full items-center gap-3 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-left"
        onClick={() => dispatch({ type: 'SET_UI', ui: { rehearsalDone: !s.ui.rehearsalDone } })}
      >
        <span
          class={`num flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg font-bold ${
            s.ui.rehearsalDone ? 'lv-clock-up' : 'bg-app-bg text-app-dim'
          }`}
        >
          {s.ui.rehearsalDone ? '✓' : '☐'}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block font-semibold">Airplane-mode rehearsal done</span>
          <span class="block text-sm text-app-dim">
            Cold-launch from the icon in airplane mode, record 5 picks, undo one. Tick it only
            after actually doing it.
          </span>
        </span>
      </button>

      <div class="mt-4 flex gap-2">
        <a
          href="#/setup"
          class="flex h-14 flex-1 items-center justify-center rounded-xl border border-app-border bg-app-surface font-bold"
        >
          Setup
        </a>
        <a
          href="#/live"
          class="flex h-14 flex-1 items-center justify-center rounded-xl bg-accent font-bold text-app-bg"
        >
          Go Live →
        </a>
      </div>
    </main>
  );
}
