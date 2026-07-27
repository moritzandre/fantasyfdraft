"""Sleeper players/nfl adapter — the id map the live app resolves picks with.

    GET api.sleeper.app/v1/players/nfl

Landmines encoded (plan, "Data pipeline"):
  * 13.9 MB, not the 5 MB the docs claim. Build-time input ONLY — the
    browser never fetches it; it gets the slim {sleeper_id: idx} map baked
    into board.json instead.
  * Cached with a same-day skip (fetch_raw skip_same_day=True always) —
    the dump changes at most daily and re-pulling 14 MB per dev iteration
    is pointless.
  * Sleeper has NO ADP endpoint; nothing here is a ranking signal.

DSTs live in the dump keyed by team code ("DET"), position "DEF".
"""

from __future__ import annotations

import datetime

from . import fetch_raw, loads_lenient, norm_team

URL = "https://api.sleeper.app/v1/players/nfl"
FANTASY_POS = {"QB", "RB", "WR", "TE", "K", "DEF"}


def load(cached: bool = True) -> dict:
    """Fetch (same-day cached) + index. Returns
    {by_name, dst_by_team, count, fetchedAt, raw} where
    by_name = {normalized_name: [ {sleeper, pos, team, active} ]}
    (normalization is crosswalk.normalize_name, applied by the caller —
    keys here are raw lowercased full names; crosswalk normalizes both
    sides with the same function)."""
    # Same-day skip is ALWAYS on here — 13.9 MB daily dump.
    body, path = fetch_raw("sleeper", URL, skip_same_day=True)
    players = loads_lenient(body)

    by_name: dict[str, list] = {}
    dst_by_team: dict[str, str] = {}
    kept = 0
    for pid, p in players.items():
        pos = p.get("position")
        if pos not in FANTASY_POS:
            continue
        kept += 1
        if pos == "DEF":
            dst_by_team[norm_team(pid)] = pid
            continue
        name = (p.get("full_name") or "").strip()
        if not name:
            continue
        by_name.setdefault(name, []).append({
            "sleeper": pid,
            "pos": pos,
            "team": norm_team(p.get("team")),
            "active": p.get("status") == "Active",
        })
    print(f"  [sleeper] {len(players)} entries, {kept} at fantasy positions, "
          f"{len(dst_by_team)} DSTs")
    return {"by_name": by_name, "dst_by_team": dst_by_team,
            "count": len(players),
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "raw": path.name}
