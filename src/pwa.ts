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

/**
 * Accept the waiting service worker and reload into the new build.
 * No-op when registration failed (e.g. dev server, insecure context).
 */
export function acceptUpdate(): void {
  if (typeof updateSW === 'function') void updateSW(true);
}
