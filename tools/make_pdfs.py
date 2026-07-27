#!/usr/bin/env python3
"""make_pdfs.py — emit the printed kit as PDFs. Python stdlib only.

Serves the built docs/ tree on 127.0.0.1:8777 (http.server in a daemon
thread), then drives headless Chrome once per sheet x paper x mode:

  "C:/Program Files/Google/Chrome/Application/chrome.exe" --headless
    --disable-gpu --no-pdf-header-footer --print-background
    --print-to-pdf=<forward-slash path>  <url>?paper=..&mode=..

Chrome ONLY, never Edge (silent no-file regression since Edge 141). After
every render the file must exist and exceed 20 KB — headless print-to-pdf
has a documented failure mode of writing NOTHING while exiting 0, so the
size assert is the actual gate, not the exit code.

Usage:
  python tools/make_pdfs.py --preset minimal|core|full [--paper a4|letter|both]
                            [--mode color|gray|both] [--sheet <id>]
  --sheet overrides the preset (single-sheet reprint after a late board change).
"""
import argparse
import re
import subprocess
import sys
import threading
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
OUT = ROOT / "out"
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
HOST, PORT = "127.0.0.1", 8777
MIN_BYTES = 20 * 1024  # below this, Chrome "succeeded" at writing nothing


def site_base() -> str:
    """The GitHub Pages base path ('/fantasyfdraft/') from astro.config.mjs.
    The built HTML hardcodes asset URLs under it, so the local server must
    serve docs/ at the SAME prefix or every stylesheet 404s and the PDFs come
    out unstyled — silently."""
    m = re.search(r"const BASE = '([^']*)'", (ROOT / "astro.config.mjs").read_text("utf-8"))
    base = m.group(1) if m else "/"
    return "/" + base.strip("/") + "/" if base.strip("/") else "/"


BASE = site_base()

# Sheet ids == routes under docs/sheets/<id>/. Presets from the plan:
# MINIMAL = S1 + S4-S5 + S13 (4 pages), CORE = + S2-S3, S6-S9, S14, FULL = 14.
# Ids not yet built (Phases 8-11) are skipped with a warning, so the presets
# can be written down once and grow into themselves.
PRESETS = {
    "minimal": ["ops-card", "big-board", "blank-board"],
    "core": [
        "ops-card", "strategy-brief", "big-board", "tiers-rb", "tiers-wr",
        "tiers-te", "tiers-qb-k-dst", "blank-board", "pace-card",
    ],
    "full": [
        "ops-card", "strategy-brief", "big-board", "tiers-rb", "tiers-wr",
        "tiers-te", "tiers-qb-k-dst", "targets-fades", "handcuff-map",
        "bye-grid", "blank-board", "pace-card",
    ],
}


class QuietHandler(SimpleHTTPRequestHandler):
    """Serves docs/ at the site base path (mirrors GitHub Pages), quietly."""

    def translate_path(self, path):
        # Strip the base prefix so /fantasyfdraft/sheets/... hits docs/sheets/.
        if BASE != "/" and path.startswith(BASE):
            path = "/" + path[len(BASE):]
        return super().translate_path(path)

    def log_message(self, *args):  # noqa: D102 — keep the render log readable
        pass


def serve_docs():
    """docs/ on 127.0.0.1:8777, daemon thread — dies with the process."""
    handler = partial(QuietHandler, directory=str(DOCS))
    try:
        httpd = ThreadingHTTPServer((HOST, PORT), handler)
    except OSError as e:
        sys.exit(f"cannot bind {HOST}:{PORT} ({e}) — is another make_pdfs.py running?")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def render(sheet: str, paper: str, mode: str) -> Path:
    url = f"http://{HOST}:{PORT}{BASE}sheets/{sheet}/?paper={paper}&mode={mode}"
    pdf = OUT / f"sheet_{sheet}_{paper}_{mode}.pdf"
    pdf.unlink(missing_ok=True)  # a stale file must not satisfy the assert
    cmd = [
        CHROME,
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--no-pdf-header-footer",
        "--print-background",
        f"--print-to-pdf={pdf.as_posix()}",  # forward slashes — Chrome quirk
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    # Exit code is advisory only; the file-size assert below is the real gate.
    if proc.returncode != 0:
        print(f"  warning: chrome exited {proc.returncode} for {sheet}/{paper}/{mode}",
              file=sys.stderr)
    if not pdf.exists() or pdf.stat().st_size <= MIN_BYTES:
        got = pdf.stat().st_size if pdf.exists() else 0
        sys.exit(
            f"FAIL {pdf.name}: {got} bytes (need > {MIN_BYTES}) — headless Chrome "
            f"wrote nothing/garbage. stderr tail:\n{proc.stderr[-800:]}"
        )
    print(f"  ok  {pdf.name}  {pdf.stat().st_size:,} bytes")
    return pdf


def main():
    ap = argparse.ArgumentParser(description="Render printed sheets to PDFs via headless Chrome")
    ap.add_argument("--preset", choices=["minimal", "core", "full"], default="core")
    ap.add_argument("--paper", choices=["a4", "letter", "both"], default="both")
    ap.add_argument("--mode", choices=["color", "gray", "both"], default="both")
    ap.add_argument("--sheet", help="single sheet id, overrides --preset")
    args = ap.parse_args()

    if not Path(CHROME).exists():
        sys.exit(f"Chrome not found at {CHROME} (Chrome only — never Edge)")
    if not DOCS.exists():
        sys.exit("docs/ missing — run `npm run build` first")
    OUT.mkdir(exist_ok=True)

    sheets = [args.sheet] if args.sheet else PRESETS[args.preset]
    built, skipped = [], []
    for s in sheets:
        (built if (DOCS / "sheets" / s / "index.html").exists() else skipped).append(s)
    if skipped:
        print(f"skipping (not built yet): {', '.join(skipped)}", file=sys.stderr)
    if not built:
        sys.exit("nothing to render — no requested sheet exists under docs/sheets/")

    papers = ["a4", "letter"] if args.paper == "both" else [args.paper]
    modes = ["color", "gray"] if args.mode == "both" else [args.mode]

    httpd = serve_docs()
    try:
        # Sanity-fetch the first sheet before spending a Chrome launch on it.
        probe = f"http://{HOST}:{PORT}{BASE}sheets/{built[0]}/"
        with urllib.request.urlopen(probe, timeout=5) as r:
            if r.status != 200:
                sys.exit(f"server probe {probe} returned {r.status}")
        n = 0
        for s in built:
            for paper in papers:
                for mode in modes:
                    render(s, paper, mode)
                    n += 1
        print(f"done: {n} PDFs in {OUT}")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
