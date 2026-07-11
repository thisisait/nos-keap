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
RUN npm ci
COPY . .
RUN npm run build   # -> dist/ (SPA)  +  dist-server/ (compiled backend)

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV KEAP_DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
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
