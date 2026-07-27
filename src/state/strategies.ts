// strategies.ts — loader for the custom-strategy registry:
// public/data/strategies.json (file, build-time) MERGED with LOCAL specs the
// in-app editor keeps in localStorage (dp:strategies-local:v1). Fetched ONCE
// per session and cached; invalid specs are dropped with a console warning,
// never fatal; a missing file is an empty registry; on a name collision the
// LOCAL spec wins (with a warning) — the editor is the more recent intent.
// The registry feeds recommend() via opts.strategies, the Setup/Strategy
// pickers, the Sim Lab sweep and the opponent archetype mix. After an editor
// save call invalidateStrategies() so the next loadStrategies() re-merges.
// Erasable TS; fetch and storage are injectable for tests.

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

// ---------------------------------------------------------------------------
// Local custom strategies (in-app editor storage — raw specs, NOT defined)
// ---------------------------------------------------------------------------

export const LOCAL_STRATEGIES_KEY = 'dp:strategies-local:v1';

export interface StrategiesStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StrategiesStorageLike | null {
  try {
    const s = (globalThis as any).localStorage;
    return s && typeof s.getItem === 'function' ? (s as StrategiesStorageLike) : null;
  } catch {
    return null;
  }
}

/** Raw spec array from localStorage — corrupt/absent data is an empty list,
    never a throw. Specs are NOT validated here (the editor keeps whatever was
    saved); loadStrategies() drops invalid ones at merge time with a warning. */
export function loadLocalStrategies(
  storage: StrategiesStorageLike | null = defaultStorage(),
): object[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOCAL_STRATEGIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.strategies) ? parsed.strategies : [];
    return list.filter((x: unknown) => x !== null && typeof x === 'object' && !Array.isArray(x));
  } catch {
    return [];
  }
}

/** SYNCHRONOUS write (the prefs.ts convention — never debounced). */
export function saveLocalStrategies(
  specs: object[],
  storage: StrategiesStorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LOCAL_STRATEGIES_KEY, JSON.stringify(specs));
  } catch {
    /* quota/private mode — the editor still works in-memory this session */
  }
}

let cache: Promise<StrategyRegistry> | null = null;

export function loadStrategies(
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u),
  baseUrl: string = (import.meta as any).env?.BASE_URL ?? '/',
  storage: StrategiesStorageLike | null = defaultStorage(),
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
        return {} as StrategyRegistry;
      })
      .then((registry: StrategyRegistry) => {
        // Merge LOCAL editor specs over the file registry: local wins on a
        // name collision (warned), invalid local specs are dropped (warned).
        for (const spec of loadLocalStrategies(storage)) {
          try {
            const s = defineStrategy(spec) as Record<string, unknown>;
            const name = s.name as string;
            if (registry[name]) {
              console.warn(`[strategies] local spec "${name}" overrides strategies.json`);
            }
            registry[name] = s;
          } catch (e) {
            console.warn('[strategies] dropped invalid LOCAL spec:', (e as Error)?.message ?? e);
          }
        }
        return registry;
      });
  }
  return cache;
}

/** Invalidate the session cache — call after an editor save so the NEXT
    loadStrategies() re-merges file + local. Components that already loaded
    the registry keep their copy until they re-mount (stated in the editor
    UI); nothing re-resolves mid-draft. */
export function invalidateStrategies(): void {
  cache = null;
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

/** Test hook (alias of invalidateStrategies, kept for existing callers). */
export function _resetStrategiesCache(): void {
  invalidateStrategies();
}

export { STRATEGIES };
