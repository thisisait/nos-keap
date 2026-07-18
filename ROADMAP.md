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
| Galaxy | Domain (12) = tier-1 of the root index | static between root-index versions |
| Constellation / region | Zone / area levels | static between root-index versions |
| **Star** | Taxonomy node (790, growing) | **deterministic function of the root index — the spatial-memory contract** |
| Nebula / dust cloud | Captures & knowledge objects clustered near their nodes | drifts as knowledge grows |
| Star formation | Dense nebula → LLM proposes a new taxonomy node | admin-gated |
| Distant stars behind the constellation | Semantic neighbors (vector distance) | ephemeral view, never stored as edges |
| Ship position / bookmarks | User state | per-user, persistent |

**The spatial-memory contract**: coordinates are a *pure deterministic function of the
canonical root index* (the taxonomy). Galaxy positions are primarily static because they
ARE tier-1 of the root index — and the same holds down the hierarchy. Positions never
drift on their own; they change **only when the root index itself updates**, in which case
the layout recomputes and `layout_version` bumps together with the taxonomy version (one
atomic event users can notice and re-learn, not continuous drift). Force simulation may
fine-tune a bake, never the live view. LLM skills may rewrite descriptions and metadata,
but only an admin-approved root-index change moves stars.

**Future (MMO-style sharing)**: once universes are shared, the *real* position of an
object will be determined by **averaging across participating instances** (consensus
layout) — but for now we run **local-only**, and the local root index is the sole source
of coordinates.

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
- **S2′ — doctrine filesystem mirror** *(shipped 2026-07-16)*: `server/fs-sync.ts` walks
  the class-3 per-user tree (`KEAP_USER_FILES_DIR` ← nOS fs-doctrine
  `tenants/<t>/users/<uid>/{documents,library,inbox}`) and mirrors files as owner-scoped
  objects (`frontmatter.source='fs'`, path/size/mtime; text excerpt for md/txt/csv);
  curated links survive syncs, prune refuses an empty mount, `agents/` scratch excluded.
  Boot + interval + `POST /agent/v1/fs/sync`. **Open**: nOS-side users/ bind-mount + env,
  binary text extraction (pdf/docx), rename = new id.
- **S2″ — mapped folders** *(shipped 2026-07-18)*: admin-managed `fs_mappings` datapoints
  over read-only `KEAP_FS_ROOTS` mounts — label, nested/standalone, schema template
  `{type, frontmatter}`, tags, manual taxonomy anchors (root + links), per-mapping sync
  status; mirrors owned by `fsmap:<id>` (`source:'fs-mapping'`, disjoint from the users
  pass by construction), visibility default `shared`, cfg-hash edit propagation, prune
  guards (capped/partial/empty walks never prune). Admin tab + FolderBrowser;
  `/api/fs/*` + `/agent/v1/fs/*` surfaces. **Option C**: `KEAP_FS_SHARED_UIDS` makes
  reserved users-tree uids (nOS self-model `nos-docs`) tenant-shared. **Open**: object→
  object links as drawn edges, per-mapping `embed:false` policy, mapping default
  visibility once multi-user.
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

> Today: `/explore` renders the 3D radial constellation with a semantic star field and
> the object nebula layer (the 2D renderer was retired 2026-07-11 — **observer mode**,
> the orbit camera, is the baseline; rocketship mode in U3 swaps the camera controller,
> not the scene). Target: a persistent 3D universe you fly through — eventually No Man's
> Sky-grade exploration gameplay. Gamification backlog (Phase G) merges into this track.

- **U1 — deterministic layout bake**: seeded 3D layout (golden-angle spirals per level,
  hash-jitter per node id) → `taxonomy_layout` table (`node_id, x, y, z, layout_version`).
  Explorer switches from live force-sim to baked coordinates; force-sim remains a
  bake-time tool. `layout_version` is coupled to the root-index (taxonomy) version: new
  nodes append in place, and a root-index update is the *only* event that rebakes
  positions. *This unlocks spatial memory and is a prerequisite for everything below.*
- **U2 — nebulae & dust**: objects/captures rendered as instanced particle clouds around
  their anchor stars (density = knowledge mass); LOD so 100k+ points stay smooth
  (instanced meshes, impostors; three.js now, WebGPU when it pays).
- **U2′ — files core** *(shipped 2026-07-16)*: explore toggle relocating every knowledge
  object into a 3D core at the (empty) galaxy-ring center; taxonomy stars never move,
  teal rays tether objects to their anchors. Reorder modes: **Folders** (default —
  folder constellations along `frontmatter.path`, synthetic `dir:` hubs), **Taxonomy**
  (clusters at their galaxy's ring angle scaled inward), **Topics** (TBD — needs
  object-vector clustering server-side; k-means over `kind='object'` embeddings +
  stable cluster→slot assignment, see Track K features pipeline as the template).
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
  as tradeable star charts. **MMO layout consensus**: shared objects' real positions
  become the *average* of their positions across participating instances (each instance
  keeps its local root index; consensus emerges, it is not imposed). Until then: local-only.

### Track R — Rich authoring (create IN nOS services, index in KEAP)

> Owner requirement (2026-07-11): entering rich data, not just notes — office
> documents, SharePoint-style tables. **KEAP never becomes an editor or a table
> engine**: the asset is created and lives in the right nOS service; KEAP
> orchestrates creation and holds the index card (`knowledge_object` with
> `resource` pointing at the live asset). Same progressive-disclosure shape as
> everything else — the card is searchable, the service is the editor.

- **R1 — create-in-service flow**: "New document" in KEAP → server-side call to
  Nextcloud WebDAV (`PUT` an empty/templated .odt/.md/.xlsx into a `KEAP/` folder)
  → open the service's editor in a new tab (Nextcloud Office/Collabora) → the
  knowledge_object card (type `document`, resource `nextcloud:KEAP/<file>`) is
  created in the same action, pre-anchored to the taxonomy node the user started
  from. Needs a service account credential (`KEAP_NEXTCLOUD_URL/USER/TOKEN`) —
  provisioned by the nOS role **[nOS]**.
- **R2′ — TableStore abstraction (DONE 2026-07-12)**: `shared/contracts/table.ts`
  (column kinds incl. file-by-ref/vector/taxonomyRef; OLAP roles dimension/measure
  on every column; `AggregateQuery` = group-by dimensions × aggregated measures;
  capability-declaring drivers) + `server/tables.ts` with the **libsql** driver
  (transactions, append-only row history = the event log, json_extract
  aggregation) + `/api/tables*` REST. Every table lives as a `knowledge_object`
  card (`keaptable:<id>`, schema card in frontmatter) — searchable, anchorable,
  OKF-exportable.
  **Update (same day): rustfs driver + grid UI DONE.** `server/tables-rustfs.ts`
  — rows as S3 objects (aws4fetch SigV4, path-style), bucket versioning enabled
  on first use → row history from ListObjectVersions with no history table;
  bounded in-memory filter/sort/aggregate (SCAN_CAP) until the DuckDB leg (S6)
  takes over. Verified E2E against MinIO. Needs `KEAP_RUSTFS_ENDPOINT/ACCESS_KEY/
  SECRET_KEY` (+ optional `_BUCKET`) from the role **[nOS]**; `/api/tables/drivers`
  tells the UI what this deployment offers. `/tables` list + storage picker
  (capability badges, honest per-driver pitch) and `/tables/:id` TanStack grid:
  inline cell editing by kind, add-row form, server-side sort, **OLAP summary
  bar** (live Σ measures × first dimension). Remaining on this contract:
  postgres, grist drivers.
- **R2 — structured tables (SharePoint-style)**: recommend **Grist** as the nOS
  table service — SQLite-native documents (each Grist doc IS a SQLite file →
  DuckDB/S6 can query it in place, embeddings can index it), REST API, self-hosted
  friendly. Alternatives if Grist doesn't fit nOS: NocoDB (over a real DB),
  Baserow. Flow mirrors R1: "New table" → Grist API creates doc/table → card
  (type `table`, resource `grist:<doc>/<table>`, frontmatter = schema card) →
  edit in Grist, query via S6, search via S4. Requires a new Tier-1/Tier-2
  service in nOS **[nOS]**.
- **R3 — templates per type**: object types carry an optional template (frontmatter
  skeleton + body scaffold + target service) so "new recipe", "new meeting-notes
  doc", "new inventory table" are one-click; K-track skills can propose templates
  from usage.
- **R4 — sync-back**: a Pulse job (like keap-embed-sync) walks `KEAP/`-scoped
  service content and refreshes cards' content_hash/description so edited
  documents re-embed and re-index automatically **[nOS]**.

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
   **M5.5 “Author rich data”** = R1 + R2 — documents and tables are created FROM
   KEAP INTO nOS services (Nextcloud Office, Grist) and come back as index cards;
   R4 keeps edited assets fresh in search.
6. **M6 “Discovery”** = U4 + K5 + S3 — fog-of-war, scanning, star formation from dense
   nebulae, OKF star charts. NMS energy.
7. **M7 “Multiplayer”** = U5 + Phase S sharing.

### Backlog guard — owner-flagged, must not slip (2026-07-12)

- **S3 OKF bundle export/import.** Scheduled inside M6 but strategically ahead of
  it: the bundle is the sharing unit (Phase S), the Track T "star chart", AND the
  interop story with Google's tooling/openknowledge CLI — while the format is
  young (see `rework/KNOWLEDGE_SUBSTRATE_RESEARCH.md` R1). Implementation is
  small: `knowledge_objects` ↔ `type/…/slug.md` with YAML frontmatter is already
  1:1, and the unified intake envelope fields (source, modality, tags,
  capturedAt) map onto frontmatter cleanly. Pull it forward into whichever
  milestone lands next.

## Standing rules

- **Spatial-memory contract**: coordinates are a pure function of the root index; they
  change only when the root index does (atomic `layout_version` bump coupled to the
  taxonomy version), never by drift. Local-only until MMO consensus (U5).
- **Similarity is a view, never an edge** (research: SimGraph edges degrade retrieval).
- **LLM writes propose, humans dispose**: all skill output goes through the review queue
  with attribution; the canonical taxonomy layer stays deterministic and admin-owned.
- **The consumer ships with the index** (llms.txt lesson): no metadata layer lands without
  the retrieval loop / UI that reads it in the same milestone.
- **nOS is the only backend** — new heavy dependencies (DuckDB sidecar, extension infra)
  arrive as nOS role/plugin changes **[nOS]**, keeping KEAP itself a single container.
- Dual-surface security model stays as designed (header-OIDC humans / bearer-token agents;
  `KEAP_TRUSTED_PROXY=1`; scopes ro/rw).

## Track T — Topology doctrine: hardcoded core, free-growing depth (road to v1.0)

Owner decision (2026-07-12). The taxonomy is NOT one uniform tree — it has
three governance zones, mirroring the universe metaphor's scale ladder
("a frog in a lake, on a planet, in a star system, in a galaxy, in a galaxy
group" — most datapoints live at frog depth, not galaxy depth):

| Zone | Topological levels | Governance | Universe scale |
|---|---|---|---|
| **Anchor core** | 0–1 | **HARDCODED** — ships with KEAP, changes only by release (an owner-approved breaking change, like the U1 layout algo bump) | galaxy groups + galaxies |
| **Votable core** | ~2–4 | seeded hardcoded, evolvable by **moderated proposals** — local admin today, MMO quorum later (the promotions machinery is already built for exactly this shape) | star systems + planets |
| **Free zone** | 5+ | grows organically: users/agents propose new nodes as easily as knowledge objects; most datapoints anchor HERE, at the most specific node that fits | lakes, frogs, and everything between |

Consequences to implement:

1. **Node-level provenance** — every taxonomy node carries a zone marker
   (derivable from depth for now; explicit once free-zone nodes exist,
   because a deep hardcoded node must stay distinguishable from a grown one).
2. **Taxonomy extension proposals** — the promotions flow generalized:
   `propose node` (parent, name, description) → moderator/quorum decides →
   node materializes + layout bake extends (U1's Fibonacci-sphere placement
   already handles arbitrary depth; LEVEL_RADIUS gets a decaying tail).
   Anchor-core parents refuse proposals; votable-core parents require them.
3. **Spatial-memory contract per zone** — anchor core NEVER moves (the sky's
   constants); votable core moves only on approved proposals (one atomic,
   versioned event, same doctrine as the layout bake); free zone placement is
   deterministic-per-node but new siblings may appear any night.
4. **Game layer retired** (done, this commit) — /game redirects to /explore.
   The universe IS the game; "locked pages" made no sense without content.
   Progression mechanics, if they return, hang off real corpus coverage
   (deserts shrinking), not hardcoded card grids.

The current 12-category / 790-node tree becomes the seed: categories =
galaxies (anchor core level 0; a future "galaxy group" super-level is
reserved for federating multiple KEAP instances), level-1 subcategories =
anchor core, levels 2+ = votable core seed, free zone opens with the
extension-proposal machinery.
