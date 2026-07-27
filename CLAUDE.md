# DraftPrep — half-PPR fantasy draft assistant

Live draft assistant (iPad PWA) + printed cheat-sheet kit for Moritz's 12-team Sleeper league.
**Draft: Mon 24 Aug 2026, 17:30 CEST.** He drafts from **slot 8**, but the entire system is
**slot-general** — slot is runtime data (Setup screen picker, `--slot` on PDF emission, per-slot
routes/branch-trees); nothing may hardcode 8 or its pick numbers `8,17,32,…,185`.

League: `1QB/2RB/2WR/1TE/2FLEX/1K/1DST` + 6 BN = 16 rounds, 192 picks, 0.5 PPR, clean redraft, snake.

## Architecture — four tools, one job each

| Layer | Job | Never does |
|---|---|---|
| `tools/*.py` (Python 3.14 **stdlib only**) | fetch + normalize + emit `public/data/board.json`, **before draft day only** | run on the pick clock |
| `engine/` (pure JS, ES modules) | ALL math — offline sim and live recommendations run the **same files** | DOM, fetch, globals, `Date.now()`, framework imports |
| Astro 5 + Preact islands + Tailwind 4 | pages, live UI, print sheets | math (UI only formats/explains) |
| Chrome headless (full path, never Edge) | `tools/make_pdfs.py` → printed kit | — |

Deploy: `npm run build` locally → commit `docs/` → GitHub Pages "main /docs" at
https://moritzandre.github.io/fantasyfdraft/ (base `/fantasyfdraft/` in astro.config.mjs —
the base path and SW scope must stay in sync). **No CI on the critical path.**
Astro is pinned to 5.x: `@vite-pwa/astro` peer-caps at 5; the PWA plugin is load-bearing, the major isn't.

## Commands

```
npm test                       # engine tests (node --test)
node --test "src/state/*.test.ts"   # state layer (Node strip-types; TS must stay ERASABLE)
node --test "src/sync/*.test.ts"
npm run test:tools             # evaluation + calibration harness tests (tools/**/*.test.mjs)
npm run dev                    # dev server :4321
python tools/serve.py          # serve BUILT docs/ at the base path :8788 (root-serving breaks assets)
npm run board                  # data refresh: build_board → verify_board → simulate
npm run build                  # build into docs/ (commit it — that IS the deploy)
python tools/make_pdfs.py --preset full --paper a4 --mode gray [--slot N]
node tools/evaluate_strategies.mjs --slots 8 --workers 12        # self-play strategy sweep → evaluation.json
python tools/fetch_mocks.py --user <name>                        # download my Sleeper mock drafts
node tools/calibrate.mjs --grid [--apply]                        # fit opponent params from real mocks
```

**Full data-refresh order** (hash-mismatch banners flag any skipped step):
`build_board.py` → `verify_board.py` (hard gate, rewrites checks INTO board.json) →
`simulate.mjs` (real Ckmeans tiers + 20k-draft Monte Carlo → mc.json) → `npm run build` →
commit docs/ + push → `make_pdfs.py`.

## Hard invariants (each has a regression test — do not relax)

- **No `CliffBonus`, no `NeedMultiplier` in scoring.** Urgency flows only through
  `E[BestAvail]`/VONA. `Score = MV + κ·CoW + Scarcity − Bye − Stack − Risk`, terms sum exactly.
- **κ rule is parity-free:** long weight iff gap-after-pick > N (`engine/picks.js`). Slot 8 ⇒ 9/15 ⇒ 1.0/1.3.
- K/DST scheduling = `myPicks(league).slice(-2)` — never constants.
- UNDO is a pure log-pop + re-reduce; derived state is NEVER persisted (replay from the pick log).
- Persistence is **synchronous localStorage on every dispatch** (picklog first, then snapshot), never debounced.
- Sub-4-point margins render as explicit ties; tier labels frozen during a draft.
- One tap = record pick at cursor. No confirm dialogs anywhere; destructive actions use 3s HoldButton.
- iPad rules: controls ≥56px, rows 52px, ALL inputs ≥17px (iOS zoom cliff), no modals on #/live.
- Print: grayscale-first (tier = luminance + letter + border weight, all in `src/styles/tokens.css`);
  ink inside the 210×279.4mm A4/Letter intersection; sheets import tokens.css + print.css, never global.css.
- Sleeper sync dispatches only `PICK_MADE {source:'sleeper'}` through the same reducer; on failure the
  dot changes and nothing else.

## Contracts (read before touching adjacent code)

- `shared/schema.js` — board.json shape, `validateBoard()`. `config/league.json` — league config.
- `src/state/store.ts` — the 9-action store contract (PICK_MADE/UNDO/SET_PICK_CURSOR/CATCHUP/
  EDIT_PICK/SET_LEAGUE/SET_UI/RESET_DRAFT/IMPORT_STATE) + pure selectors.
- `engine/index.js` — `recommend(board, league, state, opts)`; see JSDoc for the return shape.
- `public/data/mc.json` — `byPick` keyed by **overall pick 1..192** (slot-general);
  `branchesBySlot["1".."12"]`. Regenerate with `node tools/simulate.mjs`.
- Prep layer: `src/state/prefs.ts`, localStorage `dp:prefs:v1`, applied via pure `applyPrefs(board, prefs)`
  at app boot. Draft state: `dp:state:v1` + `dp:picklog:v1`.

## Gotchas that already bit us (encoded in code — don't "fix" them away)

- ESPN stats array mixes seasons: filter on ALL FOUR keys (`seasonId/statSourceId/statSplitTypeId/
  scoringPeriodId`); rushing TD is stat **25**, rec TD is 43. `leaguedefaults/3` is PPR — half-PPR is
  recomputed (`− 0.5×stat53`). Gibbs regression 365.09→331.20 guards this.
- FFC ADP: no CORS (server-side only), Content-Type lies (parse text), `teams=` param is a silent no-op.
- Sleeper players dump is ~14 MB — build-time only, never fetched by the browser; slim map in board.json.
- The installed PWA serves the **previous** build until the update banner is accepted — Ready Check
  shows the board hash; it must match the latest build before drafting.
- Prep edits (tags/overrides/tier moves) apply at next app **launch**, not live.
- TierSep on real data is ≪1.0 everywhere (σ_proj is outcome-scale RMSE); `simulate.mjs` uses a
  calibrated `SEP_THRESHOLD = 0.01`. The plan's "merge below 1.0" is scale-relative, not absolute.
- DST weekly projections have no bye-week zero (flag `dstByeZeroed`); 5 players carry `weeklySynthesized`.
- `verify_board.py` REWRITES board.json (adds checks) — always run it after build_board.

## Hub expansion (landed 2026-07-27; plan: ~/.claude/plans/okay-looks-good-i-twinkling-flask.md)

- **Contexts & profiles**: every draft state lives in a (profile, mode) CONTEXT —
  `persist.ts snapshotKey(ctx)`; default profile + real mode = the legacy keys (zero migration).
  `src/state/profiles.ts` (dp:profiles:v1) + `mode.ts` (dp:mode:v1 real/practice). Practice mode
  is a fully isolated namespace — mock drafting can NEVER touch real prep. Hub (#/hub, default
  route) switches leagues/modes/tools.
- **One opponent model**: `engine/opponent.js` (extracted from simulate.mjs, bit-identical golden
  gate — see the note in that file's header). Seats draw per-draft strategy ARCHETYPES from
  `opponents.json archetypes.mix` (names = built-ins + strategies.json); mix absent ⇒ exact
  legacy behavior. simulate.mjs, mock driver (src/state/mock.ts), RehearsalTab, evaluation and
  calibration all share it.
- **Custom strategies**: `public/data/strategies.json`, validated by
  `engine/strategy.js validateStrategy` (whitelist = multipliers/constraints/overrideDelta only —
  the structural no-additive-terms guard). `resolveStrategy(name, registry)`; unknown names still
  throw; boot guard reverts visibly to balanced.
- **recommend() extensions**: n-aware `state.entries [{n,idx}]` + `state.cursor` (holes safe —
  ALWAYS pass these from UI code, never the dense array), `opts.strategies`,
  `opts.includeIdxs → scoredExtras` (ReviewScreen grading).
- **New routes**: #/hub · #/league (rosters + live draft grid) · #/review. Practice #/live gets
  the MockControls strip; SyncPanel practice section joins real Sleeper MOCK lobbies
  (sleeperMock.ts; off-board picks: `onUnresolvable:'skip'` — real mode stays 'pause').
- **Evaluation**: `tools/evaluate_strategies.mjs` — self-play sweeps (my seat = real engine),
  paired vs balanced with common random numbers (draftSeed excludes the strategy name — forced
  picks consume no rng), worker_threads + file-shard merge. Results render in StrategyTab when
  evaluation.json matches the buildHash.
- **Calibration**: fetch_mocks.py → calibrate.mjs (teacher-forced LL, pAvail reliability,
  held-one-out grid) → opponents.json `params` → re-run simulate.mjs.
- Post-draft (planned, not started): season platform — build_week.py + season.json, per-profile
  season stores, lineup coach, waivers, sandbox-first Trade Desk. See the plan file.

## Current status (2026-07-27) & open items

Done: pipeline (7/7), engine (86 tests), state (84), sync (20), tools (9), live app + prep +
Ladder + hub/practice/league views/mock mode, MC w/ archetypes, 14 print sheets, Sleeper sync
incl. mock lobbies. All committed.

Open — **user-side**: run 1–2 Sleeper mocks per session NOW (≥10 by ~Aug 12 → fetch_mocks +
calibrate); author candidate strategies in strategies.json + run sweeps; enable GitHub Pages
(Settings→Pages: main /docs — still 404 last checked); iPad Add-to-Home-Screen + airplane-mode
cold-launch proof incl. new routes; print legibility proof; Sleeper draft ID near draft day.
Open — **schedule**: fresh data rebuild Fri 21 Aug (T−3, then re-run sweeps); full airplane-mode
mock draft Sat 22 (T−2); **hard freeze Sun 23 Aug — no pushes after**; draft Mon 24 Aug 17:30 CEST.
