# Retire the legacy SPA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Serve the built React app (`web/dist`) from the engine and delete the 10k-line legacy SPA (`sidecar/public/app.html`).

**Architecture:** Add `@fastify/static` to serve `web/dist/assets/*`; serve `web/dist/index.html` at `/`; add a Fastify `rewriteUrl` that strips a leading `/api` so the React client's `/api/<route>` calls reach the engine's `/<route>` handlers (replicating vite's dev proxy). The launcher (`web.mjs`) builds `web/dist` when missing/stale. Auth posture unchanged: `/`, `/assets/*` public; everything else token-gated.

**Tech Stack:** Fastify 5 (`rewriteUrl` factory option), `@fastify/static`, Node fs, Vitest. No DB/schema changes.

---

## Authoritative current state (verified in worktree — exact line numbers)

- `sidecar/src/server.ts:1` — `import Fastify from 'fastify';`
- `sidecar/src/server.ts:2` — `import { mkdirSync, readFileSync } from 'node:fs';` (fold new fs imports here).
- `sidecar/src/server.ts:4-5` — `import { dirname, join } from 'node:path';` + `import { fileURLToPath } from 'node:url';` (already present — reuse).
- `sidecar/src/server.ts:138-145` — `webAppHtml` IIFE reads `../public/app.html` (`dirname(fileURLToPath(import.meta.url))` → `join(here, '..', 'public', 'app.html')`).
- `sidecar/src/server.ts:148` — `const app = Fastify({ logger: false });` ← **THE Fastify ctor to replace with `rewriteUrl`.**
- `sidecar/src/server.ts:168` — `const PUBLIC_ROUTE_PREFIXES = ['/logo/', '/snaptrade/done'];`
- `sidecar/src/server.ts:171-175` — `isPublicRoute(method, url)` (GET-only; `/` is public via `if (url === '/') return true`).
- `sidecar/src/server.ts:179-184` — `app.addHook('onRequest', …)` token gate.
- `sidecar/src/server.ts:186` — `app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(webAppHtml));`
- `sidecar/src/server.ts:2474` — `await app.listen({ host, port });` (inside an async start block). **server.ts runs `listen` and exports nothing** — not cleanly importable in a test.
- `web/dist/` is **currently absent** (cleaned); `npm run build` regenerates it. Output is `index.html` + `assets/index-<hash>.{js,css,js.map}` ONLY (verified from a prior build; `web/index.html` source references only `/src/main.tsx`, which vite rewrites to a hashed `/assets/*.js` at build).
- `web/src/api.ts:39` — every call becomes `/api/<path>`.
- `web/dist/` — `index.html` + `assets/index-<hash>.{js,css,js.map}` ONLY (no root favicon/static beyond `/assets/`). `web/index.html` source has no extra static refs. `dist` is gitignored.
- `@fastify/static` is **NOT** in `sidecar/package.json` or node_modules.
- Sidecar test style (`sidecar/tests/repo.test.ts`): `import { describe, expect, it } from 'vitest'`, `.js` import extensions, temp dirs via `mkdtempSync`.

## Conventions

- Run sidecar commands from `sidecar/`, web from `web/` (NOT repo root). `node_modules` symlinked; `npx vitest run <file>` works.
- Because `server.ts` isn't importable without side effects, the **required** automated test is the pure `rewriteApiPrefix` helper. The full HTTP-level check (static serving + auth on the real app) is done via the **launcher + chrome-devtools visual verification** in Task 6 (matches the project's "routes tested manually" convention). Do NOT refactor `server.ts` into a `buildServer()` for this plan — too invasive for the payoff.
- TypeScript strict. Commit per task.

---

## Task 1: Pure `rewriteApiPrefix` helper (TDD)

The `/api`-strip logic must be a pure, unit-tested function so the `rewriteUrl` wiring is provably correct without booting the server.

**Files:**
- Create: `sidecar/src/httpRewrite.ts`
- Test: `sidecar/tests/httpRewrite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// sidecar/tests/httpRewrite.test.ts
import { describe, expect, it } from 'vitest';
import { rewriteApiPrefix } from '../src/httpRewrite.js';

describe('rewriteApiPrefix', () => {
  it('strips a leading /api segment', () => {
    expect(rewriteApiPrefix('/api/loans')).toBe('/loans');
    expect(rewriteApiPrefix('/api/connections/123/scrape')).toBe('/connections/123/scrape');
    expect(rewriteApiPrefix('/api/summary?x=1')).toBe('/summary?x=1');
  });
  it('maps bare /api to /', () => {
    expect(rewriteApiPrefix('/api')).toBe('/');
    expect(rewriteApiPrefix('/api/')).toBe('/');
  });
  it('leaves non-/api paths untouched', () => {
    expect(rewriteApiPrefix('/')).toBe('/');
    expect(rewriteApiPrefix('/assets/index-abc.js')).toBe('/assets/index-abc.js');
    expect(rewriteApiPrefix('/logo/hapoalim')).toBe('/logo/hapoalim');
    expect(rewriteApiPrefix('/loans')).toBe('/loans');
  });
  it('does not strip a partial match (/apiary)', () => {
    expect(rewriteApiPrefix('/apiary')).toBe('/apiary');
    expect(rewriteApiPrefix('/api-keys')).toBe('/api-keys');
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd sidecar && npx vitest run tests/httpRewrite.test.ts`
Expected: FAIL — cannot resolve `../src/httpRewrite.js`.

- [ ] **Step 3: Implement**

```ts
// sidecar/src/httpRewrite.ts

/**
 * Strips a single leading `/api` segment from a request URL so the React
 * client's `/api/<route>` calls reach the engine's `/<route>` handlers — the
 * production equivalent of vite's dev proxy (which does the same strip). Used as
 * Fastify's `rewriteUrl`. Only an exact `/api` prefix (followed by `/`, `?`, or
 * end-of-string) is stripped, so `/apiary` and `/api-keys` are left alone.
 */
export function rewriteApiPrefix(url: string): string {
  if (url === '/api' || url === '/api/') return '/';
  if (url.startsWith('/api/')) return url.slice(4); // drop "/api", keep the rest incl. leading "/"
  if (url.startsWith('/api?')) return '/' + url.slice(4); // "/api?x" → "/?x"
  return url;
}
```

> **VERIFY:** `'/api/loans'.slice(4)` === `'/loans'` ✓; `'/api?x'.slice(4)` === `'?x'` → prepend `/` → `'/?x'`. The bare `/api`/`/api/` cases are handled first. Confirm the test's `/api/summary?x=1` → `/summary?x=1` (slice(4) of `/api/summary?x=1` = `/summary?x=1` ✓).

- [ ] **Step 4: Run, verify PASS**

Run: `cd sidecar && npx vitest run tests/httpRewrite.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd sidecar && npm run typecheck` → clean.
```bash
git add sidecar/src/httpRewrite.ts sidecar/tests/httpRewrite.test.ts
git commit -m "feat(server): pure rewriteApiPrefix helper for /api strip"
```

---

## Task 2: Add `@fastify/static` dependency

**Files:**
- Modify: `sidecar/package.json`

- [ ] **Step 1: Install**

Run: `cd sidecar && npm install @fastify/static`
(Installs a Fastify-5-compatible version and adds it to `dependencies`.)

> **VERIFY:** `@fastify/static`'s peer range includes Fastify 5 (it does — v8.x targets Fastify 5). After install, confirm `node_modules/@fastify/static/package.json` exists and `sidecar/package.json` lists it under `dependencies`. Because node_modules is symlinked to the main checkout, the install lands in the shared `node_modules` — that's fine.

- [ ] **Step 2: Typecheck (types resolve)**

Run: `cd sidecar && npm run typecheck` → clean (no usage yet; just confirms the dep is installable).

- [ ] **Step 3: Commit**

```bash
git add sidecar/package.json
git commit -m "build(sidecar): add @fastify/static for serving the React build"
```
(Note: `package-lock.json` lives at the main checkout's root if present — if `git status` shows a lockfile change, include it.)

---

## Task 3: Serve `web/dist` from the engine + wire `rewriteUrl`

**Files:**
- Modify: `sidecar/src/server.ts` (imports; line 29 Fastify ctor; 131-138 webAppHtml; 149 PUBLIC_ROUTE_PREFIXES; 601 `/` handler)

No automated test here (server.ts not importable; covered by Task 1 unit test + Task 6 visual verify). Typecheck + the launcher smoke are the gates.

- [ ] **Step 1: Add imports**

At the top of `server.ts`, add:
```ts
import fastifyStatic from '@fastify/static';
import { rewriteApiPrefix } from './httpRewrite.js';
```
**Note:** `readFileSync` is already imported (line 2: `import { mkdirSync, readFileSync } from 'node:fs';`); `dirname, join` (line 4) and `fileURLToPath` (line 5) are present too — reuse them. `existsSync` is NOT currently imported — the new `webAppHtml` read uses a `try/catch` (not `existsSync`), so you don't need it; if Task 3 Step 4's static registration wants an existence check, add `existsSync` to the line-2 fs import.

- [ ] **Step 2: Wire `rewriteUrl` into the Fastify ctor (line 148)**

Replace:
```ts
const app = Fastify({ logger: false });
```
with:
```ts
const app = Fastify({
  logger: false,
  // The React client calls /api/<route>; strip the prefix so it reaches the
  // engine's /<route> handlers (prod equivalent of vite's dev proxy). Runs
  // before routing AND before the onRequest auth hook, so a rewritten
  // /api/loans → /loans is token-gated exactly as before.
  rewriteUrl: (req) => rewriteApiPrefix(req.url ?? '/'),
});
```

> **VERIFY:** Fastify 5's `rewriteUrl` receives the raw `http.IncomingMessage` (has `.url`) and returns a string. Confirm the signature in the installed fastify types; if it passes `(req)` with `req.url` as `string | undefined`, the `?? '/'` guard covers it.

- [ ] **Step 3: Replace `webAppHtml` (138-145) to read the built index**

Replace the `webAppHtml` IIFE with a read of the React build's `index.html`:
```ts
// The built React app's entry HTML, read once at startup. web/dist is produced
// by `cd web && npm run build` (the launcher builds it when missing/stale).
const webAppHtml = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', '..', 'web', 'dist', 'index.html'), 'utf8');
  } catch {
    return '<!doctype html><meta charset="utf-8"><title>Hon</title>'
      + '<p style="font-family:system-ui;max-width:30rem;margin:4rem auto">'
      + 'Hon web app not built. Run <code>cd web &amp;&amp; npm run build</code>, '
      + 'then reload.</p>';
  }
})();
```

> **VERIFY:** path from `sidecar/src/server.ts` to `web/dist/index.html` is `../../web/dist/index.html` (src → sidecar → repo-root → web/dist). Double-check the depth: `dirname(import.meta.url)` is `sidecar/src`, so `..` = `sidecar`, `../..` = repo root, then `web/dist`. ✓

- [ ] **Step 4: Register `@fastify/static` for `/assets/*` — use the TIGHT scoping**

Register static rooted at `web/dist/assets` under prefix `/assets/` — the tightest form, which cannot collide with `/` or any API route (the client only ever requests `/assets/<hash>.js|css`). Place the registration with the other top-level `app.*` setup (e.g. just after the `onRequest` hook at ~184, before the `/` route at 186). `server.ts` registers plugins at top level (not inside an async fn), so `app.register(...)` is queued until `listen` — do NOT `await` it:
```ts
const webAssetsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist', 'assets',
);
app.register(fastifyStatic, {
  root: webAssetsDir,
  prefix: '/assets/',
  cacheControl: true,
  maxAge: '7d',
});
```

> **VERIFY:**
> 1. Top-level `app.register(...)` (no `await`) matches how the file is structured — plugins are picked up at `app.listen()` (line 2474). Confirm there's no other `app.register` already (there isn't today) that would change ordering assumptions.
> 2. `prefix: '/assets/'` + `root: web/dist/assets` means a request for `/assets/index-<hash>.js` maps to `web/dist/assets/index-<hash>.js`. This NEVER shadows `/` (handled by the explicit route) or `/api/*` / `/loans` etc. No `wildcard`/`index` options needed with this scoping.
> 3. Path depth: `sidecar/src` → `..`=`sidecar` → `../..`=repo root → `web/dist/assets`. ✓

- [ ] **Step 5: Make `/assets/` public (auth)**

Line 168 — add `/assets/` to the prefix list:
```ts
const PUBLIC_ROUTE_PREFIXES = ['/logo/', '/snaptrade/done', '/assets/'];
```
(`/` is already public via `isPublicRoute`. The static plugin's asset responses must not be 401'd — JS/CSS carry no secrets, same posture as the old SPA.)

- [ ] **Step 6: The `/` handler (186) is unchanged** — it still does `reply.type('text/html; charset=utf-8').send(webAppHtml)`; `webAppHtml` now holds the React index. Leave the line as-is.

- [ ] **Step 7: Typecheck**

Run: `cd sidecar && npm run typecheck` → clean.

- [ ] **Step 8: Commit**

```bash
git add sidecar/src/server.ts
git commit -m "feat(server): serve web/dist (React build) + /api rewrite; drop app.html read"
```

---

## Task 4: Launcher builds `web/dist` when missing/stale

**Files:**
- Modify: `sidecar/web.mjs` (build step before the `spawn(... server.ts ...)` at ~145)

- [ ] **Step 1: Add a build-if-stale step**

In `web.mjs`, after the first-run `npm install` block (~106) and before `spawn(... 'src/server.ts' ...)` (~145), insert:
```js
// Ensure the React build exists and is fresh before the engine serves it.
// (web/dist is gitignored; built on demand so `npm run web` stays one command.)
import { statSync, readdirSync } from 'node:fs';

const webDir = join(here, '..', 'web');
const distIndex = join(webDir, 'dist', 'index.html');

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = join(dir, entry.name);
    const m = entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

function buildIsStale() {
  if (!existsSync(distIndex)) return true;
  const builtAt = statSync(distIndex).mtimeMs;
  // Compare against the React sources + build config.
  const srcNewest = newestMtime(join(webDir, 'src'));
  const cfgFiles = ['index.html', 'package.json', 'vite.config.ts']
    .map((f) => join(webDir, f))
    .filter((f) => existsSync(f))
    .map((f) => statSync(f).mtimeMs);
  const inputNewest = Math.max(srcNewest, ...cfgFiles);
  return inputNewest > builtAt;
}

if (buildIsStale()) {
  console.log('Building the web app (web/dist is missing or out of date)…');
  const build = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: webDir,
    stdio: 'inherit',
    // No VITE_HON_ENGINE_URL — the build makes same-origin /api/* calls.
    env: { ...process.env },
  });
  if (build.status !== 0) {
    console.error('Web build failed — not starting the engine.');
    process.exit(build.status || 1);
  }
}
```

> **VERIFY:**
> 1. `here` is `sidecar/` (set at `web.mjs:13` via `dirname(fileURLToPath(import.meta.url))` + `process.chdir(here)`), so `join(here, '..', 'web')` = repo-root `web`. ✓
> 2. `existsSync`, `spawnSync`, `isWindows`, `join` are already imported/defined in web.mjs (existsSync line 8, spawnSync line 6, isWindows line 95, join line 10). ADD `statSync, readdirSync` to the existing `node:fs` import on line 8 rather than a second import line (cleaner — fold them in).
> 3. `web/` must have its own `node_modules` (or symlinked) for `npm run build` to find vite. In the user's real checkout it does. If a `web/node_modules` is absent, `npm run build` will fail loudly with a clear message — acceptable.

- [ ] **Step 2: Fold the fs import**

Change line 8 from:
```js
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
```
to include `statSync, readdirSync`:
```js
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
```
And remove the inline `import { statSync, readdirSync }` from Step 1 (keep one import site).

- [ ] **Step 3: Syntax-check the launcher**

Run: `node --check sidecar/web.mjs`
Expected: no output (valid syntax).

- [ ] **Step 4: Commit**

```bash
git add sidecar/web.mjs
git commit -m "feat(launcher): build web/dist when missing or stale before engine start"
```

---

## Task 5: Delete the legacy SPA + update docs

**Files:**
- Delete: `sidecar/public/app.html`
- Modify: `CLAUDE.md`, `README.md`, `HANDOFF.md`, `web/package.json`, `web/vite.config.ts`

- [ ] **Step 1: Delete the file**

```bash
git rm sidecar/public/app.html
```
(If `sidecar/public/` is now empty, it'll disappear from git automatically.)

- [ ] **Step 2: Update docs to "single React UI"**

- `CLAUDE.md`: the "## Two UIs coexist" section → rewrite to a single "## The web app — React (`web/`), served from `web/dist`" note: built by the launcher, served by the engine at `/`, `/api/*` rewrite. Update the architecture ASCII box that says `sidecar/public/app.html (one HTML file, ~10k lines)` → `web/dist (React build)`.
- `README.md`: the passages at ~178, ~188, ~196, ~662 describing `app.html` as the UI → describe the React build served from `web/dist`; "Typical request: browser loads `/` → React index → reads token from URL fragment → `/api/*` calls (engine strips `/api`)".
- `HANDOFF.md`: add a TL;DR entry "Legacy SPA retired — engine serves `web/dist`"; update/replace the "When the migration is fully done" note (it described exactly this task) to past tense.
- `web/package.json`: description "gradually replaces sidecar/public/app.html" → "Hon's web UI (React), served from web/dist by the engine."
- `web/vite.config.ts`: the comment block (~16-22) referencing "a follow-up commit replaces the public/app.html line in server.ts" → "the engine serves this build from web/dist (see sidecar/src/server.ts)."

> **VERIFY:** grep `app.html` across the repo after editing (`grep -rn "app.html" --include=*.md --include=*.ts --include=*.json . | grep -v node_modules | grep -v /dist/`). The only remaining hits should be the `// lifted from app.html` provenance comments in `web/src/**` (intentionally kept) and the spec/plan docs. No functional code or top-level doc should still describe app.html as the live UI.

- [ ] **Step 3: Typecheck both (docs/json don't break types, sanity)**

Run: `cd web && npm run typecheck` && `cd ../sidecar && npm run typecheck` → clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete legacy SPA (app.html); docs → single React UI"
```

---

## Task 6: Full verification (the "done" gate)

- [ ] **Step 1: Build + suites + typechecks**

```bash
cd web && npm run build        # exits 0, regenerates web/dist
cd web && npm test             # green (≈551)
cd web && npm run typecheck    # clean
cd ../sidecar && npm test      # green (≈129 incl. new httpRewrite test)
cd ../sidecar && npm run typecheck  # clean
```

- [ ] **Step 2: Live serve verification (PROJECT-RULES §2 — hard gate)**

This is the critical proof: the ENGINE (not vite) serves the React app.
1. Stop any running engine/vite: `pkill -9 -f 'tsx.*server\.ts|node.*web\.mjs|[v]ite'`.
2. From the worktree, run the engine directly so it serves THIS branch's `web/dist`:
   `cd sidecar && node web.mjs` (it builds dist if stale, then serves on :4000).
   - Confirm the console shows the build step ran (or dist already fresh) and the engine bound.
3. Read the token: `cat "$HOME/Library/Application Support/Hon/dev-token"`.
4. chrome-devtools: navigate to `http://127.0.0.1:4000/#token=<TOKEN>` (the ENGINE port — no vite).
5. Screenshot the app shell + click Overview, Assets, Activity, Insights — each renders.
6. In the network panel, confirm: `GET /` 200 (HTML), `GET /assets/index-<hash>.js` 200, `/api/<route>` calls 200 (NOT 401, NOT 404) — proves rewrite + auth + static all work end-to-end.
7. Confirm it's the React app (e.g. the React-only tabs/components), not the legacy SPA.

Only after these screenshots exist may the work be called done. Restore the user's normal engine afterward.

- [ ] **Step 3: Merge prep**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon
git log --oneline main..session/retire-legacy-spa-2026-05-31
git diff main...session/retire-legacy-spa-2026-05-31 --stat
```
Show the diff; do NOT push without explicit go-ahead (PROJECT-RULES §3).

- [ ] **Step 4: HANDOFF** — finalize the "legacy SPA retired" entry (merged + how to run).

---

## Self-review notes

- **Spec coverage:** @fastify/static (T2,T3) · serve index at / (T3) · `/api` rewrite (T1 helper + T3 wiring) · `/assets/` public (T3) · launcher build-if-stale (T4) · delete app.html + docs (T5) · build/suite/typecheck/visual (T6). All spec sections mapped.
- **Test strategy honors reality:** server.ts isn't importable (runs `listen` at load, no exports), so the required automated test is the pure `rewriteApiPrefix` helper (T1); the serve/auth/static behavior is proven by the launcher + chrome-devtools visual verification (T6), per the project's manual-route-test convention. The plan deliberately does NOT refactor server.ts into `buildServer()`.
- **Flagged confirm-before-coding (real checks w/ named fallbacks, not placeholders):** Fastify 5 `rewriteUrl` signature (T3 S2); `@fastify/static` `index:false`/`wildcard:false` vs the tighter `prefix:'/assets/'`+`root:dist/assets` form — **prefer the tight form if any doubt** (T3 S4); `../../web/dist` path depth (T3 S3); web.mjs fs-import fold + `here`→`web` path (T4); residual `app.html` grep (T5 S2).
- **No DB/schema/TXN_COLS changes.** Type consistency: `rewriteApiPrefix` defined T1, consumed T3; same signature both places.
