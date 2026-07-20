# KEAP explore workflows — plan 1–5 (2026-07-18)

Named multi-agent workflows for the agreed roadmap (object links → topic mode →
scale → content panel → fs-watch/recency + lint hygiene). Any session runs one
with `Workflow({ name: '<name>' })`; each is self-contained (starts with a
repo scout, ends with adversarial verify + a build/lint/e2e gate) so it
survives a fresh session with zero prior context.

## Session contract (the human/main-session parts)

1. **Before launching**: `git checkout dev && git pull && git checkout -b feat/<name>`.
   Workflows commit stages on the CURRENT branch and never touch main/tags.
2. **After a green gate**: the session reviews the diff, then releases per the
   standing flow — merge to `dev` → CI → ff `main` + tag `vX.Y.Z` (npm version
   sync) → bump the nOS pin (`keap_repo_ref` + `keap_version`) ONLY when the
   nOS tree is clean.
3. Lint baseline is discovered at run time (do not hardcode; after
   keap-lint-burndown lands, the baseline is 0 errors and CI gates it).

## Order & scope

| # | workflow | plan item | release | notes |
|---|----------|-----------|---------|-------|
| 1 | `keap-object-links` | 1 — draw `[[object:…]]` refs as edges | v1.10a | smallest; do first, pays off with the self-model |
| 2 | `keap-topic-mode` | 2 — Topics reorder in the core | v1.10b | judge panel → 4-stage pipeline; spec lands in `docs/specs/topic-mode-spec.md` |
| 3 | `keap-scale-pass` | 3 — 10k+ nodes renderer prep | v1.11a | measured: stress fixture before/after |
| 4 | `keap-content-panel` | 4 — full preview + table grid + open deep links | v1.12 | ships inert without `KEAP_OPEN_URL_TEMPLATES` (nOS contract) |
| 5 | `keap-fs-watch-recency` | 5a+5b — instant sync + recency lens | v1.11b | watcher only changes WHEN sync runs, never WHAT it does |
| 6 | `keap-lint-burndown` | 5c — 121 errors → 0 + CI lint gate | chore | run any time; other workflows pick the new baseline up automatically |

Recommended: 1 → 2 (v1.10 together), then 6, then 3 → 5 (v1.11), then 4 when
nOS URL schemes exist. 6 can interleave anywhere — but never run two workflows
against the same checkout at once.

## Invariants baked into every workflow

- Spatial memory: taxonomy stars never move; deterministic layouts keyed by immutable ids.
- `server/fs-sync.ts` users pass is behaviorally FROZEN.
- Bulk links stay GL lines (width 0), DPR cap 1.5, half-res bloom, sim cooldown 6 s (see GraphCanvas PERF comments).
- i18n en + cs for every UI string; e2e coverage for new behavior; honest gates (report failures, don't paper over them).

## Track R3 — typed semantic relations (2026-07-19)

Turns KEAP's untyped edges into a moderated, typed knowledge graph — the "brain
for LLM" upgrade. Recall (nomic embeddings, cross-type kNN) surfaces candidate
pairs; Sonnet types them into a controlled, moderated-grow vocabulary
(ToE-style) HOST-SIDE in controlled batches; results are stored with provenance
and human-moderated, then rendered as verb-labelled edges and exposed to LLMs.
Two testable stages — run in order, releasing after each:

| # | workflow | stage | notes |
|---|----------|-------|-------|
| R3.1 | `keap-relations-stage1` | pipeline + store | migration 006 (cross-type + provenance + status) · relation_types registry · vector-index recall · agent `GET /relations/candidates` + `POST /relations` · classifier STUBBED in e2e. Backend-only, agent-testable. |
| R3.2 | `keap-relations-stage2` | moderate + render + brain | `/api/admin/relations*` moderation + vocab-grow · cross-type verb-labelled edge rendering · `GET /agent/v1/graph` (closes S2⁷). Run after R3.1 merges. |
| R3.fill | `keap-relations-typing` | populate | host-side Sonnet typing of candidate pairs → PROPOSED relations. Run AFTER v1.16.0 is deployed + healthy. Nothing auto-confirmed. |

### R3 fill — populating the typed graph (post-deploy)

Stages 1–2 ship the *pipeline*; the graph starts empty of derived edges. Filling
it is the host-side classification step (mirrors how the taxonomy was seeded in
controlled batches). Two ways to run it, both against the LIVE container:

- **Tool** `scripts/relations-typing.mjs` (npm `relations:fetch` / `relations:post`
  / `relations:list`) — deterministic I/O over the agent surface. Source the
  bearer tokens from the container first (never store them):
  ```
  export KEAP_AGENT_TOKEN_RO=$(docker exec iiab-keap-1 printenv KEAP_AGENT_TOKEN_RO)
  export KEAP_AGENT_TOKEN_RW=$(docker exec iiab-keap-1 printenv KEAP_AGENT_TOKEN_RW)
  node scripts/relations-typing.mjs fetch --limit 40 --out batch.json   # → candidates + vocab
  # …a Claude session types batch.json → typed.json (verb per pair, or omit)…
  node scripts/relations-typing.mjs post typed.json                     # → PROPOSED rows
  ```
- **Workflow** `keap-relations-typing` — automates the loop: fetch → fan-out
  conservative typing subagents (vs the controlled vocab, skip when nothing fits)
  → merge/dedup → POST. `Workflow({ scriptPath: '.claude/workflows/keap-relations-typing.js', args: { limit: 60 } })`
  (add `anchorId`+`anchorKind` for a targeted sweep). Defaults to `http://127.0.0.1:8091`.

Everything lands `status='proposed'` — moderate in **Admin → Relations** before it
renders (default `/api/graph` shows confirmed only; `?relations=all` previews
high-confidence proposed). Grown verbs land proposed too; approve them in the same
panel (assigns a render colour). Re-runs are idempotent (dedup on
from_ref,to_ref,type) and a rejected edge stays rejected (sticky moderation).

R3 invariants (beyond the shared ones above): SIMILARITY stays a view, only
TYPED relations are stored; the LLM classification runs host-side (KEAP surfaces
candidates + accepts typed results, never calls an LLM in-container); every
derived row carries provenance (source/confidence/justification/model/status);
the controlled vocab grows only through moderation; existing ToE relations
migrate unchanged; visibility scopes both endpoints of every edge (render AND
the brain endpoint).
