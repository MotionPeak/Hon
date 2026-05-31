# Hon

**Hon** (Hebrew: הוֹן, "wealth") is a private, local-first personal finance
dashboard for Israeli households. It logs into your banks, credit cards,
pension funds, brokerages, and loyalty/gift-card programs, pulls everything
into one SQLite database on your own machine, and shows you net worth, cash
flow, budgets, and trends — without sending a byte to anyone's cloud.

> **Privacy model in one line:** all data lives on your machine; the only
> outbound traffic is the bank/financial logins you explicitly configure
> (plus optional FX rates and, if you turn it on, an LLM API).

---

## Run Hon

```bash
# From the repo root:
npm install        # first time only
npm run dev        # starts the sidecar engine + opens the web app
```

`npm run dev` boots the local engine (the "sidecar") and the web UI together.
It prints a URL like:

```
Hon engine starting — web app at http://127.0.0.1:4000/#token=<uuid>
```

Open that URL (the launcher opens it for you). The token in the URL fragment
authenticates your browser to the loopback-bound engine.

**Prerequisites:** Node 20+ and Google Chrome (Hon drives Chrome for the bank
and pension scrapers — see [How Hon finds Chrome](#how-hon-finds-chrome)).

The engine listens on `127.0.0.1` only. Nothing is exposed to your LAN unless
you deliberately run it as a server (see
[Run it — NAS or home server](#run-it--nas-or-home-server)).

> Hon is browser-based — there's no desktop app to install. The engine serves
> the web UI; you open it in the browser you already use.

---

### Setting up on Windows (from scratch)

A complete walkthrough for a non-technical Windows user — from a blank PC to a
running Hon.

1. **Install Node.js.** Go to [nodejs.org](https://nodejs.org) and download the
   **LTS** installer. Run it, accept the defaults. This gives you `node` and
   `npm`.
2. **Install Google Chrome** if it's not already on the machine.
3. **Download Hon.** Either `git clone` the repo (if you have Git) or use the
   green **Code → Download ZIP** button on GitHub and unzip it somewhere like
   `C:\Hon`.
4. **Open a terminal in the Hon folder.** In File Explorer, navigate into the
   `Hon` folder, then click the address bar, type `cmd`, and press Enter.
5. **Install and run:**
   ```
   npm install
   npm run dev
   ```
6. **First run installs everything** (a few minutes), then Hon opens in your
   browser automatically.

If a Windows Firewall prompt appears, you can safely **Cancel/Deny** — Hon
only talks to `127.0.0.1` (your own machine), so it doesn't need any firewall
permission.

#### Windows-specific gotchas

- **better-sqlite3 fails to build.** You need the Visual Studio Build Tools
  with the "Desktop development with C++" workload. Install from
  [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/),
  then re-run `npm install`.
- **"npm is not recognized."** Reopen the terminal after installing Node so
  the new PATH takes effect.
- **Chrome not found.** Install Chrome, or set `PUPPETEER_EXECUTABLE_PATH` —
  see [How Hon finds Chrome](#how-hon-finds-chrome).

---

## How Hon is built

Two packages in one repo:

```
Hon/
├── sidecar/   the local engine — Fastify HTTP API, scrapers, SQLite, vault,
│              on-device LLM. This is where most of the code lives. It also
│              serves the built web UI.
└── web/       the React app (Vite) you see in the browser, built to web/dist.
```

The sidecar is the product; `web/` is its face. There's one moving part at
runtime: the engine. It serves the React build at `/` and exposes the API
under `/api/*` on the same loopback port — no separate web server, no CORS.

**How the UI is served.** `npm run dev`'s launcher (`sidecar/web.mjs`) builds
`web/dist` when it's missing or stale, then starts the engine. The engine
serves `web/dist/index.html` at `/` and the hashed assets under `/assets/`.
The React client calls `/api/<route>`; the engine strips the `/api` prefix and
routes to its handlers (the production equivalent of Vite's dev proxy), with
the bearer token enforced on every API call. In development you can instead run
Vite directly (`cd web && npm run dev`, on `:5173`) for hot-reload, with its
`/api → :4000` proxy.

---

## Contents

- [Run Hon](#run-hon)
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

---

## What Hon does

Hon logs into your financial accounts on a schedule you control, normalizes
everything into one local database, and presents it as a dashboard. Each
**tab** in the web app:

- **Overview** — net worth, this-cycle cash flow, projected end-of-cycle bank
  balance, spending pie, budget vs. actual, and "saved this cycle".
- **Assets** — banks, credit cards, brokerages, pension funds, plus manual
  assets (car by plate, property, cash) and bank-scraped loans.
- **Activity** — every transaction, searchable, with categorization, refund
  linking, Splitwise splits, and a per-transaction "savings" toggle (savings
  transfers drop out of spend and are tallied separately).
- **Fixed bills** — auto-detected recurring bills with per-merchant frequency
  and a "due this cycle" total.
- **Subscriptions** — recurring digital subscriptions, bucketed.
- **Piggy banks** — savings goals with progress rings.
- **Loans** — bank-scraped + manual, with payment history.
- **Vouchers** — Shufersal / BuyMe / HTZone gift-card balances with sync.
- **Insights** — spending breakdowns and brokerage performance charts.
- **Settings** — categories, billing cycle, AI engine, vault, integrations.

---

## Security — the credential vault

All bank/scraper credentials live in an AES-256-GCM vault, encrypted with a
key derived (scrypt, OWASP-2024 cost for new vaults) from a passphrase you
choose. The vault is locked at rest; you unlock it once per session. Lost
passphrase = re-enter credentials (documented as a feature, not a bug — Hon
can't read them without it).

The engine binds to `127.0.0.1` and every API route is gated by a bearer token
carried in the URL fragment (so it never lands in server logs). LLM provider
API keys, like every other secret, are stored in the vault — never plaintext
on disk.

---

## Recovering your credentials

If you forget the vault passphrase, there's no backdoor (that's the point).
You re-enter each connection's credentials, which re-encrypts them under a new
passphrase. Your transaction history and balances are NOT lost — only the
saved login credentials need re-entering.

---

## Splitwise integration

Hon links transactions to Splitwise expenses, tracks who owes whom, and folds
"owed to you" into your cash-flow projection. Connect with your Splitwise API
key in Settings.

---

## AI engine

Hon runs a local LLM (via `node-llama-cpp`) for transaction categorization and
free-text budget insights. Pick the model in Settings → AI engine. Nothing
goes to any cloud unless you explicitly configure an API-based provider
(OpenAI-compatible or Ollama).

---

## Tech stack & tools

- **Sidecar:** Node + TypeScript, Fastify (+ `@fastify/static` to serve the
  web build), better-sqlite3, Puppeteer + israeli-bank-scrapers,
  node-llama-cpp, SnapTrade SDK.
- **Web:** React 19, Vite, TypeScript (strict), Vitest.
- **Storage:** SQLite (WAL), AES-256-GCM vault.
- **Deploy:** single local engine — `web/dist` is built on launch and served
  by the sidecar at `/`; no separate web server, no packaging step.

---

## Run it — NAS or home server

Hon can run headless on a NAS or home server, reachable over your LAN or a
VPN (Tailscale, WireGuard). The engine binds `127.0.0.1` by default; set
`HON_HOST=0.0.0.0` to expose it.

```bash
HON_HOST=0.0.0.0 HON_PORT=4000 npm run web --prefix sidecar
```

(`npm run dev` from the repo root also works, but on a headless box set
`HON_HEADLESS=1` so it doesn't try to open a browser.)

**Security note:** the bearer token is the only thing protecting your finances
if you bind to `0.0.0.0`. Use a strong token (`HON_TOKEN`) and ideally keep it
behind a VPN, never the public internet.

---

## Setup inside the app

First launch:
1. Create the vault passphrase (Settings → unlock).
2. Add a connection (Assets → + Add asset → pick your bank).
3. Enter credentials; Hon scrapes on demand or on a schedule.

---

## Where data lives

All under one directory (the "data dir"):

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Hon` |
| Windows | `%APPDATA%\Hon` |
| Linux | `$XDG_DATA_HOME/Hon` (or `~/.local/share/Hon`) |

Override with `HON_DATA_DIR`. Contents:

| File / dir | What |
|---|---|
| `hon.db` | the SQLite database (accounts, transactions, budgets, …) |
| `vault/` | encrypted credentials + bank sessions |
| `dev-token` | the persisted bearer token (mode 0600) |
| `browser-profiles/` | persistent Chrome profiles for pension funds |
| `logos/` | cached institution logos |
| `debug/` | failure screenshots + HTML/JSON dumps |
| `sidecar.log` | engine log (tee'd by the launcher) |

---

## External APIs & data sources

- **israeli-bank-scrapers** — drives Chrome to log into Israeli banks + cards.
- **SnapTrade** — brokerage aggregation (IBKR, etc.).
- **data.gov.il** — vehicle lookup by licence plate (car asset valuation).
- **Frankfurter** — FX rates (`api.frankfurter.dev`), for multi-currency
  net worth.
- **Splitwise** — shared-expense tracking (optional, API key).
- **Pension portals** — Migdal, Harel, Clal, Meitav, Menora (custom Puppeteer).
- **Voucher portals** — Shufersal, BuyMe, HTZone.

---

## Environment variables

| Var | Default | What |
|---|---|---|
| `HON_DATA_DIR` | OS default | Override the data directory. |
| `HON_PORT` | `0` (random) | Engine port. The launcher uses 4000. |
| `HON_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` to expose on LAN. |
| `HON_TOKEN` | auto | Bearer token. Auto-generated + persisted if unset. |
| `PUPPETEER_EXECUTABLE_PATH` | auto | Explicit Chrome path. |
| `HON_LOG_DEBUG` | unset | Verbose debug logging when set to `1`. |
| `HON_HEADLESS` | unset | Don't open a browser on launch (server mode). |

---

## How Hon finds Chrome

Hon needs a real Chrome/Chromium (not the bundled Puppeteer one, which it
skips downloading). At launch it searches common install paths for Chrome,
then Edge, then Chromium. Override with `PUPPETEER_EXECUTABLE_PATH`.

---

## Troubleshooting & diagnostics

### Reading the logs

The engine streams structured logs to stderr and tees them to
`<dataDir>/sidecar.log`. Each scrape attempt is greppable by its run id.

### When a scrape fails

Check `<dataDir>/debug/<companyId>.png` (a screenshot at the point of failure)
and the matching HTML/JSON dump.

### Reset a Meitav or Menora session

Delete the fund's profile under `<dataDir>/browser-profiles/<companyId>/`
(or the lock files inside it) and re-sync.

### Peek into the SQLite database

```bash
sqlite3 "$HOME/Library/Application Support/Hon/hon.db"
```

### Recover credentials

See [Recovering your credentials](#recovering-your-credentials).

### Forgot the vault passphrase

No backdoor by design. Re-enter credentials to re-encrypt under a new
passphrase; history/balances are preserved.

### Card balance doesn't match the issuer's site

Israeli credit cards bill once a month; Hon shows the next-bill outstanding
(pending + scheduled charges), which can differ from the issuer's "current"
figure mid-cycle.

### "Hon web app not built" at `/`

The engine couldn't find `web/dist`. Run `cd web && npm run build` (the
launcher normally does this for you), then reload.

### Where each connector lives in code

| Connector | File |
|---|---|
| Banks + cards | `sidecar/src/scrapers.ts` |
| Pension funds | `sidecar/src/pension.ts` |
| Brokerages (SnapTrade) | `sidecar/src/snaptrade.ts` |
| Vouchers | `sidecar/src/voucherScrapers.ts` |
| Loans | `sidecar/src/bankLoans.ts` |
| Vehicle lookup | `sidecar/src/vehicle.ts` |
| FX | `sidecar/src/fx.ts` |
| LLM | `sidecar/src/llm.ts` |
| Vault | `sidecar/src/vault.ts` |
| Categorization | `sidecar/src/categorize.ts` |

---

## Project layout

```
Hon/
├── package.json          root — `npm run dev` launches engine + web
├── sidecar/              the local engine
│   ├── web.mjs           launcher: token, Chrome detection, builds web/dist,
│   │                     spawns the engine
│   ├── src/              engine source (see below)
│   └── tests/            vitest unit tests
└── web/                  the React app
    ├── src/              React source (tab-by-tab views)
    └── dist/             production build (built on launch, served at /)
```

---

### `sidecar/src/` — one file per concern

| File | Responsibility |
|---|---|
| `server.ts` | Fastify app — all HTTP routes, token gate, serves `web/dist` |
| `httpRewrite.ts` | strips the `/api` prefix so the client reaches `/<route>` |
| `db.ts` | SQLite schema + migrations |
| `repo.ts` | typed data access (the only place that touches SQL) |
| `runner.ts` | scrape orchestration (dispatch, OTP, retries) |
| `scrapers.ts` | bank + card scrapers (israeli-bank-scrapers) |
| `pension.ts` | pension-fund scrapers (custom Puppeteer) |
| `snaptrade.ts` | brokerage aggregation |
| `voucherScrapers.ts` | gift-card balance scrapers |
| `bankLoans.ts` | loan scraping + amortization |
| `vehicle.ts` | licence-plate vehicle lookup |
| `vault.ts` | AES-GCM credential vault |
| `llm.ts` | on-device LLM (categorization + insights) |
| `categorize.ts` | three-tier categorization |
| `fx.ts` | currency conversion |
| `budget.ts` | budget + cash-flow projection |
| `loanMatcher.ts` | links transactions to loans |
| `splitwise.ts` | Splitwise sync |
| `piggy.ts` | savings-goal math |
| `log.ts` | structured logger |

---

## Sidecar scripts

```bash
cd sidecar
npm run web        # start the engine (+ open the browser)
npm test           # vitest unit tests
npm run typecheck  # tsc --noEmit
```

For the web app:

```bash
cd web
npm run build      # produce web/dist (the engine serves this)
npm run dev        # Vite dev server with hot-reload (proxies /api → :4000)
npm test           # vitest
npm run typecheck  # tsc -b --noEmit
```

---

*Hon is a personal project, shared in case it's useful. No warranty; use at
your own risk with your own financial credentials.*
