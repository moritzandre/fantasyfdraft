# DraftPrep — Slot 8 · 12-team · Half PPR

Draft-prep + live-draft assistant for **Mon 24 Aug 2026, 17:30 CEST** (Sleeper).
Roster `1QB/2RB/2WR/1TE/2FLEX/1K/1DST` + 6 BN = 16 rounds, 192 picks.

My picks: `8 · 17 · 32 · 41 · 56 · 65 · 80 · 89 · 104 · 113 · 128 · 137 · 152 · 161 · 176 · 185`
Gaps alternate **9 / 15**: odd-round picks → short gap (take the best player);
even-round picks → long gap (take the one that won't come back).

## Architecture

| Tool | Job |
|---|---|
| Python (stdlib) | `tools/` — fetch + normalize + emit `board.json`. **Network only before draft day.** |
| Node / `engine/` | ALL math — offline sim and live recommendations run the **same files**. |
| Astro 5 + Preact | Pages + build. Live board is a Preact island; print sheets are static. |
| Chrome (headless) | `tools/make_pdfs.py` → the printed kit. Ctrl+P on the same page = fallback. |

Deploy: `npm run build` locally → commit `docs/` → GitHub Pages "main /docs".
**No CI on the critical path.**

## Commands

```
npm run dev        # local dev server
npm test           # engine unit tests (node --test)
npm run board      # rebuild data: fetch → verify → simulate  (Python + Node)
npm run build      # build the site into docs/
npm run pdfs       # emit the printed kit into out/
```

## Draft-day runbook (T−0)

1. Open the **installed Home-Screen app** (never a Safari tab — separate storage).
2. Ready Check must be all green — board age, offline cache, storage grant.
3. iPad **Auto-Lock = Never** (Settings → Display & Brightness).
4. Sleeper sync on = picks pre-fill; if the dot goes grey, keep tapping manually —
   nothing else changes.
5. If the app misbehaves: **Plan B** button = printed tier sheet on screen.
   If the iPad dies: the printed kit + blank draft board run the draft on paper.

## Freeze discipline

**No pushes after Sun 23 Aug.** The PWA header build hash must match the PDF
footers. A mismatch means reprint or trust the screen — the banner will say so.
