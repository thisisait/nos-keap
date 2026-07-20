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

**Decisions locked (2026-07-20, owner):** D1 = wire the rbac ladder into
`getVisibleObjects` (§4). D3 = **materialise** each projected row as a
first-class `knowledge_object` (§3.1) — rows become searchable, embeddable, and
R3-linkable. This has a deliberate **synergy**: materialised rows grow the
object corpus that R3 types over (a DataTable becomes a content source, not just
a card), which is exactly the "R3 needs more objects" lever. The cost is a real
storage/embed surface — bounded by a per-table cap + explicit opt-in (§3.1, D5).

Non-goals (this spec): any face-side UI; auto-injecting table edges into the
moderated R3 relation store (D4 — table edges stay display-only / reuse
olink+anchor).

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

### 3.1 How rows materialise (mode==='rows') — **D3: materialised**

Rows become first-class `knowledge_objects`, synced by a new `syncRows(t, graph)`
that runs alongside `syncCard`, on the same triggers (`createTable`, `upsertRow`,
`deleteRow`, `dropTable`). Not render-time synthesis — a durable materialisation
mirrored from `table_rows`, idempotent like the card + like embed-sync.

1. **Guarded opt-in.** `mode:'rows'` is only honoured up to `ROW_OBJECT_CAP`
   (proposed 500) rows per table; a table over the cap is **rejected at
   create/enable time** with a clear error (not silently truncated) — the owner
   splits/filters the table or raises the cap deliberately. `meta`/`log` records
   the count. (Rationale: materialisation is a real storage + embed cost;
   opt-in + a hard cap keeps a 10k-row table from flooding the object store and
   the embed queue.)
2. **One object per row**, via `db.saveObject(t.ownerId, …)`:
   - `id = table-<slug>:row-<idColValue|rowUuid>` (deterministic → stable orbit +
     idempotent upsert).
   - `type = node.kind` (default `'record'`); `assetDescriptor` extended so a
     `kind` with no built-in maps to `node.{form,hue,glyph}` (else asteroid).
   - `title = row[labelColumn]`; `body` = a compact rendering of the row's cells
     (drives search + the embedding).
   - `visibility = t.visibility` (rows inherit the table's tier).
   - `links`: `node.anchorColumn` (a `taxonomyRef`) → `[[nodeId]]` anchor ref;
     each `edges[].column` that's an `objectRef`/`taxonomyRef` → the matching
     `[[object:…]]`/`[[nodeId]]` ref (reusing `extractRefs`/`classifyRef`), so
     anchoring + edges ride the **existing** olink/anchor machinery — no new
     edge path in `graph.ts`.
   - `frontmatter`: `{ table: t.id, row: <rowId> }` provenance (so a row-object is
     recognisably table-derived + can be reverse-linked/cleaned).
3. **Embeddings**: row-objects flow through the normal object embed path with a
   `content_hash` so an unchanged row is not re-embedded (embed-sync doctrine).
   This is what makes them R3-linkable (they enter the `object` embedding kind →
   R3 candidate recall surfaces them — the corpus-growth synergy).
4. **Lifecycle**: `upsertRow` re-syncs that row's object (create/update,
   content_hash diff); `deleteRow` deletes it; `dropTable` deletes all row-objects
   for the table (a `frontmatter.table = <id>` sweep) + the card.
5. **Render is then FREE**: because rows are real objects, `/api/graph`'s existing
   `getVisibleObjects` path draws them as nodes and their anchor/olink refs as
   edges with **no table-specific code in `graph.ts`** — the visibility gate (§4)
   already scopes them, and edges stay width-0 GL lines in bulk (PERF doctrine),
   tubes only where an R3 typed relation independently exists.

Net: `syncRows` is the only new write path; `graph.ts` is untouched by rows
(only the §4 visibility fix + the §3 card-visual override touch it).

### 3.2 Passthrough chain

`graphMetaSchema` (`shared/contracts/table.ts`) → create body
(`server/agent.ts:581-588` for `/agent/v1/tables`; the human route likewise) →
`createTable` (`server/tables.ts:298`) → `syncCard` writes `frontmatter.graph`
(`tables.ts:208-212`) **and, in `rows` mode, `syncRows` materialises row-objects
(§3.1)**. On `upsertRow`/`deleteRow`/`dropTable` both re-sync. `/api/graph` then
renders card + row-objects through the unchanged `getVisibleObjects` path. No new
`data_tables` column — the `graph` block rides the card frontmatter; row-objects
carry `frontmatter.{table,row}` provenance.

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
- **Stage 2 — rows materialise as objects** (the §3.1 `syncRows` path):
  per-row `knowledge_object` sync, `ROW_OBJECT_CAP` opt-in guard, anchor/olink
  refs, embed content_hash dedup, lifecycle sync on upsert/delete/drop. e2e = a
  `mode:'rows'` table materialising N row-objects anchored to a star, an
  `objectRef` edge column drawing an olink, an over-cap table rejected at enable,
  a row edit re-syncing its object, `deleteRow`/`dropTable` cleaning up, rows
  hidden from an unentitled caller, and a row-object surfacing as an R3 candidate.

Released per the standing flow after each stage (or both together if small).

---

## 6. Open decisions (ratify before build)

- **D1 — visibility fix approach. ✅ DECIDED (A):** wire the rbac ladder into
  `getVisibleObjects` — one source of truth, fixes all objects, ladder already
  exists (§4).
- **D2 — scope now. → Recommend both, staged** — Stage 1 first (visibility + card
  look, no storage surface), decide Stage 2 (materialisation) after seeing Stage 1
  live. (Not blocking; proceeding on this unless the owner objects.)
- **D3 — row identity. ✅ DECIDED (materialise):** each projected row →
  first-class `knowledge_object` (§3.1). Rows become searchable/embeddable/
  R3-linkable (corpus-growth synergy); bounded by `ROW_OBJECT_CAP` opt-in +
  content_hash embed dedup + lifecycle sync.
- **D4 — edge semantics. → Recommend display-only** — table `edges[]` render via
  the existing olink/anchor refs on the row-object; they do **not** enter the
  moderated R3 `relations` store, and the brain endpoint `/agent/v1/graph` (which
  reads only that store) is unaffected — assert this in Stage 2 e2e. A row-object
  can still gain a *typed* R3 edge later, through normal moderation.
- **D5 — `ROW_OBJECT_CAP`.** Proposed **500/table** (materialisation cost is now
  storage + embeddings, so this is a real guard, not just a render LOD). Owner
  call on the number — and whether over-cap is a hard reject (recommended) or a
  capped-with-warning materialisation.

---

## 7. Invariants (unchanged, must hold)

- Spatial memory: taxonomy stars never move; row-object ids deterministic
  (`table-<slug>:row-<id>`), so a row keeps its orbit across renders.
- Default (no `graph` block) = today's behaviour, byte-identical — every existing
  table incl. the face config tables is unaffected.
- Idempotency: `syncRows` upserts on the deterministic id; embeddings dedup on
  `content_hash` (unchanged row → no re-embed); `dropTable`/`deleteRow` clean up
  their row-objects (no orphans).
- PERF/scale: `mode:'rows'` is opt-in and capped at `ROW_OBJECT_CAP`; over-cap is
  a hard reject at enable-time (no silent truncation); row-object edges stay
  width-0 GL lines in bulk, tubes only for sparse typed edges.
- Visibility scopes **both** the card and every row-object and every edge
  endpoint; the R3 brain endpoint ingests only the moderated `relations` store
  (D4) — table edges never auto-enter it.
- i18n en+cs for any new UI string; e2e for every new behaviour.
