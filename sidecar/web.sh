#!/usr/bin/env bash
# Starts Hon's local engine and opens the web app (macOS / Linux).
# The real launcher is web.mjs — cross-platform Node, no shell quirks.
exec node "$(dirname "$0")/web.mjs" "$@"
