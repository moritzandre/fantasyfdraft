"""nflverse games.csv adapter — schedule, byes and market-implied SoS.

    GET github.com/nflverse/nfldata/raw/master/data/games.csv

Encoded rules (plan, "Data pipeline"):
  * Assert EXACTLY 272 season-2026 regular-season rows across weeks 1–18
    (32 teams × 17 games ÷ 2). Anything else means a partial or reshaped
    feed and the build must not proceed.
  * Bye = the one week in 1..18 with no row for a team; asserted unique
    per team. This is one leg of verify_board's three-source triangulation.
  * SoS from spread_line (market-implied, home-positive). Per game the
    team-perspective expected margin is +spread_line at home,
    −spread_line away. SoS = mean of that margin over the team's
    opponents, split weeks 1–13 (sosEarly) vs 15–17 (sosPlayoff, the
    fantasy playoffs; week 14 and 18 deliberately excluded per plan).
    Positive ⇒ the market expects the team to be favored on average.
    Games with no posted line yet are skipped from the mean.
"""

from __future__ import annotations

import csv
import datetime
import io

from . import fetch_raw, norm_team

URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv"
SEASON = "2026"
EXPECTED_ROWS = 272


def load(cached: bool = False) -> dict:
    """Fetch + derive. Returns {count, byes, sos, fetchedAt, raw} where
    byes = {team: week} and sos = {team: {early, playoff}}."""
    body, path = fetch_raw("nflverse", URL, ext="csv", skip_same_day=cached)
    rows = [r for r in csv.DictReader(io.StringIO(body.decode("utf-8")))
            if r["season"] == SEASON and r["game_type"] == "REG"]

    weeks = sorted({int(r["week"]) for r in rows})
    assert len(rows) == EXPECTED_ROWS, \
        f"nflverse: expected {EXPECTED_ROWS} rows for {SEASON}, got {len(rows)}"
    assert weeks == list(range(1, 19)), f"nflverse: weeks {weeks} != 1..18"

    # Per-team game weeks and team-perspective spread samples. ADDITIVE for
    # build_week.py: per-team opponent strings ('KC' home / '@KC' away, None
    # on bye) and completed-week detection from the score columns.
    played: dict[str, set[int]] = {}
    margins: dict[str, list[tuple[int, float]]] = {}
    opp: dict[str, list] = {}
    week_done: dict[int, bool] = {}
    for r in rows:
        week = int(r["week"])
        line = float(r["spread_line"]) if r["spread_line"] else None
        home, away = norm_team(r["home_team"]), norm_team(r["away_team"])
        for team, sign in ((home, +1.0), (away, -1.0)):
            played.setdefault(team, set()).add(week)
            if line is not None:
                margins.setdefault(team, []).append((week, sign * line))
        opp.setdefault(home, [None] * 18)[week - 1] = away
        opp.setdefault(away, [None] * 18)[week - 1] = "@" + home
        done = bool((r.get("home_score") or "").strip()) \
            and bool((r.get("away_score") or "").strip())
        week_done[week] = week_done.get(week, True) and done

    # actualThrough = last week with EVERY game scored, no gaps (pre-season 0)
    actual_through = 0
    for w in range(1, 19):
        if not week_done.get(w, False):
            break
        actual_through = w

    byes, sos = {}, {}
    for team, wk in sorted(played.items()):
        missing = sorted(set(range(1, 19)) - wk)
        assert len(missing) == 1, f"nflverse: {team} byes {missing} != 1 week"
        byes[team] = missing[0]
        early = [m for w, m in margins.get(team, []) if 1 <= w <= 13]
        playoff = [m for w, m in margins.get(team, []) if 15 <= w <= 17]
        sos[team] = {
            "early": round(sum(early) / len(early), 2) if early else 0.0,
            "playoff": round(sum(playoff) / len(playoff), 2) if playoff else 0.0,
        }
    assert len(byes) == 32, f"nflverse: {len(byes)} teams != 32"

    print(f"  [nflverse] {len(rows)} rows, 32 teams, byes weeks "
          f"{min(byes.values())}..{max(byes.values())}, "
          f"actualThrough {actual_through}")
    return {"count": len(rows), "byes": byes, "sos": sos,
            "opp": opp, "actualThrough": actual_through,
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "raw": path.name}
