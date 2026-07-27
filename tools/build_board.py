#!/usr/bin/env python
"""build_board.py — fetch every source, crosswalk, score, and emit the one
frozen public/data/board.json the app and every printed sheet run on.

    python tools/build_board.py [--cached]

--cached reuses same-day raw snapshots for every source (dev iteration);
Sleeper is same-day cached always (13.9 MB daily dump). Every upstream
response is written verbatim to data/raw/ BEFORE parsing (see sources/).

Formulas implemented here (plan, "Crosswalk → Scoring → Verify"):

  half_ppr   = appliedTotal(PPR) − 0.5 × rec        # leaguedefaults/3 is
                                                    # PPR; no half-PPR default exists
  Δ_halfPPR  = 0.5 × (rec_i − rec_replacement(pos)) # the printed half-PPR column
  eff        = g_p·(half_ppr/17) + (17 − g_p)·ppgBackup(pos)
               with ppgBackup = replacement-PPG × 0.6: the weeks a player
               misses are covered by a waiver body worth ~60% of the
               positional replacement (choice documented; ALL VBD runs on eff)
  σ_adp      = FFC stdev → (low−high)/d2(n) → max(1.2, 0.75·μ^0.55),
               then × sigmaPos multiplier from league.json
               (×1.35 staleNews hook exists; the pipeline never sets the flag)
  σ_proj     = max(position floor {RB/WR 55, TE 40, QB 45, K/DST 20},
                   0.20·half_ppr)   # matches the 50–80 pt RMSE band at top RB/WR

  Replacement indices (position rank by half_ppr) are the plan's 2-FLEX
  priors: RB 30 / WR 39 / TE 12; QB/K/DST at N·S_p = 12.

  Tiers/tierLetter/posRank/overallRank are PROVISIONAL — quantile buckets by
  position rank, good enough to render; tools/simulate.mjs recomputes real
  Ckmeans tiers and overwrites. They exist now so validateBoard() passes.

  baselinesPrior is the water-filling PRIOR, run once here in Python
  (simple greedy over eff, 24 flex slots); the live engine recomputes the
  same thing dynamically every pick — this block only seeds sheets/dev.

HARD GATE: any FFC player with ADP rank ≤ 250 unmatched to ESPN, or any
board top-250-by-μ player without a Sleeper id ⇒ print the unmatched
report and exit 1. Nothing ships on a broken crosswalk.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import sys
from pathlib import Path

from sources import RAW_DIR, ROOT, sha256_files
from sources import (crosswalk, dynastyprocess, espn, fantasycalc, ffc,
                     nflverse, sleeper)

BOARD_PATH = ROOT / "public" / "data" / "board.json"
LEAGUE_PATH = ROOT / "config" / "league.json"
MANUAL_IDS_PATH = ROOT / "data" / "manual_ids.json"

# Plan baselines for the 12-team 2-FLEX room (position rank by half_ppr).
REPLACEMENT_INDEX = {"RB": 30, "WR": 39, "TE": 12, "QB": 12, "K": 12, "DST": 12}
PPG_BACKUP_DISCOUNT = 0.6      # waiver body ≈ 60% of positional replacement
SIGMA_PROJ_FLOOR = {"RB": 55, "WR": 55, "TE": 40, "QB": 45, "K": 20, "DST": 20}
SIGMA_PROJ_FRAC = 0.20
SEASON_WEEKS = 18              # fantasy weeks; 17 games + 1 bye

# Provisional tier breakpoints by position rank (1-based, inclusive upper
# bounds). Overwritten by simulate.mjs's Ckmeans — these only make the
# board renderable and validateBoard-passable today.
TIER_BREAKS = {
    "RB": [6, 12, 20, 30, 42, 999], "WR": [6, 12, 20, 30, 42, 999],
    "TE": [3, 6, 12, 18, 999], "QB": [3, 6, 12, 18, 999],
    "K": [12, 999], "DST": [12, 999],
}

# Range-rule d2 constants (expected range of n std normals). n > 10 uses the
# Blom approximation E[range] ≈ 2·Φ⁻¹((n−0.375)/(n+0.25)) — slightly high,
# but this cascade tier only fires when FFC publishes no stdev, which is rare.
D2 = {2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534,
      7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078}


def d2_for(n: int) -> float:
    if n in D2:
        return D2[n]
    import statistics
    return 2.0 * statistics.NormalDist().inv_cdf((n - 0.375) / (n + 0.25))


def sigma_adp(p, league) -> tuple[float, str]:
    """The σ cascade: FFC stdev → range rule → power law; × sigmaPos."""
    row, mu = p.get("ffcRow"), p["adpMu"]
    base, source = None, None
    if row and row.get("stdev"):
        base, source = row["stdev"], "ffc_stdev"
    elif row and row.get("n", 0) >= 2 and row["low"] > row["high"]:
        # FFC "high" is the EARLIEST pick (numerically smaller)
        base, source = (row["low"] - row["high"]) / d2_for(row["n"]), "range_d2"
    if not base or base <= 0:
        base, source = max(1.2, 0.75 * mu ** 0.55), "power_law"
    final = base * league["sigmaPos"].get(p["pos"], 1.0)
    if "staleNews" in p.get("flags", []):   # hook only; never set by pipeline
        final *= 1.35
    return round(final, 2), source


def weekly_half_ppr(p, byes) -> tuple[list[float], list[str]]:
    """18 floats; the bye week is the 0.0 one. Uses ESPN's weekly projection
    rows when all 18 exist; otherwise SYNTHESIZES half_ppr/17 across non-bye
    weeks from the nflverse bye (flagged "weeklySynthesized").

    DST quirk, verified in the live 2026-07-27 payload: ESPN's weekly DST
    projections ignore byes entirely (Seahawks bye week 11 projects 5.83,
    not 0.0). A DST scores nothing on its bye, so that week is forced to
    0.0 from the nflverse schedule and flagged "dstByeZeroed".

    Both flags make verify_board SKIP the ESPN leg of bye triangulation for
    the player — checking a week we wrote ourselves would be circular. The
    FFC and nflverse legs still triangulate those byes independently."""
    weekly, bye = p["weeklyPpr"], byes.get(p["team"])
    if set(weekly.keys()) == set(range(1, SEASON_WEEKS + 1)) \
            and any(pts for pts, _ in weekly.values()):
        vals = [round(weekly[w][0] - 0.5 * weekly[w][1], 2)
                for w in range(1, SEASON_WEEKS + 1)]
        if p["pos"] == "DST" and bye and vals[bye - 1] != 0.0:
            vals[bye - 1] = 0.0
            return vals, ["dstByeZeroed"]
        return vals, []
    ppw = p["halfPpr"] / (17 if bye else SEASON_WEEKS)
    return [0.0 if w == bye else round(ppw, 2)
            for w in range(1, SEASON_WEEKS + 1)], ["weeklySynthesized"]


def short_name(name: str, pos: str) -> str:
    if pos == "DST" or " " not in name:
        return name
    first, rest = name.split(" ", 1)
    return f"{first[0]}. {rest}"


def water_fill(players, league) -> dict:
    """The flex water-filling PRIOR (plan P1), greedy over eff:
    start from dedicated league demand N·S_p, then hand each of the 24 flex
    slots to whichever of RB/WR/TE offers the highest next-player eff.
    The live engine recomputes this every pick on *remaining* demand —
    this one-shot version only seeds baselinesPrior for sheets and dev."""
    teams = league["teams"]
    dedicated = {pos: teams * league["roster"].get(pos, 0)
                 for pos in ("QB", "RB", "WR", "TE")}
    flex_n = teams * league["roster"]["FLEX"]
    eff_by_pos = {pos: sorted((q["eff"] for q in players if q["pos"] == pos),
                              reverse=True)
                  for pos in ("QB", "RB", "WR", "TE")}
    n = dict(dedicated)
    theta = None
    for _ in range(flex_n):
        best = max(league["flexEligible"],
                   key=lambda pos: (eff_by_pos[pos][n[pos]]
                                    if n[pos] < len(eff_by_pos[pos])
                                    else -math.inf))
        theta = eff_by_pos[best][n[best]]
        n[best] += 1
    return {
        "thetaStar": round(theta, 1),
        "r": {pos: n[pos] for pos in ("QB", "RB", "WR", "TE")},
        "flexAlloc": {pos: n[pos] - dedicated[pos]
                      for pos in league["flexEligible"]},
    }


def provisional_tiers(players):
    """Quantile-bucket tiers by position rank; PROVISIONAL until
    simulate.mjs overwrites with Ckmeans. Mutates players (tier, tierLetter),
    returns the board.tiers array (cliffPoints/meanGap/tierSep included so
    sheet components can render before the real tiering lands)."""
    tiers = []
    for pos, breaks in TIER_BREAKS.items():
        ranked = sorted((p for p in players if p["pos"] == pos),
                        key=lambda p: -p["halfPpr"])
        groups: dict[int, list] = {}
        for i, p in enumerate(ranked):
            tier = next(t for t, hi in enumerate(breaks, start=1) if i < hi)
            p["tier"], p["tierLetter"] = tier, chr(64 + min(tier, 8))
            groups.setdefault(tier, []).append(p)
        for tier in sorted(groups):
            members, nxt = groups[tier], groups.get(tier + 1)
            mean = lambda g: sum(q["halfPpr"] for q in g) / len(g)
            cliff = round(mean(members) - mean(nxt), 1) if nxt else 0.0
            gaps = [members[i]["halfPpr"] - members[i + 1]["halfPpr"]
                    for i in range(len(members) - 1)]
            sep = 0.0
            if nxt:
                sa, sb = members[-1]["sigmaProj"], nxt[0]["sigmaProj"]
                sep = round(cliff / math.sqrt(sa * sa + sb * sb), 2)
            tiers.append({"pos": pos, "tier": tier,
                          "letter": chr(64 + min(tier, 8)),
                          "members": [p["idx"] for p in members],
                          "cliffPoints": cliff,
                          "meanGap": round(sum(gaps) / len(gaps), 1) if gaps else 0.0,
                          "tierSep": sep, "provisional": True})
    return tiers


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cached", action="store_true",
                    help="reuse same-day raw snapshots for every source")
    args = ap.parse_args()

    league_bytes = LEAGUE_PATH.read_bytes()
    league = json.loads(league_bytes)
    manual = json.loads(MANUAL_IDS_PATH.read_text(encoding="utf-8"))

    print("fetching sources...")
    src_espn = espn.load(cached=args.cached)
    src_ffc = ffc.load(cached=args.cached)
    src_nflverse = nflverse.load(cached=args.cached)
    src_dp = dynastyprocess.load(cached=args.cached)
    src_fc = fantasycalc.load(cached=args.cached)
    src_sl = sleeper.load(cached=args.cached)

    players = src_espn["players"]
    report = crosswalk.resolve(players, src_ffc, src_dp, src_fc, src_sl, manual)

    # ── HARD GATE 1: FFC top-250-by-ADP must all match an ESPN player ──────
    bad = [r for r in report["ffcUnmatched"] if r["rank"] <= 250]
    if bad:
        print("\nBUILD FAILED — unmatched FFC players inside the top 250:")
        for r in bad:
            print(f"  ADP {r['adp']:>6.1f}  #{r['rank']:<4} {r['name']:<28} "
                  f"{r['pos']:<4} {r['team']:<4} ffc_id={r['ffc']}")
        print("Pin these in data/manual_ids.json (byEspnId) and rebuild.")
        return 1

    byes, sos = src_nflverse["byes"], src_nflverse["sos"]

    # ── per-player scoring ─────────────────────────────────────────────────
    for p in players:
        p["halfPpr"] = round(p["ppr"] - 0.5 * p["stats"]["rec"], 2)
        p["weekly"], p["flags"] = weekly_half_ppr(p, byes)
        if p["injuryStatus"] not in ("ACTIVE", "NORMAL"):
            p["flags"].append("injury")
        row = p.get("ffcRow")
        if row:
            p["adpMu"] = row["adp"]
        elif p["espnAdp"] > 0:
            p["adpMu"] = round(p["espnAdp"], 2)
        else:  # bottom of the pool; keep μ > 0 and ordering stable
            p["adpMu"] = 350.0 + players.index(p) * 0.25
        p["sigmaFinal"], p["sigmaSource"] = sigma_adp(p, league)

    # Replacement rows at the plan's baseline indices (pos rank by half_ppr)
    repl = {}
    for pos, idx in REPLACEMENT_INDEX.items():
        ranked = sorted((p for p in players if p["pos"] == pos),
                        key=lambda p: -p["halfPpr"])
        r = ranked[min(idx, len(ranked)) - 1]
        repl[pos] = {"halfPpr": r["halfPpr"], "rec": r["stats"]["rec"],
                     "ppgBackup": round(r["halfPpr"] / 17 * PPG_BACKUP_DISCOUNT, 2)}

    for p in players:
        pos = p["pos"]
        g = league["gamesExpected"][pos]
        p["eff"] = round(g * (p["halfPpr"] / 17)
                         + (17 - g) * repl[pos]["ppgBackup"], 1)
        p["sigmaProj"] = round(max(SIGMA_PROJ_FLOOR[pos],
                                   SIGMA_PROJ_FRAC * p["halfPpr"]), 1)
        p["deltaHalfPpr"] = (round(0.5 * (p["stats"]["rec"] - repl[pos]["rec"]), 1)
                             if pos in league["flexEligible"] else 0.0)
        p["vbdPrior"] = p["halfPpr"] - repl[pos]["halfPpr"]

    # ── dense idx: draft order (μ asc), eff breaks ties ────────────────────
    players.sort(key=lambda p: (p["adpMu"], -p["eff"]))
    for i, p in enumerate(players):
        p["idx"] = i

    # posRank by half_ppr within position; overallRank by VBD prior
    for pos in REPLACEMENT_INDEX:
        for i, p in enumerate(sorted((q for q in players if q["pos"] == pos),
                                     key=lambda q: -q["halfPpr"]), start=1):
            p["posRank"] = i
    for i, p in enumerate(sorted(players, key=lambda q: -q["vbdPrior"]),
                          start=1):
        p["overallRank"] = i

    tiers = provisional_tiers(players)
    baselines = water_fill(players, league)

    # ── emit ───────────────────────────────────────────────────────────────
    raw_paths = [RAW_DIR / s["raw"] for s in
                 (src_espn, src_ffc, src_nflverse, src_dp, src_fc, src_sl)]
    build_hash = sha256_files(raw_paths)[:7]
    fingerprint = hashlib.sha256(league_bytes).hexdigest()[:8]

    board = {
        "schema": 1,
        "buildHash": build_hash,
        "builtAt": datetime.datetime.now(datetime.timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"),
        "configFingerprint": fingerprint,
        "sources": {
            "espn": {"fetchedAt": src_espn["fetchedAt"], "count": src_espn["count"],
                     "raw": src_espn["raw"], "seasonId": src_espn["seasonId"]},
            "ffc": {"fetchedAt": src_ffc["fetchedAt"], "count": src_ffc["count"],
                    "raw": src_ffc["raw"], "endDate": src_ffc["meta"]["end_date"],
                    "totalDrafts": src_ffc["meta"]["total_drafts"]},
            "nflverse": {"fetchedAt": src_nflverse["fetchedAt"],
                         "count": src_nflverse["count"], "raw": src_nflverse["raw"]},
            "dynastyprocess": {"fetchedAt": src_dp["fetchedAt"],
                               "count": src_dp["count"], "raw": src_dp["raw"]},
            "fantasycalc": {"fetchedAt": src_fc["fetchedAt"],
                            "count": src_fc["count"], "raw": src_fc["raw"]},
            "sleeper": {"fetchedAt": src_sl["fetchedAt"],
                        "count": src_sl["count"], "raw": src_sl["raw"]},
            "crosswalk": report["methodCounts"],
        },
        "checks": [],   # verify_board.py appends; [] passes validateBoard
        "teams": {t: {"bye": byes[t], "sosEarly": sos[t]["early"],
                      "sosPlayoff": sos[t]["playoff"]} for t in sorted(byes)},
        "players": [{
            "idx": p["idx"],
            "id": str(p["espn"]),
            "ids": p["ids"],
            "name": p["name"],
            "short": short_name(p["name"], p["pos"]),
            "pos": p["pos"],
            "team": p["team"],
            "bye": byes.get(p["team"]),
            "injuryStatus": p["injuryStatus"],
            "proj": {"halfPpr": p["halfPpr"], "ppr": round(p["ppr"], 2),
                     **p["stats"]},
            "deltaHalfPpr": p["deltaHalfPpr"],
            "weeklyHalfPpr": p["weekly"],
            "sigmaProj": p["sigmaProj"],
            "gamesExpected": league["gamesExpected"][p["pos"]],
            "eff": p["eff"],
            "adp": {
                "mu": p["adpMu"],
                "sd": (p.get("ffcRow") or {}).get("stdev"),
                "hi": (p.get("ffcRow") or {}).get("high"),
                "lo": (p.get("ffcRow") or {}).get("low"),
                "n": (p.get("ffcRow") or {}).get("n"),
                "espnMu": p["espnAdp"] if p["espnAdp"] > 0 else None,
                "divergence": (round(p["adpMu"] - p["espnAdp"], 1)
                               if p["espnAdp"] > 0 else None),
                "sigmaFinal": p["sigmaFinal"],
                "sigmaSource": p["sigmaSource"],
            },
            "tier": p["tier"],
            "tierLetter": p["tierLetter"],
            "posRank": p["posRank"],
            "overallRank": p["overallRank"],
            "flags": p["flags"],
        } for p in players],
        "tiers": tiers,
        "baselinesPrior": baselines,
        "slimSleeperMap": {p["ids"]["sleeper"]: p["idx"] for p in players
                           if p["ids"]["sleeper"]},
    }

    # ── HARD GATE 2: board top 250 by μ must all carry a Sleeper id ────────
    top250 = sorted(board["players"], key=lambda p: p["adp"]["mu"])[:250]
    no_sleeper = [p for p in top250 if not p["ids"]["sleeper"]]
    if no_sleeper:
        print("\nBUILD FAILED — top-250 players without a Sleeper id:")
        for p in no_sleeper:
            print(f"  μ {p['adp']['mu']:>6.1f}  {p['name']:<28} "
                  f"{p['pos']:<4} {p['team']:<4} espn={p['id']}")
        print("Pin these in data/manual_ids.json (byEspnId) and rebuild.")
        return 1

    BOARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    BOARD_PATH.write_text(json.dumps(board, separators=(",", ":")),
                          encoding="utf-8")
    size = BOARD_PATH.stat().st_size

    print(f"\nboard.json: {len(board['players'])} players, "
          f"{len(board['slimSleeperMap'])} sleeper-mapped, "
          f"{size / 1024:.0f} KB -> {BOARD_PATH.relative_to(ROOT)}")
    print(f"buildHash {build_hash} · configFingerprint {fingerprint}")
    print(f"baselinesPrior: r={baselines['r']} flex={baselines['flexAlloc']} "
          f"thetaStar={baselines['thetaStar']}")
    print("\ntop 10 by ADP:")
    for p in board["players"][:10]:
        print(f"  {p['adp']['mu']:>5.1f}  {p['name']:<24} {p['pos']:<3} "
              f"{p['team']:<4} bye {p['bye']}  half {p['proj']['halfPpr']:>6.1f} "
              f"ppr {p['proj']['ppr']:>6.1f}  eff {p['eff']:>6.1f} "
              f"T{p['tierLetter']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
