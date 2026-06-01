#!/usr/bin/env node
// Starts Hon's local engine and opens the web app in your browser.
// Cross-platform — macOS, Linux, and Windows. Nothing leaves this computer:
// the engine binds 127.0.0.1 only, and the web app is authenticated with a
// fresh token generated for this run.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.chdir(here);

// Hon skips Puppeteer's bundled Chrome download at install (see .npmrc) —
// 170 MB that Windows AV routinely quarantines mid-extract, and that nearly
// every machine already has installed via a regular Chrome install. So at
// launch time, find the installed Chrome (or Edge as a fallback) and point
// Puppeteer at it. Honours PUPPETEER_EXECUTABLE_PATH when the user set it.
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  const candidates = process.platform === 'win32'
    ? [
        `${process.env.ProgramFiles || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.ProgramFiles || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env['ProgramFiles(x86)'] || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]
    : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        `${process.env.HOME || ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ];
  const found = candidates.filter(Boolean).find((p) => existsSync(p));
  if (found) {
    process.env.PUPPETEER_EXECUTABLE_PATH = found;
    console.log(`Using installed browser: ${found}`);
  } else {
    console.warn(
      '\n⚠  No installed Chrome found. Hon needs Chrome (or Chromium / Edge)' +
      '\n   to scrape banks and pension portals. Install Chrome from' +
      '\n   https://www.google.com/chrome/ and re-run `npm run web`.\n',
    );
  }
}

const port = process.env.HON_PORT || '4000';

// --skip-web-build: vite is serving the React app on :5173 (with the /api → :4000
// proxy), so the engine doesn't need a fresh web/dist build. Saves ~2s on every
// dev launch and — more importantly — lets `npm run dev` boot even when the
// TypeScript checker is unhappy about something the user hasn't fixed yet. Also
// flips the auto-opened browser URL from :4000 → :5173 so the user lands on the
// hot-reloading dev server, not the stale built copy.
const skipWebBuild = process.argv.includes('--skip-web-build');

// Resolve the OS-default Hon data dir (overridable with HON_DATA_DIR) — same
// dir the engine uses for the SQLite DB, the vault, and sidecar.log. The
// persistent dev token lives here too so the URL stays the same across
// restarts and stays bookmarkable.
const honDataDir = process.env.HON_DATA_DIR ?? (
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Hon')
    : process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Hon')
      : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'Hon')
);

/** Read the on-disk token (creating one on first run) so the user's bookmarked
 *  http://localhost:5173/#token=<uuid> URL keeps working across restarts. The
 *  token gates the engine's HTTP API — anything on the local machine can hit
 *  127.0.0.1:4000, so without auth a random browser tab could read finances. */
function loadOrCreateToken() {
  const tokenPath = join(honDataDir, 'dev-token');
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    // UUID v4 sanity check; regenerate if the file got mangled.
    if (/^[0-9a-f-]{32,40}$/i.test(existing)) return existing;
  } catch { /* no file yet */ }
  const fresh = randomUUID();
  try {
    mkdirSync(honDataDir, { recursive: true });
    writeFileSync(tokenPath, fresh, 'utf8');
    // Best-effort tight perms — the token is a credential.
    try { chmodSync(tokenPath, 0o600); } catch { /* Windows: ignore */ }
  } catch { /* fall back to in-memory only — URL still works for this run */ }
  return fresh;
}

// Token precedence: env override > on-disk persistent > fresh-and-saved.
const token = process.env.HON_TOKEN || loadOrCreateToken();
// In dev mode the user wants vite's hot-reloading server (:5173), not the
// engine-served built copy (:4000). The token works against either since
// vite proxies /api/* through to the engine.
const url = skipWebBuild
  ? `http://localhost:5173/#token=${token}`
  : `http://127.0.0.1:${port}/#token=${token}`;
const isWindows = process.platform === 'win32';
// Headless hosts (a NAS, a server) have no browser to open.
const headless = process.env.HON_HEADLESS === '1';

// First run: install dependencies.
if (!existsSync(join(here, 'node_modules'))) {
  console.log('Installing dependencies (first run only)…');
  const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['install'], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

// Ensure the React build exists and is fresh before the engine serves it.
// (web/dist is gitignored; built on demand so `npm run web` stays one command.)
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
  const srcNewest = newestMtime(join(webDir, 'src'));
  const cfgFiles = ['index.html', 'package.json', 'vite.config.ts']
    .map((f) => join(webDir, f))
    .filter((f) => existsSync(f))
    .map((f) => statSync(f).mtimeMs);
  const inputNewest = Math.max(srcNewest, ...cfgFiles);
  return inputNewest > builtAt;
}

if (skipWebBuild) {
  console.log('Skipping web/dist build (dev mode — vite serves the UI on :5173).');
} else if (buildIsStale()) {
  console.log('Building the web app (web/dist is missing or out of date)…');
  const build = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: webDir,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (build.status !== 0) {
    console.error('Web build failed — not starting the engine.');
    process.exit(build.status || 1);
  }
}

// Open the default browser once the engine has had a moment to bind.
function openBrowser() {
  try {
    if (isWindows) {
      // `shell: true` keeps the URL fragment (#token=…) intact inside quotes.
      spawn(`start "" "${url}"`, { shell: true, stdio: 'ignore', detached: true }).unref();
    } else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // Headless machine — the URL is printed below for the user to open.
  }
}
if (!headless) setTimeout(openBrowser, 2000);

console.log(`Hon engine starting — web app at ${url}`);
if (headless) {
  console.log('Headless mode — open the URL above from another machine.');
}

// Tee the engine's stderr to a rotating-per-launch log file so a crashed
// scrape leaves an inspectable trail without the user having to keep the
// launch terminal open. Uses the same honDataDir as the SQLite DB and the
// dev token — the directory is already mkdir'd by loadOrCreateToken on
// first run, but mkdirSync is idempotent so we re-call it for safety.
let stderrTarget = 'inherit';
try {
  mkdirSync(honDataDir, { recursive: true });
  const logPath = join(honDataDir, 'sidecar.log');
  stderrTarget = openSync(logPath, 'w');
  console.log(`Engine logs → ${logPath}`);
} catch (err) {
  // Fall back to the launching terminal if the log file can't be opened.
  console.log(`(Could not open the engine log file: ${err.message}. Streaming to terminal instead.)`);
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  stdio: ['inherit', 'inherit', stderrTarget],
  env: { ...process.env, HON_PORT: port, HON_TOKEN: token, HON_LOG_DEBUG: '1' },
});
server.on('exit', (code) => process.exit(code ?? 0));
