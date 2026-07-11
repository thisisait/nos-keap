# KEAP Roadmap — the Knowledge Universe on nOS

*Revised 2026-07-11 by the owner's direction. Supersedes the phase list in
`rework/COMPLETION_PROPOSAL.md` §5 (which remains valid as the record of Phases 0′–4′).
Research grounding: `rework/KNOWLEDGE_SUBSTRATE_RESEARCH.md` (Rounds 1+2).*

## North Star

**One self-hosted universe of everything you know, queryable by you and your agents,
navigable like space.**

The unfair advantage is **nOS as the unified substrate**. Google shipped OKF — a format
with no home. Every memory startup ships a store with no data in it. KEAP sits on a
platform where the user's *actual* knowledge already lives as running services — Kiwix,
Calibre-Web, Nextcloud, Gitea, Open WebUI, databases, files — under one SSO, one network,
one agent runtime (AgentKit). We don't ingest the world; we **index it in place and render
it as a universe**:

- every datapoint (note, page, query, table, database, file, lake) is an **OKF-compatible
  markdown index card** with a URN to where the asset really lives;
- retrieval is progressive disclosure: search cheap cards → open the heavy asset in the
  live service;
- humans get a **spatial explorer with permanent coordinates** — knowledge you can fly
  through and *remember by place*;
- agents get the same corpus through `/agent/v1` + MCP.

Unification is the moat: format (OKF) × platform (nOS) × agents (AgentKit) × space (the
universe UI). Nobody has all four.

## The universe metaphor is an architecture, not a skin

| Space | Data | Guarantee |
|---|---|---|
| Galaxy | Domain (12) | fixed forever |
| Constellation / region | Zone / area levels | fixed forever |
| **Star** | Taxonomy node (790, growing) | **deterministic coordinates — the spatial-memory contract** |
| Nebula / dust cloud | Captures & knowledge objects clustered near their nodes | drifts as knowledge grows |
| Star formation | Dense nebula → LLM proposes a new taxonomy node | admin-gated |
| Distant stars behind the constellation | Semantic neighbors (vector distance) | ephemeral view, never stored as edges |
| Ship position / bookmarks | User state | per-user, persistent |

**The spatial-memory contract** is the load-bearing rule: *a star, once placed, never
moves.* "That knowledge is up-right behind Survival" only works if coordinates are
deterministic and versioned — computed once from the taxonomy structure by a seeded layout
algorithm, persisted, and append-only for new nodes. Force simulation may fine-tune the
*initial* bake, never the live view. (This is also why LLM skills may rewrite descriptions
and metadata but may **never** move stars.)

---

## Tracks

Work is organized in four tracks that can advance in parallel (local repo work here;
nOS-side counterparts flagged **[nOS]**).

### Track S — Substrate (index cards over everything)

> From Round 1+2 research: knowledge objects = OKF docs = index cards; URN per datapoint;
> RRF hybrid retrieval; DuckDB queries data in place, libSQL stays the index.

- **S1 — knowledge_objects** table + CRUD `/api/objects` + `POST/GET /agent/v1/objects`
  (rw) + embeddings `kind='object'` (existing embed-sync picks it up with zero nOS
  changes). Fields: `type` (open enum: note/page/query/table/database/file/lake/…),
  `resource` URN, `frontmatter` JSON (per-type payload), markdown `body`, extracted
  `links`, `user_id`, `visibility`, `content_hash`.
- **S2 — explorer integration**: objects as a new source kind; `[[link]]` extraction →
  untyped directed edges; nebula rendering around anchor stars.
- **S3 — OKF bundle export/import** (zip of markdown+frontmatter; dedup by id+hash).
  Interop with Google tooling & openknowledge CLI; the future sharing unit (Phase S).
- **S4 — RRF hybrid search**: FTS5(BM25) ⊕ vectors ⊕ one-hop taxonomy/link neighbors,
  Reciprocal Rank Fusion (k=60) — replaces the current FTS→vector fallback in both
  `/api` and `/agent/v1`.
- **S5 — schema cards & saved queries**: `query` and `table` object types get first-class
  treatment — DESCRIBE-generated frontmatter (columns, descriptions, sample values, join
  hints), verified-example flag on queries, coarse lineage edges (query→table→database).
  *Grounding: raw text-to-SQL ≈ 10–21 % accuracy; with schema cards + exemplar queries
  ≈ 73–100 %.*
- **S6 — DuckDB sidecar** **[nOS]**: `execute_query` agent tool over registered
  `db:`/`file:`/`lake:` URNs — DuckDB ATTACHes live SQLite/Postgres/MySQL and scans
  Parquet/CSV in place. Explore-then-query tool pair (describe → execute), read-only
  default. Backlog: DuckLake catalog living inside libSQL.

### Track K — Knowledge skills (LLM fills, validates, and grows the ontology)

> Owner requirement: LLM-driven filling & validation of the hardcoded taxonomy so the
> explorer's base layout is deterministic and trustworthy. Skills run as AgentKit
> agents / Pulse jobs on nOS **[nOS]**, authored and versioned in this repo under
> `skills/` (markdown instructions + JSON contracts — themselves OKF-ish documents).
> All writes land in a **review queue** (admin-gated, `updated_by` attribution), never
> directly in the canonical layer. Every skill output is validated against a JSON schema;
> every run is idempotent (content_hash diff, like embed-sync).

- **K1 — `taxonomy-describe`**: generate/refresh cs+en descriptions for all 790 nodes
  (canonical text quality directly powers embeddings & DescGraph-style retrieval — the
  research says descriptions are load-bearing). Batched, diff-only, admin review.
- **K2 — `taxonomy-validate`** (Karpathy's *lint*): detect contradictions, semantic
  overlaps between sibling nodes, orphan concepts, unbalanced branches, stale claims.
  Output = findings queue with proposed fixes, never auto-applied.
- **K3 — `content-link`**: propose `requiredData` links by scanning what the tenant's nOS
  actually serves (Kiwix catalog, Calibre library, Nextcloud shares) — the taxonomy lights
  up with real content automatically after deploy.
- **K4 — `capture-classify`**: every incoming capture/object gets a proposed taxonomy
  anchor (which nebula it joins) + type facet. Runs on ingest; low-confidence → review.
- **K5 — `ontology-extend`** (star formation): where object density around a node grows
  past a threshold, propose child nodes that crystallize the nebula into new stars.
  Strictly admin-gated; new stars get appended deterministic coordinates (the contract).
- **K6 — evaluation harness**: golden-set of queries/answers over the taxonomy; every
  skill release must not regress retrieval metrics (avoid llms.txt's fate — the index is
  only as good as its consumers' hit rate).

### Track U — Universe (from graph to flyable space)

> Today: `/explore` renders 2.5D force-graph constellations with a semantic star field.
> Target: a persistent 3D universe you fly through — eventually No Man's Sky-grade
> exploration gameplay. Gamification backlog (Phase G) merges into this track.

- **U1 — deterministic layout bake**: seeded 3D layout (golden-angle spirals per level,
  hash-jitter per node id) → `taxonomy_layout` table (`node_id, x, y, z, layout_version`).
  Explorer switches from live force-sim to baked coordinates; force-sim remains a
  bake-time tool. New nodes append; existing stars never move. *This unlocks spatial
  memory and is a prerequisite for everything below.*
- **U2 — nebulae & dust**: objects/captures rendered as instanced particle clouds around
  their anchor stars (density = knowledge mass); LOD so 100k+ points stay smooth
  (instanced meshes, impostors; three.js now, WebGPU when it pays).
- **U3 — the ship**: first-person camera with inertial flight (pointer/WASD/gamepad),
  smooth warp between galaxies, HUD compass to search hits ("semantic hyperspace jump":
  search → course plotted to the star). Ship position, visited-star log and **spatial
  bookmarks** persisted per user. Apple-design physics: interruptible springs,
  reduced-motion = instant cuts.
- **U4 — discovery gameplay** (NMS direction): fog-of-war universe — unvisited regions
  render dim/unknown; **scanning** a star reveals its card; landing = opening the asset in
  its live service; learning paths as quest lines (courses/completed_items reborn);
  progress = illuminated map. Discovery events feed recent_activity.
- **U5 — shared universe** (with Phase S): `visibility` columns finally pay off —
  co-op exploration, seeing teammates' illuminated regions, shared bookmarks; OKF bundles
  as tradeable star charts.

### Track C — Capture overlay (extension + native app)

> Owner direction: overlay = browser extension, likely later a native app.
> Research: dominant pattern is thin MV3 extension → REST token; Readeck-style in-browser
> extraction solves logged-in pages; JSON-LD auto-harvest is an open niche nobody fills.

- **C1 — MV3 extension** (replaces the userscript companion): capture page/selection/
  highlights → `POST /api/metadata` + `POST /api/objects`; in-browser Readability
  extraction (server can't see paywalled/session pages); token pairing with the KEAP
  instance. MV3 realities: offscreen API for DOM work, state in `chrome.storage`.
- **C2 — structured auto-harvest** (the novel bit): detect schema.org JSON-LD/microdata
  (recipes, events, products, howtos) and lift them into **typed knowledge_objects**
  automatically — capture "complex data, not just notes" with zero templates.
- **C3 — capture review UX**: K4 classification + type facets in the Admin queue; one-key
  accept → the object joins its nebula.
- **C4 — native companion app** (deferred until a concrete need): local file/folder
  watching (`file:` URN datapoints), OS clipboard/share-sheet hooks, local LLM bridge.
  Mechanism: Native Messaging API or Obsidian-style custom URI scheme. Do not build
  before C1–C3 prove the demand.

---

## Sequencing (what makes Google sit down)

Dependencies, not dates. Each milestone ends in something demoable.

1. **M1 “Objects live”** = S1 + S2 + C3-lite — richer-than-notes capture lands in the
   explorer as nebulae. *(S1 is the keystone; everything references it.)*
2. **M2 “Deterministic sky”** = U1 + K1 — stars stop moving, every star has a real
   description; spatial memory starts being real. **The wow threshold.**
3. **M3 “Agents curate”** = K2 + K3 + K4 **[nOS]** — the universe fills and cleans itself
   under admin review; deploy on fresh nOS → taxonomy lights up with that tenant's actual
   content.
4. **M4 “Fly”** = U2 + U3 — ship, warp, bookmarks, search-as-navigation. Demo: "show me
   quantum optics" → course plotted, fly past the survival nebula you remember on the way.
5. **M5 “Everything is a datapoint”** = S4 + S5 + S6 + C1 + C2 — DBs, queries, files and
   live pages join the universe; agents query them in place through one tool pair.
6. **M6 “Discovery”** = U4 + K5 + S3 — fog-of-war, scanning, star formation from dense
   nebulae, OKF star charts. NMS energy.
7. **M7 “Multiplayer”** = U5 + Phase S sharing.

## Standing rules

- **Spatial-memory contract**: baked coordinates are append-only; a layout_version bump is
  a breaking change requiring explicit owner sign-off.
- **Similarity is a view, never an edge** (research: SimGraph edges degrade retrieval).
- **LLM writes propose, humans dispose**: all skill output goes through the review queue
  with attribution; the canonical taxonomy layer stays deterministic and admin-owned.
- **The consumer ships with the index** (llms.txt lesson): no metadata layer lands without
  the retrieval loop / UI that reads it in the same milestone.
- **nOS is the only backend** — new heavy dependencies (DuckDB sidecar, extension infra)
  arrive as nOS role/plugin changes **[nOS]**, keeping KEAP itself a single container.
- Dual-surface security model stays as designed (header-OIDC humans / bearer-token agents;
  `KEAP_TRUSTED_PROXY=1`; scopes ro/rw).
