# Hon desktop shell

A tiny Electron wrapper around `../sidecar`. It spawns the sidecar as a child
process (using Electron's bundled Node, no separate install needed), waits for
it to bind a loopback port, and opens a window pointed at the local web UI.

This folder produces the downloadable `.dmg` / `.exe` / `.AppImage` artifacts
published on GitHub Releases. The sidecar itself is unchanged — `cd sidecar &&
npm run web` still works as the developer loop.

## Run it locally

```bash
# One-time, in the sibling sidecar folder:
cd ../sidecar && npm install

# Then, from this folder:
npm install
npm start          # opens the Hon window pointed at the spawned sidecar
```

The `postinstall` script rebuilds the sidecar's native modules
(`better-sqlite3`, `node-llama-cpp`) against Electron's Node ABI. That's why
the first `npm install` here takes a while.

## Build installers

```bash
npm run dist           # current OS only
npm run dist:mac       # .dmg (Apple Silicon + Intel)
npm run dist:win       # .exe NSIS installer (x64)
npm run dist:linux     # .AppImage (x64)
```

Outputs land in `dist/`. The CI workflow at `.github/workflows/release.yml`
runs all three in parallel on a tag push and uploads them to the matching
GitHub Release.

## What it ships

```
Hon.app /  Hon.exe /  Hon.AppImage
└── resources/
    └── sidecar/        ← the whole engine, including its node_modules
        ├── src/        ← TS sources, transpiled at runtime by tsx
        ├── public/
        ├── patches/
        └── node_modules/
```

Total size on disk: ~400–500 MB, dominated by Chromium (puppeteer) and the
optional `node-llama-cpp` native bits.

## Code signing

**macOS** — wired up. The `builder.yml` is configured for hardened-runtime
signing with a Developer ID Application certificate and Apple notarization;
the only missing piece is the credentials themselves. Add these five GitHub
repo secrets (Settings → Secrets and variables → Actions) and the next tag
push produces a signed + notarized dmg that opens with no Gatekeeper warning
on any Mac:

| Secret | Value |
| --- | --- |
| `MAC_CERT_BASE64` | Your Developer ID Application `.p12`, base64-encoded — `base64 -i Developer-ID.p12 \| pbcopy` |
| `MAC_CERT_PASSWORD` | The password you set when exporting the `.p12` from Keychain |
| `APPLE_ID` | The Apple ID email on your developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | Generated at appleid.apple.com → App-Specific Passwords |
| `APPLE_TEAM_ID` | 10-character Team ID from developer.apple.com → Membership |

Local builds on a Mac with the cert in Keychain auto-sign; notarization just
needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` exported
in the shell (or in a `.env` electron-builder picks up). First notarization
takes ~5 minutes while Apple's servers process the upload.

The entitlements at `build/entitlements.mac.plist` give the hardened runtime
back the few things Hon actually needs (JIT for V8, dyld env vars for
Puppeteer's Chromium child, outbound network).

**Windows** — still unsigned. Authenticode certs are a separate paid
subscription ($100–400/yr), not covered by the Apple Developer Program.
Users see SmartScreen → More info → Run anyway on first launch. Wire it up
with the same `CSC_LINK` / `CSC_KEY_PASSWORD` env vars pointing at a `.pfx`
when/if you decide to.

**Linux** — AppImages don't have a signing layer; nothing to configure.

## Why not pre-compile the TypeScript?

We ship the TS sources verbatim and let `tsx` transpile at startup, the same
way `web.mjs` does in dev. It keeps the build simple and the engine source
identical between dev and production. The startup cost is ~200 ms on modern
hardware — invisible against the time it takes to load the LLM model.
