// LeaguePanel.tsx — #/league on the SEASON page: connect the Sleeper league
// (one-tap from the active profile's sleeperLeagueId, or a manual id),
// on-demand Refresh through the app-wide leagueSyncManager, "which team is
// me" picker (SET_MY_ROSTER), the standings strip (wins, then fpts) and the
// transactions feed with player ids resolved through the merged board+season
// universe. Disconnect is a plain button — fully reversible, one tap back.

import { useState } from 'preact/hooks';
import { leagueSyncManager } from '../../sync/league';
import type { TxEntry } from '../../state/season';
import { agoLabel, fmt1, teamLabel, useLeagueSyncInfo } from './seasonShared';
import type { SeasonScreenProps } from './seasonShared';

export default function LeaguePanel({ ss, store, merged, profile }: SeasonScreenProps) {
  const info = useLeagueSyncInfo();
  const [manualId, setManualId] = useState('');

  const connect = (id: string) => {
    const clean = id.trim();
    if (!clean) return;
    store.dispatch({ type: 'SET_LEAGUE_ID', leagueId: clean });
    leagueSyncManager.start(store, clean); // first snapshot fires immediately
  };
  const disconnect = () => {
    leagueSyncManager.stop();
    store.dispatch({ type: 'SET_LEAGUE_ID', leagueId: null });
  };

  const standings = [...ss.rosters].sort(
    (x, y) => y.wins - x.wins || y.fpts - x.fpts,
  );
  const txName = (id: string) => merged.resolve(id)?.short ?? id;
  const record = (r: { wins: number; losses: number; ties: number }) =>
    `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`;

  const renderTx = (t: TxEntry) => {
    const adds = Object.entries(t.adds ?? {});
    const drops = Object.entries(t.drops ?? {});
    return (
      <li key={t.id} class="border-b border-app-border px-3 py-2 last:border-b-0">
        <div class="text-[11px] uppercase tracking-wide text-app-dim">
          {t.type} · W{t.week} · {t.status}
        </div>
        {adds.length > 0 && (
          <div class="text-sm">
            {adds.map(([pid, rid]) => (
              <span key={pid} class="mr-3">
                <span class="lv-good font-bold">＋</span> {txName(pid)}
                <span class="text-app-dim"> → {teamLabel(ss, rid as number)}</span>
              </span>
            ))}
          </div>
        )}
        {drops.length > 0 && (
          <div class="text-sm text-app-dim">
            {drops.map(([pid, rid]) => (
              <span key={pid} class="mr-3">
                − {txName(pid)} ({teamLabel(ss, rid as number)})
              </span>
            ))}
          </div>
        )}
      </li>
    );
  };

  return (
    <main class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6">
      <h1 class="text-2xl font-bold">League</h1>

      {/* ── Connect / status ─────────────────────────────────────────────── */}
      <section class="flex flex-col gap-3">
        <h2 class="lv-h-tool lv-tool-season text-sm font-semibold uppercase tracking-wide">Sleeper sync</h2>
        {ss.leagueId === null ? (
          <>
            {profile.sleeperLeagueId && (
              <button
                type="button"
                class="min-h-14 rounded-xl border border-accent px-4 font-bold"
                onClick={() => connect(profile.sleeperLeagueId!)}
              >
                Use “{profile.name}”'s league ({profile.sleeperLeagueId})
              </button>
            )}
            <div class="flex gap-2">
              <input
                class="min-h-14 min-w-0 flex-1 rounded-xl border border-app-border bg-app-surface px-4 text-[17px]"
                placeholder="Sleeper league id"
                autocomplete="off"
                value={manualId}
                onInput={(e: any) => setManualId(e.currentTarget.value)}
                onKeyDown={(e: any) => {
                  if (e.key === 'Enter') connect(manualId);
                }}
              />
              <button
                type="button"
                class="min-h-14 shrink-0 rounded-xl border border-accent px-5 font-bold"
                onClick={() => connect(manualId)}
                disabled={manualId.trim() === ''}
              >
                Connect
              </button>
            </div>
            <p class="text-sm text-app-dim">
              No league id at hand? Connect your Sleeper account on the draft app's Hub —
              the profile then carries the league id here.
            </p>
          </>
        ) : (
          <>
            <div class="flex flex-wrap gap-2">
              <span class="flex min-h-14 items-center rounded-xl border border-accent bg-accent/15 px-5 font-bold">
                {ss.leagueName ?? `League ${ss.leagueId}`}
              </span>
              <button
                type="button"
                class="min-h-14 rounded-xl border border-app-border bg-app-surface px-5 font-bold"
                onClick={() => void leagueSyncManager.refresh()}
                disabled={info.status === 'syncing'}
              >
                {info.status === 'syncing' ? 'Refreshing…' : 'Refresh'}
              </button>
              <button
                type="button"
                class="min-h-14 rounded-xl border border-app-border px-4 text-app-dim"
                onClick={disconnect}
              >
                Disconnect
              </button>
            </div>
            <p class="num text-sm text-app-dim">
              {info.status} · last sync {agoLabel(info.lastSyncAt)} · {info.syncs} sync
              {info.syncs === 1 ? '' : 's'} this session
            </p>
            {info.error && (
              <p class="lv-clock-near rounded px-3 py-2 text-sm font-bold">⚠ {info.error}</p>
            )}
          </>
        )}
      </section>

      {/* ── Which team is me ─────────────────────────────────────────────── */}
      <section class="flex flex-col gap-2">
        <h2 class="lv-h-tool lv-tool-season text-sm font-semibold uppercase tracking-wide">
          Which team is me
        </h2>
        {ss.rosters.length === 0 ? (
          <p class="text-sm text-app-dim">Sync once to list the league's teams.</p>
        ) : (
          <ul class="flex flex-col gap-2">
            {ss.rosters.map((r) => {
              const me = ss.myRosterId === r.rosterId;
              return (
                <li key={r.rosterId}>
                  <button
                    type="button"
                    class={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-4 text-left font-bold ${
                      me ? 'border-accent bg-accent/15' : 'border-app-border bg-app-surface'
                    }`}
                    onClick={() =>
                      store.dispatch({ type: 'SET_MY_ROSTER', rosterId: me ? null : r.rosterId })
                    }
                  >
                    <span class="min-w-0 flex-1 truncate">{teamLabel(ss, r.rosterId)}</span>
                    <span class="num shrink-0 text-sm text-app-dim">{record(r)}</span>
                    {me && <span class="shrink-0 text-accent">✓ me</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Standings ────────────────────────────────────────────────────── */}
      {standings.length > 0 && (
        <section class="flex flex-col gap-2">
          <h2 class="lv-h-tool lv-tool-season text-sm font-semibold uppercase tracking-wide">Standings</h2>
          <ol class="rounded-xl border border-app-border bg-app-surface">
            {standings.map((r, i) => (
              <li
                key={r.rosterId}
                class={`flex min-h-[52px] items-center gap-3 border-b border-app-border px-3 last:border-b-0 ${
                  r.rosterId === ss.myRosterId ? 'lv-grid-me' : ''
                }`}
              >
                <span class="num w-6 shrink-0 text-right text-app-dim">{i + 1}</span>
                <span class="min-w-0 flex-1 truncate font-bold">
                  {teamLabel(ss, r.rosterId)}
                </span>
                <span class="num shrink-0 font-bold">{record(r)}</span>
                <span class="num w-16 shrink-0 text-right text-sm text-app-dim">
                  {fmt1(r.fpts)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ── Transactions ─────────────────────────────────────────────────── */}
      <section class="flex flex-col gap-2">
        <h2 class="lv-h-tool lv-tool-season text-sm font-semibold uppercase tracking-wide">Transactions</h2>
        {ss.transactions.length === 0 ? (
          <p class="text-sm text-app-dim">No transactions synced yet.</p>
        ) : (
          <ul class="rounded-xl border border-app-border bg-app-surface">
            {ss.transactions.map(renderTx)}
          </ul>
        )}
      </section>
    </main>
  );
}
