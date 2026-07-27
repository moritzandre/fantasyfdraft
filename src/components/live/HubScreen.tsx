// HubScreen.tsx — #/hub, the app's front door. Sleeper ACCOUNT (username →
// real leagues → one-tap League Connect) + league-profile switcher +
// real/practice mode toggle + tool cards. The hub is where the app stops
// being one league's draft tool: every tool below operates on the ACTIVE
// profile's context (see src/state/profiles.ts ctxFor), and practice mode
// swaps in an isolated namespace so mock drafting can never touch real
// draft prep. Connecting a Sleeper league maps its settings onto a profile
// automatically (src/state/account.ts mapLeagueToProfile) — no IDs to copy.
// No modals, no confirms — destructive actions hold for 3s; disconnecting
// the account is a plain button because it is fully reversible.

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
import {
  connectAccount,
  fetchMyLeagues,
  findProfileBySleeperLeagueId,
  loadAccount,
  mapLeagueToProfile,
  saveAccount,
} from '../../state/account';
import type { SleeperAccount, SleeperLeague } from '../../state/account';
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

// [href, title, blurb, lv-tool-* hue class] — the 4th entry only colors the card.
const TOOLS: Array<[string, string, string, string]> = [
  ['#/guide', 'Guide', 'how everything works — start here', 'lv-tool-guide'],
  ['#/ready', 'Ready Check', 'board hash · SW · storage · wake lock', 'lv-tool-draft'],
  ['#/live', 'Draft Day', 'the pick-clock cockpit', 'lv-tool-draft'],
  // The Season page is a separate PAGE, not a hash route — full href on purpose.
  // NO trailing slash: with Astro trailingSlash 'ignore' the SW precaches the
  // page under the key 'season', and only the slash-less URL hits it offline.
  [import.meta.env.BASE_URL + 'season', 'Season', 'lineup coach · waivers · Trade Desk', 'lv-tool-season'],
  // Season deep links — same slash-less base + '#/…' hash convention as the
  // Season card above, so the SW's 'season' precache key still matches offline.
  [import.meta.env.BASE_URL + 'season#/coach', 'Lineup Coach', 'weekly start/sit with reasons', 'lv-tool-season'],
  [import.meta.env.BASE_URL + 'season#/waivers', 'Waivers', 'pickup targets ranked by roster need', 'lv-tool-season'],
  [import.meta.env.BASE_URL + 'season#/trade', 'Trade Desk', 'sandbox trade evaluator — works with zero sync', 'lv-tool-season'],
  ['#/prep', 'Prep', 'tiers · tags · overrides · strategy · rehearsal', 'lv-tool-draft'],
  ['#/sim', 'Sim Lab', 'strategy sweeps + mock calibration, in-app', 'lv-tool-sim'],
  ['#/league', 'League', 'all 12 rosters · live draft grid', 'lv-tool-league'],
  ['#/log', 'Pick Log', 'review · edit · catch-up', 'lv-tool-draft'],
  ['#/sync', 'Sleeper Sync', 'live draft + mock lobbies', 'lv-tool-sync'],
  ['#/planb', 'Plan B', 'tiers & strategy lists, live-struck', 'lv-tool-draft'],
];

export default function HubScreen({ s, profiles, mode, onProfiles, onMode }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const active = profiles.profiles.find((p) => p.id === profiles.activeId)
    ?? profiles.profiles[0];

  // ── Sleeper account ──────────────────────────────────────────────────────
  const [account, setAccount] = useState<SleeperAccount | null>(() => loadAccount());
  const [username, setUsername] = useState('');
  const [leagues, setLeagues] = useState<SleeperLeague[] | null>(null);
  const [accNote, setAccNote] = useState<string | null>(null);
  const [accBusy, setAccBusy] = useState(false);

  const refreshLeagues = async (acc: SleeperAccount) => {
    const season = String(new Date().getFullYear());
    setAccBusy(true);
    setAccNote(`Loading your ${season} leagues…`);
    try {
      const found = await fetchMyLeagues(acc.userId, season);
      setLeagues(found);
      setAccNote(
        found.length === 0
          ? `No ${season} NFL leagues on ${acc.displayName} yet.`
          : `${found.length} league${found.length === 1 ? '' : 's'} found — tap one to set it up here.`,
      );
    } catch (e) {
      setAccNote(`League lookup failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setAccBusy(false);
    }
  };

  const doConnect = async () => {
    const name = username.trim();
    if (!name || accBusy) return;
    setAccBusy(true);
    setAccNote('Connecting to Sleeper…');
    try {
      const acc = await connectAccount(name);
      saveAccount(acc);
      setAccount(acc);
      await refreshLeagues(acc); // clears busy in its finally
    } catch (e) {
      setAccNote(`Connect failed: ${String((e as Error)?.message ?? e)}`);
      setAccBusy(false);
    }
  };

  const disconnect = () => {
    // Plain button on purpose — fully reversible, the profiles it created stay.
    saveAccount(null);
    setAccount(null);
    setLeagues(null);
    setAccNote(null);
  };

  const connectLeague = (raw: SleeperLeague) => {
    const { profile, warnings } = mapLeagueToProfile(raw);
    const existing = findProfileBySleeperLeagueId(profiles.profiles, profile.sleeperLeagueId);
    const id = existing ? existing.id : newProfileId(profile.name, profiles.profiles);
    const next: LeagueProfile = { ...profile, id };
    onProfiles(setActiveProfile(upsertProfile(profiles, next), id));
    setAccNote(
      `${existing ? 'Updated' : 'Added'} “${profile.name}” from its Sleeper settings — it is now the active league.` +
        (warnings.length ? ` ⚠ ${warnings.join(' · ')}` : ''),
    );
  };

  // ── Manual league flow (kept — leagues outside Sleeper, or offline) ──────
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

      {/* Sleeper account + League Connect */}
      <section class="flex flex-col gap-3">
        <h2 class="lv-h-tool lv-tool-sync text-sm font-semibold uppercase tracking-wide">Account</h2>
        {!account ? (
          <>
            <p class="text-sm text-app-dim">
              Enter your Sleeper username once — your real leagues appear here and one tap sets
              each of them up. No IDs to copy around.
            </p>
            <div class="flex gap-2">
              <input
                class="min-h-14 min-w-0 flex-1 rounded-xl border border-app-border bg-app-surface px-4 text-[17px]"
                placeholder="Sleeper username"
                autocomplete="off"
                value={username}
                onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doConnect(); }}
              />
              <button
                class="min-h-14 shrink-0 rounded-xl border border-app-accent px-5 font-bold"
                onClick={doConnect}
                disabled={accBusy || username.trim() === ''}
              >
                Connect Sleeper
              </button>
            </div>
          </>
        ) : (
          <div class="flex flex-wrap gap-2">
            <span class="flex min-h-14 items-center rounded-xl border border-app-accent bg-app-accent/15 px-5 font-bold">
              Connected as {account.displayName}
            </span>
            <button
              class="min-h-14 rounded-xl border border-app-border bg-app-surface px-5 font-bold"
              onClick={() => refreshLeagues(account)}
              disabled={accBusy}
            >
              Refresh leagues
            </button>
            <button
              class="min-h-14 rounded-xl border border-app-border px-4 text-app-dim"
              onClick={disconnect}
            >
              Disconnect
            </button>
          </div>
        )}
        {account && leagues && leagues.length > 0 && (
          <ul class="flex flex-col gap-2">
            {leagues.map((l: any) => {
              const linked = findProfileBySleeperLeagueId(
                profiles.profiles,
                l.league_id != null ? String(l.league_id) : null,
              );
              return (
                <li key={String(l.league_id ?? l.name)}>
                  <div class="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface px-4 py-2">
                    <div class="min-w-0 flex-1">
                      <div class="truncate font-bold">{String(l.name ?? 'Unnamed league')}</div>
                      <div class="text-sm text-app-dim">
                        {l.total_rosters ?? '?'}-team · {String(l.status ?? '')}
                      </div>
                    </div>
                    <button
                      class={`min-h-14 shrink-0 rounded-xl border px-4 font-bold ${
                        linked ? 'border-app-accent bg-app-accent/15' : 'border-app-accent'
                      }`}
                      onClick={() => connectLeague(l)}
                    >
                      {linked ? 'Connected ✓' : 'Connect league'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {accNote && <p class="text-sm text-app-dim">{accNote}</p>}
      </section>

      {/* League switcher */}
      <section class="flex flex-col gap-3">
        <h2 class="lv-h-tool lv-tool-league text-sm font-semibold uppercase tracking-wide">League</h2>
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
        <h2 class="lv-h-tool lv-tool-hub text-sm font-semibold uppercase tracking-wide">Mode</h2>
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
        <h2 class="lv-h-tool lv-tool-hub text-sm font-semibold uppercase tracking-wide">Tools</h2>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TOOLS.map(([href, title, blurb, tool]) => (
            <a
              key={href}
              href={href}
              class={`lv-toolcard ${tool} flex min-h-14 flex-col justify-center rounded-xl border border-app-border bg-app-surface px-4 py-3`}
            >
              <span class="lv-h-tool font-bold">{title}</span>
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
