# Rework blueprint — nOS as base platform (replacing IIAB)

This directory is a **decision-ready blueprint** for rebuilding KEAP (Knowledge Explorer and
Preserver) where **[nOS](https://github.com/thisisait/nOS)** replaces Internet-in-a-Box as the
base platform. Nothing outside `rework/` is modified.

> **2026-07-10 update — direction fixed by the owner:** the rework happens **in this repository**
> (which becomes **`thisisait/nos-keap`**); nOS gets only a Tier-1 Ansible role that git-clones
> this project and builds it from source; KEAP must also serve **nOS agents** (AgentKit); real
> cs/en i18n is required; gamification moves to the backlog while the data model stays
> sharing-ready. The authoritative plan is now
> **[COMPLETION_PROPOSAL.md](./COMPLETION_PROPOSAL.md)**, which supersedes MIGRATION_PLAN.md
> Phases 0/4/5 and resolves all 10 of its open questions. The documents below remain valid as the
> underlying analysis.

## Read in this order

1. **[REVIEW.md](./REVIEW.md)** — what exists today: architecture map, the full IIAB integration-point
   catalog, and a per-module KEEP / REWRITE / DROP table. Headline: there is **no production backend**
   (the API is Vite dev-middleware only), and the IIAB coupling is **~90% branding/aspiration**, not code.
2. **[NOS_ANALYSIS.md](./NOS_ANALYSIS.md)** — how nOS works and the idiomatic way KEAP plugs in
   (Tier-2 app manifest vs Tier-1 role+plugin; the three SSO buckets; the content services that make
   the original taxonomy→content-link vision finally real).
3. **[MIGRATION_PLAN.md](./MIGRATION_PLAN.md)** — feature-by-feature IIAB→nOS mapping, a 6-phase plan
   (~9–14 days), effort, risks, and **10 open questions we need you to decide**.
4. **[NEW_REPO_STRUCTURE.md](./NEW_REPO_STRUCTURE.md)** — the proposed directory layout of the new repo
   with rationale.
5. **[scaffold/](./scaffold/)** — a runnable skeleton of the new repo (real backend, Dockerfile, nOS
   Tier-2 manifest + Tier-1 plugin manifest, content-link config) ready to copy into a fresh repository.

## The three things that shape everything

- **Build the backend the app never had.** `vite build` today ships a static bundle with a dead API.
  A real standalone server process is the central task — and is exactly what makes KEAP deployable on
  nOS.
- **Dropping IIAB is nearly free.** No code reads IIAB; it's labels, mock "IIAB network" components,
  and unbuilt type fields. Delete the fiction; keep the three real pillars (Admin CMS, companion
  page-capture, the 790-node taxonomy).
- **nOS makes the original vision real.** The never-implemented "link a taxonomy node to offline
  content" idea works on nOS because Kiwix, Calibre-Web, Nextcloud, and Open WebUI are live services
  under one shared SSO session.

## Decisions needed (see MIGRATION_PLAN.md §6 for all 10)

Repo name/owner · SSO posture (header_oidc vs native_oidc) · persistence (volume-SQLite vs Postgres) ·
target tier (Tier-1 role vs Tier-2 manifest) · backend framework · English-only vs i18n · companion
panel fate · leaderboard fate · taxonomy storage · standalone repo vs vendored into nOS.
