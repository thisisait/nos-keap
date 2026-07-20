# S2⁶ — Table graph-render metadata (design spec)

**Status:** draft for ratification (owner + nOS-face agent) · **Track:** S2⁶ (ROADMAP:115) · **Date:** 2026-07-20

A shared contract: how a DataTable declares the way its **rows** project into the
KEAP universe as graph nodes/edges — and the visibility-ladder fix that lets
non-admins actually see tier-scoped table cards in `/explore`. Design-first; no
code until this is ratified, because the nOS face companion builds the producer
side against the same contract.

---

## 1. What exists today (the baseline)

- A table anchors into the universe as **one card**: `createTable` → `syncCard`
  writes a `knowledge_object` id `table-<slug>`, type `table`, with the table's
  `anchors[]` rendered as `[[nodeId]]` refs (→ node links) and a `frontmatter`
  carrying `{storage.driver, columns[], rowCount}` (`server/tables.ts:189-218`).
- `/api/graph` renders that card as a single **asteroid** node (`type:'table'` →
  `assetDescriptor` → `dataTable {form:'asteroid', glyph:'table', hue:180}`,
  `server/asset-types.ts` + `server/graph.ts:186-217`). The card orbits its
  anchor stars.
- **Rows never reach the graph.** `graph.ts` only reads `getVisibleObjects`
  (knowledge_objects); `table_rows` are not consulted. A `taxonomyRef` column
  *can* anchor a row conceptually, but nothing projects it.
- **Visibility gap:** `getVisibleObjects` (`server/db.ts:1197-1207`) filters
  non-admins by a **flat** `user_id = ? OR visibility = 'shared'`. The 5-tier
  ladder (`private | tier-managers | tier-users | tier-guests | shared`) exists
  and is wired into the *table registry* path (`server/rbac.ts` →
  `listTables`/`canReadTable`) but **not** into the *object/graph* path. So a
  `tier-users` table card renders in `/explore` for **admins only**.

---

## 2. Goals

1. Let a table opt into projecting its **rows** as universe nodes, with a
   declared node-kind (colour/icon/form) and edges — a **table-level** contract,
   not per-row config.
2. Keep the default **card-only** (zero behaviour change for every existing
   table, incl. the face's config tables).
3. Fix the visibility ladder so tier-scoped cards (and their rows) render for the
   callers entitled to them — one source of truth, not a table-only special case.
4. Stay inside the perf doctrine (U2″): bounded node counts, LOD, deterministic.

Non-goals (this spec): materialising rows as first-class searchable/embeddable
`knowledge_objects` (see §6 Decision D3, deferred), and any face-side UI.

---

## 3. The `graph` metadata contract

A new **optional** `graph` block on `createTableRequestSchema`
(`shared/contracts/table.ts:192`, sibling of `anchors`). Absent → today's
card-only behaviour, byte-identical. Stored verbatim in the card
`frontmatter.graph` by `syncCard`; read by `graph.ts` at render.

```ts
// shared/contracts/table.ts
const celestialFormSchema = z.enum(['planet','moon','asteroid','comet','station']);

const graphMetaSchema = z.object({
  // Projection mode. 'card' (default) = one table-<slug> card, as today.
  // 'rows' = ALSO project each row as its own node hanging off the card/anchor.
  mode: z.enum(['card', 'rows']).default('card'),

  // CARD visual override (independent of mode; lets a table pick its own look
  // instead of the generic asteroid/hue-180).
  card: z.object({
    form:  celestialFormSchema.optional(),
    hue:   z.number().min(0).max(360).optional(),
    glyph: z.string().optional(),
  }).optional(),

  // Per-row node projection. Required when mode==='rows'.
  node: z.object({
    idColumn:     z.string().optional(),   // column → stable node id; default: row uuid
    labelColumn:  z.string(),              // column → node label (required)
    kind:         z.string().default('record'), // node-kind → legend + default visual
    form:         celestialFormSchema.optional(),
    hue:          z.number().min(0).max(360).optional(),
    glyph:        z.string().optional(),
    anchorColumn: z.string().optional(),   // a taxonomyRef column → the star THIS row orbits;
                                           // absent → the row orbits the table card (nested)
  }).optional(),

  // Edge definitions: a column whose cell value points at another graph node.
  edges: z.array(z.object({
    column: z.string(),                    // an objectRef | taxonomyRef | user column
    toKind: z.enum(['node', 'object']),    // how to resolve the target ref
    type:   z.string().optional(),         // edge label / relation verb (relation_types.type)
    label:  z.string().optional(),         // display label override
  })).max(8).default([]),
}).optional();
```

Validation rules (enforced in `createTableRequestSchema.superRefine`):
- `mode==='rows'` ⇒ `node` present and `node.labelColumn` names a real column.
- `node.idColumn`/`anchorColumn` and every `edges[].column` must name a real
  column of the declared `schema`.
- `edges[].column` kind must be compatible with `toKind` (`objectRef`→object,
  `taxonomyRef`→node); a `user` column may only target `toKind:'node'` if a
  user→node mapping exists (else reject — no silent drop).
- `node.kind`/`edges[].type` are lowercase-kebab slugs (`/^[a-z][a-z0-9-]{0,63}$/`),
  mirroring the R3 verb convention; an edge `type` unknown to `relation_types`
  renders with a neutral colour + label (it does **not** grow the R3 vocab —
  these are table-declared display edges, not moderated relations. See D4).

### 3.1 How `graph.ts` projects rows (mode==='rows')

For each **visible** `type:'table'` card whose `frontmatter.graph.mode==='rows'`:
1. Load rows via `storeFor(driver).listRows(tableId)` (already exists), **capped**
   at `ROW_NODE_CAP` (proposed 500). Beyond the cap: render the card only + a
   `rowCount` density hint on the card (LOD doctrine); `log`/`meta` reports the
   truncation — never a silent cut.
2. Emit one node per row: `id = table-<slug>:row-<idColOrUuid>`, `type = 'table-row'`,
   `label = row[labelColumn]`, visual from `node.{form,hue,glyph}` (falling back
   to a per-`kind` default in a small registry, then to `assetDescriptor`).
3. Anchor: if `node.anchorColumn` resolves to a live node → the row orbits that
   star; else the row orbits the table card (nested body, `orbit` centre = card).
4. Edges: for each `edges[]` def, read `row[column]`; if it resolves to a drawn
   node/object, push a link `{source: rowNodeId, target, vazba?/olink?, type,
   label}`. Endpoints not in the drawn/visible set are filtered (the existing
   existence-filter guard — never crash force-graph).
5. **Rows inherit the card's `visibility`.** They pass the same
   `getVisibleObjects` gate (§4) — a row-node is never emitted to a caller who
   can't see the card.

Row-nodes are **ephemeral** (synthesised at render from `table_rows`, not stored
in `knowledge_objects`) — see Decision D3. They therefore carry width-0 GL-line
edges by default (bulk-safe), tubes only for the sparse typed-edge case, exactly
like R3 (`GraphCanvas` PERF doctrine).

### 3.2 Passthrough chain

`graphMetaSchema` (`shared/contracts/table.ts`) → create body
(`server/agent.ts:581-588` for `/agent/v1/tables`; the human route likewise) →
`createTable` (`server/tables.ts:298`) → `syncCard` writes `frontmatter.graph`
(`tables.ts:208-212`) → `/api/graph` reads it (`graph.ts:186-217`) and, in `rows`
mode, projects rows. No new table column — it rides the card frontmatter, so
`data_tables` schema is untouched.

---

## 4. Visibility-ladder fix

Replace the flat filter in `getVisibleObjects` (`server/db.ts:1197-1207`) and
`canReadObject` (`db.ts:904-911`) with the **existing** rbac ladder
(`server/rbac.ts` — already the source of truth for table lists):

```ts
// getVisibleObjects(userId, isAdmin, groups)
//   admin (seeAll) → all rows (unchanged)
//   else → WHERE user_id = ? OR visibility IN (<readableVisibilities(tierRank(groups))>)
```

- `tierRank(groups)` + `readableVisibilities(rank)` already return the correct
  `IN()` list; `'shared'` stays rank-99 (any authenticated caller), so today's
  behaviour is a strict superset — no card that renders now stops rendering.
- Thread the caller's **groups** (from `identityMiddleware` /
  `X-Authentik-Groups`, the same source `isAdmin` derives from) into
  `getVisibleObjects`. Every caller of it (`graph.ts:181`, and audit the rest)
  passes `req.user.groups`.
- This fixes visibility for **all** objects, not just tables — a `tier-users`
  knowledge object now correctly reaches tier-users, closing the gap generally.

Test matrix (e2e): a `tier-users` table card is visible to a `nos-users` caller,
invisible to a `nos-guests` caller, visible to admin; `shared` stays visible to
all; `private` stays owner+admin only.

---

## 5. Staging (2 testable stages, per the standing preference)

- **Stage 1 — visibility + card contract** (small, ships value immediately):
  the §4 ladder fix + the `graph.card` visual override + `graph.mode` plumbed
  through `syncCard`/`graph.ts` (but `mode:'rows'` returns card-only for now,
  gated). e2e = the visibility matrix + a card rendering with an overridden
  form/hue. No rows-as-nodes yet → low risk, no perf surface.
- **Stage 2 — rows as nodes + edges** (the §3.1 projection): row-node emission,
  anchoring, edge defs, `ROW_NODE_CAP`/LOD, the existence-filter + PERF
  guards. e2e = a `mode:'rows'` table projecting N row-nodes anchored to a star,
  an edge column drawing to an object/node, cap truncation reported, rows hidden
  from an unentitled caller.

Released per the standing flow after each stage (or both together if small).

---

## 6. Open decisions (ratify before build)

- **D1 — visibility fix approach.** (A) Wire the rbac ladder into
  `getVisibleObjects` [**recommended** — one source of truth, fixes all objects,
  the ladder already exists]. (B) Have the companion send `visibility:'shared'`
  for explore-visible tables [simpler, but leaks tier semantics into the producer
  and doesn't fix non-table objects]. → **Recommend A.**
- **D2 — scope now.** Ship Stage 1 only (visibility + card look) and defer
  rows-as-nodes, or commit to both stages now? → **Recommend both, staged** (D2
  = do Stage 1 first, decide Stage 2 after seeing it live).
- **D3 — row identity.** Row-nodes **ephemeral** (synthesised at render)
  [**recommended** — no duplicate storage, no embed cost, rows stay a table
  concern] vs **materialised** as `knowledge_objects` [rows become
  searchable/embeddable/R3-linkable, but 10k-row tables flood the object store +
  embed queue]. → **Recommend ephemeral**, with a future explicit "promote row →
  object" action if a row needs to be a first-class citizen.
- **D4 — edge semantics.** Table-declared `edges[].type` are **display-only**
  labels (neutral colour if not a known verb), NOT moderated R3 relations
  [**recommended** — keeps the R3 moderation invariant clean; a table shouldn't
  inject unmoderated typed edges into the brain]. Confirm the brain endpoint
  `/agent/v1/graph` does **not** ingest these (it reads the `relations` store
  only — already true; just assert it).
- **D5 — `ROW_NODE_CAP`.** Proposed 500/table. Owner call on the number.

---

## 7. Invariants (unchanged, must hold)

- Spatial memory: taxonomy stars never move; row-node ids deterministic
  (`table-<slug>:row-<id>`), so a row keeps its orbit across renders.
- Default (no `graph` block) = today's behaviour, byte-identical — every existing
  table incl. the face config tables is unaffected.
- PERF: row-node edges stay width-0 GL lines in bulk; tubes only for sparse typed
  edges; `ROW_NODE_CAP` + LOD; no silent truncation (report it).
- Visibility scopes **both** the card and every row-node and every edge endpoint;
  the R3 brain endpoint ingests only the moderated `relations` store (D4).
- i18n en+cs for any new UI string; e2e for every new behaviour.
