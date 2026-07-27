// Foot.tsx — the provenance footer, identical on every printed page.
// Consistency contract: the same buildHash the app header shows; a mismatch
// between a sheet in hand and the screen means the sheet must be reprinted.
// Format: snapshot hash · builtAt · slot (where relevant) · league · p/N · id.

export default function Foot({
  board,
  league,
  slot,
  pageId,
  page = 1,
  pages = 1,
  extra,
}: {
  board: any;
  league: any;
  slot?: number | null;
  pageId: string;
  page?: number;
  pages?: number;
  extra?: string;
}) {
  return (
    <footer class="sheet-foot">
      snapshot {board.buildHash} · {String(board.builtAt ?? '').slice(0, 10)}
      {slot != null ? ` · slot ${slot}` : ''} · {league.teams}-team half-PPR · p{page}/{pages} ·{' '}
      {pageId}
      {extra ? ` · ${extra}` : ''}
    </footer>
  );
}
