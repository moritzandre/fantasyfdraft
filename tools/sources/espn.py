"""ESPN kona_player_info adapter — the projection source.

    GET lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/
        segments/0/leaguedefaults/3?view=kona_player_info
    header X-Fantasy-Filter: {"players":{"limit":400,
        "sortDraftRanks":{"sortPriority":100,"sortAsc":true,"value":"PPR"}}}

Landmines encoded (plan, "Data pipeline"):
  * The stats[] array is UNORDERED and mixes seasons, sources and splits.
    The season projection is the row matching ALL FOUR keys:
        seasonId==2026 AND statSourceId==1 (projection, not actual)
        AND statSplitTypeId==0 (full season) AND scoringPeriodId==0.
    Filter on fewer keys and you silently read the 2025 ACTUAL — for Gibbs
    that is 366.9 vs the 365.09 projection, which no eyeball test catches.
  * Without the X-Fantasy-Filter header ESPN truncates the player set.
  * leaguedefaults/3 is full-PPR. Half-PPR is recomputed downstream:
        half_ppr = appliedTotal(PPR) − 0.5 × stat53(receptions)
  * Stat ids VERIFIED against the live 2026-07-27 payload (the plan flagged
    "43/44 rec/rush TD — verify"): 43 IS receiving TD (Gibbs 3.38); 44 is
    receiving 2-pt conversions (values ~0.1); rushing TD is 25 (Gibbs 14.48).
    Final map: 23 ruAtt · 24 ruYd · 25 ruTd · 42 recYd · 43 recTd ·
               53 rec · 58 tgt
  * The statSplitTypeId==1 rows (scoringPeriodId 1..18, statSourceId==1,
    seasonId==2026) are the weekly projections — kept verbatim; the 0.0 week
    is the bye, and verify_board triangulates it against FFC and nflverse.
"""

from __future__ import annotations

import datetime
import json

from . import fetch_raw, loads_lenient, norm_team

SEASON = 2026
URL = (f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/"
       f"{SEASON}/segments/0/leaguedefaults/3?view=kona_player_info")
FILTER = json.dumps({"players": {"limit": 400, "sortDraftRanks": {
    "sortPriority": 100, "sortAsc": True, "value": "PPR"}}})

POSITION_BY_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}

# ESPN proTeamId → team code (verified: 8 == DET for Gibbs in the live payload)
PRO_TEAM_BY_ID = {
    0: "", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
    7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV",
    14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG",
    20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF",
    26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL",
    34: "HOU",
}

# Per-stat ids for the proj block (see docstring for the verification note)
STAT_IDS = {"ruAtt": "23", "ruYd": "24", "ruTd": "25",
            "recYd": "42", "recTd": "43", "rec": "53", "tgt": "58"}


def _season_row(stats):
    """The one full-season 2026 projection row — all four keys, no fewer."""
    for st in stats:
        if (st.get("seasonId") == SEASON and st.get("statSourceId") == 1
                and st.get("statSplitTypeId") == 0
                and st.get("scoringPeriodId") == 0):
            return st
    return None


def _weekly_rows(stats):
    """{week: (appliedTotal_PPR, receptions)} for the 2026 weekly projection
    (statSplitTypeId==1, scoringPeriodId 1..18). The bye week projects 0.0."""
    out = {}
    for st in stats:
        w = st.get("scoringPeriodId")
        if (st.get("seasonId") == SEASON and st.get("statSourceId") == 1
                and st.get("statSplitTypeId") == 1 and 1 <= (w or 0) <= 18):
            rec = float((st.get("stats") or {}).get(STAT_IDS["rec"], 0.0))
            out[w] = (float(st.get("appliedTotal") or 0.0), rec)
    return out


def _weekly_actual_rows(stats):
    """{week: (appliedTotal_PPR, receptions)} for the 2026 weekly ACTUALS
    (statSourceId==0 — real results, not projections; statSplitTypeId==1,
    scoringPeriodId 1..18). Empty until games are played. ADDITIVE for
    build_week.py — build_board never reads actuals; the existing
    _season_row/_weekly_rows filters are untouched."""
    out = {}
    for st in stats:
        w = st.get("scoringPeriodId")
        if (st.get("seasonId") == SEASON and st.get("statSourceId") == 0
                and st.get("statSplitTypeId") == 1 and 1 <= (w or 0) <= 18):
            rec = float((st.get("stats") or {}).get(STAT_IDS["rec"], 0.0))
            out[w] = (float(st.get("appliedTotal") or 0.0), rec)
    return out


def load_week(cached: bool = False, limit: int = 650) -> dict:
    """In-season weekly loader (build_week.py). Same kona endpoint with a
    wider player limit; keeps BOTH the weekly projections (statSourceId==1)
    and the weekly actuals (==0) per player. The raw snapshot is
    'espn_week_<date>.json' — a DIFFERENT raw name than load(), so an
    in-season run can never rewrite the frozen draft-board snapshot bytes
    (and never disturbs board.json's buildHash). ADDITIVE: load() untouched.

    Each player: {espn, name, pos, team, injuryStatus,
                  weeklyProj {week: (ptsPpr, rec)},
                  weeklyActual {week: (ptsPpr, rec)}}"""
    filt = json.dumps({"players": {"limit": limit, "sortDraftRanks": {
        "sortPriority": 100, "sortAsc": True, "value": "PPR"}}})
    body, path = fetch_raw("espn_week", URL, headers={"X-Fantasy-Filter": filt},
                           skip_same_day=cached)
    data = loads_lenient(body)
    players, skipped = [], 0
    for entry in data["players"]:
        pl = entry["player"]
        pos = POSITION_BY_ID.get(pl.get("defaultPositionId"))
        if pos is None:
            skipped += 1
            continue
        stats = pl.get("stats") or []
        players.append({
            "espn": pl["id"],
            "name": pl.get("fullName") or "",
            "pos": pos,
            "team": norm_team(PRO_TEAM_BY_ID.get(pl.get("proTeamId"), "")),
            "injuryStatus": pl.get("injuryStatus") or "ACTIVE",
            "weeklyProj": _weekly_rows(stats),
            "weeklyActual": _weekly_actual_rows(stats),
        })
    print(f"  [espn_week] parsed {len(players)} players "
          f"({skipped} at non-fantasy positions)")
    return {"players": players, "count": len(players), "skipped": skipped,
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "raw": path.name, "seasonId": SEASON}


def load(cached: bool = False) -> dict:
    """Fetch + parse. Returns {players, count, skipped, fetchedAt, raw}.

    Each player: {espn, name, pos, team, injuryStatus, espnAdp,
                  ppr, stats{rec,recYd,recTd,ruAtt,ruYd,ruTd,tgt},
                  weeklyPpr {week: (pts, rec)} }
    Players with no 2026 season-projection row are skipped (counted)."""
    body, path = fetch_raw("espn", URL, headers={"X-Fantasy-Filter": FILTER},
                           skip_same_day=cached)
    data = loads_lenient(body)
    players, skipped = [], 0
    for entry in data["players"]:
        pl = entry["player"]
        pos = POSITION_BY_ID.get(pl.get("defaultPositionId"))
        season = _season_row(pl.get("stats") or [])
        if pos is None or season is None:
            skipped += 1
            continue
        raw_stats = season.get("stats") or {}
        own = pl.get("ownership") or {}
        players.append({
            "espn": pl["id"],
            "name": pl.get("fullName") or "",
            "pos": pos,
            "team": norm_team(PRO_TEAM_BY_ID.get(pl.get("proTeamId"), "")),
            "injuryStatus": pl.get("injuryStatus") or "ACTIVE",
            "espnAdp": float(own.get("averageDraftPosition") or 0.0),
            "ppr": float(season.get("appliedTotal") or 0.0),
            "stats": {k: round(float(raw_stats.get(sid, 0.0)), 2)
                      for k, sid in STAT_IDS.items()},
            "weeklyPpr": _weekly_rows(pl.get("stats") or []),
        })
    print(f"  [espn] parsed {len(players)} players "
          f"({skipped} without a {SEASON} season projection)")
    return {"players": players, "count": len(players), "skipped": skipped,
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "raw": path.name, "seasonId": SEASON}
