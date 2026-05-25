# Hon

**A local-first personal finance aggregator.** Hon pulls balances and
transactions from Israeli banks, credit cards, brokerages and pension funds,
categorizes spending with AI, and builds budgets and insights — entirely on
your own machine. **No financial data ever leaves your computer.** There is no
Hon server, no account, no telemetry.

Hon is **primarily a local web app** — the engine runs on your own machine
and serves a UI you open in your browser. A thin desktop wrapper is also
packaged for **macOS, Linux, and Windows** for people who'd rather launch
Hon like any other app, but underneath it's the same web UI talking to the
same local engine; nothing about the data path changes.

## Run Hon

### Web app (the main way)

Hon is primarily a local web app. Clone the repo and start the engine — it
serves the UI on `http://127.0.0.1:4000` in your default browser, with a
fresh authentication token generated for each run. The engine binds to
loopback only; nothing leaves your machine.

```bash
git clone https://github.com/MotionPeak/Hon.git
cd Hon/sidecar
npm install        # first run: builds native modules, downloads Chromium
npm run web        # opens http://127.0.0.1:4000 in your browser
```

`npm run web` is cross-platform. You can also launch the engine directly:

- **macOS / Linux** — `./web.sh`
- **Windows** — double-click `web.cmd`, or run `web.cmd` in a terminal

Requires [Node.js](https://nodejs.org) 22.12 or later, and
[Google Chrome](https://www.google.com/chrome/) installed system-wide (Hon
drives your installed Chrome for scraping — see
[How Hon finds Chrome](#how-hon-finds-chrome) for the discovery order).

#### Setting up on Windows (from scratch)

If `node`, `npm`, or `git` aren't installed yet, do these first — the
quickstart above runs the same way on Windows once they are in place.

1. **Install Node.js.** Open PowerShell and run:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
   Or download the LTS `.msi` from [nodejs.org](https://nodejs.org/) and
   click through with the defaults. **Close the terminal** and open a fresh
   one so the new `PATH` takes effect.

2. **Install Git for Windows.**
   ```powershell
   winget install --id Git.Git -e
   ```
   Or download it from [git-scm.com](https://git-scm.com/download/win). The
   installer bundles **Git Credential Manager** — for a private repo it pops
   a browser window the first time you clone and then caches the login.

3. **Clone, install, run.** In a fresh `cmd` or PowerShell window:
   ```cmd
   cd %USERPROFILE%
   git clone https://github.com/MotionPeak/Hon.git
   cd Hon\sidecar
   npm install
   npm run web
   ```

##### Windows-specific gotchas

- **`#` is not a comment in `cmd.exe`.** If you copy a line like
  `npm install  # first run: builds native modules`, `cmd` passes the
  `#…` part to npm as an argument and you get
  `EINVALIDTAGNAME: Invalid tag name "#"`. Strip everything from the `#`
  onward when you copy from a README — or paste into PowerShell, which
  does treat `#` as a comment.
- **Where to run the commands.** `npm install` and `npm run web` only
  work from inside the `Hon\sidecar` folder (that's where `package.json`
  lives). If you see `Could not read package.json` you're in the wrong
  directory — `cd Hon\sidecar` first.
- **Native modules.** `npm install` pulls
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (native)
  and downloads Puppeteer's Chromium (~170 MB). On Node 22 LTS the
  prebuilt `better-sqlite3` binary usually drops in cleanly, so no
  compiler is needed. If it *does* fall back to compiling (you'll see
  `node-gyp` errors), install the
  [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-studio-build-tools/)
  with the **"Desktop development with C++"** workload and re-run
  `npm install`.
- **Long paths.** Puppeteer's Chromium cache nests deep enough that it
  can hit Windows' 260-character path limit on some setups. If
  `npm install` errors with `ENAMETOOLONG`, enable long paths once in an
  admin PowerShell and reboot:
  ```powershell
  Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" -Value 1
  ```
- **"No installed Chrome found" at first launch.** Hon uses your installed
  Chrome to scrape — no bundled-Chrome download fight with Defender, no
  170 MB extra to install. If you don't have Chrome yet, grab it from
  <https://www.google.com/chrome/> and re-run `npm run web`. Hon will
  also find Microsoft Edge if Chrome isn't there. The exact paths it
  checks (and how to override them) are in
  [How Hon finds Chrome](#how-hon-finds-chrome).

- **Running inside a Parallels (or other) VM?** If the engine runs on
  your Mac and you only want the UI on the Windows side, leave the
  engine on the Mac and point Edge/Chrome inside the VM at the Mac's
  Parallels-Shared address (Parallels → Devices → Network shows it,
  typically something like `http://10.211.55.2:4000`). One engine, two
  browsers — no need to clone the repo into the VM at all.

### Desktop app (a wrapper around the same engine)

If you'd rather double-click an icon than open a terminal, grab the installer
for your OS from the
[**latest release**](https://github.com/MotionPeak/Hon/releases/latest):

| OS | File | First-launch trust step |
| --- | --- | --- |
| **macOS — Apple Silicon (M-series)** | `Hon-macOS-arm64-x.y.z.dmg` | Drag `Hon.app` to `/Applications`, then in Terminal: `xattr -cr /Applications/Hon.app` and double-click. See note ↓. |
| **macOS — Intel** | `Hon-macOS-x64-x.y.z.dmg` | Drag `Hon.app` to `/Applications`, then in Terminal: `xattr -cr /Applications/Hon.app` and double-click. See note ↓. |
| **Windows** | `Hon-Windows-x.y.z-Setup.exe` | SmartScreen says "Windows protected your PC". Click **More info → Run anyway**. Once. |
| **Linux** | `Hon-Linux-x.y.z.AppImage` | `chmod +x Hon-*.AppImage` and double-click, or run from a terminal. |

The installers bundle Node and the engine — no separate install. They are
**unsigned** (Hon is one person's local-first project, not a commercial app
with a paid developer cert), so each platform's one-time trust step above
fires on first launch.

> **Note on the macOS step.** Recent macOS versions show *"Hon" is damaged
> and can't be opened* on an unsigned app downloaded via a browser — the
> right-click → Open trick no longer works once Apple marks it quarantined.
> The `xattr -cr /Applications/Hon.app` command strips that quarantine
> flag; macOS then trusts it like any locally-built app. Run it once,
> right after dragging Hon into Applications.

Running Hon on an always-on machine you can reach from anywhere? See
[NAS or home server](#run-it--nas-or-home-server).

---

## How Hon is built

Hon is two thin things: an **engine** that runs locally on your machine, and
the **web UI** it serves to your browser. Both ship from this repo.

```
        ┌──────────────────────────────────────────────────────────┐
        │ Your machine                                             │
        │                                                          │
        │  ┌─────────┐  HTTP (127.0.0.1)  ┌────────────────────┐   │
        │  │ Browser │ ◀────────────────▶ │ Engine (Node)      │   │
        │  │  (web   │                    │  • Fastify server  │   │
        │  │   UI)   │                    │  • Puppeteer       │   │
        │  └─────────┘                    │  • node-llama-cpp  │   │
        │                                 │  • SQLite (hon.db) │   │
        │                                 └─────────┬──────────┘   │
        │                                           │              │
        │                                           ▼              │
        │                              ┌──────────────────────┐    │
        │                              │  ~/.../Hon/          │    │
        │                              │  hon.db, models/,    │    │
        │                              │  browser-profiles/   │    │
        │                              └──────────────────────┘    │
        └────────────────┬─────────────────────────────────────────┘
                         │ outbound only — your data never goes to
                         ▼ a Hon-run server; see External APIs below.
        ┌──────────────────────────────────────────────────────────┐
        │ Each bank/card portal · SnapTrade · Splitwise · etc.     │
        └──────────────────────────────────────────────────────────┘
```

**Engine.** All of Hon's logic lives in `sidecar/` — TypeScript on Node 22,
run directly with `tsx`. It binds [Fastify](https://fastify.dev) to
`127.0.0.1` and serves both the REST API and the static `app.html` web UI.
Bank/card scraping uses
[`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers)
in a Puppeteer-controlled Chromium; pension portals use Hon's own Puppeteer
connector (`src/pension.ts`); brokerages go through the SnapTrade SDK.
Categorisation and insights call the on-device LLM via
[`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) (or your own
Ollama). Everything persists in a single SQLite file via
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).

**Web UI.** A single self-contained `public/app.html` — vanilla JS, no build
step. The engine serves it at `/`, and the API calls carry a per-launch
bearer token the page reads from the URL fragment.

**Desktop wrapper (optional).** A thin Electron shell (`electron/`) that
spawns the same engine and points a window at it. Same engine, same web UI,
just packaged as a double-clickable app per OS.

**Typical request.** Browser loads `/` → `app.html` reads the token from
`location.hash` → fetches `/accounts`, `/transactions`, `/budget`, etc. with
`Authorization: Bearer <token>` → the engine reads SQLite and answers JSON.

**Typical sync.** User taps **↻ Sync** → `POST /connections/:id/scrape` →
the runner launches a Puppeteer browser, replays any saved session cookies
(so a re-sync can skip the login), runs the bank scraper / pension connector
/ SnapTrade SDK, normalises the result and upserts accounts + transactions
in the DB. The UI polls `/scrape/:runId` until done.

---

## Contents

- [What Hon does](#what-hon-does)
- [Security — the credential vault](#security--the-credential-vault)
- [Recovering your credentials](#recovering-your-credentials)
- [Splitwise integration](#splitwise-integration)
- [AI engine](#ai-engine)
- [Tech stack & tools](#tech-stack--tools)
- [Run it — NAS or home server](#run-it--nas-or-home-server)
- [Setup inside the app](#setup-inside-the-app)
- [Where data lives](#where-data-lives)
- [External APIs & data sources](#external-apis--data-sources)
- [Environment variables](#environment-variables)
- [How Hon finds Chrome](#how-hon-finds-chrome)
- [Troubleshooting & diagnostics](#troubleshooting--diagnostics)
- [Project layout](#project-layout)
- [Sidecar scripts](#sidecar-scripts)
- [Build the desktop installers](#build-the-desktop-installers)

---

## What Hon does

**Account aggregation.** One dashboard across every kind of account:

| Source | How |
| --- | --- |
| Israeli banks & credit cards | [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers) in a Hon-controlled headless browser |
| Brokerages (Interactive Brokers, etc.) | [SnapTrade](https://snaptrade.com) — read-only, via your own developer key |
| Pension / gemel / study funds (קרן השתלמות) | a custom Puppeteer connector that drives each provider's member portal |
| Manual assets — cars, property, cash | entered by hand; a car's value is estimated from its plate via the [data.gov.il](https://data.gov.il) vehicle registry |

**Two-factor login.** Banks that demand an SMS one-time code are handled live:
the engine watches the bank page, prompts you in-app for the code, enters it and
continues — no browser babysitting.

**Categorization.** Every transaction lands in a fixed category via a layered
pipeline: user rules → a built-in Hebrew/English merchant rule map → the
on-device LLM for whatever is left.

**Activity, billing cycles & budgets.** Activity is grouped by your real billing
cycle (set a custom cycle start day, e.g. the day your card bill is debited).
Essentials get per-category budgets; the discretionary "variable" allowance is
derived from income minus committed spending.

**Projected budget.** Fixed bills are reserved as a monthly-equivalent — a
bimonthly bill counts every cycle at half, a yearly subscription at a
twelfth — and income is averaged from *recurring* sources only (auto-detected,
or marked by hand), so the budget reflects what to expect, not just what has
posted. Fully toggleable in Settings.

**Insights.** A trailing 12-cycle spending chart, per-cycle drill-down with
difference-from-last-cycle and difference-from-average for the total and every
category, and an optional AI-written summary.

**Subscriptions.** Recurring charges are grouped per merchant, normalized to a
monthly cost, and a lapsed one is kept out of "probably cancelled" when the AI
recognizes it as the same service under a renamed billing descriptor.

**Savings goals.** Piggy banks track money set aside each month toward a target.

**Reimbursements.** Link a refund or a [Splitwise](#splitwise-integration)
repayment to the expense it offsets, so spending totals count the real net.

---

## Security — the credential vault

Hon never sends your credentials anywhere, and never stores them in plaintext.

- Bank/card credentials go into an encrypted **vault** inside the local SQLite
  database (`sidecar/src/vault.ts`):
  - **AES-256-GCM** authenticated encryption for every credential blob.
  - The key is derived from your passphrase with **scrypt** (random per-vault
    salt). The passphrase itself is **never stored** — only a known verifier
    string encrypted under the derived key, so a wrong passphrase is rejected
    without the passphrase ever touching disk.
  - The derived key lives **in memory only**, for the lifetime of the engine
    process. Lock the vault (or quit) and it is gone.
- The same vault encrypts other secrets that outlive a connection — e.g. the
  SnapTrade user token — as named, AES-256-GCM blobs rather than a plaintext
  file on disk.
- The HTTP engine binds to **loopback only** and every request carries a bearer
  token freshly generated each launch.

---

## Recovering your credentials

Sometimes you need a bank password back out of Hon — to log in by hand, to move
it to a password manager, or just to confirm what you typed years ago. The
vault is fully local, so a tiny self-contained script can decrypt it on the
same machine:

```bash
cd sidecar
node recover-creds.mjs
# Vault passphrase: ****
```

It opens `hon.db` **read-only**, asks for your vault passphrase, checks it
against the stored verifier, and prints every connection's stored credentials
to your terminal. It writes nothing — close the terminal and the secrets are
gone again.

The script (`sidecar/recover-creds.mjs`) is ~60 lines of straightforward
Node — read it before running, especially if you got it from anyone other than
this repo. It only works on the machine that holds the vault; without the
passphrase the database is just ciphertext.

> On Linux/Windows the hard-coded path in the script is the macOS one. Edit
> the `join(...)` call near the top to point at `hon.db` in your platform's
> [data directory](#where-data-lives) — or run with `HON_DATA_DIR` already
> set and adapt the script to read it.

---

## Splitwise integration

Hon links to [Splitwise](https://www.splitwise.com) so a shared expense can be
split straight from a transaction (`sidecar/src/splitwise.ts`):

- Connect with your own Splitwise API key — verified on entry.
- From any transaction, pick the friends/group and split it; Hon creates the
  matching Splitwise expense and records who owes what.
- The Overview shows an **"Owed to you"** card summarizing outstanding balances.
- Splitwise has no per-expense "settled" flag and no webhooks, so Hon infers the
  paid state on each refresh by matching settle-up payment records to the linked
  expenses, oldest first.

---

## AI engine

AI powers three things:

1. **Categorization** — classifies transactions the rule map can't, constrained
   to the fixed category list with a JSON schema.
2. **Insights** — an optional written summary of the cycle's spending.
3. **Subscription matching** — decides whether a lapsed subscription is the same
   merchant as an active one under a renamed descriptor.

Pick one of three engines in **Settings → AI engine**:

- **On-device model** — a local **GGUF** model run via
  [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp). Not bundled;
  download one from inside the app (≈2.1 GB). Runs entirely on this computer —
  nothing is sent anywhere. Best for privacy, but needs a reasonably capable
  machine.
- **Ollama server** — point Hon at any [Ollama](https://ollama.com) server: a
  local Ollama install, or **Ollama Cloud's free tier** (paste its API key) for
  computers that can't run a model locally.
- **API service** — any **OpenAI-compatible** chat API. The easiest free option
  is [Groq](https://console.groq.com) — sign up, copy a key, and paste it with
  the URL `https://api.groq.com/openai/v1` and a model like
  `llama-3.3-70b-versatile`. Also works for OpenRouter, Google Gemini's OpenAI
  endpoint, a local LM Studio, etc.

The Ollama and API options send transaction descriptions to whichever server
you pick. The on-device option does not.

---

## Tech stack & tools

**Engine** — TypeScript on Node 22, run directly with `tsx`:

| Tool | Role |
| --- | --- |
| [`fastify`](https://fastify.dev) | HTTP server on `127.0.0.1` — the API and the web UI |
| [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | local SQLite storage (accounts, transactions, budgets, encrypted credentials) |
| [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers) | bank & credit-card scraping |
| [`puppeteer`](https://pptr.dev) | headless Chromium — interactive 2FA scrapes and the pension-portal connector |
| [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) | on-device LLM inference (GGUF) |
| [`snaptrade-typescript-sdk`](https://snaptrade.com) | brokerage aggregation |
| Node `crypto` | the credential vault — AES-256-GCM + scrypt |
| [`patch-package`](https://github.com/ds300/patch-package) | a local patch to `israeli-bank-scrapers` (`sidecar/patches/`) |
| [`tsx`](https://github.com/privatenumber/tsx) · [`typescript`](https://www.typescriptlang.org) | run & type-check TypeScript |

The Splitwise client and the data.gov.il vehicle lookup are hand-written REST
clients — no SDK.

---

## Run it — NAS or home server

Run Hon once on an always-on machine — a Synology/QNAP/Unraid NAS, a home
server, a Raspberry Pi — and reach the same dashboard from your laptop and
phone. The shipped Docker setup is the easy path.

```bash
cd sidecar
cp .env.example .env          # then put a long random secret in HON_TOKEN
docker compose up -d --build
```

Open `http://<server-address>:4000/#token=<your HON_TOKEN>`. The vault, the
SQLite database and any downloaded AI model persist in the `hon-data` volume,
so restarts and rebuilds keep your data.

Not using Docker? The engine is plain Node — run it directly on the server:

```bash
HON_HOST=0.0.0.0 HON_TOKEN=<long-random-secret> npm start
```

**Reaching it from everywhere — safely.** Hon holds your bank logins, so do
**not** port-forward it to the public internet. Instead put the server on a
private VPN and reach Hon through that:

- Install [Tailscale](https://tailscale.com) (free for personal use) on the
  server and on each device you'll use. Hon then answers on the server's
  Tailscale address from anywhere, with no ports opened to the internet.
- WireGuard, your router's built-in VPN, or a NAS feature like Synology VPN
  Server all work the same way.

Security notes:

- `HON_TOKEN` is the **only** thing gating the API — make it long and random,
  and treat it like a password. The engine **refuses to start** if it is bound
  beyond loopback without a token set.
- Data at rest is still protected by the vault passphrase you set on first run.
- To move Hon off port 4000, change the host side of the `ports:` mapping in
  `docker-compose.yml` (e.g. `"8800:4000"`).

## Setup inside the app

The repo ships with no data and no credentials. You configure these on first
run:

- **AI engine** — used for categorization and insights. In **Settings → AI
  engine**, either download an on-device model (≈2.1 GB, runs fully offline) or
  connect an Ollama server — a local Ollama or Ollama Cloud's free tier — for
  computers that can't run a model locally.
- **Israeli banks / credit cards** — add an account and enter your login
  credentials. They are stored locally in the password-protected vault.
- **Brokerages (SnapTrade)** — needs your own SnapTrade Client ID and Consumer
  Key from a free [SnapTrade](https://snaptrade.com) developer account. Enter
  them when adding a SnapTrade account, then link a brokerage through the
  connection portal.
- **Pension / study funds** — add the provider and sign in with your portal
  credentials (an SMS code is handled in-app).
- **Splitwise** (optional) — connect with your Splitwise API key to split
  transactions with friends.

## Where data lives

All local, in the OS-conventional app-data directory:

| OS | Default path |
| --- | --- |
| macOS | `~/Library/Application Support/Hon/` |
| Linux | `$XDG_DATA_HOME/Hon/` — falls back to `~/.local/share/Hon/` |
| Windows | `%APPDATA%\Hon\` — typically `C:\Users\<name>\AppData\Roaming\Hon\` |

Inside it:

| Path | What's in it |
| --- | --- |
| `hon.db` | The single SQLite database. Tables: `accounts`, `transactions`, `connections`, `credentials` (encrypted blobs), `sessions` (encrypted cookies), `categories`, `category_rules`, `budgets`, `monthly_savings`, `piggy_banks`, `subscriptions`, `cancelled_subscriptions`, `assets`, `loans`, `splitwise_*`, `scrape_runs`, `meta` (vault salt + verifier, schema version, settings). Schema lives in `sidecar/src/db.ts` and migrates forward in place. |
| `models/` | LLM model files (GGUF) downloaded from inside the app. Typically one ≈2 GB file; safe to delete to re-download. |
| `browser-profiles/` | One persistent Chromium profile per CAPTCHA-walled pension portal (currently Meitav and Menora). Once you sign in, the profile keeps the session so a re-sync skips the login. Delete a sub-folder to force a fresh sign-in. |
| `debug/` | Best-effort dumps written when a scrape fails — see below. |
| `logos/` | Cached institution favicons (`src/logos.ts` fetches each once on first use). |

### `debug/` — what gets written, when

When a scrape or pension connector fails the runner snapshots whatever state
it can into `<data-dir>/debug/`, named by the company so each provider only
keeps its most recent failure (the previous run's files get overwritten). All
files are local; nothing is uploaded anywhere.

| File | Source | When |
| --- | --- | --- |
| `<companyId>.png` | `runner.ts` — full-page screenshot | Any scrape failure where a Puppeteer page was still alive |
| `<companyId>-pension.html` | `pension.ts` — rendered DOM of the dashboard | Pension scrape ran but couldn't parse balances |
| `<companyId>-pension.json` | `pension.ts` — raw JSON the dashboard XHRs returned | Same as above, captured from the network |
| `<companyId>-harel-frame.html` | `pension.ts` — Harel's inner iframe DOM | Harel parse fell back to the iframe scraper |
| `bankLoan-<companyId>.html` | `bankLoans.ts` — loan portal page | Loan-list fetch couldn't find the loans table |

Override the path with the `HON_DATA_DIR` env var when launching the sidecar
(see [Environment variables](#environment-variables)). The directory is never
part of the repo; `*.db` and `data/` are gitignored.

## External APIs & data sources

Everything Hon talks to. No analytics, no telemetry, no Hon-run backend —
your data only goes to your institutions and the public/third-party services
below.

| Service | Used for | Endpoint(s) |
| --- | --- | --- |
| **Bank & card portals** (via [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers)) | Account balances + transactions | Each institution's own customer portal: Hapoalim, Leumi, Mizrahi-Tefahot, Discount, Mercantile, Union, FIBI group (Beinleumi / Otsar Hahayal / Massad / Pagi), Yahav, Max, Visa Cal, Isracard, Amex |
| **Pension portals** (Hon's own puppeteer connector — `src/pension.ts`) | Pension / gemel / קרן השתלמות balances | Migdal, Harel, Clal — automated OTP login; Meitav, Menora — visible Chromium window (you sign in once; cookies persist) |
| **SnapTrade** | Brokerage aggregation (Interactive Brokers, etc.) | `api.snaptrade.com` via [official SDK](https://snaptrade.com) |
| **Splitwise** | Shared-expense split tracking | `secure.splitwise.com/api/v3.0` — hand-written REST client (`src/splitwise.ts`) |
| **Yahoo Finance** | Holding price-history backfill (brokerage performance chart) | `query1.finance.yahoo.com/v8/finance/chart/{symbol}` (`src/marketData.ts`) |
| **data.gov.il** | Israeli vehicle registry — plate → make/model/year for the car asset | `data.gov.il/api/3/action/datastore_search` (`src/vehicle.ts`) |
| **Bank of Israel** | Prime interest rate — loan tracker | `boi.org.il/PublicApi/GetInterest` (`src/loans.ts`) |
| **CBS** (Israel Central Bureau of Statistics) | CPI history — for CPI-linked loan tracks | `api.cbs.gov.il/index/data/price?id=120010` (`src/loans.ts`) |
| **Ollama** *(optional)* | Remote LLM provider — alternative to the on-device model | A host you configure (e.g. `http://localhost:11434`) |
| **Institution favicons** | Logos in the UI | Each institution's own website — fetched once and cached on disk (`src/logos.ts`) |

The vault holds the credentials and per-connection session cookies, so a sync
can resume without re-typing or re-prompting whenever the institution still
accepts the saved session.

## Environment variables

Every knob the engine reads from the environment. Defaults are picked so
`npm run web` Just Works on a fresh machine; you only set these for Docker,
NAS, or unusual setups.

| Variable | Default | What it does |
| --- | --- | --- |
| `HON_TOKEN` | random per-launch | The bearer token gating every API call. Required when binding off-loopback (the engine refuses to start otherwise). For Docker/NAS, set a long random value in `.env`. |
| `HON_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` on a NAS/server to reach Hon from your LAN/VPN. |
| `HON_PORT` | `4000` | TCP port the engine listens on. |
| `HON_DATA_DIR` | OS app-data dir (see [Where data lives](#where-data-lives)) | Override the location of `hon.db`, `models/`, `browser-profiles/`, `debug/`. The Docker image points this at `/data` so the volume captures it. |
| `HON_PENSION_HEADFUL` | unset | When set (`1`), forces every pension scrape to launch a visible Chromium window — handy for debugging silent failures. Meitav/Menora are always headful. |
| `HON_BROWSER_NO_SANDBOX` | unset | Add Chromium's `--no-sandbox` flag. Needed in some Docker/Linux server setups; harmless on desktops. |
| `PUPPETEER_EXECUTABLE_PATH` | unset | Skip Puppeteer's bundled Chrome and drive the Chrome at this path instead. Handy on Windows when antivirus blocks the bundled download — point it at your installed Chrome (e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe`). Read by Puppeteer itself, not Hon. |
| `HON_LOG_DEBUG` | unset | Verbose logging across the engine — request bodies, scraper steps, LLM prompts. Off by default to keep logs readable. |
| `XDG_DATA_HOME` | unset | Standard XDG variable Hon honours on Linux when picking the default data dir. |
| `APPDATA` | set by Windows | Windows-only; standard env Hon honours when picking the default data dir. |

Read by the wrapper scripts:

- `web.sh`, `web.cmd` → just `exec node web.mjs "$@"`, so any env you export
  before launching is passed straight through.
- `web.mjs` → opens the browser to the printed URL once the engine reports
  ready, then leaves the engine running in the foreground. Ctrl-C kills both.

## How Hon finds Chrome

Hon drives **your installed Chrome** for every browser-based scrape (banks,
credit cards, pension portals). It does **not** ship a bundled Chromium —
the `npm install` step explicitly skips Puppeteer's bundled download
(`.npmrc` sets `puppeteer_skip_download=true`) because:

- it's 170 MB of redundant binary on machines that already have Chrome;
- on Windows, Defender and most third-party AVs routinely quarantine the
  bundled `chrome.exe` mid-extract, leaving a half-installed folder that
  fails verification and blocks the whole install.

**Discovery order at launch** (`sidecar/web.mjs`):

1. If `PUPPETEER_EXECUTABLE_PATH` is set, Hon uses that and skips discovery.
2. Otherwise it scans the standard install locations for the platform:

| OS | Paths checked, in order |
| --- | --- |
| **Windows** | `%ProgramFiles%\Google\Chrome\Application\chrome.exe` · `%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe` · `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` · `%ProgramFiles%\Microsoft\Edge\Application\msedge.exe` · `%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe` |
| **macOS** | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` · `~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` · `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` · `/Applications/Chromium.app/Contents/MacOS/Chromium` |
| **Linux** | `/usr/bin/google-chrome` · `/usr/bin/google-chrome-stable` · `/usr/bin/chromium` · `/usr/bin/chromium-browser` · `/snap/bin/chromium` |

The first one that exists wins, and Hon prints `Using installed browser: …`
at startup. If none match, Hon prints a clear "install Chrome" message
rather than crashing on the first scrape.

**To use a Chrome that lives elsewhere** (a portable build, a custom
install, a non-default channel), set `PUPPETEER_EXECUTABLE_PATH` before
launching. Get the full path from Chrome's `chrome://version` page,
"Executable Path" line.

- **macOS / Linux:**
  ```bash
  export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  npm run web
  ```
- **Windows:**
  ```cmd
  setx PUPPETEER_EXECUTABLE_PATH "C:\Program Files\Google\Chrome\Application\chrome.exe"
  ```
  `setx` writes the var permanently — **close the terminal and open a
  fresh one** so the new env is picked up.

## Troubleshooting & diagnostics

### Reading the logs

Both `npm run web` and the desktop wrapper print every request, scrape step
and warning to the terminal they were launched from. The desktop installer
hides this — to see what's happening when something fails, quit the app and
run `npm run web` from `sidecar/` instead, or set `HON_LOG_DEBUG=1` before
launching.

### When a scrape fails

1. Check the engine log for the company id and error message.
2. Look in `<data-dir>/debug/` — the [debug folder table](#debug--what-gets-written-when)
   says which files each connector leaves behind.
3. For pension portals, re-run with `HON_PENSION_HEADFUL=1` to watch the
   browser drive the page.
4. Open `<companyId>.png` — most "couldn't find the login form" errors are
   actually "the portal showed an OTP challenge we didn't expect" or
   "session is logged out".

### Reset a Meitav or Menora session

These portals use a persistent Chromium profile so you only sign in once.
If a profile gets stuck (the portal demands re-auth on every run, or shows
a CAPTCHA loop), delete the corresponding folder under
`<data-dir>/browser-profiles/` and try again. The next scrape opens a fresh
visible window and you sign in once more.

### Peek into the SQLite database

Anything `sqlite3`-compatible works:

```bash
sqlite3 "$HOME/Library/Application Support/Hon/hon.db" \
  '.tables' '.schema accounts' 'SELECT count(*) FROM transactions;'
```

Treat it as read-only unless you really know what you're doing — Hon owns
the schema and migrates forward, but won't repair a hand-edited DB.

### Recover credentials

See [Recovering your credentials](#recovering-your-credentials) — a
read-only `node recover-creds.mjs` prints what's stored, decrypted, after
asking for your vault passphrase.

### Forgot the vault passphrase

There's no recovery path — the passphrase is never stored anywhere. Delete
`hon.db` and start over, re-adding your connections from scratch. Account
history is gone with the DB.

### Card balance doesn't match the issuer's site

Hon counts pending charges and rescrapes the full card window every sync
(unlike bank accounts, which use a 14-day incremental window). If a card
balance is still off, re-sync once; persistent drift usually means the card
portal silently lost the saved session — open the connection's settings and
re-enter credentials.

### Where each connector lives in code

| Symptom | File |
| --- | --- |
| Bank/card scrape misbehaving | `sidecar/src/scrapers.ts` + `sidecar/patches/israeli-bank-scrapers+*.patch` |
| Pension portal failing | `sidecar/src/pension.ts` (per-provider helpers) |
| Brokerage / SnapTrade | `sidecar/src/snaptrade.ts`, `snaptradeUser.ts` |
| Loan tracker odd numbers | `sidecar/src/loans.ts` (Bank of Israel + CBS), `bankLoans.ts` (per-bank loan-list scrape) |
| Splitwise not syncing | `sidecar/src/splitwise.ts` |
| Categorization off | `sidecar/src/categorize.ts`, `llm.ts` |

## Project layout

```
sidecar/                Node engine — TypeScript, run via tsx
  src/                  every module is one concern; see table below
  public/app.html       the entire web UI in a single self-contained file
  patches/              patch-package patches applied on npm install
  recover-creds.mjs     read-only vault decrypt utility
  web.mjs               launcher: starts engine, opens browser
  web.sh, web.cmd       tiny per-OS wrappers around web.mjs
  Dockerfile            base image for the NAS / home-server install
  docker-compose.yml    one-shot bring-up for the same
  .env.example          starter env file for Docker (HON_TOKEN)
electron/               optional desktop shell — spawns the sidecar
  main.cjs              window + lifecycle
  builder.yml           electron-builder config (dmg / nsis / AppImage)
.github/workflows/
  release.yml           CI: build installers on tag push, attach to Release
```

### `sidecar/src/` — one file per concern

| File | What it owns |
| --- | --- |
| `server.ts` | Fastify routes, bearer-token middleware, request → repo wiring |
| `db.ts` | SQLite open, schema, the `MIGRATIONS` array that moves the DB forward, OS-correct default data dir |
| `repo.ts` | All SQL — every read/write of accounts, transactions, subs, savings, etc. |
| `vault.ts` | AES-256-GCM + scrypt vault; in-memory key only |
| `session.ts` | Encrypted per-connection cookie restore/persist for Puppeteer pages |
| `runner.ts` | Scrape orchestration: picks startDate, manages browsers, writes debug dumps, upserts results |
| `scrapers.ts` | Bridge to `israeli-bank-scrapers`, with the per-card-company quirks |
| `pension.ts` | Custom Puppeteer connector for Migdal/Harel/Clal/Meitav/Menora |
| `otp.ts` | The OTP/SMS dance — pauses scraping until the user pastes the code |
| `snaptrade.ts`, `snaptradeUser.ts` | SnapTrade SDK wiring + per-user token storage |
| `splitwise.ts` | Hand-written Splitwise REST client + split-from-transaction flow |
| `loans.ts` | Loan amortisation, Bank of Israel prime + CBS CPI history fetch |
| `bankLoans.ts` | Per-bank loan-list scrapers (separate from balance scrapes) |
| `categorize.ts` | Rules + Hebrew/English merchant map + LLM fallback |
| `llm.ts` | The three AI backends: on-device GGUF, Ollama, OpenAI-compatible |
| `budget.ts` | Cycle math, income/committed/variable derivation, savings cap |
| `subscriptions.ts` | Recurring-charge detection, cancellation flagging |
| `piggy.ts` | Savings-goal "piggy bank" balances |
| `insights.ts` | Per-cycle drill-down + optional AI written summary |
| `analytics.ts` | Trailing 12-cycle spending series for the chart |
| `marketData.ts` | Yahoo Finance price-history backfill for holdings |
| `discountSavings.ts` | Discount Bank's separate "savings deposits" portal |
| `vehicle.ts` | data.gov.il plate → make/model/year lookup for car assets |
| `fx.ts` | FX rates for non-ILS holdings (cached) |
| `logos.ts` | Institution favicon fetch + on-disk cache |
| `log.ts` | The tiny logger — formatted timestamps, `HON_LOG_DEBUG` gate |

## Sidecar scripts

Run from `sidecar/`:

| Command                    | What it does                              |
| -------------------------- | ----------------------------------------- |
| `npm run web`              | Start the engine and open the web UI      |
| `./web.sh` *(mac / Linux)* | Same as above — direct launcher           |
| `web.cmd` *(Windows)*      | Same as above — double-clickable          |
| `npm start`                | Start the engine only (no browser open)   |
| `npm run dev`              | Start with auto-reload on file changes    |
| `npm run typecheck`        | Type-check TypeScript without emitting    |
| `node recover-creds.mjs`   | Decrypt and print stored credentials (read-only; asks for vault passphrase) |

## Build the desktop installers

The downloadable apps are produced from `electron/` using
[`electron-builder`](https://www.electron.build).

```bash
# One-time:
cd sidecar && npm install
cd ../electron && npm install   # rebuilds native modules against Electron's Node

# Then, from electron/:
npm start              # run the app locally without packaging
npm run dist           # build the installer for the current OS into electron/dist/
npm run dist:mac       # .dmg (Apple Silicon + Intel)
npm run dist:win       # .exe (NSIS installer, x64)
npm run dist:linux     # .AppImage (x64)
```

CI does the same on every tag push (`v*`) — see
[`.github/workflows/release.yml`](.github/workflows/release.yml). The job
matrix builds on `macos-latest`, `windows-latest` and `ubuntu-latest` in
parallel and attaches the three artifacts to the matching GitHub Release.
