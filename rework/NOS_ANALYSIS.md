# Phase 2 — nOS analysis & recommended integration model

> Scope: `nOS` @ `dev` (tip `27dc838`). How nOS works and the idiomatic way KEAP
> plugs into it. Companion docs: [`REVIEW.md`](./REVIEW.md),
> [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md), [`NEW_REPO_STRUCTURE.md`](./NEW_REPO_STRUCTURE.md).

## 1. What nOS is

nOS is an **Ansible playbook** that provisions a complete self-hosted "agentic home lab" — ~50 FOSS
Docker services across 8 compose stacks, wired together by 71 Ansible roles (`pazny.*` namespace) and
65 "anatomy" plugins. It is the open-source engine behind *This is AIT — Agentic IT*. Everything is
FOSS, all data stays local, and a `blank=true` run wipes and reinstalls from scratch. Targets Apple
Silicon (primary) and Ubuntu 24.04 (v0.4 Linux port).

The relevant subsystems for a third-party app:

- **Docker stacks** (`~/stacks/`): `infra` (MariaDB, PostgreSQL, Redis, Portainer, Traefik,
  Authentik, Infisical), `observability` (Grafana/Prometheus/Loki/Tempo), `iiab` (WordPress,
  Nextcloud, n8n, Kiwix, Jellyfin, Open WebUI, Calibre-Web, Vaultwarden, …), `apps` (Tier-2
  manifest-driven apps), `devops` (Gitea, Woodpecker, GitLab), plus `b2b`/`voip`/`engineering`/`data`.
- **Traefik** is the default edge proxy (binds 80/443). Two providers: a **file provider**
  auto-derived from `state/manifest.yml` (Tier-1), and a **docker provider** reading labels emitted
  for Tier-2 apps. TLS via mkcert wildcards (local) or Let's Encrypt (public).
- **Authentik** is central SSO at `auth.<tld>`. Cookie domain `.<tld>` → one login is shared across
  all service subdomains. Per-plugin `authentik:` blocks are the source of truth for OIDC clients.
- **Anatomy plugins** (`files/anatomy/plugins/<svc>-base/plugin.yml`) declare cross-service wiring:
  SSO, notifications, GDPR register, Wing hub cards, health lifecycle, observability.

## 2. The two ways a third-party app plugs in

nOS has a deliberate two-tier onboarding model.

| | **Tier-2 — apps_runner manifest** | **Tier-1 — role + plugin** |
|---|---|---|
| Files | one `apps/<name>.yml` | `roles/pazny.<name>/` + `files/anatomy/plugins/<name>-base/plugin.yml` + `state/manifest.yml` row + `default.config.yml` toggle + `include_role` in an orchestrator |
| Effort | ~30 min, no playbook code | ~half-day |
| Image | must be a **pullable `image:`** | pullable **or built from source** (`build: context: files/<name>/`) |
| Routing | Traefik **docker labels** auto-emitted by `nos_apps_render.py` | Traefik **file provider** from `state/manifest.yml` (needs `domain_var` + `port_var`) |
| SSO | `authentik:` block (forward_auth / native_oidc), harvested `from: app_manifest` | full `authentik:` block, all three buckets |
| DB | bring your own (embedded Postgres container) | can request the **shared infra Postgres/MariaDB** |
| Post-start API calls, migration recipes, coexistence, `/hub` card, notifications | ❌ | ✅ |
| GDPR Art-30 | **mandatory** `gdpr:` block or the parser rejects | `gdpr:` block in plugin.yml |

Best model to copy for each path:
- **Tier-2:** `apps/documenso.yml` — a Next.js (Node) app + its own bundled `postgres:15-alpine`, both
  in one manifest, forward-auth SSO. The closest analog to KEAP.
- **Tier-1:** `roles/pazny.miniflux/` + `files/anatomy/plugins/miniflux-base/plugin.yml` — a simple web
  app on the `iiab` stack with native OIDC and a shared Postgres DB.

### Tier-2 manifest anatomy (mandatory blocks)

`nos_app_parser.py` enforces three top-level blocks: `meta`, `gdpr`, `compose`.

- **`meta`**: `name` (lowercase, matches filename), `version`, `summary`, `ports`.
- **`gdpr`** (all required, no defaults): `purpose`, `legal_basis` (enum), `data_categories`,
  `data_subjects` (values like `end_users` flip the TLS gate on), `retention_days` (`0` invalid, use
  `-1` for forever), `processors`, `transfers_outside_eu` (when `false`, every image must come from an
  EU registry allowlist: docker.io, ghcr.io, registry.gitlab.com, lscr.io, quay.io, registry.k8s.io).
- **`compose`**: verbatim docker-compose. Magic tokens expanded before up and persisted to
  `credentials.yml` under `app_secrets:`: `$SERVICE_FQDN_<APP>`, `$SERVICE_PASSWORD_<SUFFIX>`,
  `$SERVICE_USER_<SUFFIX>`, `$SERVICE_BASE64_{32,64}_<NAME>`.
- Optional **`authentik:`** and **`nginx:`** (`auth: none|proxy|oidc`, `rbac_tier: N`) routing blocks.

Bind app ports on `127.0.0.1` only — Traefik is the sole edge and enforces the SSO gate; a bare
`8080:8080` publishes on the LAN and bypasses Authentik.

## 3. Auth / SSO — three buckets, and which one KEAP wants

- **`native_oidc`** — the app speaks OIDC itself; user sees "Sign in with Authentik" (or auto-redirect)
  in-app; per-user identity flows in (Grafana, Miniflux, Vaultwarden).
- **`header_oidc`** — the Authentik proxy outpost forwards `X-Authentik-Username`/`-Email`/`-Groups`
  headers; the app auto-creates its local user from them. True SSO, no per-app OIDC client (Firefly III).
- **`forward_auth`** — pure access gate: a valid session = "you're in", the app has no per-user state
  (Uptime Kuma, Calibre-Web, Kiwix, Qdrant).

**Recommendation for KEAP:** start with **`header_oidc`**, optionally graduate to **`native_oidc`**.

- KEAP *wants per-user state* (progress, todos, saved bookmarks, a real leaderboard) → `forward_auth`
  alone is too coarse.
- We control KEAP's source, so reading `X-Authentik-*` headers is trivial — the scaffold's
  `server/identity.ts` already does exactly this and scopes every DB row by `user_id`. **No OIDC
  client library, no redirect dance, no client secret round-trips.** This is the lowest-friction path
  to real per-user knowledge spaces and it is idiomatic (Firefly III uses it).
- If a nicer in-app account experience is later wanted, flip the plugin's `authentik.mode` to
  `native_oidc`, add an OIDC client lib to the backend consuming the discovery URL, and add
  `redirect_uris`/`scopes` — the Miniflux model. The scaffold's plugin manifest documents both.
- **Never** stack `forward_auth` middleware on top of `native_oidc` (double login for no benefit).

Wiring, either way, is declarative: the `authentik:` block in the plugin/manifest provisions the
Authentik provider + application automatically; forward-auth middleware (`authentik@file`) attaches to
the Traefik router when `auth: proxy` (Tier-1 via `services.yml.j2`, Tier-2 via docker labels). When
consuming OIDC on a local TLD, the mkcert root CA mount + `*_CA_CERTS` env **must** be guarded by
`{% if install_authentik and tenant_domain_is_local %}` in the plugin compose-extension (mandatory
nOS doctrine — omitting it breaks LE chain validation on public TLDs).

## 4. Persistence

nOS runs **shared MariaDB + PostgreSQL** in the always-on `infra` stack. Options for KEAP, simplest
first:

1. **SQLite on a named volume** (recommended default). KEAP's store is already SQLite; it needs only
   persistent storage (`keap_data:/data`), no DB provisioning task. Matches the app's single-node,
   offline-first spirit. This is what the scaffold ships.
2. **Embedded Postgres container** (Tier-2 `documenso` pattern) — a `postgres:15-alpine` service in
   the same manifest, isolated volume. Use only if KEAP migrates off SQLite while staying Tier-2.
3. **Shared infra Postgres** (Tier-1 only) — append a `keap` clause to the four ternary loops in
   `roles/pazny.postgresql/tasks/post.yml` (create DB, create/alter user, enable pgcrypto, grant),
   then read `postgres://keap:…@postgresql:5432/keap`. Best if KEAP grows into a multi-user service
   wanting central backup/observability of its DB.

## 5. Content services already in nOS — the real payoff

These ship as `pazny.*` roles (mostly on the `iiab` stack) and are auto-routed under `tenant_domain`
(default `dev.local`). A knowledge/preservation app links directly to them, and because the SSO cookie
domain is `.<tld>`, an authenticated KEAP session is shared across all of them:

| Service | Role | Default domain | Port | SSO |
|---|---|---|---|---|
| **Kiwix** (offline Wikipedia / ZIM) | `pazny.kiwix` | `kiwix.dev.local` | 8888 | forward_auth |
| **Calibre-Web** (e-book library) | `pazny.calibre_web` | `books.dev.local` | 8083 | forward_auth |
| **Nextcloud** (files & docs) | `pazny.nextcloud` | `cloud.dev.local` | 8085 | native_oidc |
| **Jellyfin** (media) | `pazny.jellyfin` | `media.dev.local` | 8096 | native_oidc |
| **Open WebUI** (local AI chat / RAG) | `pazny.open_webui` | `ai.dev.local` | 3004 | native_oidc |
| **WordPress** (CMS/blog) | `pazny.wordpress` | `wordpress.dev.local` | 8084 | native_oidc |

This is the strategic reframe: KEAP's original `requiredData: "kiwix package/file"` idea — never
implemented on IIAB — becomes **real** here. A taxonomy item's `requiredData` (e.g. `kiwix:wikipedia_en`
or `calibre:12`) resolves through a small link map (`src/config/nos.ts` in the scaffold) into a live
deep link. Kiwix and Calibre-Web are the natural content neighbors; Open WebUI is the search/RAG
companion; Nextcloud is the file backing store.

## 6. Build/deploy of a Node/Vite app on nOS

Everything runs as a **Docker container** — nOS has no host-side npm/Vite build step. Two patterns:

1. **Pre-built image** (most roles): `image: vendor/app:tag`.
2. **Build from source** in-repo: `build: { context: {{ playbook_dir }}/files/<app> }`, tagged
   `nos/<app>:<version>`. Only `pazny.puter` and `pazny.superset` do this today; **Puter is the
   template for a Node app built from source.**

For KEAP: a standard **multi-stage Dockerfile** (build the Vite SPA + compile the standalone backend,
then a slim runtime that serves both on one port). The scaffold ships exactly this
(`rework/scaffold/Dockerfile`). Traefik routes a single upstream port, so the backend must serve the
built SPA static assets *and* the `/api` surface from that one port — which the scaffold's
`server/index.ts` does.

## 7. Recommended integration model for KEAP

**Phase-appropriate, two-step:**

- **Step 1 (pilot, get it live fast): Tier-2 app manifest** `apps/keap.yml` with a pre-built image
  (`ghcr.io/budweis-dev/keap`), `mode: header_oidc`, SQLite on a `keap_data` volume, `auth: proxy`,
  `rbac_tier: 3`. Ships in the scaffold at `deploy/nos/keap.yml`. This proves the container,
  the SSO gate, and per-user identity end-to-end with zero nOS playbook changes.

- **Step 2 (destination, first-class): Tier-1 role `pazny.keap` + plugin `keap-base`**, built from
  source under `files/keap/`, on the `iiab` stack. This unlocks the `/hub` card, notification routing,
  health lifecycle, deep content-service linking, and (if wanted) native OIDC + shared Postgres. The
  scaffold ships the plugin manifest at `deploy/plugin/keap-base/plugin.yml` and documents the role
  files to create (clone `pazny.miniflux`, swap in a `build:`-based compose fragment).

The migration plan ([`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md)) sequences this so the pilot lands in
days and the Tier-1 promotion follows once the containerized app is stable.

### nOS files worth reading before implementing
- Tier-2: `apps/_template.yml`, `apps/documenso.yml`, `apps/qdrant.yml`,
  `files/anatomy/module_utils/nos_app_parser.py`, `files/anatomy/library/nos_apps_render.py`,
  `docs/tier2-app-onboarding.md`.
- Tier-1: `roles/pazny.miniflux/*`, `files/anatomy/plugins/miniflux-base/plugin.yml` (+ its
  `templates/miniflux-base.compose.yml.j2`), `roles/pazny.traefik/templates/dynamic/services.yml.j2`,
  `state/manifest.yml`, `roles/pazny.postgresql/tasks/post.yml`.
- Build-from-source: `roles/pazny.puter/templates/compose.yml.j2`, `files/puter/Dockerfile`.
