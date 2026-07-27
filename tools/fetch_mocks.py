#!/usr/bin/env python
"""fetch_mocks.py — pull YOUR completed Sleeper mock drafts for opponent-model
calibration (tools/calibrate.mjs replays them against engine/opponent.js).

    python tools/fetch_mocks.py --user <sleeper_username> [--season 2026]
                                [--teams 12] [--out data/mocks]

What it keeps: MOCK drafts only (league_id is null), finished (status ==
"complete" — an abandoned lobby has no full pick log to calibrate on) and the
right room size (settings.teams == --teams). Everything else is skipped and
counted BY REASON in the summary, so a surprising "0 mocks" run explains
itself.

Output: one slim JSON per draft at <out>/<draft_id>.json (~10-25 KB):
    {"fetched": ISO date,
     "draft": {draft_id, type, status, season, settings: {teams, rounds},
               draft_order, start_time},
     "picks": [{"pick_no", "player_id",
                "metadata": {first_name, last_name, position, team}}]}
player_id is the Sleeper id — calibrate.mjs maps it to a board idx through
board.json's slimSleeperMap. Files already on disk are skipped (idempotent
re-runs), so the archive only grows as more mocks are finished.

Committable on purpose: data/mocks/ is NOT in .gitignore (unlike data/raw/) —
the mock archive is a calibration input worth versioning.

Endpoint note: the documented draft-list path is
/v1/user/{user_id}/drafts/nfl/{season}; some clients use
/v1/drafts/user/{user_id}/nfl/{season}. We try the documented form first and
fall back on 404, logging which one worked.
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from sources import ROOT, USER_AGENT

API = "https://api.sleeper.app/v1"
SLEEP_S = 0.5  # polite pause between draft-level fetches


def get_json(url: str, timeout: int = 60):
    """GET `url` with the shared tools/sources User-Agent; parse the body
    explicitly (never trust Content-Type). HTTPErrors propagate — callers
    turn the 404s they expect into messages."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_user_id(username: str) -> str:
    """GET /v1/user/{username} → user_id. Sleeper answers unknown users with
    a 404 (sometimes a literal null body) — both become the same message."""
    try:
        user = get_json(f"{API}/user/{username}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            sys.exit(f"error: Sleeper user '{username}' not found (404) — "
                     "check the username (it is the login name, not the display name)")
        raise
    if not isinstance(user, dict) or not user.get("user_id"):
        sys.exit(f"error: Sleeper user '{username}' not found (empty response)")
    print(f"  [user] {username} -> user_id {user['user_id']}")
    return str(user["user_id"])


def fetch_drafts(user_id: str, season: str) -> list:
    """All drafts (league + mock) for the user in `season`. Documented path
    first, /v1/drafts/user/ variant on 404; log which worked."""
    attempts = [
        ("documented /v1/user/{id}/drafts/nfl/{season}",
         f"{API}/user/{user_id}/drafts/nfl/{season}"),
        ("fallback /v1/drafts/user/{id}/nfl/{season}",
         f"{API}/drafts/user/{user_id}/nfl/{season}"),
    ]
    for label, url in attempts:
        try:
            drafts = get_json(url)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                print(f"  [drafts] {label} -> 404, trying next path")
                continue
            raise
        if drafts is None:
            drafts = []
        if isinstance(drafts, list):
            print(f"  [drafts] {label} worked: {len(drafts)} drafts in {season}")
            return drafts
        print(f"  [drafts] {label} returned {type(drafts).__name__}, "
              "expected list — trying next path")
    sys.exit("error: no draft-list endpoint answered — tried "
             "/v1/user/{id}/drafts/nfl/{season} and /v1/drafts/user/{id}/nfl/{season}")


def slim_draft(meta: dict) -> dict:
    """The handful of draft fields calibration needs — nothing else."""
    settings = meta.get("settings") or {}
    return {
        "draft_id": meta.get("draft_id"),
        "type": meta.get("type"),
        "status": meta.get("status"),
        "season": meta.get("season"),
        "settings": {"teams": settings.get("teams"), "rounds": settings.get("rounds")},
        "draft_order": meta.get("draft_order"),
        "start_time": meta.get("start_time"),
    }


def slim_picks(picks: list) -> list:
    """Slim pick rows, sorted by pick_no; malformed rows are dropped, not
    fatal (the calibration parser is defensive too, but garbage stops here)."""
    out = []
    for p in picks:
        if not isinstance(p, dict):
            continue
        md = p.get("metadata") or {}
        if not isinstance(md, dict):
            md = {}
        out.append({
            "pick_no": p.get("pick_no"),
            "player_id": str(p["player_id"]) if p.get("player_id") is not None else None,
            "metadata": {k: md.get(k)
                         for k in ("first_name", "last_name", "position", "team")},
        })
    out.sort(key=lambda r: (r["pick_no"] is None, r["pick_no"] or 0))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Fetch completed Sleeper mock drafts "
                                             "into data/mocks/ for calibration.")
    ap.add_argument("--user", required=True, help="Sleeper username (login name)")
    ap.add_argument("--season", default="2026")
    ap.add_argument("--teams", type=int, default=12,
                    help="only keep mocks with this room size (default 12)")
    ap.add_argument("--out", default="data/mocks")
    args = ap.parse_args()

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = ROOT / args.out

    user_id = fetch_user_id(args.user)
    drafts = fetch_drafts(user_id, str(args.season))

    skipped = {
        "league draft (league_id set)": 0,
        f"teams != {args.teams}": 0,
        "not complete": 0,
        "malformed entry": 0,
    }
    mocks = []
    for d in drafts:
        if not isinstance(d, dict) or not d.get("draft_id"):
            skipped["malformed entry"] += 1
            continue
        if d.get("league_id") is not None:
            skipped["league draft (league_id set)"] += 1
            continue
        settings = d.get("settings") or {}
        if settings.get("teams") != args.teams:
            skipped[f"teams != {args.teams}"] += 1
            continue
        if d.get("status") != "complete":
            skipped["not complete"] += 1
            continue
        mocks.append(d)

    out_dir.mkdir(parents=True, exist_ok=True)
    written, on_disk, failed = 0, 0, 0
    fetched_any = False
    for d in mocks:
        draft_id = str(d["draft_id"])
        path = out_dir / f"{draft_id}.json"
        if path.exists() and path.stat().st_size > 0:
            on_disk += 1
            print(f"  [{draft_id}] already on disk — skipped")
            continue
        if fetched_any:
            time.sleep(SLEEP_S)
        fetched_any = True
        try:
            meta = get_json(f"{API}/draft/{draft_id}")
            time.sleep(SLEEP_S)
            picks = get_json(f"{API}/draft/{draft_id}/picks")
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            failed += 1
            print(f"  [{draft_id}] fetch failed ({e}) — skipped, re-run to retry")
            continue
        doc = {
            "fetched": datetime.date.today().isoformat(),
            "draft": slim_draft(meta if isinstance(meta, dict) else d),
            "picks": slim_picks(picks if isinstance(picks, list) else []),
        }
        path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
        written += 1
        print(f"  [{draft_id}] wrote {path.stat().st_size:,} bytes "
              f"({len(doc['picks'])} picks)")

    print(f"\n[fetch_mocks] {args.user} season {args.season}: {len(drafts)} drafts, "
          f"{len(mocks)} usable mocks -> {written} written, {on_disk} already on disk, "
          f"{failed} failed")
    for reason, cnt in skipped.items():
        if cnt:
            print(f"  skipped {cnt}: {reason}")
    if written or on_disk:
        try:
            rel = out_dir.relative_to(ROOT)
        except ValueError:
            rel = out_dir
        print(f"next: node tools/calibrate.mjs --mocks {rel}")
    else:
        print("no completed mocks found — finish a Sleeper mock draft "
              f"({args.teams}-team) and re-run")


if __name__ == "__main__":
    main()
