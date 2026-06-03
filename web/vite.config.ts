/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// Dev-server config tuned for Hon's engine-on-loopback architecture.
//
// During development:
//   1. Start the engine:    cd ../sidecar && npm run web
//      (it prints `Hon engine starting — web app at http://127.0.0.1:<P>/#token=<T>`)
//   2. Start this dev srv:  npm run dev
//      Vite opens http://localhost:5173 with HMR for React code.
//   3. Open Vite URL with the engine's token fragment appended:
//      http://localhost:5173/#token=<T>
//      The React app reads the fragment from the URL.
//
// Vite proxies every /api/* request to the engine, forwarding the
// Bearer token header. That removes the CORS dance.
//
// For production: `npm run build` outputs web/dist, and the engine
// serves this build from web/dist and rewrites /api/* to /<route>
// (see sidecar/src/server.ts).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon-180x180.png', 'favicon.ico'],
      manifest: {
        name: 'Hon',
        short_name: 'Hon',
        description: 'Personal finance, on your phone.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#1a1612',
        theme_color: '#1a1612',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
        // Never cache the API — financial data is always fresh from the engine.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          { urlPattern: /^.*\/api\/.*$/, handler: 'NetworkOnly' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      // Single source of truth for the zod schemas shared with the engine.
      // Mirrors the "@hon/shared/*" path in web/tsconfig.json and the sidecar
      // tsconfig, so the same import works in Vite, Vitest, tsc and tsx.
      '@hon/shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The engine picks a free port each launch (HON_PORT=0 unless
    // overridden), so default the proxy target to 4000 (the most
    // common port) and let users override via VITE_HON_ENGINE_URL.
    proxy: {
      '/api': {
        target: process.env.VITE_HON_ENGINE_URL ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    // Output as a single HTML + asset bundle ready to drop into the
    // engine's public/ dir. No legacy build, no manifest needed.
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
