# KEAP — multi-stage build: compile the SPA + the standalone backend, then run
# a slim Node runtime that serves both. This is what makes KEAP deployable on
# nOS (the old repo had no production server, only Vite dev-middleware).
#
# Multi-arch: nOS targets arm64 (Apple Silicon) AND linux/amd64 (v0.4 Linux
# port). libsql ships prebuilt binaries for both; the build stage keeps
# build-essential/python3 available in case a source rebuild is needed.

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# --ignore-scripts: the root postinstall (`wxt prepare`) runs during install,
# BEFORE the source is copied, so it has no config/entrypoints to prepare and
# exits non-zero. It is also irrelevant to this image — the MV3 browser
# extension is a separate deliverable the operator installs in their browser,
# not part of the server image. `wxt build` (if ever run) does its own prepare.
RUN npm ci --ignore-scripts
COPY . .
# Server image = SPA (vite) + compiled backend only; NOT the extension
# (build:ext / wxt). Keeps the image independent of the extension toolchain.
RUN npx vite build && npm run build:server   # -> dist/  +  dist-server/

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV KEAP_DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# --ignore-scripts: the runtime image needs only the prebuilt production deps
# to run the compiled server bundle. The root postinstall (`wxt prepare`) is
# extension-dev codegen whose binary lives in devDependencies — under
# --omit=dev it is absent, so the script would exit 127 and fail the build.
# libsql ships prebuilt binaries (see the build-stage note), so skipping
# lifecycle scripts here rebuilds nothing.
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
# /data must exist and belong to the runtime user BEFORE the VOLUME
# declaration — an anonymous volume inherits these permissions; without the
# chown the non-root process gets SQLITE_CANTOPEN on first boot.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O - http://127.0.0.1:8080/api/health || exit 1
USER node
CMD ["node", "dist-server/index.js"]
