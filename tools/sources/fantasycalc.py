"""FantasyCalc adapter — SECONDARY id crosswalk + market cross-check.

    GET api.fantasycalc.com/values/current
        ?isDynasty=false&numQbs=1&numTeams=12&ppr=0.5

isDynasty=false is load-bearing: the dynasty list is age-adjusted and
never a redraft signal. Value is used only as a market cross-check /
diagnostic — NEVER a projection (plan landmine).

Each entry carries player.espnId and player.sleeperId (strings), which is
what makes this the fallback crosswalk behind DynastyProcess.
"""

from __future__ import annotations

import datetime

from . import fetch_raw, loads_lenient

URL = ("https://api.fantasycalc.com/values/current"
       "?isDynasty=false&numQbs=1&numTeams=12&ppr=0.5")


def load(cached: bool = False) -> dict:
    """Fetch + index. Returns {by_espn, count, fetchedAt, raw} where
    by_espn = {espn_id_str: {fantasycalc, sleeper, name, pos, value, rank}}."""
    body, path = fetch_raw("fantasycalc", URL, skip_same_day=cached)
    entries = loads_lenient(body)
    assert isinstance(entries, list) and entries, "FantasyCalc: empty list"

    by_espn = {}
    for e in entries:
        pl = e.get("player") or {}
        espn = (pl.get("espnId") or "").strip() or None
        if espn is None:
            continue
        by_espn[espn] = {
            "fantasycalc": pl.get("id"),
            "sleeper": (pl.get("sleeperId") or "").strip() or None,
            "name": pl.get("name"),
            "pos": pl.get("position"),
            "value": e.get("redraftValue"),
            "rank": e.get("overallRank"),
        }
    print(f"  [fantasycalc] {len(entries)} entries, "
          f"{len(by_espn)} with an espnId")
    return {"by_espn": by_espn, "count": len(entries),
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "raw": path.name}
