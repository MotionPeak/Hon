# Hon

**A local-first personal finance aggregator for macOS.** Hon pulls balances and
transactions from Israeli banks, credit cards, brokerages and pension funds,
categorizes spending with an on-device AI model, and builds budgets and
insights — entirely on your own machine. **No financial data ever leaves the
Mac.** There is no Hon server, no account, no telemetry.

Hon has two parts:

- **Hon app** (`Hon/`) — a native SwiftUI macOS app. It supervises the engine
  and hosts the dashboard in a `WKWebView`.
- **Sidecar** (`sidecar/`) — a local Node engine that does the scraping,
  encrypted storage (SQLite), categorization and on-device LLM work. It speaks
  HTTP on `127.0.0.1` only and also serves the complete web UI, so Hon can run
  without Xcode at all.

---

## Contents

- [What Hon does](#what-hon-does)
- [Security — the credential vault](#security--the-credential-vault)
- [Splitwise integration](#splitwise-integration)
- [On-device AI](#on-device-ai)
- [Tech stack & tools](#tech-stack--tools)
- [Requirements](#requirements)
- [Run it — web app](#run-it--web-app-no-xcode)
- [Run it — native macOS app](#run-it--native-macos-app)
- [Setup inside the app](#setup-inside-the-app)
- [Where data lives](#where-data-lives)
- [Project layout](#project-layout)
- [Sidecar scripts](#sidecar-scripts)

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

- **Native app** — bank/card credentials live in the **macOS Keychain**.
- **Web app** — there is no Keychain, so credentials go into an encrypted
  **vault** inside the local SQLite database (`sidecar/src/vault.ts`):
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

## On-device AI

A local **GGUF** model (run via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp))
powers three things, all fully offline:

1. **Categorization** — classifies transactions the rule map can't, constrained
   to the fixed category list with a JSON-schema grammar.
2. **Insights** — an optional written summary of the cycle's spending.
3. **Subscription matching** — decides whether a lapsed subscription is the same
   merchant as an active one under a renamed descriptor.

The model is not bundled — download one from inside the app (≈2.1 GB). It runs
entirely on your Mac; nothing is sent anywhere.

---

## Tech stack & tools

**Sidecar engine** — TypeScript on Node 22, run directly with `tsx`:

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

**macOS app** — Swift, SwiftUI, and a `WKWebView` that hosts the web dashboard;
the Xcode project is generated from `project.yml` with
[XcodeGen](https://github.com/yonaskolb/XcodeGen).

---

## Requirements

- macOS 15 or later
- [Node.js](https://nodejs.org) 22.12 or later — `brew install node`
- For the native app only: Xcode, plus
  [XcodeGen](https://github.com/yonaskolb/XcodeGen) — `brew install xcodegen`

## Run it — web app (no Xcode)

The quickest path. The sidecar starts and opens the web UI in your browser.

```bash
cd sidecar
npm install      # first run is large: builds native modules, downloads Chromium
npm run web
```

This opens `http://127.0.0.1:4000`. The engine binds to loopback only, and the
web app is authenticated with a fresh token generated on each run.

## Run it — native macOS app

```bash
brew install node xcodegen
xcodegen                          # generates Hon.xcodeproj from project.yml
cd sidecar && npm install && cd ..
open Hon.xcodeproj
```

`Hon.xcodeproj` is generated and not checked in — re-run `xcodegen` whenever
`project.yml` changes.

Before building, edit `project.yml` (then re-run `xcodegen`):

1. **`HON_SIDECAR_DIR`** (under `targets.Hon.scheme.environmentVariables`) is an
   absolute path to this repo's `sidecar/` folder. Set it to wherever you
   cloned the repo. If the repo lives at `~/Documents/Code/Hon`, you can
   instead delete the `environmentVariables` block — the app falls back to that
   path automatically.
2. **`DEVELOPMENT_TEAM`** is an Apple Developer team ID. Set it to your own, or
   select your team in Xcode under the Hon target → Signing & Capabilities.

Then Build & Run (⌘R). The app launches and supervises the sidecar itself.

## Setup inside the app

The repo ships with no data and no credentials. You configure these on first
run:

- **AI model** — used for categorization and insights. Not bundled; download a
  model from within the app (≈2.1 GB). It runs fully on-device.
- **Israeli banks / credit cards** — add an account and enter your login
  credentials. They are stored locally — the macOS Keychain for the native
  app, the password-protected vault for the web app.
- **Brokerages (SnapTrade)** — needs your own SnapTrade Client ID and Consumer
  Key from a free [SnapTrade](https://snaptrade.com) developer account. Enter
  them when adding a SnapTrade account, then link a brokerage through the
  connection portal.
- **Pension / study funds** — add the provider and sign in with your portal
  credentials (an SMS code is handled in-app).
- **Splitwise** (optional) — connect with your Splitwise API key to split
  transactions with friends.

## Where data lives

All local, under `~/Library/Application Support/Hon/`:

- `hon.db` — SQLite database (accounts, transactions, budgets, **encrypted**
  credentials)
- `models/` — the downloaded LLM model
- `debug/` — best-effort page dumps from the pension connector, for diagnosis

This directory is never part of the repo; `*.db` and `data/` are gitignored.

## Project layout

```
Hon/            SwiftUI macOS app — App, Views, Services, Models
sidecar/        Node engine, TypeScript, run directly via tsx
  src/          server, scrapers, SnapTrade, pension, Splitwise, vault,
                LLM, categorization, budget, insights, subscriptions…
  public/       the web UI (app.html)
  patches/      patch-package patches applied on npm install
Tools/          app icon generation
project.yml     XcodeGen project definition
```

## Sidecar scripts

Run from `sidecar/`:

| Command            | What it does                              |
| ------------------ | ----------------------------------------- |
| `npm run web`      | Start the engine and open the web UI      |
| `npm start`        | Start the engine only                     |
| `npm run dev`      | Start with auto-reload on file changes    |
| `npm run typecheck`| Type-check the TypeScript without emitting|
