// SimLab.tsx — #/sim: in-browser strategy sweeps + opponent-model mock
// calibration, everything through the UI (no CLI on the critical path).
//
//   A. STRATEGY SWEEP — the SAME pure core the CLI harness runs
//      (tools/lib/evaluate_core.mjs), self-playing the live engine in a Web
//      Worker (src/workers/evalWorker.ts) with common random numbers across
//      strategies. The main thread sends 250-sim chunks sequentially (chunk
//      boundaries are seed-exact — shards merge bit-identically to an
//      unsplit run), merges + summarizes at the end, and persists the
//      artifact to localStorage dp:evaluation:v1 (StrategyTab reads it when
//      the buildHash matches). Cancel = terminate the worker.
//   B. MOCK CALIBRATION — fetch my completed Sleeper mock drafts (account
//      from dp:account:v1 or a username input), keep slim {draft, picks}
//      pairs in dp:mocks:v1 (cap 20, deduped), replay them through
//      tools/lib/calibrate_core.mjs in the same worker: teacher-forced LL vs
//      baselines + the tauScale × needAwareShare × window held-one-out grid
//      (≥3 mocks). "Apply params" writes dp:opp-params:v1 — rehearsal mock
//      rooms (src/state/mock.ts) and future sweeps use it immediately;
//      mc.json stays the offline build until tools/simulate.mjs re-runs.
//
// iPad rules hold: controls ≥56px, inputs 17px, no modals, results tables
// scroll inside their own containers.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { OPP_DEFAULT_PARAMS } from '../../../engine/opponent.js';
import { mergeShards, shardFromJSON, summarize } from '../../../tools/lib/evaluate_core.mjs';
import { fmt1 } from '../../../shared/format.js';
import type { Board, DraftState, Store } from '../../state/store';
import { loadStrategies, strategyList } from '../../state/strategies';
import type { StrategyRegistry } from '../../state/strategies';
import { loadOpponents } from '../../state/opponents';
import type { OpponentsFile } from '../../state/opponents';
import { OPP_PARAMS_KEY, loadOppParams } from '../../state/mock';
import {
  fetchDraft,
  fetchDraftPicks,
  fetchUserDrafts,
  isMockDraft,
  resolveUser,
} from '../../sync/sleeperMock';

export const EVALUATION_KEY = 'dp:evaluation:v1';
export const MOCKS_KEY = 'dp:mocks:v1';
const ACCOUNT_KEY = 'dp:account:v1';
const SWEEP_SEED = 20260827; // the CLI default — numbers stay comparable
const CHUNK = 250;
const SIMS_OPTIONS = [500, 2000, 5000];
const MOCKS_CAP = 20;

// ---------------------------------------------------------------------------
// localStorage helpers (guarded — private mode must never crash the lab)
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    const s = (globalThis as any).localStorage;
    return s && typeof s.getItem === 'function' ? (s as Storage) : null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    /* quota/private mode — the run still renders this session */
  }
}

interface SlimMock {
  draft: {
    draft_id: string;
    type?: unknown;
    status?: unknown;
    season?: unknown;
    settings: { teams: number; rounds: number };
    start_time?: number | null;
  };
  picks: Array<{ pick_no: unknown; player_id: unknown }>;
}

function loadMocks(): SlimMock[] {
  const blob = readJson<{ mocks?: SlimMock[] }>(MOCKS_KEY);
  return Array.isArray(blob?.mocks) ? blob!.mocks! : [];
}

function makeWorker(): Worker {
  return new Worker(new URL('../../workers/evalWorker.ts', import.meta.url), { type: 'module' });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SweepRun {
  phase: 'idle' | 'running' | 'error';
  draftsDone: number;
  totalDrafts: number;
  startedAt: number;
  error?: string;
}

const IDLE: SweepRun = { phase: 'idle', draftsDone: 0, totalDrafts: 0, startedAt: 0 };

export default function SimLab({ s, store, board }: { s: DraftState; store: Store; board: Board }) {
  const l = s.league;

  // Registry + opponents — the same loaders every other consumer uses.
  const [registry, setRegistry] = useState<StrategyRegistry | null>(null);
  const [opponents, setOpponents] = useState<OpponentsFile | null>(null);
  useEffect(() => {
    loadStrategies().then(setRegistry);
    loadOpponents().then(setOpponents);
  }, []);
  const strategies = useMemo(() => strategyList(registry), [registry]);

  // ── A. Sweep controls ────────────────────────────────────────────────────
  const [selected, setSelected] = useState<string[]>(['balanced', 'anchor_rb', 'zero_rb_mod', 'robust_rb']);
  const [sims, setSims] = useState(500);
  const [slot, setSlot] = useState(l.slot);
  const [run, setRun] = useState<SweepRun>(IDLE);
  const [artifact, setArtifact] = useState<any | null>(null);
  const [lastRun, setLastRun] = useState<{ sims: number; when: string } | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const stored = readJson<any>(EVALUATION_KEY);
    if (stored && typeof stored.sims === 'number') {
      setLastRun({
        sims: stored.sims,
        when: stored.generatedAt ? new Date(stored.generatedAt).toLocaleString() : 'unknown time',
      });
      if (stored.buildHash === board.buildHash) setArtifact(stored);
    }
    return () => workerRef.current?.terminate();
  }, []);

  // Bumped after Apply/Clear so the loadOppParams re-read below re-renders.
  const [, setAppliedRev] = useState(0);
  const appliedParams = loadOppParams(storage());

  const toggleStrategy = (name: string) =>
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  const cancelRun = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRun(IDLE);
  };

  const startRun = () => {
    if (run.phase === 'running' || selected.length === 0) return;
    const names = strategies.map((m) => m.name).filter((n) => selected.includes(n));
    const totalDrafts = sims * names.length;
    const startedAt = Date.now();
    setRun({ phase: 'running', draftsDone: 0, totalDrafts, startedAt });
    setArtifact(null);

    const w = makeWorker();
    workerRef.current = w;
    const shards: any[] = [];
    const opponentParams = loadOppParams(storage());
    let from = 0;
    let doneBase = 0; // drafts completed in FINISHED chunks

    const sendChunk = () => {
      const to = Math.min(sims, from + CHUNK);
      w.postMessage({
        kind: 'sweep',
        board,
        league: { ...l, slot },
        opponents: opponents ?? { seats: [] },
        registry,
        strategyNames: names,
        slots: [slot],
        simRange: [from, to],
        baseSeed: SWEEP_SEED,
        opponentParams,
      });
    };

    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.kind === 'progress') {
        setRun((r) => ({ ...r, draftsDone: doneBase + m.draftsDone }));
      } else if (m.kind === 'shard') {
        shards.push(shardFromJSON(m.shard));
        const to = Math.min(sims, from + CHUNK);
        doneBase += (to - from) * names.length;
        from = to;
        setRun((r) => ({ ...r, draftsDone: doneBase }));
        if (from < sims) {
          sendChunk();
        } else {
          try {
            const merged = shards.length > 1 ? mergeShards(shards) : shards[0];
            const summary = summarize(merged);
            const out = {
              schema: 1,
              source: 'simlab',
              buildHash: summary.buildHash,
              seed: summary.seed,
              sims: summary.sims,
              generatedAt: new Date().toISOString(),
              savedAt: Date.now(),
              opponentParams: opponentParams ?? opponents?.params ?? null,
              slots: summary.slots,
              strategies: summary.strategies,
              cells: summary.cells,
              pairedVsBalanced: summary.pairedVsBalanced,
            };
            writeJson(EVALUATION_KEY, out);
            setArtifact(out);
            setLastRun({ sims: out.sims, when: new Date(out.savedAt).toLocaleString() });
            setRun(IDLE);
          } catch (err) {
            setRun({ ...IDLE, phase: 'error', error: String((err as Error)?.message ?? err) });
          }
          w.terminate();
          workerRef.current = null;
        }
      } else if (m.kind === 'error') {
        setRun({ ...IDLE, phase: 'error', error: m.error });
        w.terminate();
        workerRef.current = null;
      }
    };
    w.onerror = (e: ErrorEvent) => {
      setRun({ ...IDLE, phase: 'error', error: e.message || 'worker failed to load' });
      w.terminate();
      workerRef.current = null;
    };
    sendChunk();
  };

  const elapsed = run.phase === 'running' ? Math.max(1, Date.now() - run.startedAt) : 1;
  const draftsPerSec = run.phase === 'running' ? (run.draftsDone / elapsed) * 1000 : 0;
  const pct = run.totalDrafts > 0 ? Math.round((100 * run.draftsDone) / run.totalDrafts) : 0;

  // ── B. Mock calibration state ────────────────────────────────────────────
  const account = readJson<{ username?: string; userId?: string }>(ACCOUNT_KEY);
  const [username, setUsername] = useState(account?.username ?? '');
  const [mocks, setMocks] = useState<SlimMock[]>(() => loadMocks());
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calib, setCalib] = useState<any | null>(null);
  const [calibErr, setCalibErr] = useState<string | null>(null);

  const fetchMyMocks = async () => {
    if (fetching) return;
    setFetching(true);
    setFetchNote(null);
    try {
      const stored = readJson<{ username?: string; userId?: string }>(ACCOUNT_KEY);
      const name = username.trim() || stored?.username || '';
      let userId = stored?.userId && (!name || name === stored?.username) ? stored.userId : undefined;
      if (!userId) {
        if (!name) throw new Error('enter your Sleeper username first');
        const u = await resolveUser(name);
        userId = u.userId;
        writeJson(ACCOUNT_KEY, { ...(stored ?? {}), username: name, userId });
      }
      const season = String(new Date().getFullYear());
      const drafts = await fetchUserDrafts(userId, season);
      const eligible = drafts
        .filter(
          (d) =>
            isMockDraft(d) &&
            d.status === 'complete' &&
            Number((d.settings as any)?.teams) === l.teams,
        )
        .sort((a, b) => Number(b.start_time ?? 0) - Number(a.start_time ?? 0));

      const byId = new Map(mocks.map((m) => [m.draft.draft_id, m]));
      let added = 0;
      for (const d of eligible) {
        const id = String(d.draft_id);
        if (byId.has(id)) continue;
        if (byId.size >= MOCKS_CAP) break;
        const meta = await fetchDraft(id);
        const picks = await fetchDraftPicks(id);
        const settings = (meta.settings ?? {}) as any;
        byId.set(id, {
          draft: {
            draft_id: id,
            type: meta.type,
            status: meta.status,
            season: meta.season,
            settings: { teams: Number(settings.teams), rounds: Number(settings.rounds) },
            start_time: typeof meta.start_time === 'number' ? meta.start_time : null,
          },
          picks: picks.map((p) => ({ pick_no: p.pick_no, player_id: p.player_id })),
        });
        added += 1;
      }
      const list = [...byId.values()]
        .sort((a, b) => Number(b.draft.start_time ?? 0) - Number(a.draft.start_time ?? 0))
        .slice(0, MOCKS_CAP);
      writeJson(MOCKS_KEY, { v: 1, fetchedAt: Date.now(), mocks: list });
      setMocks(list);
      setFetchNote(
        `${added} new mock${added === 1 ? '' : 's'} — ${list.length} stored `
        + `(${eligible.length} complete ${l.teams}-team mocks on Sleeper this season)`,
      );
    } catch (e) {
      setFetchNote(`⚠ ${String((e as Error)?.message ?? e)}`);
    } finally {
      setFetching(false);
    }
  };

  const runCalibration = () => {
    if (calibrating || mocks.length === 0) return;
    setCalibrating(true);
    setCalib(null);
    setCalibErr(null);
    const P: any = {
      ...OPP_DEFAULT_PARAMS,
      ...(opponents?.params ?? {}),
      ...(loadOppParams(storage()) ?? {}),
    };
    const w = makeWorker();
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.kind === 'calibration') setCalib(m.result);
      else if (m.kind === 'error') setCalibErr(m.error);
      setCalibrating(false);
      w.terminate();
    };
    w.onerror = (e: ErrorEvent) => {
      setCalibErr(e.message || 'worker failed to load');
      setCalibrating(false);
      w.terminate();
    };
    w.postMessage({
      kind: 'calibrate',
      board,
      league: l,
      rawMocks: mocks,
      current: { tauScale: P.tauScale, needAwareShare: P.needAwareShare, window: P.window },
      runGrid: mocks.length >= 3,
    });
  };

  const applyParams = (best: { tauScale: number; needAwareShare: number; window: number }) => {
    writeJson(OPP_PARAMS_KEY, {
      tauScale: best.tauScale,
      needAwareShare: best.needAwareShare,
      window: best.window,
      appliedAt: Date.now(),
    });
    setAppliedRev((r) => r + 1);
  };

  const clearParams = () => {
    try {
      storage()?.removeItem(OPP_PARAMS_KEY);
    } catch {
      /* ignore */
    }
    setAppliedRev((r) => r + 1);
  };

  // ── Render helpers ───────────────────────────────────────────────────────

  const chip = (active: boolean) =>
    `min-h-14 shrink-0 rounded-lg border px-3 text-[15px] font-bold ${
      active ? 'border-accent bg-accent text-app-bg' : 'border-app-border bg-app-bg text-app-text'
    }`;

  const renderResults = (art: any) => {
    const paired = art.pairedVsBalanced ?? null;
    return art.slots.map((sl: number) => {
      const rows = (art.cells as any[])
        .filter((c) => c.slot === sl)
        .sort((a, b) => b.rosterValue.mean - a.rosterValue.mean);
      return (
        <div class="mt-2 overflow-x-auto rounded-lg border border-app-border">
          <table class="num w-full border-collapse text-right text-sm">
            <thead>
              <tr class="bg-app-surface text-xs text-app-dim">
                <th class="px-2 py-2 text-left">slot {sl} · strategy</th>
                <th class="px-2 py-2">mean</th>
                <th class="px-2 py-2">p10</th>
                <th class="px-2 py-2">p90</th>
                <th class="px-2 py-2">Δ vs balanced (±2se)</th>
                <th class="px-2 py-2">win%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const pb = paired?.[sl]?.[c.strategy];
                const band = pb ? 2 * pb.se : 0;
                const label = strategies.find((m) => m.name === c.strategy)?.label ?? c.strategy;
                return (
                  <tr class="border-t border-app-border">
                    <td class="px-2 py-2 text-left font-bold">{label}</td>
                    <td class="px-2 py-2 font-bold">{fmt1(c.rosterValue.mean)}</td>
                    <td class="px-2 py-2 text-app-dim">{fmt1(c.rosterValue.p10)}</td>
                    <td class="px-2 py-2 text-app-dim">{fmt1(c.rosterValue.p90)}</td>
                    <td class="px-2 py-2">
                      {c.strategy === 'balanced'
                        ? 'baseline'
                        : pb
                          ? `${pb.meanDiff >= 0 ? '+' : ''}${fmt1(pb.meanDiff)} ± ${fmt1(band)}${
                              Math.abs(pb.meanDiff) < band ? ' ≈ noise' : ''
                            }`
                          : '—'}
                    </td>
                    <td class="px-2 py-2">{(100 * c.allPlayWinPct.mean).toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    });
  };

  const fmtLL = (v: number | null | undefined) => (v == null ? 'n/a' : v.toFixed(3));

  return (
    <div class="mx-auto max-w-4xl px-3 pb-16">
      <div class="flex items-center gap-2 pt-3">
        <a
          href="#/hub"
          class="flex h-14 min-w-14 items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 font-bold"
        >
          ← Hub
        </a>
        <h1 class="flex-1 text-lg font-bold">Sim Lab</h1>
      </div>

      {/* ── A. Strategy sweep ─────────────────────────────────────────── */}
      <section class="mt-3 rounded-xl border border-app-border bg-app-surface p-3">
        <h2 class="text-[17px] font-bold">Strategy sweep — browser self-play</h2>
        <p class="pt-1 text-sm text-app-dim">
          The live engine drafts every selected strategy from slot {slot} against the shared
          opponent room — same core, seed and paired Δ-vs-balanced math as the CLI harness.
          {appliedParams
            ? ` Using calibrated opponent params (τ×${appliedParams.tauScale ?? '·'}, share ${appliedParams.needAwareShare ?? '·'}, window ${appliedParams.window ?? '·'}).`
            : ' Opponent params: offline build defaults.'}
        </p>

        <div class="mt-2 flex flex-wrap gap-1">
          {strategies.map((m) => (
            <button type="button" class={chip(selected.includes(m.name))} onClick={() => toggleStrategy(m.name)}>
              {m.label}
              {m.custom ? ' ✎' : ''}
            </button>
          ))}
        </div>
        {!selected.includes('balanced') && (
          <p class="pt-1 text-xs text-app-dim">
            Without <b>balanced</b> selected there is no paired Δ baseline — the Δ column will be empty.
          </p>
        )}

        <div class="mt-2 flex flex-wrap items-center gap-1">
          <span class="w-14 text-xs text-app-dim">sims</span>
          {SIMS_OPTIONS.map((n) => (
            <button type="button" class={chip(sims === n)} onClick={() => setSims(n)}>
              {n}
            </button>
          ))}
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-1">
          <span class="w-14 text-xs text-app-dim">slot</span>
          {Array.from({ length: l.teams }, (_, i) => i + 1).map((n) => (
            <button type="button" class={chip(slot === n)} onClick={() => setSlot(n)}>
              {n}
            </button>
          ))}
        </div>

        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="min-h-14 flex-1 rounded-xl bg-accent font-bold text-app-bg disabled:opacity-40"
            disabled={run.phase === 'running' || selected.length === 0 || !registry || !opponents}
            onClick={startRun}
          >
            {registry && opponents ? `Run ${sims} sims × ${selected.length}` : 'Loading…'}
          </button>
          <button
            type="button"
            class="min-h-14 flex-1 rounded-xl border border-app-border bg-app-bg font-bold disabled:opacity-40"
            disabled={run.phase !== 'running'}
            onClick={cancelRun}
          >
            Cancel
          </button>
        </div>

        {run.phase === 'running' && (
          <div class="mt-2">
            <div class="h-3 overflow-hidden rounded bg-app-bg">
              <div class="h-3 bg-accent" style={`width:${pct}%`} />
            </div>
            <p class="num pt-1 text-xs text-app-dim">
              {run.draftsDone} / {run.totalDrafts} drafts ({pct}%) · {draftsPerSec.toFixed(1)} drafts/s
            </p>
          </div>
        )}
        {run.phase === 'error' && (
          <p class="lv-bye-alert mt-2 rounded-lg px-3 py-2 text-sm font-semibold">⚠ sweep failed: {run.error}</p>
        )}

        {lastRun && !artifact && run.phase !== 'running' && (
          <p class="num pt-2 text-xs text-app-dim">
            last run: {lastRun.sims} sims, {lastRun.when} — computed against a different board build,
            re-run to refresh.
          </p>
        )}
        {artifact && (
          <>
            <p class="num pt-2 text-xs text-app-dim">
              last run: {artifact.sims} sims, {lastRun?.when} · seed {artifact.seed} · saved to this
              device (Strategy tab shows these numbers while the board build matches).
            </p>
            {renderResults(artifact)}
          </>
        )}
      </section>

      {/* ── B. Mock calibration ───────────────────────────────────────── */}
      <section class="mt-3 rounded-xl border border-app-border bg-app-surface p-3">
        <h2 class="text-[17px] font-bold">Mock calibration — fit the room to YOUR Sleeper mocks</h2>
        <p class="pt-1 text-sm text-app-dim">
          Fetches your completed {l.teams}-team Sleeper mock drafts, replays every observed pick
          through the opponent model (teacher-forced, neutral seats) and grid-searches τ ×
          need-share × window when ≥3 mocks exist. Applying the best cell tunes rehearsal mocks and
          sweeps on this device; the offline mc.json stays as built.
        </p>

        <div class="mt-2 flex flex-wrap gap-2">
          <input
            type="text"
            value={username}
            placeholder="Sleeper username"
            autocapitalize="off"
            autocorrect="off"
            class="h-14 min-w-0 flex-1 rounded-lg border border-app-border bg-app-bg px-3 text-[17px]"
            onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            class="min-h-14 rounded-xl bg-accent px-4 font-bold text-app-bg disabled:opacity-40"
            disabled={fetching}
            onClick={fetchMyMocks}
          >
            {fetching ? 'Fetching…' : 'Fetch my mocks'}
          </button>
        </div>
        {fetchNote && <p class="pt-1 text-sm text-app-dim">{fetchNote}</p>}

        {mocks.length > 0 && (
          <div class="mt-2 max-h-56 overflow-y-auto rounded-lg border border-app-border">
            {mocks.map((m) => (
              <div class="num flex min-h-9 items-center gap-2 border-b border-app-border px-2 text-sm last:border-b-0">
                <span class="min-w-0 flex-1 truncate text-app-dim">{m.draft.draft_id}</span>
                <span>
                  {m.draft.settings.teams}×{m.draft.settings.rounds}
                </span>
                <span class="text-app-dim">{m.picks.length} picks</span>
                <span class="text-app-dim">
                  {m.draft.start_time ? new Date(Number(m.draft.start_time)).toLocaleDateString() : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="min-h-14 flex-1 rounded-xl border border-app-border bg-app-bg font-bold disabled:opacity-40"
            disabled={calibrating || mocks.length === 0}
            onClick={runCalibration}
          >
            {calibrating
              ? 'Calibrating…'
              : `Calibrate (${mocks.length} mock${mocks.length === 1 ? '' : 's'}${mocks.length >= 3 ? ' + grid' : ''})`}
          </button>
        </div>
        {mocks.length > 0 && mocks.length < 3 && (
          <p class="pt-1 text-xs text-app-dim">
            Grid search needs ≥3 mocks — below that only the current-params check runs.
          </p>
        )}
        {calibErr && (
          <p class="lv-bye-alert mt-2 rounded-lg px-3 py-2 text-sm font-semibold">⚠ calibration failed: {calibErr}</p>
        )}

        {calib && (
          <div class="mt-2 rounded-lg border border-app-border bg-app-bg p-3 text-sm">
            <p class="num">
              <b>{calib.nMocks}</b> mocks · coverage{' '}
              {(100 * (calib.current.coverage.scoredPct ?? 0)).toFixed(1)}% of{' '}
              {calib.current.coverage.totalPicks} picks scored (offBoard{' '}
              {calib.current.coverage.offBoard}, beyondWindow {calib.current.coverage.beyondWindow})
            </p>
            <p class="num pt-1">
              mean LL <b>{fmtLL(calib.current.meanLL)}</b> nats/pick at current params (τ×
              {calib.current.params.tauScale}, share {calib.current.params.needAwareShare}, window{' '}
              {calib.current.params.window}) — baselines: uniform-over-window{' '}
              {fmtLL(calib.current.uniformMeanLL)} · pure-ADP {fmtLL(calib.pureAdp.meanLL)}
            </p>
            {calib.grid?.best && (
              <>
                <p class="num pt-1">
                  grid best: τ×{calib.grid.best.tauScale} · share {calib.grid.best.needAwareShare} ·
                  window {calib.grid.best.window} (cvLL {fmtLL(calib.grid.best.cvLL)}
                  {calib.grid.foldSelection?.meanLL != null
                    ? `; CV-of-selection ${fmtLL(calib.grid.foldSelection.meanLL)}`
                    : ''}
                  )
                </p>
                <p class="pt-1 text-xs text-app-dim">Honesty note: {calib.grid.note}</p>
                <button
                  type="button"
                  class="mt-2 min-h-14 w-full rounded-xl bg-accent font-bold text-app-bg"
                  onClick={() => applyParams(calib.grid.best)}
                >
                  Apply params — τ×{calib.grid.best.tauScale} · share {calib.grid.best.needAwareShare}{' '}
                  · window {calib.grid.best.window}
                </button>
              </>
            )}
            {!calib.grid && (
              <p class="pt-1 text-xs text-app-dim">
                No grid this run — fetch more mocks (≥3) to search τ × share × window held-one-out.
              </p>
            )}
          </div>
        )}

        {appliedParams && (
          <div class="mt-2 flex items-center gap-2 rounded-lg border border-accent px-3 py-2 text-sm">
            <span class="num min-w-0 flex-1">
              Applied on this device: τ×{appliedParams.tauScale ?? '·'} · share{' '}
              {appliedParams.needAwareShare ?? '·'} · window {appliedParams.window ?? '·'} — mock
              drafts and sweeps use these now (mc.json remains the offline build).
            </span>
            <button
              type="button"
              class="min-h-14 shrink-0 rounded-lg border border-app-border bg-app-bg px-3 font-bold"
              onClick={clearParams}
            >
              Clear
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
