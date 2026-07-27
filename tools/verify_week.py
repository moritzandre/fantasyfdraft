#!/usr/bin/env python
"""verify_week.py — the hard gate for the weekly season artifact.

    python tools/verify_week.py [--profile default]     # after build_week.py

Re-opens public/data/season.json (per profile) plus board.json and the raw
rosters snapshot it was built from, runs the 5 gates, writes the results
INTO season.checks (the season UI surfaces provenance; seasonMerge degrades
on a boardHash mismatch regardless), re-saves, and exits non-zero on any
failure. Pre-season runs are first-class: actualThrough 0 with week 1 must
pass on a July build.

The 5 gates (plan Phase A, "Weekly pipeline"):
  1. board_binding — season.boardHash == public/data/board.json buildHash
     (the file `npm run build` copies into docs/ — the deployed board).
  2. proj_present — every top-200-by-ros board player carries a
     current-week number unless the current week is his bye (then 0.0).
     Affirmative zeros (injured/suspended players ESPN projects out) pass
     while the weekly line is otherwise populated; all-zero lines or >20
     zeroed players fail (dead feed).
  3. roster_coverage — 100% of league-rostered sleeper ids resolve via the
     board slim map or an extras row; skipped (pass) until a
     sleeperLeagueId is configured in config/season.json.
  4. bye_consistency — spot check: weekly[bye-1] == 0.0 for the top 100
     board players and every extra with a team bye.
  5. size — the minified artifact ≤ 300 KB (as emitted by build_week,
     before this script appends checks).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from sources import RAW_DIR, ROOT, loads_lenient

BOARD_PATH = ROOT / "public" / "data" / "board.json"
MAX_SIZE_KB = 300


def season_path(profile: str) -> Path:
    name = "season.json" if profile == "default" else f"season.{profile}.json"
    return ROOT / "public" / "data" / name


def check_board_binding(season, board):
    ok = season.get("boardHash") == board.get("buildHash")
    return ok, (f"season.boardHash {season.get('boardHash')} "
                f"{'==' if ok else '!='} board.buildHash {board.get('buildHash')}")


MAX_PROJECTED_OUT = 20  # >10% of the top 200 zeroed ⇒ systemic feed failure


def check_proj_present(season, board):
    """Top-200-by-ros must carry a current-week number unless on bye.
    A zero on a non-bye week is a legitimate AFFIRMATIVE projection when the
    rest of the player's weekly line is populated (ESPN projects injured/
    suspended players out: Nabers/Kittle wk1 0.0 in the live 2026-07-27
    payload). The failure modes gated here are the real ones: non-numeric
    values, a scoring bye week, an ALL-ZERO weekly line (no data at all),
    or > MAX_PROJECTED_OUT zeroed players (a dead feed)."""
    week = season["week"]
    top = sorted(season["players"], key=lambda p: -p["ros"])[:200]
    bad, projected_out = [], []
    for p in top:
        bp = board["players"][p["idx"]]
        v = p["weekly"][week - 1]
        if not isinstance(v, (int, float)):
            bad.append(f"{bp['name']}: wk{week} not a number ({v!r})")
        elif bp.get("bye") == week:
            if v != 0.0:
                bad.append(f"{bp['name']}: bye wk{week} but scores {v}")
        elif v <= 0:
            if not any(x > 0 for x in p["weekly"]):
                bad.append(f"{bp['name']}: weekly line ALL zero")
            else:
                projected_out.append(bp["name"])
    if len(projected_out) > MAX_PROJECTED_OUT:
        bad.append(f"{len(projected_out)} top-200 players zeroed for wk{week} "
                   f"(max {MAX_PROJECTED_OUT}) — feed failure, not injuries")
    ok = not bad
    detail = (f"top-200-by-ros checked for week {week}, {len(bad)} problems, "
              f"{len(projected_out)} projected out")
    if projected_out:
        detail += f" ({', '.join(projected_out[:4])}"
        detail += ", ...)" if len(projected_out) > 4 else ")"
    if bad:
        detail += " — " + "; ".join(bad[:5])
    return ok, detail


def check_roster_coverage(season, board):
    src = (season.get("sources") or {}).get("sleeperRosters")
    if not src:
        return True, "no sleeperLeagueId configured — gate skipped"
    raw = loads_lenient((RAW_DIR / src["raw"]).read_bytes())
    rostered = set()
    for r in raw or []:
        for pid in (r.get("players") or []):
            rostered.add(str(pid))
    covered = set(board["slimSleeperMap"].keys())
    covered |= {e["sleeper"] for e in season.get("extras", [])}
    missing = sorted(rostered - covered)
    ok = not missing
    detail = (f"{len(rostered)} rostered ids, "
              f"{len(rostered) - len(missing)} resolved")
    if missing:
        detail += f" — MISSING: {missing[:10]}"
    return ok, detail


def check_bye_consistency(season, board):
    bad, checked = [], 0
    for p in sorted(season["players"], key=lambda p: -p["ros"])[:100]:
        bp = board["players"][p["idx"]]
        bye = bp.get("bye")
        if not bye:
            continue
        checked += 1
        if p["weekly"][bye - 1] != 0.0:
            bad.append(f"{bp['name']}: bye {bye} weekly {p['weekly'][bye - 1]}")
    for e in season.get("extras", []):
        bye = e.get("bye")
        if not bye:
            continue
        checked += 1
        if e["weekly"][bye - 1] != 0.0:
            bad.append(f"{e['name']}: bye {bye} weekly {e['weekly'][bye - 1]}")
    ok = not bad
    detail = f"{checked} bye weeks spot-checked, {len(bad)} nonzero"
    if bad:
        detail += " — " + "; ".join(bad[:5])
    return ok, detail


def check_size(path):
    size = path.stat().st_size
    ok = size <= MAX_SIZE_KB * 1024
    return ok, f"{size / 1024:.0f} KB minified (max {MAX_SIZE_KB} KB)"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", default="default")
    args = ap.parse_args()

    path = season_path(args.profile)
    if not path.exists():
        print(f"VERIFY FAILED — {path.relative_to(ROOT)} missing; "
              f"run build_week.py first")
        return 1
    # size gate measures the artifact as EMITTED, before checks are appended
    size_result = check_size(path)
    season = json.loads(path.read_text(encoding="utf-8"))
    board = json.loads(BOARD_PATH.read_text(encoding="utf-8"))

    checks = [
        ("board_binding", check_board_binding(season, board)),
        ("proj_present", check_proj_present(season, board)),
        ("roster_coverage", check_roster_coverage(season, board)),
        ("bye_consistency", check_bye_consistency(season, board)),
        ("size", size_result),
    ]

    season["checks"] = [{"name": name, "status": "pass" if ok else "fail",
                         "detail": detail} for name, (ok, detail) in checks]
    path.write_text(json.dumps(season, separators=(",", ":")),
                    encoding="utf-8")

    failed = 0
    for c in season["checks"]:
        mark = "PASS" if c["status"] == "pass" else "FAIL"
        failed += c["status"] != "pass"
        print(f"  [{mark}] {c['name']}: {c['detail']}")
    print(f"\n{len(checks) - failed}/{len(checks)} checks passed "
          f"(buildHash {season['buildHash']} · boardHash {season['boardHash']} "
          f"· week {season['week']})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
