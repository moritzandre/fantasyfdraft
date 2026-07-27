// seasonMerge.ts — pure merge of the frozen draft board with the weekly
// season.json overlay (plan Phase A: "Season store" #2).
//
//   mergeSeason(board, season) → { resolve(sleeperId), all, degraded }
//
// Board players resolve via board.slimSleeperMap (sleeperId → idx); the
// season artifact overlays weekly/ros/injury/fc/trend by idx and contributes
// standalone `extras` rows (rostered or top-of-pool players outside the
// 395-player board, keyed by sleeper id).
//
// DEGRADED MODE: season null (not yet built / offline miss) OR
// season.boardHash !== board.buildHash (season built against another board)
// ⇒ degraded: true and a board-only fallback: weekly = weeklyHalfPpr,
// ros = Σ weekly, no extras. The UI shows the merged data either way and
// surfaces `degraded` as a banner — never a hard failure.
//
// PURE + erasable TS: no fetch, no storage, no clock; runs under node --test.

export interface ResolvedPlayer {
  key: string; // 'b<idx>' for board players | 's<sleeperId>' for extras
  idx: number | null; // board index, null for extras
  sleeper: string | null;
  name: string;
  short: string;
  pos: string;
  team: string;
  bye: number | null;
  weekly: number[]; // 18 entries, bye = 0
  ros: number;
  injury: string | null;
  fc: { value: number; rank: number } | null;
  trend: { add: number; drop: number } | null;
}

export interface MergedSeason {
  resolve(sleeperId: string): ResolvedPlayer | null;
  all: ResolvedPlayer[];
  degraded: boolean;
}

function sumWeekly(weekly: number[]): number {
  let sum = 0;
  for (const v of weekly) if (typeof v === 'number' && Number.isFinite(v)) sum += v;
  return Math.round(sum * 100) / 100;
}

/** Board injuryStatus ('ACTIVE'/'NORMAL' = healthy) → merged injury field. */
function boardInjury(status: unknown): string | null {
  return typeof status === 'string' && status !== 'ACTIVE' && status !== 'NORMAL'
    ? status
    : null;
}

function normFc(fc: any): { value: number; rank: number } | null {
  return fc && typeof fc.value === 'number'
    ? { value: fc.value, rank: typeof fc.rank === 'number' ? fc.rank : 0 }
    : null;
}

function normTrend(trend: any): { add: number; drop: number } | null {
  return trend && (typeof trend.add === 'number' || typeof trend.drop === 'number')
    ? { add: trend.add ?? 0, drop: trend.drop ?? 0 }
    : null;
}

/**
 * @param board  board.json (validated at app boot — trusted shape)
 * @param season season.json parsed, or null when unavailable
 */
export function mergeSeason(board: any, season: any): MergedSeason {
  const degraded =
    !season || typeof season !== 'object' || season.boardHash !== board?.buildHash;

  // idx → sleeperId reverse map from the slim map baked into the board
  const slim: Record<string, unknown> = board?.slimSleeperMap ?? {};
  const idxToSleeper = new Map<number, string>();
  for (const [sid, idx] of Object.entries(slim)) {
    if (typeof idx === 'number') idxToSleeper.set(idx, sid);
  }

  const overlay = new Map<number, any>();
  if (!degraded) {
    for (const row of season.players ?? []) {
      if (row && Number.isInteger(row.idx)) overlay.set(row.idx, row);
    }
  }

  const all: ResolvedPlayer[] = [];
  const bySleeper = new Map<string, ResolvedPlayer>();

  for (const p of board?.players ?? []) {
    const row = overlay.get(p.idx) ?? null;
    const weekly: number[] =
      row && Array.isArray(row.weekly) ? row.weekly : (p.weeklyHalfPpr ?? []);
    const sleeper = idxToSleeper.get(p.idx) ?? null;
    const rp: ResolvedPlayer = {
      key: `b${p.idx}`,
      idx: p.idx,
      sleeper,
      name: p.name ?? '',
      short: p.short ?? p.name ?? '',
      pos: p.pos ?? '',
      team: p.team ?? '',
      bye: typeof p.bye === 'number' ? p.bye : null,
      weekly,
      ros: row && typeof row.ros === 'number' ? row.ros : sumWeekly(weekly),
      injury: row ? (typeof row.injury === 'string' ? row.injury : null) : boardInjury(p.injuryStatus),
      fc: row ? normFc(row.fc) : null,
      trend: row ? normTrend(row.trend) : null,
    };
    all.push(rp);
    if (sleeper !== null) bySleeper.set(sleeper, rp);
  }

  if (!degraded) {
    for (const e of season.extras ?? []) {
      if (!e || typeof e.sleeper !== 'string' || e.sleeper.length === 0) continue;
      if (bySleeper.has(e.sleeper)) continue; // board wins on collision
      const weekly: number[] = Array.isArray(e.weekly) ? e.weekly : [];
      const rp: ResolvedPlayer = {
        key: `s${e.sleeper}`,
        idx: null,
        sleeper: e.sleeper,
        name: e.name ?? '',
        short: e.short ?? e.name ?? '',
        pos: e.pos ?? '',
        team: e.team ?? '',
        bye: typeof e.bye === 'number' ? e.bye : null,
        weekly,
        ros: typeof e.ros === 'number' ? e.ros : sumWeekly(weekly),
        injury: typeof e.injury === 'string' ? e.injury : null,
        fc: normFc(e.fc),
        trend: normTrend(e.trend),
      };
      all.push(rp);
      bySleeper.set(e.sleeper, rp);
    }
  }

  return {
    resolve: (sleeperId: string) => bySleeper.get(String(sleeperId)) ?? null,
    all,
    degraded,
  };
}
