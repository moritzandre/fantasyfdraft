// wakelock.ts — keep the iPad screen on during the live draft.
// Request on the FIRST USER GESTURE inside #/live (Safari requires a gesture
// for wakeLock.request), re-acquire on visibilitychange → visible (iOS
// releases the sentinel whenever the app is backgrounded). Every path is
// try/catch silent: an unsupported browser must change nothing.

let sentinel: any = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!wanted || sentinel) return;
  try {
    const wl = (navigator as any).wakeLock;
    if (!wl) return;
    sentinel = await wl.request('screen');
    sentinel?.addEventListener?.('release', () => {
      sentinel = null;
    });
  } catch {
    sentinel = null; // denied / low battery / unsupported — silently ignore
  }
}

export function wakeLockAvailable(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  } catch {
    return false;
  }
}

export function wakeLockActive(): boolean {
  return sentinel !== null && sentinel.released !== true;
}

/** Arm the wake lock for the live screen. Returns a disposer that releases
    the sentinel and detaches all listeners (call on route change/unmount). */
export function enableWakeLock(): () => void {
  wanted = true;
  const onGesture = () => {
    void acquire();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void acquire();
  };
  document.addEventListener('pointerdown', onGesture, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  void acquire(); // harmless if the gesture requirement rejects it

  return () => {
    wanted = false;
    document.removeEventListener('pointerdown', onGesture);
    document.removeEventListener('visibilitychange', onVisible);
    try {
      sentinel?.release?.();
    } catch {
      /* silent */
    }
    sentinel = null;
  };
}
