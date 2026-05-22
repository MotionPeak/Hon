#!/usr/bin/env node
// Starts Hon's local engine and opens the web app in your browser.
// Cross-platform — macOS, Linux, and Windows. Nothing leaves this computer:
// the engine binds 127.0.0.1 only, and the web app is authenticated with a
// fresh token generated for this run.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.chdir(here);

const port = process.env.HON_PORT || '4000';
// Reuse a token from the environment when one is set — a server keeps the same
// token across restarts so its URL stays stable; otherwise generate a fresh
// one for this run.
const token = process.env.HON_TOKEN || randomUUID();
const url = `http://127.0.0.1:${port}/#token=${token}`;
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

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  stdio: 'inherit',
  env: { ...process.env, HON_PORT: port, HON_TOKEN: token },
});
server.on('exit', (code) => process.exit(code ?? 0));
