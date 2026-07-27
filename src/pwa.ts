// PWA registration. registerType is 'prompt': a new build NEVER silently
// replaces the running one (a mid-draft SW swap is a failure mode, not a
// feature). The UI surfaces "update available" (top banner + Ready Check
// row) and tapping it calls acceptUpdate() — that tap IS the prompt.
import { registerSW } from 'virtual:pwa-register';

// True once onNeedRefresh has fired — lets UI that mounts AFTER the event
// (islands boot async) still know an update is waiting.
let pending = false;

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // Surfaced by the UI; deliberately no auto-reload.
    pending = true;
    document.dispatchEvent(new CustomEvent('dp:sw-update-available'));
  },
  onOfflineReady() {
    document.dispatchEvent(new CustomEvent('dp:sw-offline-ready'));
  },
});

/** Has a new build been detected (dp:sw-update-available already fired)? */
export function isUpdatePending(): boolean {
  return pending;
}

// ---------------------------------------------------------------------------
// Install prompt capture. `beforeinstallprompt` (Chromium only) fires ONCE,
// usually shortly after load — the listener must exist before that. This
// module is loaded from <head> in AppLayout.astro (module scripts run before
// the load event), so the stash below is always registered in time. Islands
// that mount later poll canInstall() and listen for 'dp:can-install'.
// ---------------------------------------------------------------------------

let installEvt: any = null;

try {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault(); // no mini-infobar — WE choose when to prompt
    installEvt = e;
    document.dispatchEvent(new CustomEvent('dp:can-install'));
  });
} catch {
  /* non-browser context */
}

/** Is a stashed install prompt available right now? (Chromium only; false on
    iOS Safari / Firefox — those need the manual Add-to-Home-Screen path.) */
export function canInstall(): boolean {
  return installEvt !== null;
}

/**
 * Fire the stashed install prompt. Resolves with the user's choice, or null
 * when no prompt is stashed (unsupported browser, already installed, or the
 * prompt was already spent). The event is single-use: it is cleared here
 * either way — Chromium may re-fire beforeinstallprompt later after a
 * dismissal, which re-stashes.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
  const evt = installEvt;
  if (!evt || typeof evt.prompt !== 'function') return null;
  installEvt = null; // spent — a second .prompt() on the same event throws
  try {
    await evt.prompt();
    const choice = await evt.userChoice;
    return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return null;
  }
}

/**
 * Accept the waiting service worker and reload into the new build.
 * No-op when registration failed (e.g. dev server, insecure context).
 */
export function acceptUpdate(): void {
  if (typeof updateSW === 'function') void updateSW(true);
}
