// NavBar.tsx — the persistent bottom navigation bar for the draft app.
// Fixed, 64px + safe-area (the season page's tab-bar convention), one tap to
// any main tool from anywhere. Deliberately HIDDEN on #/live: the pick-clock
// cockpit keeps every vertical pixel and has its own Board/Recs/Team panel
// tabs — leaving the draft is a TopBar/League action there, not a nav-bar
// temptation. Season is a separate page, so its item is a full href.

interface Item {
  href: string;
  label: string;
  glyph: string;
  external?: boolean;
}

export default function NavBar({ route }: { route: string }) {
  const base = (import.meta as any).env?.BASE_URL ?? '/';
  const items: Item[] = [
    { href: '#/hub', label: 'Hub', glyph: '⌂' },
    { href: '#/live', label: 'Draft', glyph: '▶' },
    { href: '#/league', label: 'League', glyph: '⚏' },
    { href: '#/sim', label: 'Sim', glyph: '∿' },
    { href: base + 'season', label: 'Season', glyph: '⚑', external: true },
    // Prep moved off the bar — it stays one tap away via More and the Hub;
    // More is the full directory, so EVERY screen is reachable from the bar.
    { href: '#/more', label: 'More', glyph: '▤' },
  ];
  return (
    <nav
      class="fixed inset-x-0 bottom-0 z-40 flex border-t border-app-border bg-app-surface"
      style={{
        height: 'calc(64px + env(safe-area-inset-bottom))',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      aria-label="Main navigation"
    >
      {items.map((it) => {
        const active = !it.external && route === it.href;
        return (
          <a
            key={it.href}
            href={it.href}
            class={`flex h-full min-w-14 flex-1 flex-col items-center justify-center gap-0.5 ${
              active ? 'text-accent' : 'text-app-dim'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <span class="text-[17px] leading-none" aria-hidden="true">{it.glyph}</span>
            <span class="text-[12px] font-bold leading-none">{it.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
