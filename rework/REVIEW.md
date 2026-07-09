# Phase 1 — Review of the current project (KEAP, IIAB-based)

> Scope: `knowledge-explorer-and-preserver` @ `main` (tip `94c1e17`). This is the
> "what exists today" half of the rework blueprint. Companion docs:
> [`NOS_ANALYSIS.md`](./NOS_ANALYSIS.md), [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md),
> [`NEW_REPO_STRUCTURE.md`](./NEW_REPO_STRUCTURE.md).

## 1. Executive summary

KEAP ("Knowledge Explorer and Preserver") is a **Lovable-generated React 18 + TypeScript + Vite SPA**
with a **Vite dev-middleware REST API** backed by `better-sqlite3`. It presents a gamified
(island → city → building) view over a static 12-domain knowledge taxonomy, plus an Admin CMS and a
browser "companion" userscript that captures page metadata into the taxonomy.

Three findings dominate everything else and should shape the rework more than any feature list:

1. **There is no production backend.** The entire `/api/*` surface and all SQLite persistence exist
   only inside `vite.config.ts`'s `configureServer` middleware. `package.json` has `dev`, `build`,
   `preview` — **no `start`/`server`**. `vite build` emits a static `dist/` with no API and no
   persistence. The README's "server-first architecture" and its Apache deployment therefore ship a
   frontend with a dead API. **Rebuilding a real, long-lived backend is the central task**, and it is
   exactly what makes the app deployable on nOS (a container with a real process).

2. **The IIAB coupling is ~90% branding and aspiration, not code.** No source reads `/opt/iiab`,
   Kiwix `.zim` files, IIAB module state, or checks content availability. The advertised
   "link taxonomy items to IIAB modules via `requiredData`/`iiabObtained`, auto-check availability,
   quest types" story lives in the README and *partially* in TypeScript types — **the taxonomy data
   has 0 `requiredData`, 0 `questType`, 0 `iiabObtained`, 0 kiwix references across 790 nodes**, and
   no runtime code consumes them. `ServerStatus`/`LeaderBoard` are pure mock "IIAB network" fiction
   (fake Prague/Brno/Vienna servers, "blockchain"/Solana claims) and are imported nowhere. Dropping
   IIAB costs almost nothing; the real content-linking vision was never implemented.

3. **Most of what the UI shows is mock data.** All four homepage tiles, the three top-level custom
   components, and the Setup wizard render hardcoded placeholders. The genuinely working surface is
   narrow: **Admin CRUD + companion page-capture + the static taxonomy tree.** Plan the rework around
   promoting those three real pillars and deleting the fiction — not around preserving the stated
   feature surface.

A secondary theme: **pervasive Czech UI strings** with English data/code (every page, both mock
components, the companion script; an inert language setting; typos like *vzdělávacoím*), and a
**recurring async-treated-as-sync bug class** that silently disables the app's headline feature (the
DB-metadata overlay on the game map) and theme persistence.

## 2. Technology stack

| Layer | Choice |
|---|---|
| Frontend | React 18, TypeScript, Vite (SWC plugin), react-router-dom |
| UI | shadcn/ui + Radix + Tailwind; custom `game.*` theme colors |
| Data fetching | `fetch` wrappers (per-domain); `@tanstack/react-query` mounted but unused |
| "Backend" | Vite middleware plugin → `src/services/apiServer.ts` → `better-sqlite3` (**dev-only**) |
| DB | SQLite at `process.cwd()/data/knowledge-explorer.db` (lost on redeploy) |
| Build | `vite build` → static `dist/` (no server output) |
| Provenance | Lovable scaffold (leftover OG meta, `lovable-tagger`, title `hoard-progress-tracker`) |

## 3. Architecture map

```
Browser SPA (React)
  ├─ pages/  Index, Admin, Game(+island/city/building), Setup, Settings, NotFound
  ├─ game/   taxonomy data (3451 ln static tree) → taxonomyMapper → GameMap/CityView/BuildingView
  ├─ hooks/  useServerHealth (gates all rendering), useDatabase (pass-through), useTheme
  └─ services/api/*  → fetch('/api/*')
                         │  (same-origin)
                         ▼
Vite dev middleware (vite.config.ts `api-middleware`)  ◀── ONLY exists under `vite dev`
  └─ apiServer.ts (manual URL routing, { success, data, error } envelope)
       └─ database.server.ts (better-sqlite3, 8 tables, single-tenant)

External: public/companion-script.js  (Tampermonkey userscript, @match *://*/*)
  └─ floating panel on ANY page → REST POST /api/metadata (captures page metadata)
```

### Data flows that actually work
- **Companion capture:** userscript on any page → `POST /api/metadata` → `api_taxonomy_metadata` table → Admin "API Data" tab lists them.
- **Admin CMS:** taxonomy-metadata CRUD, homepage-tile config, both persisted.
- **Static taxonomy render:** `taxonomyData` → `taxonomyMapper.gameMap` → game views.

### Data flows that are broken/mock
- Homepage tiles (Index ignores the configured `homepage-tiles` and renders a hardcoded array).
- Game completion (in-memory only; never calls `completionApi`).
- Game DB-metadata overlay (async-Promise bug → always falls back to defaults).
- Theme persistence to DB; Settings export/reset (operate on non-existent `localStorage['iiab-database']`).
- Every numeric stat shown (all placeholder).

## 4. Full IIAB integration-point catalog

Every IIAB touchpoint found, with its true nature:

| # | Integration point | Location | Reality | Verdict |
|---|---|---|---|---|
| 1 | "IIAB Learning / Internet in a Box" branding | `pages/Index.tsx`, `game/components/GameMap.tsx` | String labels only | Rebrand → nOS |
| 2 | Mock IIAB server network | `components/ServerStatus.tsx` (5 fake servers, "blockchain") | 100% mock, imported nowhere | **DROP** |
| 3 | Mock IIAB leaderboard | `components/LeaderBoard.tsx` (fake users, "Solana guru") | 100% mock, imported nowhere | **DROP** |
| 4 | "IIAB síti" copy | `components/ProgressTracker.tsx` | Orphaned component, async bug | **DROP** |
| 5 | `requiredData` = "kiwix package/file" | `game/types/taxonomy.ts` | Type field, **0 usages in data/code** | Repurpose → nOS content link (see below) |
| 6 | `iiabObtained` auto-check | README only | **Does not exist** in code | N/A (was never built) |
| 7 | `questType` download/read/exercise/explore | `game/types/taxonomy.ts` | Type field, **0 usages** | Optional keep, unimplemented |
| 8 | `src/config/iiab.ts` (module base URLs) | README | **File does not exist** | N/A |
| 9 | Companion "capture IIAB page" | `public/companion-script.js` | Generic page capture, **no IIAB detection** | Keep as generic capture |
| 10 | `localStorage['iiab-database']` export/reset | `pages/Settings.tsx` | Vestigial from a former SQL.js design; **key never set** → dead | Rewrite/remove |
| 11 | Apache vhost + IIAB menu JSON deploy | README | Manual, brittle; replaced by container deploy | Replace with nOS manifest |
| 12 | Kiwix/Kolibri/Sugarizer module paths | README `iiabConfig` | Aspirational; not in code | Repurpose → real nOS services |

**The pivotal insight:** items #5/#8/#12 — linking a taxonomy node to real offline content — were
*never implemented on IIAB* but become **genuinely achievable on nOS**, because nOS ships Kiwix,
Nextcloud, Jellyfin, Calibre-Web, and Open WebUI as first-class services at stable subdomains under a
shared SSO session. The rework doesn't just swap a deployment target; it lets the app finally deliver
its original content-linking premise. See [`NOS_ANALYSIS.md`](./NOS_ANALYSIS.md) §Content services.

## 5. Notable bugs & tech debt (independent of the migration)

- **Async-as-sync (bug class):** `useTheme`, all 3 game views (`GameMap`/`CityView`/`BuildingView`),
  and `ProgressTracker` call async APIs without `await`/state, testing a `Promise` for truthiness.
  Silently disables the game's DB-metadata overlay (its headline feature) and DB theme persistence.
- **Port inconsistency:** README + `bookmarklet.js` + `companion-script.js` default to **42069**;
  `vite.config.ts` serves **8080**. Companion fails out-of-the-box against a default dev server.
- **Bookmarklet ID/flag mismatch:** checks `window.DataHoarderCompanion`/`#dh-companion-panel`; the
  script sets `window.DataHoardingCompanion`/`#data-hoarding-companion` → toggle never matches,
  re-injects every click. Also hardcodes `localhost:42069`.
- **Companion baked LAN IP:** `192.168.1.131:42069` hardcoded in the server list.
- **Settings type mismatch:** reads `appMetadata.lastUpdate` + `.migrations`; type has `lastUpdated`
  and no `migrations` → `undefined`/`JSON.parse(undefined)` throw. About tab claims "SQLite (SQL.js)"
  (stale).
- **Two half-wired companion channels:** `Index.tsx` listens for `postMessage` `DH_SAVE_METADATA`;
  the companion script only ever POSTs REST → the postMessage path is never exercised.
- **`unlock_all: true`** in `featureFlags` bypasses the entire progression/unlock system.
- **`TaxonomySelect`** re-derives node IDs from array index rather than reading `.id` — brittle.
- **Dead code:** `ServerStatus`, `LeaderBoard`, `ProgressTracker`, `PolygonCard`, `todosApi` (no UI),
  route params (unused), `react-query` (mounted, unused), `Setup` fake init (placebo `setTimeout`).
- **ESLint** disables `@typescript-eslint/no-unused-vars` → orphans go unflagged.

## 6. Per-module KEEP / REWRITE / DROP verdicts

Legend: **KEEP** = port with minor fixes · **REWRITE** = keep the intent, rebuild the code ·
**DROP** = delete.

| Module | Verdict | Reason / action |
|---|---|---|
| `services/apiServer.ts` (dev middleware) | **REWRITE** | Becomes a real standalone backend process (Express/Fastify). Keep the endpoint map + `{success,data,error}` envelope. |
| `services/database.server.ts` | **REWRITE** | Port schema; add `user_id` scoping (per-user SSO); move DB path to a mounted volume. |
| `services/api/*` (9 clients) | **REWRITE** | Collapse into one typed `apiFetch<T>()`; drop `any`; real error bodies. |
| `hooks/useDatabase` | **DROP** | Pure pass-through indirection; replace with react-query hooks. |
| `hooks/useServerHealth` | **REWRITE** | Add polling/reconnect; today it gates all rendering off one un-repeated fetch. |
| `hooks/useTheme` | **REWRITE** | Fix async-in-sync read; dedupe with `App.tsx` init. |
| `types/database.ts` | **KEEP** | Fix `lastUpdated` vs `lastUpdate`/`migrations` mismatch. |
| `pages/Index` | **REWRITE** | Render real tile config; unify companion channel; rebrand. |
| `pages/Admin` | **KEEP** | Core working CMS; await deletes; translate to English. |
| `pages/Game` | **REWRITE** | Persist completion via API; drop `unlock_all`; fix island-vs-galaxy metaphor. |
| `pages/Settings` | **REWRITE** | export/reset broken; SQL.js/`migrations` stale; wire real i18n or cut. |
| `pages/Setup` | **DROP** | Placebo wizard; replace with a health gate. |
| `pages/NotFound` | **KEEP** | Restyle to theme tokens; translate. |
| `game/data/taxonomy.ts` (3451 ln) | **KEEP** | The real asset (12 domains, 790 nodes). Relocate to DB/JSON; populate content links (nOS) or drop the unused fields. |
| `game/types` + `taxonomyMapper` | **KEEP** | Solid model; drop unused x/y positions; make `gameMap` non-import-time if data goes dynamic. |
| `game/config/featureFlags` | **REWRITE** | Make `unlock_all` env/runtime-driven; default off. |
| `game/components/{GameMap,CityView,BuildingView}` | **REWRITE** | Fix async-metadata bug (headline feature currently dead). |
| `game/components/PolygonCard` | **DROP** | Unused; hardcoded non-token styling. |
| `components/ServerStatus` | **DROP** | Mock IIAB/blockchain fiction. |
| `components/LeaderBoard` | **DROP** | Mock (Solana). Optionally rebuild later from real per-user data. |
| `components/ProgressTracker` | **DROP** | Orphaned; async bug; stale SQL.js copy. |
| `components/TaxonomySelect` | **KEEP** | Used by Admin; read real `.id` instead of array index. |
| `components/homepage/*` (4 tiles) | **REWRITE** | All mock; `CustomTodo` must use `todosApi`; wire real data. |
| `components/ui/*` (shadcn) | **KEEP** | Standard primitives; carry over verbatim. |
| `public/companion-script.js` | **REWRITE** | Genuinely wired but 1219 ln with 500 ln inline CSS, baked LAN IP, wrong port, Czech. Extract, fix, translate. |
| `public/bookmarklet.js` | **REWRITE** | Wrong port + ID/flag mismatch + hardcoded host. |
| `index.html`/`main.tsx`/`App.tsx` | **KEEP** | Strip Lovable meta; add StrictMode; dedupe theme init; use or remove react-query. |
| `vite.config.ts` | **REWRITE** | Remove the middleware "backend"; Vite becomes SPA-only; backend is a separate process. |
| `tailwind`/`components.json`/`eslint` | **KEEP** | Drop stale content globs; re-enable `no-unused-vars`. |

## 7. Recent git history (taken into account)

The last ~10 commits ("Fix API and build errors", "Refactor: Remove legacy code and set port",
"Implement server-first architecture", "Split useDatabase hook") show the maintainer already moving
**toward a server-first model and cleaning legacy client-SQLite (SQL.js) code**. That direction is
correct and this blueprint continues it — the missing next step the history hasn't reached is a
*real* server process that survives `vite build`. The stale "SQL.js" About-tab copy and the vestigial
`localStorage['iiab-database']` code are leftovers from the pre-refactor client-DB era and should be
finished off in the rework.

## 8. What to carry forward vs. what to delete

**Carry forward (the real value):**
- The 12-domain / 790-node taxonomy dataset (the genuine intellectual asset).
- The Admin CMS interaction model (taxonomy-metadata + tiles + captured metadata).
- The companion page-capture concept (generic web capture into a taxonomy).
- The shadcn/Tailwind design system and the island→city→building navigation metaphor.
- The `{success,data,error}` API envelope and endpoint map.

**Delete (the fiction):**
- All mock components (ServerStatus, LeaderBoard, ProgressTracker) and mock tile data.
- The Setup placebo wizard.
- Vestigial SQL.js/localStorage export/reset paths.
- IIAB branding and the unbuilt `iiabObtained`/multi-server/blockchain claims.
