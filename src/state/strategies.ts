// strategies.ts — loader for the custom-strategy registry
// (public/data/strategies.json). Fetched ONCE per session and cached;
// invalid specs are dropped with a console warning, never fatal; a missing
// file is an empty registry. The registry feeds recommend() via
// opts.strategies, the Setup/Strategy pickers, and the opponent archetype
// mix. Erasable TS; fetch is injectable for tests.

import { STRATEGIES, defineStrategy, resolveStrategy } from '../../engine/strategy.js';

export type StrategyRegistry = Record<string, Record<string, unknown>>;

export interface StrategyMeta {
  name: string;
  label: string;
  blurb: string;
  custom: boolean;
}

/** Display metadata for the built-ins (single source for both pickers). */
export const BUILTIN_META: StrategyMeta[] = [
  { name: 'balanced', label: 'Balanced / BPA', blurb: 'Pure tier discipline — the most robust default.', custom: false },
  { name: 'anchor_rb', label: 'Hero / Anchor RB', blurb: 'One elite RB, then pass-catchers; RB again R6–9.', custom: false },
  { name: 'zero_rb_mod', label: 'Modified Zero RB', blurb: 'No RB before R4 — load WR/TE while RBs fly.', custom: false },
  { name: 'robust_rb', label: 'Robust RB', blurb: '2 RB by R3, 3 by R5 — volume early (weakest late-slot).', custom: false },
];

let cache: Promise<StrategyRegistry> | null = null;

export function loadStrategies(
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u),
  baseUrl: string = (import.meta as any).env?.BASE_URL ?? '/',
): Promise<StrategyRegistry> {
  if (!cache) {
    cache = fetchFn(baseUrl + 'data/strategies.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`strategies.json HTTP ${r.status}`))))
      .then((raw: any) => {
        const registry: StrategyRegistry = {};
        for (const spec of raw?.strategies ?? []) {
          try {
            const s = defineStrategy(spec) as Record<string, unknown>;
            registry[s.name as string] = s;
          } catch (e) {
            console.warn('[strategies] dropped invalid spec:', (e as Error)?.message ?? e);
          }
        }
        return registry;
      })
      .catch((e) => {
        console.warn('[strategies] load failed — built-ins only:', (e as Error)?.message ?? e);
        return {};
      });
  }
  return cache;
}

/** Built-ins + custom registry entries, picker-ready. */
export function strategyList(registry: StrategyRegistry | null): StrategyMeta[] {
  const customs = Object.values(registry ?? {}).map((s: any) => ({
    name: String(s.name),
    label: String(s.label ?? s.name),
    blurb: String(s.blurb ?? 'Custom strategy (strategies.json).'),
    custom: true,
  }));
  return [...BUILTIN_META, ...customs];
}

/** Boot guard: a persisted strategy name that no longer resolves must be
    reverted VISIBLY at boot — never left to throw mid-draft. Returns the
    safe name (the input when valid, 'balanced' otherwise). */
export function safeStrategyName(name: string | undefined | null, registry: StrategyRegistry | null): string {
  const n = name ?? 'balanced';
  try {
    resolveStrategy(n, registry);
    return n;
  } catch {
    console.warn(`[strategies] persisted strategy "${n}" not found — reverting to balanced`);
    return 'balanced';
  }
}

/** Test hook. */
export function _resetStrategiesCache(): void {
  cache = null;
}

export { STRATEGIES };
