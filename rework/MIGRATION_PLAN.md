# Phase 3 — Migration plan (IIAB → nOS)

> Feature-by-feature mapping, phased plan, effort, risks, and the decisions we
> need from you. Read with [`REVIEW.md`](./REVIEW.md) and
> [`NOS_ANALYSIS.md`](./NOS_ANALYSIS.md). The scaffold in
> [`scaffold/`](./scaffold/) is the starting point for the new repo.

## 1. Guiding principle

The rework is **~30% "swap IIAB for nOS"** and **~70% "finish the app that was mostly mocked."** The
IIAB coupling is shallow (branding + aspiration), so ripping it out is cheap. The real work is
building the production backend the app never had, deleting the mock fiction, and — the upside —
making the taxonomy→content-link vision real against nOS's actual content services.

## 2. Feature-by-feature mapping

| Feature (today) | Today's reality | On nOS | Action |
|---|---|---|---|
| Production backend / API | Vite dev-middleware only; dies on `vite build` | Standalone Express/Fastify process in a container | **Build new** (`server/`) |
| Persistence | SQLite in `cwd/data` (lost on redeploy) | SQLite on a `/data` volume (or shared Postgres) | **Rewrite** (add `user_id`, volume path) |
| Auth / user identity | none | Authentik `header_oidc` (`X-Authentik-*`) → per-user | **Build new** (`server/identity.ts`) |
| Deployment | Apache vhost + hand-edited IIAB menu JSON | Tier-2 `apps/keap.yml` → Tier-1 `pazny.keap` role | **Replace** (`deploy/`) |
| Content links (`requiredData`) | type field, 0 usages, never built | Deep links to Kiwix/Calibre-Web/Nextcloud/Open WebUI | **Build new** (`src/config/nos.ts` + resolver) |
| Taxonomy dataset | static 3451-ln TS, 12 domains/790 nodes | unchanged (relocate to DB/JSON) | **Keep** |
| Admin CMS | working (taxonomy-metadata, tiles, captured metadata) | unchanged | **Keep** (translate, await deletes) |
| Companion capture | userscript → REST `/api/metadata` (works) | unchanged; point at `keap.<tld>` | **Rewrite** (fix port/ID/IP, translate, extract CSS) |
| Game map (island→city→building) | renders; DB-metadata overlay dead (async bug) | unchanged | **Rewrite** (fix async bug, persist completion) |
| Homepage tiles | Index ignores config, renders mock | real tiles from real data | **Rewrite** |
| IIAB server network | mock (fake servers, blockchain) | — | **Drop** |
| Leaderboard | mock (Solana) | optional: rebuild from real per-user data | **Drop** now, optional later |
| ProgressTracker | orphaned, async bug, stale SQL.js copy | real per-user stats | **Drop** now, optional rebuild |
| Setup wizard | placebo `setTimeout` theater | health gate | **Drop** |
| Settings export/reset | operate on non-existent localStorage key | real DB export via API | **Rewrite** |
| i18n (cs/en setting) | inert; UI hardcoded Czech | real English UI + optional i18n | **Rewrite** (English-first) |
| Theme | works via localStorage; DB path dead | unchanged | **Keep** (fix async) |

## 3. Phased plan

### Phase 0 — New repo bootstrap (0.5 day)
- Create the new repository from [`scaffold/`](./scaffold/).
- Copy `src/` (SPA), `public/` (companion, after fixes), configs from the current repo on top of the
  scaffold. Merge the frontend deps from the old `package.json` into the scaffold's.
- Delete the Vite `api-middleware` plugin; Vite becomes SPA-only.
- **Exit criteria:** `npm run dev` runs SPA + backend concurrently; `npm run build && npm start`
  serves a working app with a live `/api/health`.

### Phase 1 — Real backend + persistence (2–3 days)
- Port `apiServer.ts` routing → `server/routes.ts` (Express), preserving the `{success,data,error}`
  envelope so the frontend API clients keep working.
- Port `database.server.ts` → `server/db.ts`; add `user_id` to every user-scoped table; DB path =
  `KEAP_DATA_DIR`.
- Add `server/identity.ts` header-OIDC middleware; scope all reads/writes by `req.user.id`; add
  `/api/me`.
- **Exit criteria:** every existing endpoint answers from the standalone server; data survives a
  container restart; a request with `X-Authentik-Username` gets an isolated data space.

### Phase 2 — De-mock & de-IIAB (2–3 days)
- Delete `ServerStatus`, `LeaderBoard`, `ProgressTracker`, `PolygonCard`, `Setup`.
- Rewrite the 4 homepage tiles to consume real APIs; wire `CustomTodoTile` to `todosApi`.
- Make Index render the configured tiles; unify the companion channel (pick REST *or* postMessage).
- Fix the async-as-sync bug in `useTheme` + the 3 game views; persist game completion.
- Rebrand IIAB → nOS/KEAP; translate Czech → English; fix `unlock_all` default.
- **Exit criteria:** no mock data on screen; no IIAB strings; game DB-metadata overlay works.

### Phase 3 — nOS content linking (1–2 days)
- Add `src/config/nos.ts` link map + `resolveRequiredData()`.
- Extend the taxonomy schema / Admin to attach `requiredData` (e.g. `kiwix:wikipedia_en`) to nodes.
- Render a "Open in Kiwix/Calibre/Nextcloud" affordance on items that have a link.
- **Exit criteria:** a taxonomy item deep-links into a live nOS content service.

### Phase 4 — nOS deploy: Tier-2 pilot (1 day)
- Build & push `ghcr.io/budweis-dev/keap:<version>` (multi-arch arm64+amd64).
- Drop `deploy/nos/keap.yml` into an nOS `apps/`; `python3 -m module_utils.nos_app_parser apps/keap.yml`;
  `ansible-playbook main.yml --tags apps`.
- **Exit criteria:** `https://keap.apps.<tld>` live behind Authentik SSO, per-user data working.

### Phase 5 — nOS deploy: Tier-1 promotion (1–2 days, optional/when stable)
- Create `roles/pazny.keap/` (clone `pazny.miniflux`, `build:`-based compose + `keap_data` volume).
- Add `install_keap` toggle, `state/manifest.yml` row (`domain_var`+`port_var`), `include_role` in the
  iiab orchestrator, `keap-base` plugin (from `deploy/plugin/`).
- Optionally graduate SSO to `native_oidc` and/or move to shared Postgres.
- **Exit criteria:** `ansible-playbook main.yml --tags keap` brings up a healthy service with a Wing
  `/hub` card and notification routing.

**Total: ~9–14 working days** to a first-class nOS service; a usable Tier-2 pilot is reachable by end
of Phase 4 (~7–10 days). Phases 0–2 are the critical path and independent of nOS.

## 4. Effort summary

| Phase | Effort | Depends on nOS? | Blocking? |
|---|---|---|---|
| 0 Bootstrap | 0.5 d | no | yes |
| 1 Backend + persistence | 2–3 d | no | yes |
| 2 De-mock & de-IIAB | 2–3 d | no | yes |
| 3 Content linking | 1–2 d | conceptually | no |
| 4 Tier-2 deploy | 1 d | yes | no |
| 5 Tier-1 promotion | 1–2 d | yes | no |

## 5. Risks

- **R1 — Scope creep from "finishing" the app.** 70% of the work is completing mocked features. Guard
  against gold-plating: ship the three real pillars (Admin, capture, taxonomy) + backend + SSO first.
- **R2 — Backend framework churn.** The scaffold uses Express; if you prefer Fastify/Hono, decide
  before Phase 1 (cheap now, costly later).
- **R3 — SQLite vs Postgres.** Volume-SQLite is simplest but single-node and needs a volume backup
  story (nOS nightly backup covers volumes). If multi-tenant scale matters, choose Postgres up front.
- **R4 — header_oidc trust boundary.** `X-Authentik-*` headers are only trustworthy because Traefik is
  the sole ingress and strips client copies. The container port **must** bind `127.0.0.1` — a bare
  LAN-published port would let anyone forge identity headers. The scaffold binds loopback; keep it.
- **R5 — Companion userscript re-architecture.** It's 1219 ln with a baked LAN IP, wrong port, and an
  ID/flag mismatch. Budget real time to refactor rather than port verbatim.
- **R6 — Multi-arch image builds.** nOS is arm64-primary; CI must build/push arm64 (and amd64 for the
  Linux port). `better-sqlite3` ships prebuilts for both, but verify in CI.
- **R7 — GDPR gate friction (Tier-2).** The parser rejects an incomplete `gdpr:` block; the scaffold's
  manifest is complete, but keep it accurate as data categories change.
- **R8 — Taxonomy dataset ownership.** 790 nodes are the core asset; moving them from TS to DB/JSON is
  a data migration — validate no IDs are lost (and stop `TaxonomySelect` deriving IDs by index).

## 6. Open questions — decisions we need from you

1. **New repo name & owner.** Keep `keap` / "Knowledge Explorer and Preserver"? Under
   `budweis-dev` or `thisisait`? (Scaffold assumes `budweis-dev/keap`, image `ghcr.io/budweis-dev/keap`.)
2. **SSO posture.** Start with **header_oidc** (recommended, per-user, no client code) and graduate to
   native_oidc later — or go native_oidc from day one?
3. **Persistence.** Volume-SQLite (recommended) vs embedded Postgres vs shared infra Postgres?
4. **Integration tier destination.** Is Tier-1 (`pazny.keap` role, first-class, in-nOS build) the
   goal, or is a Tier-2 app manifest (pre-built image) sufficient long-term?
5. **Backend framework.** Express (scaffolded) vs Fastify/Hono?
6. **Language.** English-only (recommended, matches nOS's retired-Czech policy) or real cs/en i18n?
7. **Companion panel.** Keep, rewrite, or replace with a proper browser extension? Ship it inside the
   image (served at `/companion-script.js`) or as a separate artifact?
8. **Leaderboard / social.** Drop entirely, or rebuild later from real per-user nOS-scoped data?
9. **Taxonomy storage.** Keep the 790-node tree as a seeded static asset, or make it fully
   DB-editable via Admin (with the static tree as the initial seed)?
10. **Where does the new code live relative to nOS?** Standalone repo consumed by nOS as an image
    (recommended), or vendored into nOS under `files/keap/`?
