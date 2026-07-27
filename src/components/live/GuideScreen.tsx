// GuideScreen.tsx — #/guide, the in-app wiki/tutorial. One scrollable page,
// static JSX (no fetch — it must read fine in airplane mode like everything
// else). Sticky header + jump chips; chips navigate via scrollIntoView on
// element ids because href="#section" would fight the hash router.

const SECTIONS: Array<[string, string, string]> = [
  // [id, chip label, section title]
  ['start', 'Start here', 'START HERE'],
  ['sleeper', 'Sleeper', 'CONNECT YOUR SLEEPER ACCOUNT'],
  ['draftday', 'Draft day', 'DRAFT DAY WORKFLOW'],
  ['shortlist', 'Shortlist', 'READING THE SHORTLIST'],
  ['mocks', 'Mocks', 'MOCK DRAFTS'],
  ['strategy', 'Strategies', 'STRATEGIES & SIMULATIONS'],
  ['season', 'Season', 'SEASON TOOLS'],
  ['glossary', 'Glossary', 'GLOSSARY'],
  ['trouble', 'Trouble', 'WHEN THINGS BREAK'],
];

const jump = (id: string) => {
  document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function Section({ id, title, children }: { id: string; title: string; children: any }) {
  return (
    <section id={`guide-${id}`} class="lv-tool-guide scroll-mt-36 pt-5">
      <h2 class="lv-h-tool pb-2 text-xs font-bold tracking-widest">{title}</h2>
      <div class="lv-sect flex flex-col gap-3 rounded-xl border border-app-border bg-app-surface p-4 text-[15px] leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function Ul({ children }: { children: any }) {
  return <ul class="flex list-disc flex-col gap-1.5 pl-5">{children}</ul>;
}

export default function GuideScreen() {
  return (
    <main class="mx-auto max-w-2xl px-4 pb-24">
      <div class="sticky top-0 z-10 flex flex-col gap-2 bg-app-bg py-2">
        <div class="flex items-center gap-2">
          <a
            href="#/hub"
            class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
          >
            ← Hub
          </a>
          <h1 class="lv-h-tool lv-tool-guide flex-1 text-lg font-bold">Guide</h1>
        </div>
        <nav class="flex gap-1 overflow-x-auto pb-1" aria-label="Jump to section">
          {SECTIONS.map(([id, chip]) => (
            <button
              key={id}
              type="button"
              class="h-14 shrink-0 rounded-lg border border-app-border bg-app-surface px-3 text-sm font-semibold"
              onClick={() => jump(id)}
            >
              {chip}
            </button>
          ))}
        </nav>
      </div>

      <Section id="start" title="START HERE">
        <p>
          DraftPrep is two things: a <b>draft-day cockpit</b> that recommends picks on the clock,
          and a <b>season companion</b> for lineups, waivers and trades afterwards. It is an
          offline-first PWA — everything runs on this device, and the draft works start to finish
          in airplane mode.
        </p>
        <Ul>
          <li>
            The <b>Hub</b> is the front door: switch between league profiles, open tools, and flip
            between <b>REAL</b> and <b>PRACTICE</b> mode.
          </li>
          <li>
            <b>Practice mode is fully isolated.</b> It keeps a completely separate draft state —
            mock as much as you like, your real prep can never be touched.
          </li>
          <li>
            <b>Install it:</b> Share → Add to Home Screen, then always launch from the icon. The
            live screen is gated on this — a browser tab can be evicted mid-draft.
          </li>
          <li>
            When a new build ships, the app <b>keeps running the old one</b> until you accept it.
            A green <b>"New version ready — tap to reload"</b> banner appears at the top; tap it
            when you're ready (never mid-draft).
          </li>
        </Ul>
      </Section>

      <Section id="sleeper" title="CONNECT YOUR SLEEPER ACCOUNT">
        <p>
          The app only ever <b>reads</b> from Sleeper — it never makes picks or changes for you.
          Connecting is optional; manual entry always works.
        </p>
        <Ul>
          <li>
            <b>Hub → Account:</b> enter your Sleeper username and tap <b>Connect</b>.
          </li>
          <li>
            Connect one of your leagues and its <b>profile is created for you</b> — name, league
            shape and ids filled in.
          </li>
          <li>
            The league and draft ids flow into <b>Sleeper Sync</b> (#/sync): during the draft,
            picks made in the Sleeper app land here automatically. Your username also powers mock
            lobby discovery in practice mode.
          </li>
        </Ul>
      </Section>

      <Section id="draftday" title="DRAFT DAY WORKFLOW">
        <p>
          The night before, run <b>Ready Check</b>. Every row is a gate with a one-line fix, and
          none of them can be fixed on the pick clock:
        </p>
        <Ul>
          <li>
            Board hash + age (fresh build?), standalone mode (launched from the icon?), persistent
            storage, wake lock, and the literal <b>airplane-mode rehearsal</b> checkbox — tick it
            only after actually doing it.
          </li>
        </Ul>
        <p>
          The live screen has three panels: <b>MY TEAM</b> (empty starter boxes ARE your needs),
          the <b>SHORTLIST</b> (ranked recommendations), and the <b>BOARD</b> (everyone left).
          On a narrow screen they collapse into tabs.
        </p>
        <Ul>
          <li>
            <b>One tap records a pick</b> at the current cursor — no confirm dialogs, ever.
          </li>
          <li>
            <b>UNDO</b>: tap to undo the last pick, <b>long-press</b> to open the editable pick
            log.
          </li>
          <li>
            Looked away for six picks? <b>Catch-up</b> (in the pick log): select everyone who
            went, commit once.
          </li>
          <li>
            The <b>LG button</b> opens the League view — all rosters plus the live draft grid.
            The strip above the shortlist shows the <b>wait window</b>: "8 picks until yours — 5
            teams need RB".
          </li>
          <li>
            If the engine ever errors, the shortlist points you to <b>Plan B</b>: the printed tier
            board on screen, drafted players struck. You are never left blank.
          </li>
        </Ul>
      </Section>

      <Section id="shortlist" title="READING THE SHORTLIST">
        <p>
          Each card's score is <b>MV + κ·CoW + Scarcity − small penalties</b> (bye overlap, stack,
          risk). In plain words: <b>value now, plus what waiting would cost you</b>. Tap a card for
          the full term table.
        </p>
        <Ul>
          <li>
            <b>Tier holds %</b> — the chance this player's tier survives until your next pick.
          </li>
          <li>
            <b>"Waiting costs ~X pts"</b> — the expected points lost if you pass now and take the
            best leftover next turn.
          </li>
          <li>
            <b>TIE chips</b>: cards within 4 points are an explicit tie — a coin flip. Take
            whichever you like; the math genuinely can't tell them apart.
          </li>
          <li>
            <b>OFF-PLAN chip</b>: when the top pick conflicts with your chosen strategy by more
            than 20 points, that is surfaced — never hidden, never silently obeyed. Strategies
            are priors, not handcuffs.
          </li>
          <li>
            <b>K and DST only appear in your last two rounds.</b> The engine schedules them at
            your two final picks, where taking them costs nothing.
          </li>
        </Ul>
      </Section>

      <Section id="mocks" title="MOCK DRAFTS">
        <p>
          Switch the Hub to <b>PRACTICE</b> and open Draft Day: the live screen gains the
          <b> MockControls</b> strip. Everything else is identical to draft day — that's the
          point.
        </p>
        <Ul>
          <li>
            <b>Start/Pause</b> auto-advances the room, <b>Step</b> moves one pick, speed cycles
            1× / 3× / 10×, and <b>AUTO-ME</b> lets the engine take your picks too.
          </li>
          <li>
            Opponents follow ADP tendencies <b>and</b> draw a per-run strategy archetype (the
            strip shows the room, e.g. "T3 zero_rb") — every mock feels like a different room.
          </li>
          <li>
            <b>Review</b> grades every one of your picks against the engine at that exact moment:
            <b> MATCH</b>, <b>EVEN</b> (within the tie margin), or <b>−pts</b> left on the board.
          </li>
          <li>
            You can also track a <b>real Sleeper mock lobby</b>: join one in the Sleeper app, then
            on the Sync screen (practice mode) find it by username and tap it. Picks of players
            not on your board are skipped harmlessly.
          </li>
        </Ul>
      </Section>

      <Section id="strategy" title="STRATEGIES & SIMULATIONS">
        <p>The built-ins, one line each:</p>
        <Ul>
          <li><b>Balanced / BPA</b> — pure tier discipline; the most robust default.</li>
          <li><b>Hero / Anchor RB</b> — one elite RB, then pass-catchers; RB again R6–9.</li>
          <li><b>Modified Zero RB</b> — no RB before R4; load up WR/TE while RBs fly.</li>
          <li><b>Robust RB</b> — 2 RB by R3, 3 by R5; volume early (weakest from a late slot).</li>
        </Ul>
        <p>
          Custom strategies live in a <b>strategies.json</b> file (or the in-app editor). A
          strategy may only nudge — position multipliers per round range plus soft constraints —
          it can never add new scoring terms.
        </p>
        <Ul>
          <li>
            <b>Sim Lab</b> runs self-play sweeps: your seat uses the real engine with a strategy,
            the other seats use the opponent model. You get <b>mean / p10 / p90</b> roster value
            and <b>Δ vs balanced</b>. When the Δ is inside the noise band it says <b>"≈ noise"</b>
            — an honest tie, not a win.
          </li>
          <li>
            <b>Calibration</b> fits the opponent model to your real Sleeper mocks: how closely the
            room follows ADP, how need-aware it is, how wide its reach window is. It deliberately
            fits <b>global</b> knobs only — with 10–20 mocks, fitting each seat would just be
            memorizing noise.
          </li>
        </Ul>
      </Section>

      <Section id="season" title="SEASON TOOLS">
        <p>After the draft, the same app carries the season:</p>
        <Ul>
          <li>
            <b>Lineup coach</b> — your current lineup vs the optimal one for the week, with a
            swap list and the reason for each swap.
          </li>
          <li>
            <b>Waivers</b> — every free agent scored by <b>this-week gain</b> and
            <b> rest-of-season gain</b> over your worst roster spot.
          </li>
          <li>
            <b>Trade Desk</b> — both sides valued as the <b>sum of best weekly lineups for the
            rest of the season</b>. Market value is shown as a sanity column only, never mixed
            into the verdict. Sandbox mode works with zero sync: assemble any two rosters by hand.
          </li>
          <li>
            Weekly data arrives via a <b>script + redeploy</b>, not inside the app — the app
            always shows how old its data is instead of pretending it's fresh.
          </li>
        </Ul>
      </Section>

      <Section id="glossary" title="GLOSSARY">
        <Ul>
          <li><b>ADP</b> — average draft position across many real drafts; where the market takes a player.</li>
          <li><b>VONA / CoW</b> — value over next available: what you lose by waiting one turn (the cost of waiting).</li>
          <li><b>Tier / cliff</b> — a group of near-equal players; the cliff is the value drop to the next group.</li>
          <li><b>κ (kappa)</b> — the weight on CoW; larger before a long wait, when the cliff can actually fall on you.</li>
          <li><b>Slack</b> — your remaining picks minus unfilled starter slots; how many "free" picks you still have.</li>
          <li><b>Eff points</b> — points that actually help: projections measured against a replacement baseline, not raw totals.</li>
          <li><b>Half-PPR</b> — 0.5 points per reception.</li>
          <li><b>Snake</b> — draft order reverses every round (1→12, then 12→1), so end seats pick back-to-back.</li>
          <li><b>Archetype</b> — the strategy a simulated opponent draws for one draft (e.g. a zero-RB seat).</li>
        </Ul>
      </Section>

      <Section id="trouble" title="WHEN THINGS BREAK">
        <Ul>
          <li>
            <b>Offline</b> — everything keeps working from the on-device cache. Only the sync dot
            changes: grey MANUAL or red OFFLINE. Keep tapping picks in manually.
          </li>
          <li>
            <b>Amber "board is N days old" banner</b> — the data is stale. Rebuild and redeploy
            before draft day; the Ready Check board-hash row confirms you got the new build.
          </li>
          <li>
            <b>Engine error</b> — the shortlist shows the error and a button to <b>Plan B</b>, the
            printed tier board on screen with drafted players struck. Draft on from there.
          </li>
          <li>
            <b>Backup</b> — the My Team rail has <b>Export / Import JSON</b>. Export before
            anything risky and paste it anywhere safe; import restores the full draft state.
          </li>
        </Ul>
      </Section>
    </main>
  );
}
