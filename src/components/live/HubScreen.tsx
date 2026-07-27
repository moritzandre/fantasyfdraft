// HubScreen.tsx — #/hub, the app's front door. League-profile switcher +
// real/practice mode toggle + tool cards. The hub is where the app stops
// being one league's draft tool: every tool below operates on the ACTIVE
// profile's context (see src/state/profiles.ts ctxFor), and practice mode
// swaps in an isolated namespace so mock drafting can never touch real
// draft prep. No modals, no confirms — destructive actions hold for 3s.

import { useState } from 'preact/hooks';
import type { DraftState } from '../../state/store';
import type { LeagueProfile, ProfilesState } from '../../state/profiles';
import {
  DEFAULT_PROFILE_ID,
  makeDefaultProfile,
  newProfileId,
  removeProfile,
  setActiveProfile,
  upsertProfile,
  ctxFor,
} from '../../state/profiles';
import { clearPersisted } from '../../state/persist';
import type { AppMode } from '../../state/mode';
import HoldButton from './HoldButton';

interface Props {
  s: DraftState;
  profiles: ProfilesState;
  mode: AppMode;
  onProfiles(next: ProfilesState): void;
  onMode(next: AppMode): void;
}

const TOOLS: Array<[string, string, string]> = [
  ['#/ready', 'Ready Check', 'board hash · SW · storage · wake lock'],
  ['#/live', 'Draft Day', 'the pick-clock cockpit'],
  ['#/prep', 'Prep', 'tiers · tags · overrides · strategy · rehearsal'],
  ['#/league', 'League', 'all 12 rosters · live draft grid'],
  ['#/log', 'Pick Log', 'review · edit · catch-up'],
  ['#/sync', 'Sleeper Sync', 'live draft + mock lobbies'],
  ['#/planb', 'Plan B', 'the printed board, on screen'],
];

export default function HubScreen({ s, profiles, mode, onProfiles, onMode }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const active = profiles.profiles.find((p) => p.id === profiles.activeId)
    ?? profiles.profiles[0];

  const addLeague = () => {
    const name = newName.trim();
    if (!name) return;
    const id = newProfileId(name, profiles.profiles);
    const profile: LeagueProfile = { ...makeDefaultProfile({}), id, name };
    onProfiles(setActiveProfile(upsertProfile(profiles, profile), id));
    setNewName('');
    setAdding(false);
  };

  const removeActive = () => {
    // Wipe both of this profile's draft contexts, then drop the profile.
    clearPersisted(undefined, ctxFor(active.id, false));
    clearPersisted(undefined, ctxFor(active.id, true));
    onProfiles(removeProfile(profiles, active.id));
  };

  return (
    <main class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 pb-24">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-bold">DraftPrep</h1>
        {mode === 'practice' && (
          <span class="lv-clock-near rounded-full px-4 py-2 text-[15px] font-bold">PRACTICE</span>
        )}
      </header>

      {/* League switcher */}
      <section class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-app-dim">League</h2>
        <div class="flex flex-wrap gap-2">
          {profiles.profiles.map((p) => (
            <button
              key={p.id}
              class={`min-h-14 rounded-xl border px-5 font-bold ${
                p.id === profiles.activeId
                  ? 'border-app-accent bg-app-accent/15'
                  : 'border-app-border bg-app-surface'
              }`}
              onClick={() => onProfiles(setActiveProfile(profiles, p.id))}
            >
              {p.name}
            </button>
          ))}
          {!adding ? (
            <button
              class="min-h-14 rounded-xl border border-dashed border-app-border px-5 font-bold text-app-dim"
              onClick={() => setAdding(true)}
            >
              + Add league
            </button>
          ) : (
            <div class="flex w-full gap-2">
              <input
                class="min-h-14 flex-1 rounded-xl border border-app-border bg-app-surface px-4 text-[17px]"
                placeholder="League name"
                value={newName}
                onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addLeague(); }}
              />
              <button class="min-h-14 rounded-xl border border-app-accent px-5 font-bold" onClick={addLeague}>
                Add
              </button>
              <button
                class="min-h-14 rounded-xl border border-app-border px-4 text-app-dim"
                onClick={() => { setAdding(false); setNewName(''); }}
              >
                ✕
              </button>
            </div>
          )}
        </div>
        <p class="text-sm text-app-dim">
          {s.picks.length > 0
            ? `${s.picks.length} pick${s.picks.length === 1 ? '' : 's'} recorded in this ${mode === 'practice' ? 'practice' : 'draft'} session.`
            : `No picks recorded yet in this ${mode === 'practice' ? 'practice' : 'draft'} session.`}{' '}
          Set teams, slot and strategy per league in <a href="#/setup" class="underline">Setup</a>.
        </p>
      </section>

      {/* Mode toggle */}
      <section class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-app-dim">Mode</h2>
        <div class="grid grid-cols-2 gap-2">
          <button
            class={`min-h-14 rounded-xl border font-bold ${
              mode === 'real' ? 'border-app-accent bg-app-accent/15' : 'border-app-border bg-app-surface'
            }`}
            onClick={() => onMode('real')}
          >
            REAL draft
          </button>
          <button
            class={`min-h-14 rounded-xl border font-bold ${
              mode === 'practice' ? 'lv-clock-near border-transparent' : 'border-app-border bg-app-surface'
            }`}
            onClick={() => onMode('practice')}
          >
            PRACTICE (mock)
          </button>
        </div>
        <p class="text-sm text-app-dim">
          Practice keeps a fully separate draft state — mock away, your real prep is untouchable.
          Switching back is instant and loses nothing.
        </p>
      </section>

      {/* Tools */}
      <section class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-app-dim">Tools</h2>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TOOLS.map(([href, title, blurb]) => (
            <a
              key={href}
              href={href}
              class="flex min-h-14 flex-col justify-center rounded-xl border border-app-border bg-app-surface px-4 py-3"
            >
              <span class="font-bold">{title}</span>
              <span class="text-sm text-app-dim">{blurb}</span>
            </a>
          ))}
        </div>
      </section>

      {active.id !== DEFAULT_PROFILE_ID && (
        <section class="mt-4">
          <HoldButton
            ms={3000}
            onHold={removeActive}
            class="min-h-14 w-full rounded-xl border border-app-border px-4 font-bold text-app-dim"
          >
            Hold to remove “{active.name}” (wipes its draft states)
          </HoldButton>
        </section>
      )}
    </main>
  );
}
