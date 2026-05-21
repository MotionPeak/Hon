#!/usr/bin/env bash
# Starts Hon's local engine and opens the web app in your browser.
# Nothing leaves your Mac: the engine binds 127.0.0.1 only, and the web app
# is authenticated with a fresh token generated for this run.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${HON_PORT:-4000}"
TOKEN="$(uuidgen)"
URL="http://127.0.0.1:${PORT}/#token=${TOKEN}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it first:  brew install node"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)…"
  npm install
fi

echo "Hon engine starting — web app at ${URL}"
( sleep 2 && open "${URL}" ) &

HON_PORT="${PORT}" HON_TOKEN="${TOKEN}" exec node --import tsx src/server.ts
