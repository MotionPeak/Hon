# Hon

A local-first personal finance aggregator for macOS. It pulls balances and
transactions from Israeli banks, credit cards and brokerages, categorizes
spending, and builds budgets and insights — entirely on your own machine.
No financial data ever leaves the Mac.

Hon has two parts:

- **Hon app** (`Hon/`) — a native SwiftUI macOS app.
- **Sidecar** (`sidecar/`) — a local Node engine that does the scraping,
  storage (SQLite), categorization and on-device LLM work. It speaks HTTP on
  `127.0.0.1` only.

The sidecar also serves a complete web UI, so Hon can run without Xcode at all.

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
  app, a password-protected vault for the web app.
- **Brokerages (SnapTrade)** — needs your own SnapTrade Client ID and Consumer
  Key from a free [SnapTrade](https://snaptrade.com) developer account. Enter
  them when adding a SnapTrade account, then link a brokerage through the
  connection portal.

## Where data lives

All local, under `~/Library/Application Support/Hon/`:

- `hon.db` — SQLite database (accounts, transactions, budgets, credentials)
- `models/` — the downloaded LLM model

This directory is never part of the repo; `*.db` and `data/` are gitignored.

## Project layout

```
Hon/            SwiftUI macOS app — App, Views, Services, Models
sidecar/        Node engine, TypeScript, run directly via tsx
  src/          server, scrapers, SnapTrade, LLM, categorization, budget…
  public/       the web UI (app.html)
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
