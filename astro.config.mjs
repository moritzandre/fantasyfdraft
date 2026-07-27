// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwindcss from '@tailwindcss/vite';
import AstroPWA from '@vite-pwa/astro';

// ─── Deploy target ────────────────────────────────────────────────────────────
// SITE/BASE must match the GitHub Pages repo before the first deploy (Phase 0
// gate). For a project repo `https://<user>.github.io/<repo>/` set base to
// '/<repo>/'. For a `<user>.github.io` root repo leave base as '/'.
// The service-worker scope inherits from base — a mismatch here is the
// "loads online, never works offline" failure mode. Verified in Phase 3.
const SITE = 'https://moritzandre.github.io';
const BASE = '/fantasyfdraft/';

export default defineConfig({
  site: SITE,
  base: BASE,
  outDir: './docs', // committed; Pages serves "main /docs" — no CI on the critical path
  integrations: [
    preact(),
    AstroPWA({
      registerType: 'prompt', // never silently swap builds mid-draft
      manifest: {
        name: 'DraftPrep — Slot 8',
        short_name: 'DraftPrep',
        description: 'Half-PPR draft assistant, 12-team, slot 8',
        display: 'standalone',
        orientation: 'landscape',
        background_color: '#0b0f1a',
        theme_color: '#0b0f1a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the entire app shell AND the data files: the draft must run
        // in airplane mode from a cold Home-Screen launch.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,woff2}'],
        // sheets: print pages are desktop-only, keep the SW cache lean.
        // season data: changes weekly — NetworkFirst below, never precached
        // (a precached season.json would pin week-1 data until the next build).
        globIgnores: ['**/sheets/**', '**/data/season*.json'],
        navigateFallback: null,
        // Sleeper API is network-only by omission: no runtimeCaching entry —
        // sync is a progressive enhancement and must never be served stale.
        runtimeCaching: [
          {
            // season.json / season.<profile>.json: fresh when online, last
            // good copy offline — the season page must still boot in a tunnel.
            urlPattern: /\/data\/season[^/]*\.json$/,
            handler: 'NetworkFirst',
            options: { cacheName: 'season-data', expiration: { maxEntries: 4 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
