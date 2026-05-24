// Hon desktop shell.
//
// Spawns the Hon sidecar as a child process (running the same Node engine
// already in `../sidecar`), waits for it to bind a loopback port, then opens
// a window pointing at the local web UI.  When the window closes, the child
// is terminated so we don't leak background processes.
//
// In development (`npm start` from this folder) the sidecar's source lives
// at `../sidecar`.  In a packaged build it lives next to the app under
// `process.resourcesPath/sidecar`.

const { app, BrowserWindow, shell, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

// --- Paths ----------------------------------------------------------------

// Where the sidecar lives.  `app.isPackaged` is true inside a built app.
const SIDECAR_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'sidecar')
  : path.join(__dirname, '..', 'sidecar');
const SIDECAR_ENTRY = path.join(SIDECAR_DIR, 'src', 'server.ts');

// --- Sidecar lifecycle ----------------------------------------------------

let sidecarProcess = null;
let mainWindow = null;
let sidecarShutdown = false;

/** Asks the OS for a free TCP port on loopback. Avoids the 4000-in-use case
 *  we used to hit when multiple sidecars stacked up. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Waits until the sidecar is accepting connections on `port`, or rejects
 *  after `timeoutMs` of trying.  Polls with a 200 ms gap. */
function waitForSidecar(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      let done = false;
      sock.once('connect', () => {
        done = true;
        sock.end();
        resolve();
      });
      sock.once('error', () => {
        if (done) return;
        if (Date.now() > deadline) {
          reject(new Error(`Sidecar did not bind ${port} within ${timeoutMs} ms.`));
        } else {
          setTimeout(tryOnce, 200);
        }
      });
    };
    tryOnce();
  });
}

async function startSidecar() {
  const port = await pickFreePort();
  const token = crypto.randomUUID();

  // Electron's own Node binary doubles as the runtime when ELECTRON_RUN_AS_NODE
  // is set, so the bundled Node version (matching the sidecar's >=22.12 ask)
  // runs the sidecar — no separate Node install needed on the user's machine.
  //
  // `tsx` transpiles the TypeScript source on the fly, the same way `web.mjs`
  // does in development.  It must be in the sidecar's node_modules (it already
  // is, as a devDependency the bundled npm install pulls in).
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HON_TOKEN: token,
    HON_PORT: String(port),
    HON_HOST: '127.0.0.1',
  };

  sidecarProcess = spawn(
    process.execPath,
    ['--import', 'tsx', SIDECAR_ENTRY],
    { cwd: SIDECAR_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Forward the sidecar's logs to our own stdout/stderr so they show up under
  // `electron .` and in packaged-app crash diagnostics.
  sidecarProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[sidecar] ${chunk}`);
  });
  sidecarProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[sidecar:err] ${chunk}`);
  });

  // If the sidecar dies on its own (not as part of an app quit), there's no
  // app left — exit so we don't leave a window pointed at a dead server.
  sidecarProcess.on('exit', (code, signal) => {
    sidecarProcess = null;
    if (!sidecarShutdown) {
      console.error(`Sidecar exited unexpectedly (code=${code} signal=${signal}).`);
      app.exit(code ?? 1);
    }
  });

  await waitForSidecar(port, 30_000);
  return { port, token };
}

function stopSidecar() {
  if (!sidecarProcess) return;
  sidecarShutdown = true;
  const child = sidecarProcess;
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  // Give the sidecar two seconds to close its DB / browser cleanly, then
  // force-kill if it's still around.
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 2_000);
}

// --- Window ---------------------------------------------------------------

function createWindow(port, token) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: '#1a1612', // matches the dark warm bg in app.html
    title: 'Hon',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links (e.g. SnapTrade portal, Splitwise dev page) open in the
  // system browser instead of inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Reveal once the page has loaded so the user never sees a flash of bg.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  void mainWindow.loadURL(`http://127.0.0.1:${port}/#token=${token}`);
}

// --- App boot -------------------------------------------------------------

app.setName('Hon');

// One window per app launch — clicking the dock icon while it's open just
// focuses, not relaunch.
const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32' || process.platform === 'linux') {
      // Hide the Edit/File/View menu on Windows/Linux — Hon has no use for it.
      Menu.setApplicationMenu(null);
    }
    try {
      const { port, token } = await startSidecar();
      createWindow(port, token);
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow(port, token);
      });
    } catch (err) {
      console.error('Failed to start the sidecar:', err);
      app.exit(1);
    }
  });
}

app.on('window-all-closed', () => {
  // macOS convention: apps stay running until the user explicitly quits. On
  // every other OS, closing the last window quits.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopSidecar);

// Belt and braces — if Electron dies on a signal, still try to take the child.
process.on('SIGTERM', () => { stopSidecar(); app.quit(); });
process.on('SIGINT',  () => { stopSidecar(); app.quit(); });
