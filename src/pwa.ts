// PWA registration. registerType is 'prompt': a new build NEVER silently
// replaces the running one (a mid-draft SW swap is a failure mode, not a
// feature). The Ready Check screen surfaces "update available" instead.
import { registerSW } from 'virtual:pwa-register';

export const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // Surfaced by the Ready Check screen; deliberately no auto-reload.
    document.dispatchEvent(new CustomEvent('dp:sw-update-available'));
  },
  onOfflineReady() {
    document.dispatchEvent(new CustomEvent('dp:sw-offline-ready'));
  },
});
