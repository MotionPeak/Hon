import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-server config tuned for Hon's engine-on-loopback architecture.
//
// During development:
//   1. Start the engine:    cd ../sidecar && npm run web
//      (it prints `Hon engine starting — web app at http://127.0.0.1:<P>/#token=<T>`)
//   2. Start this dev srv:  npm run dev
//      Vite opens http://localhost:5173 with HMR for React code.
//   3. Open Vite URL with the engine's token fragment appended:
//      http://localhost:5173/#token=<T>
//      The React app reads the fragment exactly like the old SPA did.
//
// Vite proxies every /api/* request to the engine, forwarding the
// Bearer token header. That removes the CORS dance and means the
// API surface stays identical to the old app.html.
//
// For production: `npm run build` outputs dist/ which the engine
// serves in place of app.html (a follow-up commit replaces the
// public/app.html line in server.ts).
export default defineConfig({
  plugins: [react()],
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
});
