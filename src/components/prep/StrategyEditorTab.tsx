// StrategyEditorTab.tsx — 'Strategies+': author CUSTOM strategies on-device.
// Specs live in localStorage (dp:strategies-local:v1, src/state/strategies.ts)
// and merge over public/data/strategies.json at loadStrategies() time (local
// wins on a name collision). The editor is pure data entry — multipliers +
// constraints + overrideDelta only, validated LIVE by engine/strategy.js
// validateStrategy (the structural no-additive-terms guard); Save is disabled
// while any error stands. No modal — the form is an inline expanding section;
// delete is a 3s HoldButton; all inputs ≥17px, controls ≥56px (iPad rules).

import { useMemo, useState } from 'preact/hooks';
import { validateStrategy } from '../../../engine/strategy.js';
import {
  invalidateStrategies,
  loadLocalStrategies,
  saveLocalStrategies,
} from '../../state/strategies';
import HoldButton from '../live/HoldButton';
import type { PrepCtx } from './PrepScreen';

const POS = ['QB', 'RB', 'WR', 'TE'];

interface MultRow {
  pos: string;
  from: number;
  to: number;
  m: number;
}

interface ConRow {
  pos: string;
  type: 'min' | 'max';
  round: number; // max → through, min → by
  count: number; // max → limit,  min → need
}

interface Form {
  name: string;
  label: string;
  blurb: string;
  mults: MultRow[];
  cons: ConRow[];
  isNew: boolean;
  /** No form control (default 20) — preserved through the edit round-trip. */
  overrideDelta?: number;
}

function emptyForm(): Form {
  return { name: '', label: '', blurb: '', mults: [], cons: [], isNew: true };
}

/** Raw stored spec → form rows (defensive — the spec may be hand-mangled). */
function specToForm(spec: any): Form {
  const mults: MultRow[] = [];
  for (const [pos, rules] of Object.entries((spec?.multipliers ?? {}) as Record<string, any[]>)) {
    for (const r of Array.isArray(rules) ? rules : []) {
      mults.push({ pos, from: Number(r?.from) || 1, to: Number(r?.to) || 1, m: Number(r?.m) || 1 });
    }
  }
  const cons: ConRow[] = [];
  for (const c of Array.isArray(spec?.constraints) ? spec.constraints : []) {
    if (c?.type === 'max') cons.push({ pos: String(c.pos), type: 'max', round: Number(c.through) || 1, count: Number(c.limit) || 0 });
    else cons.push({ pos: String(c?.pos ?? 'RB'), type: 'min', round: Number(c?.by) || 1, count: Number(c?.need) || 1 });
  }
  return {
    name: String(spec?.name ?? ''),
    label: String(spec?.label ?? ''),
    blurb: String(spec?.blurb ?? ''),
    mults,
    cons,
    isNew: false,
    ...(typeof spec?.overrideDelta === 'number' ? { overrideDelta: spec.overrideDelta } : {}),
  };
}

/** Form rows → the spec shape validateStrategy/defineStrategy consume. */
function formToSpec(f: Form): Record<string, unknown> {
  const multipliers: Record<string, Array<{ from: number; to: number; m: number }>> = {};
  for (const r of f.mults) {
    (multipliers[r.pos] = multipliers[r.pos] ?? []).push({ from: r.from, to: r.to, m: r.m });
  }
  const constraints = f.cons.map((c) =>
    c.type === 'max'
      ? { pos: c.pos, type: 'max', through: c.round, limit: c.count }
      : { pos: c.pos, type: 'min', by: c.round, need: c.count },
  );
  const spec: Record<string, unknown> = { name: f.name.trim(), multipliers, constraints };
  if (f.label.trim()) spec.label = f.label.trim();
  if (f.blurb.trim()) spec.blurb = f.blurb.trim();
  if (typeof f.overrideDelta === 'number') spec.overrideDelta = f.overrideDelta;
  return spec;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** −/+ stepper — two 56px buttons around a read-only value. */
function Stepper({
  label,
  value,
  min,
  max,
  step,
  digits = 0,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits?: number;
  onChange: (v: number) => void;
}) {
  const set = (v: number) => onChange(r2(Math.min(max, Math.max(min, v))));
  return (
    <div class="flex items-center gap-1">
      <span class="w-12 shrink-0 text-right text-xs text-app-dim">{label}</span>
      <button
        type="button"
        class="num min-h-14 min-w-14 rounded-lg border border-app-border bg-app-bg text-[17px] font-bold"
        onClick={() => set(value - step)}
      >
        −
      </button>
      <span class="num w-12 shrink-0 text-center text-[17px] font-bold">{value.toFixed(digits)}</span>
      <button
        type="button"
        class="num min-h-14 min-w-14 rounded-lg border border-app-border bg-app-bg text-[17px] font-bold"
        onClick={() => set(value + step)}
      >
        +
      </button>
    </div>
  );
}

function PosSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      class="h-14 rounded-lg border border-app-border bg-app-bg px-2 text-[17px] font-bold"
      value={value}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
    >
      {POS.map((p) => (
        <option value={p}>{p}</option>
      ))}
    </select>
  );
}

export default function StrategyEditorTab({ ctx }: { ctx: PrepCtx }) {
  const { s } = ctx;
  const rounds = s.league.rounds;
  const [specs, setSpecs] = useState<any[]>(() => loadLocalStrategies());
  const [form, setForm] = useState<Form | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const upd = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const errors = useMemo(() => {
    if (!form) return [];
    const errs = validateStrategy(formToSpec(form), { rounds }) as string[];
    // A NEW spec must not silently shadow another local spec — editing an
    // existing one keeps its own name (the input is locked then).
    if (form.isNew && specs.some((sp) => sp?.name === form.name.trim())) {
      errs.push(`a local strategy named "${form.name.trim()}" already exists — edit it instead`);
    }
    return errs;
  }, [form, specs, rounds]);

  const persist = (next: any[]) => {
    saveLocalStrategies(next);
    invalidateStrategies();
    setSpecs(next);
  };

  const save = () => {
    if (!form || errors.length > 0) return;
    const spec = formToSpec(form);
    const name = spec.name as string;
    const next = specs.some((sp) => sp?.name === name)
      ? specs.map((sp) => (sp?.name === name ? spec : sp))
      : [...specs, spec];
    persist(next);
    setForm(null);
    setSavedNote(`Saved "${name}".`);
  };

  const remove = (name: string) => {
    persist(specs.filter((sp) => sp?.name !== name));
    if (form && !form.isNew && form.name === name) setForm(null);
    setSavedNote(`Deleted "${name}".`);
  };

  const multText = (spec: any): string => {
    const parts: string[] = [];
    for (const [pos, rules] of Object.entries((spec?.multipliers ?? {}) as Record<string, any[]>)) {
      for (const r of Array.isArray(rules) ? rules : []) {
        parts.push(`${pos} R${r?.from}–${r?.to} ×${r?.m}`);
      }
    }
    return parts.join(' · ');
  };
  const conText = (spec: any): string =>
    (Array.isArray(spec?.constraints) ? spec.constraints : [])
      .map((c: any) => (c?.type === 'max' ? `≤${c.limit} ${c.pos} through R${c.through}` : `≥${c?.need} ${c?.pos} by R${c?.by}`))
      .join(' · ');

  return (
    <div class="mx-auto max-w-2xl px-3 pb-16">
      <p class="py-2 text-sm text-app-dim">
        Custom strategies stored on THIS device (they merge over strategies.json — local wins on a
        name clash). Multipliers tilt the score by round; constraints are hard min/max counts. The
        no-bonus-points whitelist is enforced live below. Saved strategies appear in the Strategy
        tab, Setup picker and Sim Lab sweeps <b class="text-app-text">the next time those screens
        load</b> — recommendations re-read the registry at app launch, not mid-draft.
      </p>
      {savedNote && <p class="pb-2 text-sm font-semibold">{savedNote}</p>}

      {/* Local list */}
      {specs.length === 0 && !form && (
        <p class="py-2 text-sm text-app-dim">No local strategies yet.</p>
      )}
      <div class="flex flex-col gap-2">
        {specs.map((sp) => (
          <section class="rounded-xl border border-app-border bg-app-surface p-3">
            <div class="flex items-center gap-2">
              <div class="min-w-0 flex-1">
                <h3 class="truncate text-[17px] font-bold">
                  {String(sp?.label ?? sp?.name ?? '?')}{' '}
                  <span class="num text-xs font-normal text-app-dim">{String(sp?.name ?? '')}</span>
                </h3>
                {sp?.blurb ? <p class="truncate text-sm text-app-dim">{String(sp.blurb)}</p> : null}
              </div>
              <button
                type="button"
                class="min-h-14 shrink-0 rounded-lg border border-app-border bg-app-bg px-4 font-bold"
                onClick={() => {
                  setSavedNote(null);
                  setForm(specToForm(sp));
                }}
              >
                Edit
              </button>
            </div>
            <p class="num pt-1 text-xs text-app-dim">
              {[multText(sp), conText(sp)].filter(Boolean).join('  ·  ') || 'no multipliers, no constraints'}
            </p>
            <HoldButton
              ms={3000}
              onHold={() => remove(String(sp?.name ?? ''))}
              class="mt-2 min-h-14 w-full rounded-lg border border-app-border bg-app-bg text-sm font-bold text-app-dim"
            >
              Hold 3s to delete "{String(sp?.name ?? '')}"
            </HoldButton>
          </section>
        ))}
      </div>

      {/* Inline expanding editor — never a modal */}
      {!form && (
        <button
          type="button"
          class="mt-3 min-h-14 w-full rounded-xl bg-accent font-bold text-app-bg"
          onClick={() => {
            setSavedNote(null);
            setForm(emptyForm());
          }}
        >
          + New strategy
        </button>
      )}

      {form && (
        <section class="mt-3 rounded-xl border border-accent bg-app-surface p-3">
          <h3 class="text-[17px] font-bold">{form.isNew ? 'New strategy' : `Editing "${form.name}"`}</h3>

          <label class="mt-2 block">
            <span class="text-xs text-app-dim">
              name (a–z, 0–9, _ — locked after creation; used by pickers and archetype mixes)
            </span>
            <input
              type="text"
              value={form.name}
              disabled={!form.isNew}
              autocapitalize="off"
              autocorrect="off"
              placeholder="my_strategy"
              class="mt-1 h-14 w-full rounded-lg border border-app-border bg-app-bg px-3 text-[17px] disabled:opacity-50"
              onInput={(e) => upd({ name: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="mt-2 block">
            <span class="text-xs text-app-dim">label (shown in pickers)</span>
            <input
              type="text"
              value={form.label}
              placeholder="My Strategy"
              class="mt-1 h-14 w-full rounded-lg border border-app-border bg-app-bg px-3 text-[17px]"
              onInput={(e) => upd({ label: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="mt-2 block">
            <span class="text-xs text-app-dim">blurb (one line)</span>
            <input
              type="text"
              value={form.blurb}
              placeholder="What this strategy does."
              class="mt-1 h-14 w-full rounded-lg border border-app-border bg-app-bg px-3 text-[17px]"
              onInput={(e) => upd({ blurb: (e.target as HTMLInputElement).value })}
            />
          </label>

          {/* Multiplier rows */}
          <h4 class="pt-3 text-xs font-bold tracking-widest text-app-dim">
            MULTIPLIERS — score ×m for POS in rounds from…to
          </h4>
          {form.mults.map((row, i) => {
            const set = (patch: Partial<MultRow>) =>
              upd({ mults: form.mults.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
            return (
              <div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-app-border p-2">
                <PosSelect value={row.pos} onChange={(pos) => set({ pos })} />
                <Stepper label="from" value={row.from} min={1} max={rounds} step={1} onChange={(from) => set({ from })} />
                <Stepper label="to" value={row.to} min={1} max={rounds} step={1} onChange={(to) => set({ to })} />
                <Stepper label="×m" value={row.m} min={0.25} max={2.5} step={0.05} digits={2} onChange={(m) => set({ m })} />
                <button
                  type="button"
                  class="min-h-14 min-w-14 rounded-lg border border-app-border bg-app-bg font-bold"
                  onClick={() => upd({ mults: form.mults.filter((_, k) => k !== i) })}
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            type="button"
            class="mt-2 min-h-14 w-full rounded-lg border border-app-border bg-app-bg font-bold"
            onClick={() => upd({ mults: [...form.mults, { pos: 'RB', from: 1, to: 3, m: 1.1 }] })}
          >
            + multiplier row
          </button>

          {/* Constraint rows */}
          <h4 class="pt-3 text-xs font-bold tracking-widest text-app-dim">
            CONSTRAINTS — max: ≤count through round · min: ≥count by round
          </h4>
          {form.cons.map((row, i) => {
            const set = (patch: Partial<ConRow>) =>
              upd({ cons: form.cons.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
            return (
              <div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-app-border p-2">
                <PosSelect value={row.pos} onChange={(pos) => set({ pos })} />
                <select
                  class="h-14 rounded-lg border border-app-border bg-app-bg px-2 text-[17px] font-bold"
                  value={row.type}
                  onChange={(e) => set({ type: (e.target as HTMLSelectElement).value as 'min' | 'max' })}
                >
                  <option value="min">min (≥ by)</option>
                  <option value="max">max (≤ through)</option>
                </select>
                <Stepper
                  label={row.type === 'max' ? 'thru' : 'by'}
                  value={row.round}
                  min={1}
                  max={rounds}
                  step={1}
                  onChange={(round) => set({ round })}
                />
                <Stepper
                  label={row.type === 'max' ? 'limit' : 'need'}
                  value={row.count}
                  min={row.type === 'max' ? 0 : 1}
                  max={rounds}
                  step={1}
                  onChange={(count) => set({ count })}
                />
                <button
                  type="button"
                  class="min-h-14 min-w-14 rounded-lg border border-app-border bg-app-bg font-bold"
                  onClick={() => upd({ cons: form.cons.filter((_, k) => k !== i) })}
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            type="button"
            class="mt-2 min-h-14 w-full rounded-lg border border-app-border bg-app-bg font-bold"
            onClick={() => upd({ cons: [...form.cons, { pos: 'RB', type: 'min', round: 3, count: 2 }] })}
          >
            + constraint row
          </button>

          {/* Live validation */}
          {errors.length > 0 && (
            <div class="mt-3 rounded-lg border border-app-border bg-app-bg p-3">
              {errors.map((e) => (
                <p class="text-sm font-semibold">✕ {e}</p>
              ))}
            </div>
          )}

          <div class="mt-3 flex gap-2">
            <button
              type="button"
              class="min-h-14 flex-1 rounded-xl bg-accent font-bold text-app-bg disabled:opacity-40"
              disabled={errors.length > 0}
              onClick={save}
            >
              Save
            </button>
            <button
              type="button"
              class="min-h-14 flex-1 rounded-xl border border-app-border bg-app-bg font-bold"
              onClick={() => setForm(null)}
            >
              Discard edits
            </button>
          </div>
          <p class="pt-2 text-xs text-app-dim">
            Saving updates the registry for the next screen load (Strategy tab, Setup, Sim Lab,
            rehearsal rooms). A draft already in progress keeps its loaded registry until relaunch.
          </p>
        </section>
      )}
    </div>
  );
}
