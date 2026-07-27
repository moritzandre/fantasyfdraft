// opponents.ts — loader for public/data/opponents.json (seat names +
// tendencies + archetype mix). Fetched ONCE per session and cached; a
// missing/broken file degrades to neutral anonymous seats. Consumers: the
// League view (seat names), the mock-draft driver and RehearsalTab (the
// opponent model), the Recs insights strip. Erasable TS.

export interface OpponentSeat {
  seat: number;
  name?: string;
  adpDiscipline?: number;
  positionBias?: Record<string, number>;
  homerTeams?: string[];
  reachRounds?: number[];
}

export interface OpponentsFile {
  seats?: OpponentSeat[];
  archetypes?: { mix?: Record<string, number> | null } | null;
  params?: Record<string, unknown> | null;
  [k: string]: unknown;
}

let cache: Promise<OpponentsFile> | null = null;

export function loadOpponents(
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u),
  baseUrl: string = (import.meta as any).env?.BASE_URL ?? '/',
): Promise<OpponentsFile> {
  if (!cache) {
    cache = fetchFn(baseUrl + 'data/opponents.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`opponents.json HTTP ${r.status}`))))
      .then((o: any) => (o && typeof o === 'object' ? (o as OpponentsFile) : { seats: [] }))
      .catch((e) => {
        console.warn('[opponents] load failed — neutral seats:', (e as Error)?.message ?? e);
        return { seats: [] } as OpponentsFile;
      });
  }
  return cache;
}

/** Display name for a seat: the configured name, else T{slot}; the user's
    own slot renders as YOU wherever the caller passes mySlot. */
export function seatName(opp: OpponentsFile | null, slot: number, mySlot?: number): string {
  if (mySlot != null && slot === mySlot) return 'YOU';
  const seat = opp?.seats?.find((x) => x.seat === slot);
  const name = seat?.name?.trim();
  return name && name.length > 0 && name !== `ME (slot ${slot})` ? name : `T${slot}`;
}

/** Test hook. */
export function _resetOpponentsCache(): void {
  cache = null;
}
