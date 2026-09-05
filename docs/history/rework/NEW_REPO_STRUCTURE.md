# Phase 3 — Proposed new-repository structure

> The directory layout for the fresh repo that rebuilds KEAP on nOS. A runnable
> skeleton of the key files lives in [`scaffold/`](./scaffold/) — copy it out,
> then port the existing `src/` on top. See [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md).

## 1. Design goals

1. **A real, separable backend.** The single biggest defect of the old repo — the API existing only
   as Vite middleware — is fixed by a top-level `server/` that builds and runs independently of Vite.
2. **Container-first, nOS-native.** A multi-stage `Dockerfile` produces one image serving SPA + API;
   `deploy/` carries both nOS onboarding paths so the app is a drop-in nOS service.
3. **Clear frontend/backend/deploy separation** so each can be reasoned about (and CI'd) alone.
4. **Delete the fiction.** No home for mock components — they simply don't get ported.

## 2. Proposed layout

```
keap/                                  # new repo root
├── README.md                          # nOS-edition readme (see scaffold/README.md)
├── package.json                       # frontend deps + REAL backend deps + `start` script
├── Dockerfile                         # multi-stage: build SPA + backend → slim runtime
├── docker-compose.yml                 # standalone local run (no nOS in front)
├── .dockerignore
├── vite.config.ts                     # SPA-only (NO api-middleware plugin)
├── tsconfig.json / tsconfig.app.json  # SPA TS config (carried over)
├── tsconfig.server.json               # backend TS config (NEW)
├── tailwind.config.ts                 # drop stale content globs
├── components.json / eslint.config.js # re-enable no-unused-vars
│
├── server/                            # ★ standalone backend — the missing piece
│   ├── index.ts                       # express: serve dist/ + /api + /api/health
│   ├── identity.ts                    # Authentik header-OIDC → per-user identity
│   ├── db.ts                          # sqlite (user-scoped), volume-backed
│   ├── routes.ts                      # REST API (ported from old apiServer.ts)
│   └── taxonomy.ts                    # loads the seed taxonomy dataset
│
├── src/                               # React SPA (ported from current repo)
│   ├── main.tsx / App.tsx             # + StrictMode; dedupe theme init
│   ├── config/
│   │   └── nos.ts                     # ★ nOS content-service link map (replaces phantom iiab.ts)
│   ├── pages/                         # Index, Admin, Game, Settings, NotFound  (Setup dropped)
│   ├── game/
│   │   ├── data/taxonomy.ts           # 12-domain seed tree (or move to /data/*.json)
│   │   ├── types/ · utils/ · config/  # model + mapper + feature flags
│   │   └── components/                # GameMap, CityView, BuildingView (async bug fixed)
│   ├── components/
│   │   ├── ui/                        # shadcn primitives (kept verbatim)
│   │   ├── homepage/                  # tiles (rewritten to real data)
│   │   └── TaxonomySelect.tsx         # kept; read real .id
│   ├── hooks/                         # useTheme (fixed); react-query hooks replace useDatabase
│   ├── services/api/                  # collapsed to one typed apiFetch<T>()
│   └── types/
│
├── public/
│   ├── companion-script.js            # refactored: no baked IP, correct port, English
│   └── bookmarklet.js                 # fixed IDs + host
│
├── deploy/                            # ★ nOS onboarding (both paths)
│   ├── nos/
│   │   └── keap.yml                   # Tier-2 apps_runner manifest (quick pilot)
│   └── plugin/
│       └── keap-base/
│           └── plugin.yml             # Tier-1 anatomy plugin (first-class destination)
│
├── data/                             # gitignored runtime volume mount (SQLite lives here)
│
└── .github/workflows/
    └── build.yml                     # lint · typecheck · test · docker buildx (arm64+amd64) · push
```

## 3. Rationale, section by section

- **`server/` at the top level, not under `src/`.** It is a separate build target (`tsconfig.server.json`
  → `dist-server/`) and a separate runtime. Co-locating it with the SPA is what let the old repo
  pretend Vite middleware was a backend. Keeping it visibly separate prevents that regression.
- **`server/index.ts` serves both the SPA static bundle and `/api`.** Traefik routes one upstream port
  per service, so a single process must own both. This also removes the need for the old CORS wildcard
  (same-origin again).
- **`server/identity.ts` is the SSO seam.** All per-user behavior derives from `req.user` here; local
  dev with no outpost falls back to a single `local` user, so the app runs identically inside and
  outside nOS.
- **`src/config/nos.ts` replaces the phantom `src/config/iiab.ts`.** It is the *only* place that knows
  about external content services; swapping IIAB→nOS was, in effect, replacing a file that never
  existed with one that maps to services that actually do.
- **`deploy/` carries both nOS paths.** `nos/keap.yml` for the fast Tier-2 pilot; `plugin/keap-base/`
  for the Tier-1 promotion. Shipping both in-repo keeps the deployment contract versioned with the app.
- **`data/` is gitignored** and maps to the container's `/data` volume — the fix for state being lost
  on redeploy.
- **CI builds a multi-arch image.** nOS is arm64-primary (Apple Silicon) with an amd64 Linux port, so
  `docker buildx` must emit both; `better-sqlite3` prebuilts cover both.

## 4. What is deliberately absent

- No `components/ServerStatus.tsx`, `LeaderBoard.tsx`, `ProgressTracker.tsx`, `PolygonCard.tsx` —
  dropped (mock/orphaned).
- No `pages/Setup.tsx` — the placebo wizard is replaced by the `/api/health` gate.
- No Vite `api-middleware` — Vite is SPA-only; the backend is a real process.
- No Apache vhost / IIAB menu JSON — replaced by `deploy/`.
- No `localStorage['iiab-database']` export/reset path — replaced by a real DB export endpoint.

## 5. Using the scaffold

The [`scaffold/`](./scaffold/) directory is a runnable seed of the ★-marked new files:
`package.json`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `tsconfig.server.json`,
`README.md`, `server/{index,identity,db,routes}.ts`, `src/config/nos.ts`,
`deploy/nos/keap.yml`, `deploy/plugin/keap-base/plugin.yml`.

```bash
# bootstrap the new repo
mkdir keap && cd keap && git init
cp -r <this-repo>/rework/scaffold/. .
# then port the SPA on top
cp -r <this-repo>/src ./src
cp -r <this-repo>/public ./public         # after the companion fixes
# merge frontend deps from the old package.json into the scaffold's
npm install && npm run dev
```

The scaffold's `server/routes.ts` and `server/db.ts` include two worked user-scoped endpoints
(todos, completed-items) and mark the rest as mechanical ports from the old `apiServer.ts`.
