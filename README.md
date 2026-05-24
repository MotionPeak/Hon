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

Requires [Node.js](https://nodejs.org) 22.12 or later.

### Desktop app (a wrapper around the same engine)

If you'd rather double-click an icon than open a terminal, grab the installer
for your OS from the
[**latest release**](https://github.com/MotionPeak/Hon/releases/latest):

| OS | File | First-launch trust step |
| --- | --- | --- |
| **macOS — Apple Silicon (M-series)** | `Hon-macOS-arm64-x.y.z.dmg` | Right-click `Hon.app` → **Open** → **Open** in the prompt. Once. |
| **macOS — Intel** | `Hon-macOS-x64-x.y.z.dmg` | Right-click `Hon.app` → **Open** → **Open** in the prompt. Once. |
| **Windows** | `Hon-Windows-x.y.z-Setup.exe` | SmartScreen says "Windows protected your PC". Click **More info → Run anyway**. Once. |
| **Linux** | `Hon-Linux-x.y.z.AppImage` | `chmod +x Hon-*.AppImage` and double-click, or run from a terminal. |

The installers bundle Node and the engine — no separate install. They are
**unsigned** (Hon is one person's local-first project, not a commercial app
with a paid developer cert), so each platform's one-time trust step above
fires on first launch.

Running Hon on an always-on machine you can reach from anywhere? See
[NAS or home server](#run-it--nas-or-home-server).

---

## How Hon is built

The whole of Hon is the **engine** (`sidecar/`) — a local Node process that
does the scraping, encrypted storage (SQLite), categorization and AI work. It
speaks HTTP on `127.0.0.1` only and serves the complete web UI.

The downloadable apps are a thin **Electron shell** (`electron/`) that spawns
the engine and opens a window pointed at it. Same engine, same web UI, just
packaged as a double-clickable app per OS.

---

## Contents

- [What Hon does](#what-hon-does)
- [Security — the credential vault](#security--the-credential-vault)
- [Splitwise integration](#splitwise-integration)
- [AI engine](#ai-engine)
- [Tech stack & tools](#tech-stack--tools)
- [Run it — NAS or home server](#run-it--nas-or-home-server)
- [Setup inside the app](#setup-inside-the-app)
- [Where data lives](#where-data-lives)
- [External APIs & data sources](#external-apis--data-sources)
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

- `hon.db` — SQLite database (accounts, transactions, budgets, **encrypted**
  credentials, session cookies)
- `models/` — the downloaded LLM model
- `browser-profiles/` — persistent Chrome profiles for Meitav/Menora; keeps
  you signed in across runs so a re-sync skips the login
- `debug/` — best-effort page dumps from the pension connector, for diagnosis

Override the path with the `HON_DATA_DIR` env var when launching the sidecar.
The directory is never part of the repo; `*.db` and `data/` are gitignored.

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

## Project layout

```
sidecar/        Node engine, TypeScript, run directly via tsx
  src/          server, scrapers, SnapTrade, pension, Splitwise, vault,
                LLM, categorization, budget, insights, subscriptions…
  public/       the web UI (app.html)
  patches/      patch-package patches applied on npm install
electron/       desktop shell — spawns the sidecar, opens a window
  main.cjs      lifecycle + window setup
  builder.yml   electron-builder config (dmg / nsis / AppImage)
.github/
  workflows/
    release.yml CI: build installers on tag push, attach to Release
```

## Sidecar scripts

Run from `sidecar/`:

| Command            | What it does                              |
| ------------------ | ----------------------------------------- |
| `npm run web`      | Start the engine and open the web UI      |
| `npm start`        | Start the engine only                     |
| `npm run dev`      | Start with auto-reload on file changes    |
| `npm run typecheck`| Type-check the TypeScript without emitting|

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
