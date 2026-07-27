// MoreScreen.tsx — #/more: the full tool directory behind the nav bar's
// "More" item. EVERY screen in the app is reachable from here in one tap —
// the bar itself only carries the big five (Hub · Draft · League · Sim ·
// Season), so everything else lives on this grid. Blurbs mirror HubScreen's
// phrasing so the two directories never disagree. Season deep links are full
// hrefs onto the season PAGE's hash routes — NO trailing slash before the
// hash (with Astro trailingSlash 'ignore' the SW precaches the page under
// the key 'season'; only the slash-less URL hits it offline — same
// convention as HubScreen's Season card).

interface Tool {
  href: string;
  title: string;
  blurb: string;
}

const base = import.meta.env.BASE_URL;

const DRAFT_TOOLS: Tool[] = [
  { href: '#/ready', title: 'Ready Check', blurb: 'board hash · SW · storage · wake lock' },
  { href: '#/setup', title: 'Setup', blurb: 'teams · slot · rounds · roster · strategy' },
  { href: '#/prep', title: 'Prep', blurb: 'tiers · tags · overrides · strategy · rehearsal' },
  { href: '#/guide', title: 'Guide', blurb: 'how everything works — start here' },
  { href: '#/sync', title: 'Sleeper Sync', blurb: 'live draft + mock lobbies' },
  { href: '#/log', title: 'Pick Log', blurb: 'review · edit · catch-up' },
  { href: '#/review', title: 'Review & History', blurb: 'grade my picks against the engine' },
  { href: '#/planb', title: 'Plan B', blurb: 'the printed board, on screen' },
  { href: '#/league', title: 'League', blurb: 'all 12 rosters · live draft grid' },
  { href: '#/sim', title: 'Sim Lab', blurb: 'strategy sweeps + mock calibration, in-app' },
];

const SEASON_TOOLS: Tool[] = [
  { href: base + 'season#/coach', title: 'Lineup Coach', blurb: 'weekly start/sit with reasons' },
  { href: base + 'season#/waivers', title: 'Waivers', blurb: 'pickup targets ranked by roster need' },
  { href: base + 'season#/trade', title: 'Trade Desk', blurb: 'sandbox trade evaluator — works with zero sync' },
];

function ToolGrid({ tools }: { tools: Tool[] }) {
  return (
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {tools.map((t) => (
        <a
          key={t.href}
          href={t.href}
          class="flex min-h-14 flex-col justify-center rounded-xl border border-app-border bg-app-surface px-4 py-3"
        >
          <span class="font-bold">{t.title}</span>
          <span class="text-sm text-app-dim">{t.blurb}</span>
        </a>
      ))}
    </div>
  );
}

export default function MoreScreen() {
  return (
    <main class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 pb-24">
      <header>
        <h1 class="text-2xl font-bold">More</h1>
        <p class="mt-1 text-sm text-app-dim">
          Every tool, one tap away — the nav bar carries the big five; the rest lives here.
        </p>
      </header>

      <section class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-app-dim">Draft tools</h2>
        <ToolGrid tools={DRAFT_TOOLS} />
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-app-dim">Season</h2>
        <ToolGrid tools={SEASON_TOOLS} />
      </section>
    </main>
  );
}
