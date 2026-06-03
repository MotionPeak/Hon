# Hon — single-image build for a NAS or home server.
#
# The build context is the REPO ROOT, not sidecar/: the engine serves the React
# build (web/dist) and imports the shared zod schemas (@hon/shared -> ../shared),
# so sidecar/, web/ and shared/ must be assembled together in the dev layout.
#
#   docker compose up -d --build
#
# Reach it at  http://<server>:4000/#token=<HON_TOKEN>
# Keep <server> on your LAN or a private VPN (Tailscale, WireGuard) — never the
# public internet. The bearer token is the only thing guarding your finances.

# ---- Stage 1: build the React UI (web/dist) -------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /build
# Install web deps first for layer caching. web declares its own zod, so the
# build resolves the shared schemas (@hon/shared -> ../shared) standalone.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
# shared/*.ts imports 'zod' and is bundled from /build/shared (outside web/), so
# rollup resolves its imports from /build upward — not web/node_modules. Expose
# web's node_modules at /build so the shared schemas resolve zod, mirroring how
# the dev checkout resolves them via the hoisted root node_modules.
RUN ln -sf /build/web/node_modules /build/node_modules
# shared/ must sit beside web/ — the vite alias + tsconfig path map
# @hon/shared/* to ../shared/*.
COPY shared ./shared
COPY web ./web
# Build the production bundle with vite (esbuild) directly — the same artifact
# the app serves. `npm run build` also runs `tsc -b`, but that is a dev/CI
# type-check gate (and incremental, so it depends on tsconfig.tsbuildinfo state);
# keeping it out of the image means a clean build never hinges on type-check
# cleanliness. Run `npm run typecheck` in CI for that.
RUN cd web && npx vite build     # -> /build/web/dist

# ---- Stage 2: the engine runtime ------------------------------------------
FROM node:22-bookworm-slim

# Chromium powers the bank scrapers (Puppeteer). Installed from Debian, not
# downloaded by Puppeteer (which ships no Linux-arm64 build). python3/make/g++
# compile the native modules (better-sqlite3, node-llama-cpp) when no prebuilt
# binary matches the host architecture.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation \
      python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# HON_TOKEN is intentionally unset — it must be supplied at run time (via .env),
# or the engine refuses to start rather than run unauthenticated.
ENV HON_DATA_DIR=/data \
    HON_HOST=0.0.0.0 \
    HON_PORT=4000 \
    HON_HEADLESS=1 \
    HON_BROWSER_NO_SANDBOX=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# The engine runs from /opt/hon/sidecar; shared/ and web/dist sit beside it at
# /opt/hon so server.ts's `../../web/dist` and the `@hon/shared -> ../shared`
# tsconfig path both resolve at runtime — the same layout as a dev checkout.
WORKDIR /opt/hon/sidecar

# Install engine deps first for layer caching. postinstall runs patch-package,
# so patches/ must be present before npm ci.
COPY sidecar/package.json sidecar/package-lock.json ./
COPY sidecar/patches ./patches
RUN npm ci

# Engine source + sibling packages.
COPY sidecar ./
COPY shared /opt/hon/shared
COPY --from=web /build/web/dist /opt/hon/web/dist

# shared/*.ts imports 'zod'; Node resolves modules upward from each file's own
# directory, so expose the engine's node_modules at /opt/hon for the shared
# files (which live at /opt/hon/shared, outside sidecar/).
RUN ln -sf /opt/hon/sidecar/node_modules /opt/hon/node_modules

VOLUME /data
EXPOSE 4000

CMD ["node", "--import", "tsx", "src/server.ts"]
