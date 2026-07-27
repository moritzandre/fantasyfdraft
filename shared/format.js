// format.js — the ONE place player names, tier letters and numeric columns
// are formatted. Shared by the live app (src/) and every print sheet
// (src/components/print/), so the screen on your lap and the sheet in your
// hand cannot disagree on how "Jahmyr Gibbs" or tier 2 is written.
// PURE: no DOM, no fetch, no locale, no Date.now(). Runs in Node and Safari.
//
// Conventions:
//   names   "Jahmyr Gibbs"        → "Gibbs, J."      (last name, first initial)
//           "Amon-Ra St. Brown"   → "St. Brown, A."  (multi-word last names kept)
//           "Marvin Harrison Jr." → "Harrison, M."   (suffixes dropped)
//           "Ravens D/ST"         → "Ravens D/ST"    (team units pass through)
//   tiers   1 → "A", 2 → "B", …   (the letter is one of the three grayscale
//                                   channels — see tokens.css)
//   numbers tabular strings; integers on paper (a 8.5pt column has no room
//           for false precision); "—" for missing, explicit sign on deltas.

/** Generational suffixes never worth 4 characters of an 8.5pt name cell. */
const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v']);

/** Truncate `s` to `max` characters, ellipsizing the final char if clipped. */
export function fit(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** "Jahmyr Gibbs" → "Gibbs, J." (≤ `max` chars). Team units ("Ravens D/ST")
    and single-word names pass through untouched. Everything after the first
    word is treated as the last name, so "St. Brown" survives intact. */
export function abbrevName(name, max = 16) {
  const words = String(name).trim().split(/\s+/);
  if (words.length < 2 || name.includes('/')) return fit(String(name).trim(), max);
  while (words.length > 2 && SUFFIXES.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  const first = words[0];
  const last = words.slice(1).join(' ');
  return fit(`${last}, ${first[0]}.`, max);
}

/** Tier number → letter: 1 → "A", 2 → "B", … (clamped to A–Z). */
export function tierLetter(tier) {
  const t = Math.min(Math.max(1, Math.trunc(tier)), 26);
  return String.fromCharCode(64 + t);
}

/** Integer for a tabular column; em dash for missing. Pair with `.num`
    (font-variant-numeric: tabular-nums) so ranks align optically. */
export function fmtInt(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return String(Math.round(x));
}

/** One decimal for a tabular column; em dash for missing. */
export function fmt1(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return x.toFixed(1);
}

/** ADP: one decimal inside round 1 (where half a pick matters), integer after
    (where FFC's own σ dwarfs the decimal) — also caps the column at 3 chars,
    which is all a 4.1mm print cell can hold. */
export function fmtAdp(mu) {
  if (mu == null || !Number.isFinite(mu)) return '—';
  return mu < 10 ? mu.toFixed(1) : String(Math.round(mu));
}

/** Signed integer: "+12" / "-8" / "0". */
export function fmtSigned(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  const r = Math.round(x);
  return r > 0 ? `+${r}` : String(r);
}

/** ADP-delta arrow for `delta = adp.mu − myOverallRank`:
      ▲  market drafts him ≥ `eps` picks LATER than my rank — value, he waits
      ▼  market drafts him ≥ `eps` picks EARLIER — must reach to get him
      ·  board and market agree within eps
    Shape, not color, so the signal survives grayscale (never red/green-only). */
export function adpArrow(delta, eps = 3) {
  if (delta == null || !Number.isFinite(delta)) return '·';
  if (delta >= eps) return '▲';
  if (delta <= -eps) return '▼';
  return '·';
}
