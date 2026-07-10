# Completion proposal — KEAP as a native nOS system serving humans AND nOS agents

> Written 2026-07-10 after a deep exploration of the live nOS checkout at `../nOS`
> (branch tip `27dc8389` = `origin/dev`). This document **supersedes parts of
> [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md)** (notably open questions 1, 4, 10 and Phases 0/4/5)
> and extends the blueprint with the agent-facing half that the overnight review did not cover.
> All `nOS:` paths below are relative to the nOS repo root and were verified against the working tree.

## 0. Decisions taken by the owner (fixed constraints)

1. **The rework happens in THIS repository.** No fresh repo is bootstrapped from `scaffold/`;
   the scaffold's pieces are merged into the repo root in place (Phase 0 below).
2. **nOS is the backend platform, KEAP is one of its systems.** KEAP runs as a first-class
   **Tier-1** nOS service. The **only artifact living in the nOS repo is an Ansible role
   (`roles/pazny.keap/`) + the standard Tier-1 onboarding row/toggle/plugin**; the role
   `git clone`s this repository at a pinned ref and builds the image from source.
   No image is published to a registry — this removes the Tier-2 pilot (Tier-2 requires a
   pullable `image:`, per `nOS:CLAUDE.md` §Tier-2) and makes Tier-1 the direct target.
3. **KEAP must serve nOS agents**, not only humans: the knowledge system becomes a queryable
   knowledge source (and a write target for preservation) for the AgentKit runtime.
4. **The repo becomes `thisisait/nos-keap`** — same GitHub org as nOS. The current
   `budweis-dev/knowledge-explorer-and-preserver` is transferred/renamed there (GitHub transfer
   keeps history, PRs, and redirects); the nOS role's `keap_repo_url` points at the new home.
5. **Real cs/en i18n is a requirement**, not English-only. The currently inert language setting
   becomes functional; hardcoded Czech strings are extracted into locale catalogs.
6. **Gamification is deprioritized** (island→city→building map moves to the backlog); the core
   product is the knowledge system: taxonomy, Admin CMS, companion capture, and the agent surface.
   **Sharing is strategically important later** — the data model must be sharing-ready from day one
   (per-user rows carry a `visibility`/owner field so shared collections and social features can be
   added without a schema rework).

## 1. What nOS actually provides (verified, with sources)

Facts the design below builds on — each checked in the nOS working tree:

- **Tier-1 pattern**: role with compose-override (`roles/pazny.<svc>/templates/compose.yml.j2` →
  `~/stacks/<stack>/overrides/<svc>.yml`), a row in `state/manifest.yml` (`domain_var` + `port_var`
  drive Traefik's file provider — `roles/pazny.traefik/templates/dynamic/services.yml.j2:32-144`),
  an `install_<svc>` toggle in `default.config.yml`, an `include_role` in the stack orchestrator,
  and an anatomy plugin `files/anatomy/plugins/<svc>-base/plugin.yml` (SSO + GDPR + lifecycle +
  Wing hub card). Build-from-source precedent: `roles/pazny.puter` (`build: context:`, image tag
  `nos/<app>:<version>`).
- **Identity via forward-auth headers**: the Traefik middleware `authentik@file` injects
  `X-authentik-username / -uid / -email / -name / -groups`
  (`nOS:roles/pazny.traefik/templates/dynamic/middlewares.yml.j2:14-27`). Reference consumer:
  `nOS:files/anatomy/wing/app/Security/ForwardAuthUserStorage.php:46-66` (groups become roles).
- **SEC-02 isolation**: header-trusting backends sit on the Traefik-only **`gated_net`**
  (`nOS:tasks/stacks/shared-network.yml:18-38`) so peer containers cannot forge identity headers.
  KEAP must join `gated_net` and publish its port on `127.0.0.1` only.
- **Agent runtime = AgentKit** (`nOS:files/anatomy/wing/app/AgentKit/`, design doc
  `nOS:docs/ait-runtime-architecture.md`): PHP host-side runner, agents declared in
  `files/anatomy/agents/<name>/agent.yml`, tools statically registered
  (`Tools/ToolRegistry.php`, scope-gated at session start). Agents do **not** speak MCP;
  they call loopback HTTP APIs through tool classes (`McpWingTool.php` is the template, 16 KiB
  response cap). New-tool recipe is documented at `nOS:docs/ait-runtime-architecture.md:283-288`
  (tool class → schema enum → `common.neon` registration → CI test).
- **Semantic substrate exists but is corpus-less**: Qdrant (Tier-2 `apps/qdrant.yml`) fronted by
  Bone's JWT-scoped embeddings proxy `POST /api/v1/embeddings/{upsert,search}`
  (`nOS:files/anatomy/bone/main.py:816-890`, 768-dim cosine, vectors computed by the caller via
  Ollama `nomic-embed-text`). The `librarian` agent is shipped but **deferred: "needs Qdrant corpus
  population pipeline"** (`nOS:files/anatomy/agents/librarian/agent.yml:57-58`). The RAG doc
  explicitly scopes the existing collections to platform telemetry, *not* a knowledge base
  (`nOS:docs/rag-architecture.md:54-56`).
- **No knowledge/taxonomy/curriculum system exists anywhere in nOS** (searched: only GDPR/event/CSS
  taxonomies). KEAP fills a genuine gap and overlaps with nothing.
- **Real MCP exists only for Open WebUI** via the mcpo gateway
  (`nOS:roles/pazny.mcp_gateway/templates/mcpo-config.json.j2`); entries are config-only, including
  `{"type": "sse", "url": ...}` remotes.
- **No generic app-data API** in nOS core (Bone/Wing are ops/agent-scoped). KEAP therefore keeps its
  own thin API process (the scaffold's Express server) — that *is* the idiomatic shape of an nOS
  system; "nOS as backend" means Traefik + Authentik + gated_net + volumes/DB + Bone/Qdrant +
  AgentKit do everything around it.

## 2. Target architecture

```
                          ┌──────────────────────────── nOS host ────────────────────────────┐
 Browser ── https://keap.<tld> ── Traefik ──[authentik@file: X-authentik-*]──┐               │
                                    (file provider row in state/manifest.yml) │               │
                                                                              ▼               │
                                                              ┌────────── iiab-keap-1 ─────┐  │
 AgentKit agents (host PHP) ── http://127.0.0.1:{keap_port} ─▶│ Express: SPA + /api (human)│  │
   via new `mcp-keap` tool         Bearer service token       │          /agent/v1 (agents)│  │
                                                              │ SQLite on keap_data volume │  │
 Open WebUI ── mcpo ──(sse)── /agent/v1/mcp (optional) ──────▶│ nets: gated_net (+shared)  │  │
                                                              └──────────┬─────────────────┘  │
                                                                         │ JWT (client creds) │
                                              Bone /api/v1/embeddings/* ─┴─▶ Qdrant           │
                                              (semantic index of taxonomy + captures)         │
```

**One container, two authenticated surfaces:**

- **Human surface** (`/`, `/api/*`): SPA + the existing REST API. Identity from
  `X-authentik-uid` (stable key; username/email/groups as profile), trusted **only** because the
  container is reachable exclusively through Traefik on `gated_net`. Per-user data scoping as in
  `scaffold/server/identity.ts`, but keyed on `uid`, not username.
- **Agent surface** (`/agent/v1/*`): reached by host-side AgentKit processes directly on the
  loopback-published port — which **bypasses Traefik**, so Authentik headers are absent and must
  not be trusted there. Instead: a **bearer service token** minted by the Ansible role
  (`{{ global_password_prefix }}_pw_keap_agent` in nOS credentials, injected into the container
  env and into AgentKit's vault). Read and write scopes are separated (`keap.read` / `keap.write`
  capability scopes on the tool side, two tokens or token-embedded scope on the KEAP side).

This dual-surface split resolves the apparent conflict between R4 of the migration plan ("loopback
port = header forgery risk") and the agents' need to skip SSO: containers can't reach KEAP at all
(gated_net), LAN can't reach it (loopback), and host processes get a scoped token instead of
identity headers.

## 3. The agent-facing API (the "helps nOS agents" half)

New in this repo, `server/agent/` — versioned, machine-first, self-describing:

| Endpoint | Purpose |
|---|---|
| `GET /agent/v1/health` | liveness + version + corpus stats |
| `GET /agent/v1/openapi.json` | self-description (also what mcpo/Open WebUI consumes) |
| `GET /agent/v1/taxonomy/search?q=&domain=` | structural + FTS5 full-text search over the 790-node tree and captured metadata |
| `GET /agent/v1/taxonomy/node/{id}` | node + ancestors + children + **content links resolved to live nOS URLs** (kiwix/calibre/nextcloud/openwebui deep links via `src/config/nos.ts`) |
| `GET /agent/v1/content/resolve?ref=kiwix:wikipedia_en` | resolve a single `requiredData` ref to a live URL |
| `POST /agent/v1/captures` | **agents preserve knowledge**: submit a discovered source/fact (same shape as the companion userscript's `POST /api/metadata`) into a review queue surfaced in the Admin CMS |
| `GET /agent/v1/search/semantic?q=` | proxied Qdrant search via Bone (Phase 6; falls back to FTS until the index exists) |

Design rules: JSON only, `{success,data,error}` envelope (kept from the current API), stable IDs,
responses trimmed to fit AgentKit's 16 KiB tool-response cap (summary + pagination, never dumps).

**Why agents want this**: taxonomy lookup gives agents a curated map of "what knowledge exists and
where it lives locally" (Kiwix/Calibre/Nextcloud — all offline, all SSO'd); captures give agents a
durable place to *preserve* what they discover (the "P" in KEAP) with human review; semantic search
(Phase 6) finally gives `librarian` a real corpus.

## 4. The nOS-side contact surface (everything nOS needs, nothing more)

Standard Tier-1 onboarding, all mechanical (`nOS:CLAUDE.md:266-274`):

1. `roles/pazny.keap/` — defaults (`keap_version`, `keap_port`, `keap_domain: keap.<tld>`,
   `keap_data_dir`, `keap_repo_url: https://github.com/thisisait/nos-keap`, `keap_repo_ref`),
   tasks: **`git clone`/fetch this repo at the pinned ref** into the role's build dir → render compose override with
   `build: { context: <clone dir> }`, image `nos/keap:{{ keap_version }}` (puter pattern, but
   cloning instead of vendoring), loopback port bind, `gated_net` + shared net, healthcheck
   (`/agent/v1/health`), `mem_limit`/`cpus`.
2. `state/manifest.yml` row (`id: keap`, `stack: iiab`, `install_flag: install_keap`,
   `domain_var: keap_domain`, `port_var: keap_port`, `data_path_var: keap_data_dir`,
   `oidc: proxy`, `rbac_tier: 3`, `version_source: config`).
3. `install_keap: false` toggle in `default.config.yml`; `include_role` in the iiab orchestrator.
4. `files/anatomy/plugins/keap-base/plugin.yml` — adapted from `deploy/plugin/keap-base/plugin.yml`
   in this repo: `authentik: mode: header_oidc` (proxy provider), full GDPR Art-30 block
   (categories: username/uid/email/groups, learning progress, captured page metadata;
   `transfers_outside_eu: false`), lifecycle `wait_health`, Wing hub card.
5. **One deliberate code addition beyond the role** (flagging it honestly — it cannot be expressed
   as Ansible): the AgentKit tool `mcp-keap`, following the documented 4-step recipe
   (`nOS:docs/ait-runtime-architecture.md:283-288`): `Tools/KeapTool.php` cloned from
   `McpWingTool.php` (loopback base URL `http://127.0.0.1:{keap_port}/agent/v1`, bearer from vault,
   scopes `keap.read`/`keap.write`), enum entry in `state/schema/agent.schema.yaml`, registration in
   `common.neon`, schema CI test. ~150 lines total. Until it lands, agents can already reach KEAP
   zero-code through **mcpo** (config-only SSE/OpenAPI entry in
   `roles/pazny.mcp_gateway/templates/mcpo-config.json.j2`) — Open WebUI gets KEAP tools for free.
6. *(Phase 6, optional)* a `keap_knowledge` Qdrant collection declared alongside the three reserved
   collections in `nOS:files/anatomy/plugins/qdrant-base/plugin.yml:95-138`; KEAP syncs embeddings
   through Bone's `POST /api/v1/embeddings/upsert` using an Authentik client-credentials JWT with
   `nos:embeddings:write` — computing vectors via Ollama `nomic-embed-text` (768-dim), exactly the
   contract in `nOS:docs/rag-architecture.md:110-117`. This is also the first real corpus for the
   deferred `librarian` pipeline.

Everything else — TLS, routing, SSO, secrets, GDPR registry, health lifecycle, hub card,
observability, backups of the `keap_data` volume — is inherited from the platform. That is what
"backend = nOS" buys.

## 5. Updated phased plan (replaces MIGRATION_PLAN §3 Phases 0/4/5)

| Phase | Work | Effort | Where |
|---|---|---|---|
| **0′ In-place restructure** | Owner action: transfer the repo to `thisisait/nos-keap`. Merge `scaffold/` into repo root (`server/`, `Dockerfile`, `tsconfig.server.json`, SPA-only `vite.config.ts`); delete Vite api-middleware; delete obsolete `deploy/nos/keap.yml` (Tier-2 path dropped); keep `deploy/plugin/` as the source for nOS's plugin. Exit: `npm run build && npm start` serves SPA + live `/api/health`. | 0.5 d | this repo |
| **1 Real backend + identity** | As MIGRATION_PLAN Phase 1, with two changes: key users on `X-authentik-uid`, and every user-scoped table carries an owner + `visibility` column (`private` default) so future sharing needs no schema rework. | 2–3 d | this repo |
| **2 De-mock, de-IIAB & i18n** | Delete fiction, rebrand; **stand up real i18n** (extract all hardcoded Czech into `cs`+`en` catalogs via react-i18next, wire the language setting, locale-aware dates/numbers). Game-view fixes move to the backlog (Phase G). | 3–4 d | this repo |
| **3 Content linking** | Unchanged (`src/config/nos.ts` resolver + Admin `requiredData` editing + deep-link affordances). | 1–2 d | this repo |
| **4′ Agent surface** | `/agent/v1/*` per §3: routes, bearer-token auth with read/write scopes, FTS5 index, capture review queue in Admin, OpenAPI doc. | 1–2 d | this repo |
| **5′ Tier-1 role (git-clone build)** | §4 items 1–4 in nOS; deploy via `ansible-playbook main.yml --tags keap`. Exit: `https://keap.<tld>` behind SSO, per-user data isolated, health green in Wing. | 1–1.5 d | nOS |
| **6 Agent integration** | `mcp-keap` tool (§4 item 5) + mcpo entry; smoke agent session (e.g. `scout` or a new `knowledge-guide` agent.yml) querying taxonomy and filing a capture. *(Optional +1–2 d: Qdrant/Bone semantic sync, §4 item 6.)* | 1–2 d | nOS + this repo |

**Total ~8.5–13 d.** Phases 0′–4′ need no nOS changes and are fully testable locally
(`docker compose up` + curl with faked `X-authentik-*` headers and a static bearer token).

**Backlog (deliberately after the above):**
- **Phase G — gamification revival**: fix the async-metadata bug in `GameMap`/`CityView`/`BuildingView`,
  persist completion via API, re-enable progression (drop `unlock_all`). The game layer stays in the
  codebase but receives no rework investment until the knowledge core + agent surface ship.
- **Phase S — sharing & social**: shared collections (flip `visibility` to `shared`/`public`),
  sharing captures/curated links between users, and a leaderboard rebuilt on real per-user data.
  Enabled by the Phase 1 data model; no earlier phase may hardcode single-user assumptions.

## 6. Risks (delta to MIGRATION_PLAN §5)

- **R9 — Loopback agent port is host-trusted.** Any host process can call `/agent/v1` if it has the
  token; token lives in nOS credentials + AgentKit vault. Mitigation: scope-split tokens, rotate via
  playbook re-run, never log tokens, keep `/agent/v1` responses free of other users' personal data
  (captures are attributed to agent identity, progress endpoints are human-surface only).
- **R10 — Git-clone build coupling.** The role builds whatever `keap_repo_ref` points at; a broken
  ref breaks `--tags keap`. Mitigation: pin tags (not branches), CI in this repo must keep
  `docker build` green (the workflow in `.github/workflows/build.yml` already plans this — retarget
  it from "push image" to "build-only gate").
- **R11 — Schema-enum coupling for `mcp-keap`.** nOS CI (`test_agent_schema.py`) pins the tool
  enum; land the tool class + enum + neon registration in one nOS commit.
- **R12 — 16 KiB tool cap.** Agent endpoints must paginate/summarize; a raw taxonomy dump is ~3.4k
  lines. Enforce response-size budget in `/agent/v1` handlers from day one.

## 7. Open questions — all resolved

All 10 questions from MIGRATION_PLAN §6 are now decided by the owner:

| # | Question | Decision |
|---|---|---|
| 1 | Repo name & owner | **`thisisait/nos-keap`** (same org as nOS); service slug `keap` |
| 2 | SSO posture | `header_oidc` on `gated_net`; native_oidc optional later |
| 3 | Persistence | volume-SQLite default; shared-Postgres promotion optional later |
| 4 | Target tier | **Tier-1** role, no Tier-2 pilot |
| 5 | Backend framework | Express (as scaffolded) |
| 6 | Language | **real cs/en i18n** (Phase 2); language setting becomes functional |
| 7 | Companion userscript | keep & rewrite (Phase 2/4′ serve it at `/companion-script.js`); browser-extension form factor stays a backlog idea |
| 8 | Leaderboard / social | not dropped — **deferred to Phase S (sharing)** on real per-user data |
| 9 | Taxonomy storage | static 790-node tree as DB seed, Admin-editable after seeding |
| 10 | Repo vs vendored into nOS | standalone repo, git-cloned + built from source by `roles/pazny.keap` |

Strategic note: **gamification is on the back burner, sharing is the future.** The near-term product
is the knowledge core (taxonomy · Admin CMS · companion capture · agent surface); the sharing-ready
data model (Phase 1) is the only investment made now for that future.
