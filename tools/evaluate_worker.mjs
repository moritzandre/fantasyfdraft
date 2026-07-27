// evaluate_worker.mjs — worker_threads entry for tools/evaluate_strategies.mjs.
// Receives one shard's config via workerData, rebuilds the custom-strategy
// registry from raw specs (frozen registry objects don't survive structured
// clone as-defined), runs evaluateShard and posts the shard back with the
// typed-array buffers transferred (zero-copy where the runtime allows).
// All I/O and timing stay in the parent — this file only computes.

import { parentPort, workerData } from 'node:worker_threads';
import { defineStrategy } from '../engine/strategy.js';
import { evaluateShard } from './lib/evaluate_core.mjs';

try {
  const {
    board, league, opponents, strategySpecs, strategyNames, slots,
    simRange, baseSeed, opponentParams,
  } = workerData;

  // Rebuild the registry from validated raw specs (the parent already
  // dropped invalid ones with a warning — defineStrategy here cannot fail).
  let strategies = null;
  if (Array.isArray(strategySpecs) && strategySpecs.length > 0) {
    strategies = {};
    for (const spec of strategySpecs) {
      const s = defineStrategy(spec);
      strategies[s.name] = s;
    }
  }

  const shard = evaluateShard({
    board, league, opponents, strategies, strategyNames, slots,
    simRange, baseSeed, opponentParams,
  });

  const transfers = [];
  for (const c of shard.cells) {
    transfers.push(
      c.perSimRv.buffer, c.rvHist.buffer, c.apHist.buffer,
      c.posByRound.buffer, c.roundEffSum.buffer, c.roundEffSumsq.buffer,
    );
  }
  parentPort.postMessage({ shard }, transfers);
} catch (e) {
  parentPort.postMessage({ error: e && e.stack ? e.stack : String(e) });
}
