#!/usr/bin/env python
"""build_week.py — weekly in-season artifact: public/data/season.json
(plan Phase A, "Weekly pipeline"). The draft board stays FROZEN; this
emits a separate overlay the season UI merges at runtime (seasonMerge.ts).

    python tools/build_week.py [--profile default] [--cached]

--cached reuses same-day raw snapshots (dev iteration); the Sleeper 14 MB
dump is same-day cached always. Runbook: Tue evening `npm run week` →
`npm run build` → commit docs/.

Sources (stdlib only, reusing tools/sources adapters):
  * ESPN kona (espn.load_week, limit from config/season.json): per-player
    per-week PROJECTIONS (statSourceId==1) and ACTUALS (==0). Raw snapshot
    espn_week_<date>.json — never touches the frozen board's espn raw.
  * nflverse games.csv (nflverse.load, extended additively): byes, playoff
    SoS, per-team opp[18] ('KC' home / '@KC' away / null bye), and
    actualThrough (last week where every game has scores; pre-season 0).
  * FantasyCalc current values — SOFT-FAIL: an outage emits fc: null
    everywhere plus a warning, never a build failure.
  * Sleeper players dump (sleeper.load_meta, same-day cached) for
    injury_status / depth_chart_order; if the profile has a
    sleeperLeagueId, also GET /league/{id}/rosters so EVERY rostered
    sleeper_id resolves — rostered or top-of-pool players outside the
    board become `extras` rows keyed by sleeper id.

Artifact shape (consumed by src/state/seasonMerge.ts):
  {schema:1, buildHash, builtAt, boardHash, profile, week, actualThrough,
   endWeek, sources, checks:[], teams:{CODE:{bye, opp[18], sosPlayoff}},
   players:[{idx, weekly[18], ros, injury, depth, fc:{value,rank}|null,
             trend:null}],
   extras:[{sleeper, name, short, pos, team, bye, weekly[18], ros, injury,
            depth, fc, trend:null}]}
  players.weekly: actuals for w ≤ actualThrough else projections; the bye
  week is forced 0.0. ros = Σ weekly[week..endWeek].

config/season.json is per-profile runtime config and is deliberately NOT
fingerprinted anywhere (unlike league.json) — the board stays bound to the
draft-day config only. verify_week.py is the hard gate; run it after.
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path

from sources import RAW_DIR, ROOT, fetch_raw, loads_lenient, sha256_files
from sources import espn, fantasycalc, nflverse, sleeper
from sources.crosswalk import normalize_name

BOARD_PATH = ROOT / "public" / "data" / "board.json"
SEASON_CONFIG_PATH = ROOT / "config" / "season.json"
SEASON_WEEKS = 18


def season_out_path(profile: str) -> Path:
    name = "season.json" if profile == "default" else f"season.{profile}.json"
    return ROOT / "public" / "data" / name


def short_name(name: str, pos: str) -> str:
    if pos == "DST" or " " not in name:
        return name
    first, rest = name.split(" ", 1)
    return f"{first[0]}. {rest}"


def half_ppr(t) -> float:
    """(appliedTotal_PPR, receptions) → half-PPR points."""
    return round(t[0] - 0.5 * t[1], 2)


def weekly_line(espn_row, bye, actual_through, base=None) -> list:
    """18 half-PPR numbers: actuals for w ≤ actualThrough, projections after,
    bye forced 0.0 (ESPN's weekly DST projections ignore byes — same landmine
    as build_board.weekly_half_ppr). `base` (board weeklyHalfPpr) fills weeks
    ESPN publishes no projection row for — board players never lose their
    synthesized line to a sparse feed."""
    vals = []
    for w in range(1, SEASON_WEEKS + 1):
        if bye == w:
            vals.append(0.0)
            continue
        if w <= actual_through:
            t = (espn_row or {}).get("weeklyActual", {}).get(w) if espn_row else None
            vals.append(half_ppr(t) if t is not None else 0.0)
            continue
        t = espn_row["weeklyProj"].get(w) if espn_row else None
        if t is not None:
            vals.append(half_ppr(t))
        elif base is not None:
            vals.append(round(float(base[w - 1]), 2))
        else:
            vals.append(0.0)
    return vals


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", default="default",
                    help="profile key in config/season.json (default: default)")
    ap.add_argument("--cached", action="store_true",
                    help="reuse same-day raw snapshots for every source")
    args = ap.parse_args()

    cfg_all = json.loads(SEASON_CONFIG_PATH.read_text(encoding="utf-8"))
    cfg = (cfg_all.get("profiles") or {}).get(args.profile)
    if cfg is None:
        print(f"BUILD FAILED — profile '{args.profile}' not in "
              f"{SEASON_CONFIG_PATH.relative_to(ROOT)}")
        return 1
    end_week = int(cfg.get("endWeek", 17))
    espn_limit = int(cfg.get("espnLimit", 650))
    league_id = cfg.get("sleeperLeagueId")

    board = json.loads(BOARD_PATH.read_text(encoding="utf-8"))

    print("fetching sources...")
    src_week = espn.load_week(cached=args.cached, limit=espn_limit)
    src_nfl = nflverse.load(cached=args.cached)
    sl_meta = sleeper.load_meta()

    fc_by_espn, fc_src, fc_warn = None, None, None
    try:
        fc_src = fantasycalc.load(cached=args.cached)
        fc_by_espn = fc_src["by_espn"]
    except Exception as e:  # SOFT-FAIL — market values are advisory only
        fc_warn = f"FantasyCalc unavailable ({e}) — fc null everywhere"
        print(f"  [fantasycalc] WARNING: {fc_warn}")

    rosters_raw_name, rostered = None, set()
    if league_id:
        body, path = fetch_raw(
            f"sleeper_rosters_{args.profile}",
            f"https://api.sleeper.app/v1/league/{league_id}/rosters",
            skip_same_day=args.cached)
        rosters_raw_name = path.name
        for r in loads_lenient(body) or []:
            for pid in (r.get("players") or []):
                rostered.add(str(pid))
        print(f"  [sleeper_rosters] {len(rostered)} rostered ids "
              f"(league {league_id})")

    byes, sos = src_nfl["byes"], src_nfl["sos"]
    opp = src_nfl["opp"]
    actual_through = src_nfl["actualThrough"]
    week = min(max(actual_through + 1, 1), SEASON_WEEKS)

    espn_by_id = {str(r["espn"]): r for r in src_week["players"]}
    slim = board["slimSleeperMap"]  # sleeper_id → idx

    def fc_for(espn_id) -> dict | None:
        row = fc_by_espn.get(str(espn_id)) if fc_by_espn else None
        if row and row.get("value") is not None:
            return {"value": row["value"], "rank": row.get("rank")}
        return None

    def meta_for(sleeper_id):
        return sl_meta["by_id"].get(sleeper_id) if sleeper_id else None

    # ── players: one row per board idx (weekly overlay) ────────────────────
    players_out = []
    espn_matched = 0
    for p in board["players"]:
        row = espn_by_id.get(str(p["ids"]["espn"]))
        if row:
            espn_matched += 1
        bye = p.get("bye")
        weekly = weekly_line(row, bye, actual_through, base=p["weeklyHalfPpr"])
        meta = meta_for(p["ids"]["sleeper"])
        players_out.append({
            "idx": p["idx"],
            "weekly": weekly,
            "ros": round(sum(weekly[week - 1:end_week]), 2),
            "injury": (meta or {}).get("injury"),
            "depth": (meta or {}).get("depth"),
            "fc": fc_for(p["ids"]["espn"]),
            "trend": None,
        })

    # ── extras: rostered or top-of-pool players outside the board ──────────
    board_espn = {str(p["ids"]["espn"]) for p in board["players"]}
    used_sleeper = set(slim.keys())

    name_idx, dst_by_team = {}, {}
    for pid, m in sl_meta["by_id"].items():
        if m["pos"] == "DST":
            dst_by_team[m["team"]] = pid
        elif m["name"]:
            name_idx.setdefault(normalize_name(m["name"]), []).append((pid, m))

    def resolve_sleeper(r) -> str | None:
        """ESPN row → sleeper id: DST team code, FantasyCalc crosswalk,
        then normalized-name fallback (pos, then team tiebreak)."""
        if r["pos"] == "DST":
            return dst_by_team.get(r["team"])
        fc_row = fc_by_espn.get(str(r["espn"])) if fc_by_espn else None
        if fc_row and fc_row.get("sleeper"):
            return fc_row["sleeper"]
        cands = [(pid, m) for pid, m in name_idx.get(normalize_name(r["name"]), [])
                 if m["pos"] == r["pos"]]
        if len(cands) > 1 and r["team"]:
            team_match = [(pid, m) for pid, m in cands if m["team"] == r["team"]]
            cands = team_match or cands
        return cands[0][0] if cands else None

    extras, extra_ids = [], set()

    def add_extra(sid, name, pos, team, espn_row, meta, espn_id=None):
        bye = byes.get(team)
        weekly = weekly_line(espn_row, bye, actual_through)
        ros = round(sum(weekly[week - 1:end_week]), 2)
        extras.append({
            "sleeper": sid,
            "name": name,
            "short": short_name(name, pos),
            "pos": pos,
            "team": team,
            "bye": bye,
            "weekly": weekly,
            "ros": ros,
            "injury": (meta or {}).get("injury"),
            "depth": (meta or {}).get("depth"),
            "fc": fc_for(espn_id) if espn_id is not None else None,
            "trend": None,
        })
        extra_ids.add(sid)

    # (a) ESPN top-of-pool players not on the board (waiver-wire depth)
    espn_extra_by_name = {}
    for r in src_week["players"]:
        if str(r["espn"]) in board_espn:
            continue
        espn_extra_by_name.setdefault((normalize_name(r["name"]), r["pos"]), r)
        sid = resolve_sleeper(r)
        if not sid or sid in used_sleeper or sid in extra_ids:
            continue
        meta = meta_for(sid)
        weekly_probe = weekly_line(r, byes.get(r["team"]), actual_through)
        ros_probe = round(sum(weekly_probe[week - 1:end_week]), 2)
        if ros_probe <= 0 and sid not in rostered:
            continue  # zero-value deep pool — keep the artifact small
        add_extra(sid, r["name"] or (meta or {}).get("name", ""), r["pos"],
                  r["team"], r, meta, espn_id=r["espn"])

    # (b) league-rostered ids still unresolved — EVERY rostered id must land
    for pid in sorted(rostered):
        if pid in used_sleeper or pid in extra_ids:
            continue
        meta = meta_for(pid)
        name = (meta or {}).get("name") or f"sleeper:{pid}"
        pos = (meta or {}).get("pos") or "?"
        team = (meta or {}).get("team") or ""
        espn_row = espn_extra_by_name.get((normalize_name(name), pos))
        add_extra(pid, name, pos, team, espn_row, meta,
                  espn_id=espn_row["espn"] if espn_row else None)

    # ── emit ───────────────────────────────────────────────────────────────
    raw_paths = [RAW_DIR / src_week["raw"], RAW_DIR / src_nfl["raw"],
                 RAW_DIR / sl_meta["raw"]]
    if fc_src:
        raw_paths.append(RAW_DIR / fc_src["raw"])
    if rosters_raw_name:
        raw_paths.append(RAW_DIR / rosters_raw_name)
    build_hash = sha256_files(raw_paths)[:7]

    sources = {
        "espn": {"fetchedAt": src_week["fetchedAt"], "count": src_week["count"],
                 "raw": src_week["raw"], "seasonId": src_week["seasonId"]},
        "nflverse": {"fetchedAt": src_nfl["fetchedAt"],
                     "count": src_nfl["count"], "raw": src_nfl["raw"]},
        "sleeper": {"fetchedAt": sl_meta["fetchedAt"],
                    "count": sl_meta["count"], "raw": sl_meta["raw"]},
        "fantasycalc": ({"status": "ok", "fetchedAt": fc_src["fetchedAt"],
                         "count": fc_src["count"], "raw": fc_src["raw"]}
                        if fc_src else {"status": "failed", "error": fc_warn}),
        "sleeperRosters": ({"raw": rosters_raw_name, "count": len(rostered),
                            "leagueId": league_id}
                           if rosters_raw_name else None),
    }

    season = {
        "schema": 1,
        "buildHash": build_hash,
        "builtAt": datetime.datetime.now(datetime.timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"),
        "boardHash": board["buildHash"],
        "profile": args.profile,
        "week": week,
        "actualThrough": actual_through,
        "endWeek": end_week,
        "sources": sources,
        "checks": [],   # verify_week.py appends; [] until verified
        "teams": {t: {"bye": byes[t], "opp": opp[t],
                      "sosPlayoff": sos[t]["playoff"]} for t in sorted(byes)},
        "players": players_out,
        "extras": extras,
    }

    out_path = season_out_path(args.profile)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(season, separators=(",", ":")),
                        encoding="utf-8")
    size = out_path.stat().st_size

    print(f"\nseason.json: week {week} (actualThrough {actual_through}), "
          f"{len(players_out)} board players ({espn_matched} ESPN-matched), "
          f"{len(extras)} extras, {size / 1024:.0f} KB "
          f"-> {out_path.relative_to(ROOT)}")
    print(f"buildHash {build_hash} · boardHash {board['buildHash']}"
          + (f" · {fc_warn}" if fc_warn else ""))
    top = sorted(players_out, key=lambda p: -p["ros"])[:5]
    for p in top:
        bp = board["players"][p["idx"]]
        print(f"  ros {p['ros']:>6.1f}  wk{week} {p['weekly'][week-1]:>5.1f}  "
              f"{bp['name']:<24} {bp['pos']:<3} {bp['team']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
