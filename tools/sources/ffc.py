"""FantasyFootballCalculator half-PPR ADP adapter — THE market signal.

    GET fantasyfootballcalculator.com/api/v1/adp/half-ppr?year=2026

Landmines encoded (plan, "Data pipeline"):
  * Server-side only — no CORS headers; the browser never calls this.
  * Content-Type LIES (text/html for valid JSON) → read the body text and
    json.loads explicitly, never trust the header (loads_lenient).
  * DO NOT pass teams= — verified a silent no-op for half-PPR. The meta
    block reports teams=12 anyway; we assert it.
  * Assert len(players) > 0 — status=="Success" alone is not proof; a stale
    or empty window still says Success.
  * Assert meta.end_date within 3 days of the build — the freshness gate
    (verify_board re-checks it independently from the raw snapshot).

Gives: adp (mu), stdev, high/low (best/worst pick), times_drafted (n), bye.
Positions arrive as DEF/PK → normalized to DST/K.
"""

from __future__ import annotations

import datetime

from . import fetch_raw, loads_lenient, norm_team, today

URL = "https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?year=2026"
POS_NORMALIZE = {"DEF": "DST", "PK": "K"}
MAX_STALE_DAYS = 3


def load(cached: bool = False) -> dict:
    """Fetch + validate + normalize.
    Returns {players, count, meta, fetchedAt, raw}; players sorted by adp,
    each: {ffc, name, pos, team, adp, stdev, high, low, n, bye, rank}."""
    body, path = fetch_raw("ffc", URL, skip_same_day=cached)
    data = loads_lenient(body)  # Content-Type lies; parse the text ourselves

    players = data.get("players") or []
    meta = data.get("meta") or {}
    assert len(players) > 0, "FFC returned an empty player list"
    assert meta.get("teams") == 12, f"FFC teams != 12: {meta.get('teams')}"
    end = datetime.date.fromisoformat(meta["end_date"])
    age = (today() - end).days
    assert age <= MAX_STALE_DAYS, \
        f"FFC ADP window stale: end_date {end} is {age} days old"

    out = []
    for p in sorted(players, key=lambda p: float(p["adp"])):
        out.append({
            "ffc": p["player_id"],
            "name": p["name"],
            "pos": POS_NORMALIZE.get(p["position"], p["position"]),
            "team": norm_team(p.get("team")),
            "adp": float(p["adp"]),
            "stdev": float(p["stdev"]) if p.get("stdev") is not None else None,
            "high": int(p["high"]), "low": int(p["low"]),
            "n": int(p.get("times_drafted") or 0),
            "bye": int(p["bye"]) if p.get("bye") else None,
            "rank": len(out) + 1,  # 1-based ADP rank — the top-250 gate key
        })
    print(f"  [ffc] {len(out)} players, window "
          f"{meta.get('start_date')}..{meta.get('end_date')} "
          f"({meta.get('total_drafts')} drafts)")
    return {"players": out, "count": len(out), "meta": meta,
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "raw": path.name}
