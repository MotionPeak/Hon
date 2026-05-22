# Hon engine — container image for running on a NAS or home server.
# Build context is this `sidecar/` directory.
FROM node:22-bookworm-slim

# Chromium powers the bank scrapers (via Puppeteer). It is installed from
# Debian, not downloaded by Puppeteer — Puppeteer ships no Linux arm64 build,
# so its own download breaks on ARM NASes and Raspberry Pis. The apt package
# matches the image architecture and pulls in its own library dependencies.
# python3/make/g++ cover native modules without a prebuilt binary for the host
# architecture (better-sqlite3, node-llama-cpp).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation \
      python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Server defaults. HON_TOKEN is intentionally unset — it must be supplied at
# run time, or the engine refuses to start (it would otherwise be unauthed).
ENV HON_DATA_DIR=/data \
    HON_HOST=0.0.0.0 \
    HON_PORT=4000 \
    HON_HEADLESS=1 \
    HON_BROWSER_NO_SANDBOX=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /opt/hon

# Install dependencies first so the layer is cached across source changes.
# `postinstall` runs patch-package, so the patches must be present.
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

# Application source.
COPY . .

# The vault, database and downloaded models live here — mount a volume.
VOLUME /data
EXPOSE 4000

CMD ["node", "--import", "tsx", "src/server.ts"]
