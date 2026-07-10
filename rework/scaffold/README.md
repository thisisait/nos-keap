# KEAP — Knowledge Explorer and Preserver (nOS edition)

A gamified knowledge-management interface, built to run as a first-class service
on the **[nOS](https://github.com/thisisait/nOS)** self-hosted platform
(replacing the original Internet-in-a-Box base).

> This is the **scaffold** for a fresh repository. Copy it out of
> `rework/scaffold/`, then port the existing SPA source (`src/`) on top of it.
> See `../MIGRATION_PLAN.md` and `../NEW_REPO_STRUCTURE.md` for the full plan.

## What changed vs the IIAB-era app

| Concern | Old (IIAB) | New (nOS) |
|---|---|---|
| Backend | Vite dev-middleware only → **no API in production** | Standalone Express server (`server/`), runs in a container |
| Deploy | Copy `dist/` to Apache + hand-edit IIAB menu YAML | One Tier-2 manifest (`deploy/nos/keap.yml`), `apps_runner` does the rest |
| Auth | none | Authentik header-OIDC SSO (per-user progress) |
| Content links | hard-coded `/kiwix`, `/kolibri`, mock server list | `src/config/nos.ts` → live nOS services (Kiwix, Nextcloud, Jellyfin, Calibre-Web, Open WebUI) |
| Persistence | `cwd/data/*.db` (lost on redeploy) | `/data` volume (survives container recreation) |

## Layout

```
server/            standalone backend (NEW — this is the missing piece)
  index.ts         express app: serves SPA + /api + health
  identity.ts      Authentik header-OIDC → per-user identity
  db.ts            sqlite persistence (user-scoped), ported from old server
  routes.ts        REST API, ported from old apiServer.ts
src/               React SPA (carried over from existing repo)
  config/nos.ts    nOS content-service link map (replaces phantom iiab.ts)
deploy/
  nos/keap.yml     Tier-2 app manifest for nOS apps_runner
  plugin/keap-base/plugin.yml   (optional) Tier-1 plugin autowiring manifest
Dockerfile         multi-stage build (SPA + backend) → runnable image
docker-compose.yml local standalone run (no nOS/Authentik in front)
```

## Local dev

```bash
npm install
npm run dev        # vite (SPA :5173) + tsx watch (api :8080) concurrently
```

## Build & run standalone

```bash
docker compose up --build   # http://localhost:8080
```

## Deploy on nOS

```bash
cp deploy/nos/keap.yml <nOS-checkout>/apps/keap.yml
cd <nOS-checkout>
python3 -m module_utils.nos_app_parser apps/keap.yml   # validate
ansible-playbook main.yml --tags apps
# → https://keap.apps.<tenant_domain>  (behind Authentik SSO)
```
