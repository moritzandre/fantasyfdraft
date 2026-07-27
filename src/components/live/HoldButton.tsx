// HoldButton.tsx — the app's only "are you sure": a press-and-HOLD button.
// No confirm dialogs anywhere (they train tap-through under a clock); a 3s
// hold cannot be performed by accident. CSS fill (live.css .lv-hold) shows
// progress; releasing early cancels.

import { useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface Props {
  ms?: number;
  onHold: () => void;
  class?: string;
  children: ComponentChildren;
}

export default function HoldButton({ ms = 3000, onHold, class: cls = '', children }: Props) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  const start = (e: Event) => {
    e.preventDefault();
    setHolding(true);
    timer.current = setTimeout(() => {
      cancel();
      onHold();
    }, ms);
  };

  return (
    <button
      type="button"
      class={`lv-hold ${holding ? 'lv-holding' : ''} ${cls}`}
      style={`--hold-ms:${ms}ms`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e: Event) => e.preventDefault()}
    >
      <span class="lv-hold-fill" />
      <span class="relative z-10">{children}</span>
    </button>
  );
}
