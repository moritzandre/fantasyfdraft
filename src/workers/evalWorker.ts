// evalWorker.ts — the Sim Lab's Web Worker: runs the SAME pure cores the CLI
// harnesses use (tools/lib/evaluate_core.mjs self-play sweeps and
// tools/lib/calibrate_core.mjs mock calibration) off the main thread. Vite
// module worker — created via
//   new Worker(new URL('../../workers/evalWorker.ts', import.meta.url),
//              { type: 'module' })
// so the cores (and engine/*) bundle into a precached worker chunk; nothing
// here touches DOM, fetch or storage — every input arrives in the message.
//
// Protocol (one request in, one 'shard'/'calibration' out; 'progress' events
// stream during a sweep chunk; any throw becomes {kind:'error'}):
//   in  {kind:'sweep', board, league, opponents, registry, strategyNames,
//        slots, simRange:[a,b), baseSeed, opponentParams}
//   out {kind:'progress', draftsDone}            (throttled, per sweep chunk)
//   out {kind:'shard', shard}                    (shardToJSON — plain arrays)
//   in  {kind:'calibrate', board, league, rawMocks, current:{tauScale,
//        needAwareShare, window}, runGrid}
//   out {kind:'calibration', result}
//
// The main thread (SimLab.tsx) owns chunking, merging (mergeShards),
// summarize() and persistence; Cancel simply terminates this worker.

import {
  evaluateShard,
  shardToJSON,
} from '../../tools/lib/evaluate_core.mjs';
import {
  GRID_DEFAULT,
  evaluateParams,
  gridSearch,
  makeNeutralCtxCache,
  mapMock,
} from '../../tools/lib/calibrate_core.mjs';

interface SweepMsg {
  kind: 'sweep';
  board: any;
  league: any;
  opponents: any;
  registry: Record<string, object> | null;
  strategyNames: string[];
  slots: number[];
  simRange: [number, number];
  baseSeed: number;
  opponentParams: Record<string, number> | null;
}

interface CalibrateMsg {
  kind: 'calibrate';
  board: any;
  league: any;
  rawMocks: any[];
  current: { tauScale: number; needAwareShare: number; window: number };
  runGrid: boolean;
}

const PROGRESS_EVERY = 10; // drafts between progress posts — cheap, smooth

function runSweep(msg: SweepMsg): void {
  let drafts = 0;
  const shard = evaluateShard({
    board: msg.board,
    league: msg.league,
    opponents: msg.opponents,
    strategies: msg.registry,
    strategyNames: msg.strategyNames,
    slots: msg.slots,
    simRange: msg.simRange,
    baseSeed: msg.baseSeed,
    opponentParams: msg.opponentParams,
    onSimDone: () => {
      drafts += 1;
      if (drafts % PROGRESS_EVERY === 0) {
        (self as any).postMessage({ kind: 'progress', draftsDone: drafts });
      }
    },
  });
  (self as any).postMessage({ kind: 'shard', shard: shardToJSON(shard) });
}

const r4 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10000) / 10000);

function runCalibrate(msg: CalibrateMsg): void {
  const { board, league } = msg;
  const mocks = msg.rawMocks
    .map((raw) =>
      mapMock(raw, board.slimSleeperMap, {
        defaultTeams: league.teams,
        defaultRounds: league.rounds,
        nPlayers: board.players.length,
      }),
    )
    .filter((m: any) => m.picks.length > 0);

  const getCtx = makeNeutralCtxCache(board, league);
  const current = evaluateParams(board, league, mocks, msg.current, getCtx);
  const pureAdp = evaluateParams(
    board, league, mocks,
    { tauScale: 1, needAwareShare: 0, window: msg.current.window },
    getCtx,
  );

  let grid: any = null;
  if (msg.runGrid && mocks.length >= 2) {
    const g = gridSearch(board, league, mocks, GRID_DEFAULT);
    grid = {
      best: g.best ? { ...g.best, cvLL: r4(g.best.cvLL) } : null,
      foldSelection: g.foldSelection
        ? { meanLL: r4(g.foldSelection.meanLL), chosen: g.foldSelection.chosen }
        : null,
      note: g.note,
      top: g.grid.slice(0, 5).map((c: any) => ({
        tauScale: c.tauScale,
        needAwareShare: c.needAwareShare,
        window: c.window,
        cvLL: Number.isFinite(c.cvLL) ? r4(c.cvLL) : null,
      })),
    };
  }

  (self as any).postMessage({
    kind: 'calibration',
    result: {
      nMocks: mocks.length,
      current: {
        params: current.params,
        meanLL: r4(current.meanLL),
        perplexity: r4(current.perplexity),
        uniformMeanLL: r4(current.uniformMeanLL),
        coverage: { ...current.coverage, scoredPct: r4(current.coverage.scoredPct) },
        byBand: current.byBand.map((b: any) => ({ ...b, meanLL: r4(b.meanLL) })),
      },
      pureAdp: { params: pureAdp.params, meanLL: r4(pureAdp.meanLL) },
      grid,
    },
  });
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as SweepMsg | CalibrateMsg;
  try {
    if (msg.kind === 'sweep') runSweep(msg);
    else if (msg.kind === 'calibrate') runCalibrate(msg);
    else throw new Error(`evalWorker: unknown message kind "${(msg as any)?.kind}"`);
  } catch (err) {
    (self as any).postMessage({ kind: 'error', error: String((err as Error)?.message ?? err) });
  }
};
