"""tools/sources — shared plumbing for every upstream adapter.

Hard rules encoded here (see the plan, "Data pipeline"):
  * stdlib ONLY (urllib.request, json, csv, ...). No pip, no requests.
  * Every upstream response is written VERBATIM to
        data/raw/<source>_<YYYY-MM-DD>.<ext>
    BEFORE any parsing. The raw snapshot is the audit trail: if a feed
    changes shape or goes stale, the bytes we decided from are on disk.
  * buildHash is the sha256 over exactly these raw files, so the app header
    and every PDF footer can name the snapshot the board was built from.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "raw"

# Some feeds (FFC in particular) 403 the default urllib UA. A plain,
# honest browser-ish UA is accepted everywhere we call.
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DraftPrep/1.0"


def today() -> datetime.date:
    """Build date. Python may use the clock (the engine may not)."""
    return datetime.date.today()


def raw_path(source: str, ext: str) -> Path:
    return RAW_DIR / f"{source}_{today().isoformat()}.{ext}"


def fetch_raw(source: str, url: str, *, ext: str = "json",
              headers: dict | None = None, skip_same_day: bool = False,
              timeout: int = 120) -> tuple[bytes, Path]:
    """GET `url`; write the response bytes verbatim to data/raw BEFORE parsing.

    skip_same_day: reuse an existing same-day snapshot instead of re-fetching
    (used for Sleeper's 13.9 MB players dump, which changes at most daily).
    Returns (body_bytes, raw_file_path).
    """
    path = raw_path(source, ext)
    if skip_same_day and path.exists() and path.stat().st_size > 0:
        print(f"  [{source}] same-day cache hit: {path.name} "
              f"({path.stat().st_size:,} bytes)")
        return path.read_bytes(), path

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)  # verbatim, before any json.loads/csv parse
    print(f"  [{source}] fetched {len(body):,} bytes -> {path.name}")
    return body, path


def loads_lenient(body: bytes):
    """json.loads from raw text. FFC serves valid JSON with a lying
    Content-Type (text/html), so we NEVER trust headers — always read the
    body and parse explicitly."""
    return json.loads(body.decode("utf-8"))


def sha256_files(paths: list[Path]) -> str:
    """sha256 over the concatenated bytes of `paths` in sorted order —
    the buildHash provenance for board.json."""
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(p.name.encode())  # name in the hash: same bytes, new day => new hash
        h.update(p.read_bytes())
    return h.hexdigest()


# ── Team-code normalization ─────────────────────────────────────────────────
# Canonical set = nflverse's, except LA->LAR (nflverse writes the Rams as
# "LA"; everyone else says LAR). ESPN says WSH, FFC has said JAC historically.
TEAM_NORMALIZE = {
    "LA": "LAR", "WSH": "WAS", "JAC": "JAX", "OAK": "LV", "SD": "LAC",
    "STL": "LAR", "ARZ": "ARI", "HST": "HOU", "BLT": "BAL", "CLV": "CLE",
    "GNB": "GB", "KAN": "KC", "NWE": "NE", "NOR": "NO", "SFO": "SF",
    "TAM": "TB", "LVR": "LV",
}


def norm_team(code) -> str:
    c = (code or "").strip().upper()
    return TEAM_NORMALIZE.get(c, c)
