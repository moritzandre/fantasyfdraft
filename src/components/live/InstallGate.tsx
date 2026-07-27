// InstallGate.tsx — S0b. Home-screen web apps get a COMPLETELY SEPARATE
// localStorage/SW jar from Safari: prepping in a tab then drafting from the
// icon looks exactly like data loss. So: outside standalone mode on a touch
// device, #/live mutations are blocked behind a full-screen gate (a route
// takeover, not a modal) with a 3s-hold escape hatch. Desktop dev (no touch)
// is never gated. On Ready Check the same component renders as a non-blocking
// amber banner variant.

import HoldButton from './HoldButton';

export function isStandalone(): boolean {
  try {
    return (
      (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) ||
      (navigator as any).standalone === true
    );
  } catch {
    return false;
  }
}

/** iPad-targeted detection: the gate only applies to touch devices. */
export function isTouchDevice(): boolean {
  try {
    return 'ontouchend' in document;
  } catch {
    return false;
  }
}

export function gateApplies(): boolean {
  return isTouchDevice() && !isStandalone();
}

export default function InstallGate({
  variant,
  onAck,
}: {
  variant: 'gate' | 'banner';
  onAck?: () => void;
}) {
  if (variant === 'banner') {
    return (
      <div class="lv-clock-near px-4 py-3 text-[15px] font-semibold">
        ⚠ Running in the browser, not the installed app. Add to Home Screen and launch from the
        icon — the icon has its own separate storage, so drafting here and there are different
        worlds.
      </div>
    );
  }

  return (
    <main class="mx-auto flex min-h-[70dvh] max-w-xl flex-col justify-center gap-5 px-6 py-10">
      <h1 class="text-2xl font-bold">Install first</h1>
      <p class="text-app-dim">
        You're in a browser tab, not the Home Screen app. The installed app keeps its own storage
        — a draft recorded here will <strong class="text-app-text">not exist</strong> when you
        later open the icon.
      </p>
      <ol class="list-decimal space-y-1 pl-5 text-[15px] text-app-dim">
        <li>Share button → “Add to Home Screen”</li>
        <li>Launch DraftPrep from the icon</li>
        <li>Re-open the Ready Check there</li>
      </ol>
      <p class="text-sm text-app-dim">
        If storage diverged: Export JSON here, Import in the installed app (My Team rail).
      </p>
      <HoldButton
        ms={3000}
        onHold={() => onAck && onAck()}
        class="min-h-14 rounded-xl border border-app-border bg-app-surface px-5 font-semibold"
      >
        Hold 3s — I understand, continue in browser
      </HoldButton>
      <a href="#/ready" class="py-3 text-center text-app-dim underline">
        Back to Ready Check
      </a>
    </main>
  );
}
