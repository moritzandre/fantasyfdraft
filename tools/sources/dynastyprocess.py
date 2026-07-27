"""DynastyProcess db_playerids.csv adapter — the PRIMARY id crosswalk.

    GET github.com/dynastyprocess/data/raw/master/files/db_playerids.csv

One job only: espn_id ↔ sleeper_id (± every other platform id).
Its values.csv is age-adjusted DYNASTY value and is never used for
redraft anything (plan landmine).

Missing ids arrive as the literal string "NA" — treated as absent.
"""

from __future__ import annotations

import csv
import datetime
import io

from . import fetch_raw

URL = ("https://github.com/dynastyprocess/data/raw/master/files/"
       "db_playerids.csv")


def _val(row, key):
    v = (row.get(key) or "").strip()
    return v if v and v != "NA" else None


def load(cached: bool = False) -> dict:
    """Fetch + index. Returns {by_espn, count, fetchedAt, raw} where
    by_espn = {espn_id_str: {sleeper, mfl, name, merge_name, pos, team}}."""
    body, path = fetch_raw("dynastyprocess", URL, ext="csv",
                           skip_same_day=cached)
    by_espn = {}
    n = 0
    for row in csv.DictReader(io.StringIO(body.decode("utf-8"))):
        n += 1
        espn = _val(row, "espn_id")
        if espn is None:
            continue
        by_espn[espn] = {
            "sleeper": _val(row, "sleeper_id"),
            "mfl": _val(row, "mfl_id"),
            "name": _val(row, "name"),
            "merge_name": _val(row, "merge_name"),
            "pos": _val(row, "position"),
            "team": _val(row, "team"),
        }
    print(f"  [dynastyprocess] {n} rows, {len(by_espn)} with an espn_id")
    return {"by_espn": by_espn, "count": n,
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "raw": path.name}
