"""Cross-source id resolution. The ESPN 400 is the player universe; this
module attaches sleeper / ffc / fantasycalc ids to each ESPN player.

Crosswalk order, STRICTLY (plan, "Crosswalk → Scoring → Verify"):
    1. DynastyProcess ids   (espn_id → sleeper_id, the primary map)
    2. FantasyCalc id map   (espnId → sleeperId/fc id, secondary)
    3. data/manual_ids.json (hand-pinned fixes, keyed by espn id)
    4. normalized-name fallback — casefold, strip ' . -, strip the suffixes
       Jr/Sr/II/III/IV/V, collapse spaces, tiebreak on pos then team.
Name-joining alone breaks silently on Ja'Marr Chase, Marvin Harrison Jr.,
Kenneth Walker III — which is why it is the LAST resort, not the first.

FFC publishes no foreign ids at all, so for FFC steps 1–2 are vacuous by
construction: manual pin (espn → ffc player_id) first, then name fallback.
DSTs are matched by team code on every axis (ESPN "Lions D/ST" and FFC
"Detroit Lions Defense" share no name tokens; the team code is the id).

HARD GATE (enforced by build_board): every FFC player with ADP rank ≤ 250
must resolve to an ESPN player, else the build fails and prints the
unmatched report.
"""

from __future__ import annotations

import re
import unicodedata

_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def normalize_name(name: str) -> str:
    """Casefold; fold diacritics (FFC says Piñeiro, ESPN says Pineiro);
    strip apostrophes/dots/hyphens; drop Jr/Sr/II/III/IV/V; collapse
    whitespace. 'Marvin Harrison Jr.' == 'marvin harrison'."""
    s = unicodedata.normalize("NFKD", name or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).casefold()
    s = re.sub(r"[.'’-]", "", s)
    words = [w for w in s.split() if w not in _SUFFIXES]
    return " ".join(words)


def _name_index(sleeper):
    """{normalized_name: [entry]} over the Sleeper dump (skill players + K)."""
    idx: dict[str, list] = {}
    for raw_name, entries in sleeper["by_name"].items():
        idx.setdefault(normalize_name(raw_name), []).extend(entries)
    return idx


def _pick_by_pos_team(cands, pos, team):
    """Tiebreak duplicate names: position first, then team, prefer active."""
    by_pos = [c for c in cands if c.get("pos") == pos]
    if len(by_pos) > 1 and team:
        by_team = [c for c in by_pos if c.get("team") == team]
        if by_team:
            by_pos = by_team
    if len(by_pos) > 1:
        active = [c for c in by_pos if c.get("active", True)]
        if active:
            by_pos = active
    return by_pos[0] if len(by_pos) >= 1 else None


def resolve(espn_players, ffc, dp, fc, sleeper, manual) -> dict:
    """Mutates each espn player: adds .ids {espn, sleeper, ffc, fantasycalc}
    and .ffcRow (the matched FFC dict or None). Returns the report:
    {ffcUnmatched: [rows], sleeperMisses: [names], method_counts}."""
    manual_by_espn = manual.get("byEspnId", {})
    sl_names = _name_index(sleeper)
    method_counts: dict[str, int] = {}

    def count(m):
        method_counts[m] = method_counts.get(m, 0) + 1

    # ── sleeper + fantasycalc ids per ESPN player ──────────────────────────
    sleeper_misses = []
    for p in espn_players:
        eid = str(p["espn"])
        pin = manual_by_espn.get(eid, {})
        dp_row = dp["by_espn"].get(eid)
        fc_row = fc["by_espn"].get(eid)

        if p["pos"] == "DST":
            slid = sleeper["dst_by_team"].get(p["team"])  # DST: team code IS the id
            count("sleeper:dst" if slid else "sleeper:miss")
        elif dp_row and dp_row.get("sleeper"):
            slid = dp_row["sleeper"]; count("sleeper:dp")
        elif fc_row and fc_row.get("sleeper"):
            slid = fc_row["sleeper"]; count("sleeper:fc")
        elif pin.get("sleeper"):
            slid = str(pin["sleeper"]); count("sleeper:manual")
        else:
            cand = _pick_by_pos_team(
                sl_names.get(normalize_name(p["name"]), []),
                p["pos"], p["team"])
            slid = cand["sleeper"] if cand else None
            count("sleeper:name" if slid else "sleeper:miss")
            if not slid:
                sleeper_misses.append(f'{p["name"]} ({p["pos"]} {p["team"]})')

        fcid = (fc_row or {}).get("fantasycalc") or pin.get("fantasycalc")
        p["ids"] = {"espn": p["espn"], "sleeper": slid,
                    "ffc": None, "fantasycalc": fcid}
        p["ffcRow"] = None

    # ── FFC rows → ESPN players (manual pin, DST team code, then name) ─────
    espn_by_pin = {}       # manual: ffc player_id → espn player
    for p in espn_players:
        pin = manual_by_espn.get(str(p["espn"]), {})
        if pin.get("ffc") is not None:
            espn_by_pin[int(pin["ffc"])] = p
    dst_by_team = {p["team"]: p for p in espn_players if p["pos"] == "DST"}
    by_norm: dict[str, list] = {}
    for p in espn_players:
        by_norm.setdefault(normalize_name(p["name"]), []).append(p)

    ffc_unmatched = []
    for row in ffc["players"]:
        target = espn_by_pin.get(row["ffc"])
        if target is None and row["pos"] == "DST":
            target = dst_by_team.get(row["team"])
        if target is None:
            cands = [c for c in by_norm.get(normalize_name(row["name"]), [])
                     if c["pos"] == row["pos"]]
            if len(cands) > 1 and row["team"]:
                team_match = [c for c in cands if c["team"] == row["team"]]
                cands = team_match or cands
            target = cands[0] if cands else None
        if target is not None and target["ffcRow"] is None:
            target["ffcRow"] = row
            target["ids"]["ffc"] = row["ffc"]
            count("ffc:matched")
        else:
            ffc_unmatched.append(row)
            count("ffc:unmatched")

    return {"ffcUnmatched": ffc_unmatched, "sleeperMisses": sleeper_misses,
            "methodCounts": method_counts}
