#!/usr/bin/env node
// merge_evaluation.mjs — glue shard files from split evaluation runs
// (tools/evaluate_strategies.mjs --sim-range A..B) into the final
// public/data/evaluation.json artifact.
//
// CLI:
//   node tools/merge_evaluation.mjs shard-*.json [--out public/data/evaluation.json]
//
// Globs are expanded HERE (PowerShell/cmd pass wildcards through literally,
// unlike POSIX shells). Compatibility is enforced by evaluate_core
// mergeShards(): identical baseSeed / buildHash / strategy list / slots /
// opponent-config hash, sim ranges non-overlapping and gap-free — any
// mismatch is a hard failure. Shards built under different Node MAJOR
// versions only warn (float math is spec-fixed, but be told).

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { mergeShards, summarize, shardFromJSON } from './lib/evaluate_core.mjs';

const DEFAULT_OUT = path.join('public', 'data', 'evaluation.json');

const t0 = Date.now();
const args = process.argv.slice(2);

// ── Args: everything before/around --out is a shard path or glob ───────────
let outPath = DEFAULT_OUT;
const patterns = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    outPath = args[i + 1];
    if (!outPath) { console.error('--out requires a path'); process.exit(1); }
    i++;
  } else {
    patterns.push(args[i]);
  }
}
if (patterns.length === 0) {
  console.error('usage: node tools/merge_evaluation.mjs shard-*.json [--out path]');
  process.exit(1);
}

/** Expand * and ? in the basename (PowerShell passes globs literally). */
function expandPattern(pat) {
  if (!/[*?]/.test(pat)) return [pat];
  const dir = path.dirname(pat);
  const rx = new RegExp('^' + path.basename(pat)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$', 'i');
  return readdirSync(dir === '' ? '.' : dir)
    .filter((f) => rx.test(f))
    .map((f) => path.join(dir, f))
    .sort();
}

const files = [...new Set(patterns.flatMap(expandPattern))];
if (files.length === 0) {
  console.error(`no shard files match: ${patterns.join(' ')}`);
  process.exit(1);
}

// ── Load + validate + merge ────────────────────────────────────────────────
const raws = files.map((f) => {
  try {
    return { file: f, json: JSON.parse(readFileSync(f, 'utf8')) };
  } catch (e) {
    console.error(`cannot read shard ${f}: ${e.message}`);
    process.exit(1);
  }
});

// Node-major provenance check — warn only (see header).
const majors = new Map();
for (const { file, json } of raws) {
  const m = /^v(\d+)/.exec(json.meta?.nodeVersion ?? '');
  if (m) majors.set(file, Number(m[1]));
}
if (new Set(majors.values()).size > 1) {
  console.warn('[merge] WARNING: shards were built under different Node major versions: '
    + [...majors.entries()].map(([f, v]) => `${path.basename(f)}=v${v}`).join(', '));
}

let merged;
try {
  merged = mergeShards(raws.map(({ json }) => shardFromJSON(json)));
} catch (e) {
  console.error(`merge failed: ${e.message}`);
  process.exit(1);
}

const summary = summarize(merged);
const artifact = {
  schema: 1,
  buildHash: summary.buildHash,
  seed: summary.seed,
  sims: summary.sims,
  generatedAt: new Date().toISOString(),
  opponentParams: raws[0].json.meta?.opponentParams ?? null,
  slots: summary.slots,
  strategies: summary.strategies,
  cells: summary.cells,
  pairedVsBalanced: summary.pairedVsBalanced,
  meta: {
    wallTimeMs: Date.now() - t0,
    workers: null, // shards may come from anywhere — worker count is unknowable here
    shards: files.length,
    nodeVersion: process.version,
  },
};
writeFileSync(path.resolve(outPath), JSON.stringify(artifact), 'utf8');

console.log(`[merge] ${files.length} shard(s) → sims [${merged.meta.simRange[0]}, `
  + `${merged.meta.simRange[1]}) → ${outPath} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
