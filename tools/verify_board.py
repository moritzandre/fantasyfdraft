#!/usr/bin/env python
"""verify_board.py — the hard gate. Nothing ships unverified.

    python tools/verify_board.py        # after build_board.py

Re-opens public/data/board.json AND the raw snapshots it was built from
(named in board.sources.*.raw), runs the plan's 7 assertions, writes the
results INTO board.checks (the app header and every PDF footer display
them; validateBoard refuses a board with any failing check), re-saves, and
exits non-zero on any failure.

The 7 assertions (plan, "verify_board.py — hard gate"):
  1. bye_triangulation — for every player with ADP ≤ 180: FFC `bye` ==
     the week ESPN's weekly projection is 0.0 == the week with no nflverse
     row for the team. Three independent sources agreeing is cheap, strong
     proof we are not reading a stale 2025 cache — the likeliest
     catastrophic silent failure. (Players whose weekly line — or whose
     bye-week zero — was written by the pipeline from the nflverse bye
     carry `weeklySynthesized` / `dstByeZeroed`; their ESPN leg is
     skipped, it would be circular. ESPN's weekly DST projections have
     no bye-week zero at all — verified in the 2026-07-27 payload.)
  2. halfppr_regression — known-player recompute captured from the actual
     data (Gibbs if present, else the highest-reception player):
     |halfPpr − (ppr − 0.5·rec)| ≤ 0.05.
  3. halfppr_lt_ppr — for EVERY player with rec > 0.
  4. freshness — FFC window end_date ≤ 3 days old (re-read from the raw
     snapshot, not from what build_board claimed) and ESPN seasonId 2026
     present in the raw payload.
  5. match_rates — zero unmatched in the top 250 (every FFC rank-≤250 id
     present on the board AND every board top-250-by-μ player carries a
     Sleeper id); ≥ 98% Sleeper coverage in the top 400.
  6. position_counts_and_schedule — pool depth ≥ {QB 32, RB 60, WR 80,
     TE 24, K 20, DST 20}; nflverse exactly 272 rows.
  7. adp_spearman — Spearman(FFC ADP, ESPN ADP) ≥ 0.85 over players with
     both; a collapse means a feed changed shape.
"""

from __future__ import annotations

import datetime
import json
import statistics
import sys
from pathlib import Path

from sources import RAW_DIR, ROOT, loads_lenient

BOARD_PATH = ROOT / "public" / "data" / "board.json"
MIN_POSITION_COUNTS = {"QB": 32, "RB": 60, "WR": 80, "TE": 24, "K": 20, "DST": 20}
MAX_STALE_DAYS = 3


def check_bye_triangulation(board, ffc_raw):
    ffc_bye = {p["player_id"]: p.get("bye") for p in ffc_raw["players"]}
    mismatches, n_ffc, n_espn = [], 0, 0
    for p in board["players"]:
        if p["adp"]["mu"] > 180 or p["bye"] is None:
            continue
        bye = p["bye"]  # nflverse leg — the missing week, by construction
        fb = ffc_bye.get(p["ids"]["ffc"]) if p["ids"]["ffc"] else None
        if fb is not None:
            n_ffc += 1
            if fb != bye:
                mismatches.append(f"{p['name']}: FFC bye {fb} != nflverse {bye}")
        # Skip the ESPN leg where the weekly line (or its bye zero) was
        # written by US from the nflverse bye — circular otherwise. See
        # build_board.weekly_half_ppr for both flags.
        if not {"weeklySynthesized", "dstByeZeroed"} & set(p["flags"]):
            n_espn += 1
            zeros = [w for w, v in enumerate(p["weeklyHalfPpr"], 1) if v == 0.0]
            if bye not in zeros:
                mismatches.append(f"{p['name']}: ESPN weekly zeros {zeros} "
                                  f"missing bye {bye}")
    ok = not mismatches
    detail = (f"ADP<=180: {n_ffc} FFC legs, {n_espn} ESPN weekly legs, "
              f"{len(mismatches)} mismatches")
    if mismatches:
        detail += " — " + "; ".join(mismatches[:5])
    return ok, detail


def check_halfppr_regression(board):
    p = next((q for q in board["players"] if q["name"] == "Jahmyr Gibbs"),
             None) or max(board["players"], key=lambda q: q["proj"]["rec"])
    expect = p["proj"]["ppr"] - 0.5 * p["proj"]["rec"]
    err = abs(p["proj"]["halfPpr"] - expect)
    return err <= 0.05, (f"{p['name']}: ppr {p['proj']['ppr']} − 0.5×"
                         f"{p['proj']['rec']} rec = {expect:.2f}, "
                         f"board says {p['proj']['halfPpr']} (err {err:.3f})")


def check_halfppr_lt_ppr(board):
    bad = [p["name"] for p in board["players"]
           if p["proj"]["rec"] > 0
           and not p["proj"]["halfPpr"] < p["proj"]["ppr"]]
    n = sum(1 for p in board["players"] if p["proj"]["rec"] > 0)
    return not bad, (f"{n} pass-catchers checked"
                     + (f" — violators: {bad[:5]}" if bad else ""))


def check_freshness(board, ffc_raw, espn_raw):
    end = datetime.date.fromisoformat(ffc_raw["meta"]["end_date"])
    age = (datetime.date.today() - end).days
    season_ok = any(
        st.get("seasonId") == 2026 and st.get("statSourceId") == 1
        and st.get("statSplitTypeId") == 0 and st.get("scoringPeriodId") == 0
        for entry in espn_raw["players"][:5]
        for st in entry["player"].get("stats", []))
    ok = age <= MAX_STALE_DAYS and season_ok
    return ok, (f"FFC end_date {end} ({age}d old, max {MAX_STALE_DAYS}); "
                f"ESPN 2026 season-projection rows "
                f"{'present' if season_ok else 'MISSING'}")


def check_match_rates(board, ffc_raw):
    board_ffc_ids = {p["ids"]["ffc"] for p in board["players"] if p["ids"]["ffc"]}
    ffc_sorted = sorted(ffc_raw["players"], key=lambda p: float(p["adp"]))
    ffc_missing = [p["name"] for p in ffc_sorted[:250]
                   if p["player_id"] not in board_ffc_ids]
    by_mu = sorted(board["players"], key=lambda p: p["adp"]["mu"])
    no_sl_250 = [p["name"] for p in by_mu[:250] if not p["ids"]["sleeper"]]
    top400 = by_mu[:400]
    cov400 = sum(1 for p in top400 if p["ids"]["sleeper"]) / len(top400)
    ok = not ffc_missing and not no_sl_250 and cov400 >= 0.98
    detail = (f"FFC top-250 unmatched: {len(ffc_missing)}; top-250 without "
              f"sleeper id: {len(no_sl_250)}; top-400 sleeper coverage "
              f"{cov400:.1%}")
    if ffc_missing or no_sl_250:
        detail += f" — {ffc_missing[:3] + no_sl_250[:3]}"
    return ok, detail


def check_position_counts_and_schedule(board):
    counts = {}
    for p in board["players"]:
        counts[p["pos"]] = counts.get(p["pos"], 0) + 1
    low = {pos: (counts.get(pos, 0), need)
           for pos, need in MIN_POSITION_COUNTS.items()
           if counts.get(pos, 0) < need}
    sched = board["sources"]["nflverse"]["count"]
    ok = not low and sched == 272
    return ok, (f"counts {counts}; nflverse rows {sched}/272"
                + (f"; BELOW MINIMUM: {low}" if low else ""))


def check_adp_spearman(board):
    pairs = [(p["adp"]["mu"], p["adp"]["espnMu"]) for p in board["players"]
             if p["ids"]["ffc"] and p["adp"]["espnMu"]]
    rho = statistics.correlation([a for a, _ in pairs],
                                 [b for _, b in pairs], method="ranked")
    return rho >= 0.85, f"Spearman rho {rho:.3f} over {len(pairs)} players (min 0.85)"


def main() -> int:
    board = json.loads(BOARD_PATH.read_text(encoding="utf-8"))
    ffc_raw = loads_lenient((RAW_DIR / board["sources"]["ffc"]["raw"]).read_bytes())
    espn_raw = loads_lenient((RAW_DIR / board["sources"]["espn"]["raw"]).read_bytes())

    checks = [
        ("bye_triangulation", check_bye_triangulation(board, ffc_raw)),
        ("halfppr_regression", check_halfppr_regression(board)),
        ("halfppr_lt_ppr", check_halfppr_lt_ppr(board)),
        ("freshness", check_freshness(board, ffc_raw, espn_raw)),
        ("match_rates", check_match_rates(board, ffc_raw)),
        ("position_counts_and_schedule",
         check_position_counts_and_schedule(board)),
        ("adp_spearman", check_adp_spearman(board)),
    ]

    board["checks"] = [{"name": name, "status": "pass" if ok else "fail",
                        "detail": detail} for name, (ok, detail) in checks]
    # Results live IN board.json: the app header and every PDF footer
    # display provenance, and validateBoard refuses any failing check.
    BOARD_PATH.write_text(json.dumps(board, separators=(",", ":")),
                          encoding="utf-8")

    failed = 0
    for c in board["checks"]:
        mark = "PASS" if c["status"] == "pass" else "FAIL"
        failed += c["status"] != "pass"
        print(f"  [{mark}] {c['name']}: {c['detail']}")
    print(f"\n{len(checks) - failed}/{len(checks)} checks passed "
          f"(buildHash {board['buildHash']})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
