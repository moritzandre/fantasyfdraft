#!/usr/bin/env python3
"""Serve the BUILT docs/ tree at the GitHub Pages base path (default
'/fantasyfdraft/', parsed live from astro.config.mjs) — the built HTML
hardcodes base-path asset URLs, so root-serving docs/ silently yields an
unstyled app. Same pattern as tools/make_pdfs.py's internal server.

Usage:  python tools/serve.py [--port 8788]
Then open http://127.0.0.1:8788/fantasyfdraft/
"""
import argparse
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

m = re.search(r"const BASE = '([^']*)'", (ROOT / "astro.config.mjs").read_text("utf-8"))
base = m.group(1) if m else "/"
BASE = "/" + base.strip("/") + "/" if base.strip("/") else "/"


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if BASE != "/" and path.startswith(BASE):
            path = "/" + path[len(BASE):]
        return super().translate_path(path)

    def log_message(self, *args):  # keep the console quiet
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8788)
    args = ap.parse_args()
    httpd = ThreadingHTTPServer(
        ("127.0.0.1", args.port), partial(Handler, directory=str(DOCS))
    )
    print(f"serving {DOCS} at http://127.0.0.1:{args.port}{BASE}", flush=True)
    httpd.serve_forever()
