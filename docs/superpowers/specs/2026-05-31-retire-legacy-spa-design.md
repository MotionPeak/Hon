# Retire the legacy SPA — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorm complete)
**Topic:** Stop serving the 10k-line legacy SPA (`sidecar/public/app.html`) and
serve the built React app (`web/dist`) from the engine instead — the
"migration done" milestone.

---

## Goal

Today the engine serves `sidecar/public/app.html` at `/` (read once into a
`webAppHtml` constant). The React app in `web/` has full tab-by-tab parity but
only runs under vite in dev. This change makes the engine serve the **built
React bundle** at `/`, deletes the legacy SPA, and keeps `npm run dev` (the
launcher) a true one-command start.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| How to serve `web/dist` | **`@fastify/static`** (add dep) — correct content-types, caching, hashed assets. |
| When to build `web/dist` | **Launcher builds if missing/stale** — `web.mjs` runs `vite build` before spawning the engine when `dist` is absent or older than `web/src`. |
| Legacy `app.html` | **Delete now** — React parity confirmed; git history preserves it. |

## The load-bearing problem: `/api` prefix

`web/src/api.ts` calls **`/api/<route>`** for every request. In dev,
`web/vite.config.ts`'s proxy forwards `/api/*` to the engine and **strips the
`/api`** (`rewrite: path.replace(/^\/api/, '')`), so `/api/loans` → engine
`/loans`. In production there is no vite proxy, so the engine must replicate the
strip itself or every API call 404s.

**Solution:** a Fastify `rewriteUrl` hook (set at server construction) that
strips a single leading `/api` before routing. Engine routes stay named `/loans`,
`/summary`, etc. — no route renaming. Static paths never collide: the client
always prefixes API calls with `/api/`, and built assets always live under
`/assets/`.

```
Browser → GET /api/loans → rewriteUrl strips → /loans → existing handler (token-gated)
Browser → GET /          → index.html (public)
Browser → GET /assets/index-<hash>.js → @fastify/static (public)
```

## Existing code (reference, verified)

- `sidecar/src/server.ts:138-145` — `webAppHtml` reads `../public/app.html` at startup.
- `sidecar/src/server.ts:186` — `app.get('/', …reply.type('text/html').send(webAppHtml))`.
- `sidecar/src/server.ts:168-183` — H-11 `PUBLIC_ROUTE_PREFIXES = ['/logo/', '/snaptrade/done']` + `isPublicRoute()` (treats GET `/` as public) + the `onRequest` token hook.
- `web/src/api.ts:39` — `const url = path.startsWith('/api/') ? path : \`/api${path}\`;` (every call is `/api/...`).
- `web/vite.config.ts:30-35` — dev proxy `/api → :4000` with `/api` strip.
- `web/package.json:9` — `"build": "tsc -b && vite build"`; `outDir: dist` (`vite.config.ts:41`); `web/.gitignore` ignores `dist`.
- `web/dist/index.html` references `/assets/index-<hash>.js` + `/assets/index-<hash>.css` (absolute `/assets/` paths).
- `sidecar/web.mjs:145-148` — spawns `src/server.ts`; opens `http://127.0.0.1:<port>/#token=<token>` (already the engine, not vite).
- `sidecar/package.json` — Fastify `^5.8.5`; **`@fastify/static` NOT installed**.
- No `react-router` — tab state only, so `/` is the single HTML entry (no SPA deep-link fallback needed).

## Components

### 1. Engine serving — `sidecar/src/server.ts`

- **Add `@fastify/static`** (`sidecar/package.json` dep). Register it rooted at
  `web/dist` resolved relative to the engine file:
  `join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')`
  (engine is `sidecar/src/server.ts` → up to repo root → `web/dist`). Serve with
  a `prefix: '/'` but DO NOT let it auto-serve index at `/` (we handle `/`
  explicitly so we control the missing-build message). Configure `wildcard`
  appropriately so `/assets/*` resolves; keep `index: false`.
- **`rewriteUrl`** option on `Fastify({ rewriteUrl })`: if `url` starts with
  `/api/` (or is exactly `/api`), return it with the leading `/api` removed;
  else return `url` unchanged. `rewriteUrl` runs before routing AND before the
  `onRequest` auth hook, so a rewritten `/api/loans` → `/loans` is then
  token-gated exactly as today. (Fastify 5 supports `rewriteUrl(req)` returning
  a string.)
- **`GET /`** → replace the `webAppHtml` send with reading
  `web/dist/index.html`. Read it once at startup into a constant (same pattern as
  the old `webAppHtml`); if the file is missing, the constant becomes a clear
  message: `"Hon web app not built. Run: cd web && npm run build"` served as
  HTML with a 200 (so the browser shows guidance, not a network error).
- **Auth (H-11):** add `'/assets/'` to `PUBLIC_ROUTE_PREFIXES`. `/` is already
  public via `isPublicRoute`. Everything else stays gated. The favicon (if the
  build emits `/vite.svg` or similar) — check the actual `dist` output; if there
  are root-level static files beyond `/assets/`, either add them to the public
  list or confirm the build inlines them. (Hon's `index.html` currently emits
  only `/assets/*` refs — verify at implementation time.)
- **Remove** the `webAppHtml` IIFE (138-145) and the old `/` handler body.

### 2. Launcher — `sidecar/web.mjs`

- Before spawning the engine, ensure the build exists and is fresh:
  - Compute `distIndex = web/dist/index.html`.
  - "Stale" = `distIndex` missing OR the newest mtime under `web/src` (+
    `web/index.html`, `web/package.json`, `web/vite.config.ts`) is newer than
    `distIndex`'s mtime.
  - If stale, run `vite build` via `spawnSync('npm', ['run', 'build'], { cwd: web, stdio: 'inherit' })`
    **with `VITE_HON_ENGINE_URL` unset/empty** (the proxy only matters in dev;
    the build bakes no engine URL — API calls are same-origin `/api/*`).
  - On build failure, exit with the build's status (don't spawn a broken engine).
- Keep the existing first-run `npm install`, Chrome detection, token, log-tee,
  and the opened URL (already engine `/#token=`). The build step slots in just
  before `spawn(... server.ts ...)`.

### 3. Delete the legacy SPA + docs

- Delete `sidecar/public/app.html`.
- Remove the `webAppHtml` constant (done in §1).
- Update docs to "single React UI served from `web/dist`":
  - `CLAUDE.md` (the "Two UIs coexist" section + the architecture ASCII).
  - `README.md` (the `app.html` / "single self-contained file" passages).
  - `HANDOFF.md` (TL;DR + the "When the migration is fully done" note).
  - `web/package.json` description ("gradually replaces …").
  - `web/vite.config.ts` comment ("a follow-up commit replaces … server.ts").
- Leave the `// lifted from app.html` provenance comments in `web/src/**` — they
  document where logic came from and cost nothing.

## Data flow (production, post-change)

```
npm run dev (web.mjs)
  → build web/dist if stale (vite build)
  → spawn engine (server.ts), open http://127.0.0.1:<port>/#token=<t>
Engine:
  GET /                        → web/dist/index.html (public)
  GET /assets/index-<hash>.js  → @fastify/static (public)
  GET /api/<route>             → rewriteUrl → /<route> → token-gated handler
```

## Error handling

- **Missing build:** `GET /` returns the "run the build" HTML (200), not a 500.
  `@fastify/static` 404s missing `/assets/*` normally.
- **Build failure in launcher:** non-zero exit, engine not spawned, message printed.
- **Rewrite safety:** only a leading `/api` segment is stripped; `/apiary` or
  `/logo/api…` are untouched (match `/api/` prefix or exact `/api`).

## Testing (TDD where it fits)

- **New sidecar HTTP test** (`sidecar/tests/serve.test.ts`) using Fastify
  `app.inject()` against a built app instance:
  - `GET /` → 200, content-type `text/html`, body contains `<div id="root">`.
  - `GET /api/<a-real-GET-route>` with no token → 401 (rewrite + auth intact).
  - same route WITH `Authorization: Bearer <token>` → 200 (rewrite resolves it).
  - `GET /assets/<nonexistent>` → 404 (static registered, file absent) and NOT 401
    (proves `/assets/` is public, not token-gated).
  - This requires factoring the Fastify app construction so a test can build an
    instance with a known token + a temp `dist`. If `server.ts` isn't importable
    without side effects (it calls `listen()`), the test may inject against a
    minimal harness that registers the same static + rewrite + auth wiring — OR
    (preferred) extract a `buildServer(opts)` that returns the configured Fastify
    instance without listening, and have `server.ts`'s entrypoint call it. Decide
    at implementation: if extraction is too invasive, fall back to documenting
    the manual curl checks and keep the test scoped to the pure rewrite helper.
  - **Pure `rewriteApiPrefix(url)` helper** is always unit-testable regardless:
    `/api/loans`→`/loans`, `/api`→`/`, `/apiary`→`/apiary`, `/`→`/`,
    `/assets/x`→`/assets/x`, `/logo/x`→`/logo/x`. Extract it and test it.
- **Build:** `cd web && npm run build` exits 0.
- **Suites:** `cd web && npm test` + `cd sidecar && npm test` stay green; both typechecks clean.

## Visual verification (PROJECT-RULES §2 — hard gate)

Stop the dev vite. Run the real launcher (`cd Hon && npm run dev`) so the engine
builds `dist` and serves it. In chrome-devtools, load the **engine** URL
(`http://127.0.0.1:<port>/#token=<token>` — NOT vite's :5173), then:
- Screenshot the app shell loading (React, not the legacy SPA).
- Click through several tabs (Overview, Assets, Activity, Insights) — each
  renders.
- Confirm one API-backed view shows real data (proves `/api/*` rewrite works
  end-to-end against the real engine).
- Confirm no 404s for `/assets/*` and no 401s for API calls in the network panel.
No "done" before these screenshots exist.

## Out of scope

- Committing `web/dist` (stays gitignored; built on launch).
- SPA deep-link / history fallback (no client router; `/` is the only HTML route).
- Bundling/minification tuning beyond vite defaults.
- Removing the `// lifted from app.html` provenance comments.
