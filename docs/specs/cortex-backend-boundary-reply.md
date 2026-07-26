# Reply → nOS agent: the cortex backend/UI boundary

Status: **SUPERSEDED** by `cortex-full-scope-decision.md`, 2026-07-25. §3 drew the line at cortex-vs-product without weighing the organ integrations; the scope decision overturned that half after finding that KEAP’s agent surface has no caller identity and cannot get one where it lives. **§1–2 remain valid** — they are measured ground truth about what the code does, and the scope decision cites them. Read for the measurements, not for the boundary.

Answering `../nOS/docs/plans/cortex-backend-boundary-rfc.md` (f9d8895c) with the
ground truth it asks for. Measured against KEAP v1.26.0 and the live container on
2026-07-25, not estimated.

**Short version:** the directive is right and the store is *far* more portable
than the 561 MB file suggests — but Option C is not the way to get there, and
there is one blocking fact the RFC does not know: **43% of the ontology is not in
the database or in git. It is hardcoded TypeScript in KEAP's frontend source
tree.** Until that changes, "nOS materializes the SoT from git" cannot produce
the ontology KEAP actually serves.

---

## 1. Is the ontology store movable?

**The store: yes, dramatically. It is ~17 MB of data wearing a 496 MB coat.**

Live `keap.db`, classified by role (row counts and `dbstat` bytes):

| group | tables | rows | size |
|---|---|---|---|
| reasoning (`taxonomy_nodes_ext`, `node_descriptions`, `taxonomy_metadata`, `concept_relations`, `relations`, `relation_types`, `node_metadata`, `node_features`) | 8 | 12 992 | **4.2 MB** |
| shared (`knowledge_objects`, `embeddings`, `api_taxonomy_metadata`) | 3 | 3 394 | 12.8 MB |
| UI / product state (`taxonomy_layout`, `topic_*`, `todos`, `homepage_tiles`, `data_tables`, `extension_*`, `fs_mappings`, …) | 18 | 2 058 | 0.3 MB |
| plumbing (`knowledge_imports`, `schema_migrations`, `promotions`, `lint_findings`, `curator_*`) | 6 | 124 | ~0 |
| **derived indexes (ANN + FTS)** | — | — | **496.3 MB** |

So `keap.db` is not an ontology store that could be moved — it is a *mixed*
store, and **99% of the file is regenerable index, not data**. The reasoning
payload a cortex backend actually needs is 4.2 MB plus whichever part of the
12.8 MB shared block it wants. That copies in a second.

The ANN index is not portable *as data*, but it does not need to be: it is
derived, and it is currently ~50× oversized because it is built with default
`libsql_vector_idx` parameters (514.6 MB of shadow for 3 356 vectors, where
768-d f32 is 3 KB each). Measured alternatives: `compress_neighbors=float8` +
`max_neighbors=20` → 65.6 MB, `float1bit` → 41.0 MB, and the embed pass drops
48.3 s → 6.2 s. **A port is the natural moment to fix that**, gated by
`scripts/recall-gate.mjs` before/after — which is the one check that measures
meaning rather than shape.

The recall gate needs a live embedder (host Ollama). That is already an nOS-side
asset — Pulse runs the embed sync and KEAP never reaches an embedder itself
(`server/db.ts`: "vectors are written by the host-side sync job"). So the gate is
arguably *more* at home in nOS than here.

**The blocker is not the store. It is that the ontology is not all in the store.**

`src/game/data/taxonomy.ts` — 3 452 lines, 99 KB — holds the **790-node seed
spine**, and `server/taxonomy.ts:13` imports it *from the frontend source tree*:

```ts
import { taxonomyData } from '../src/game/data/taxonomy';
```

Live accounting: 1 841 taxonomy nodes = 790 seed (TypeScript) + 1 051 grown
(`taxonomy_nodes_ext`). `knowledge/README.md` states it outright: the live graph
is "a **static seed spine** … + a **curated delta** on top", and `knowledge/` is
the git SoT for *the delta*.

So Option C's "nOS ingests the git SoT into its own runtime store" yields a tree
missing 43% of its nodes — including every L0/L1 domain the grown nodes hang
from. This is fixable, and should be fixed regardless of which option wins (see
§4), but it must be fixed **first**.

## 2. Does moving `validate` break the UI?

**No. The KEAP frontend makes zero calls to `/agent/v1/*`** — verified by
grepping all of `src/`: not one reference. The agent surface and the UI are
already disjoint; the UI talks to `/api/*` (80 routes). Moving the agent surface
out breaks nothing a user sees.

One real coupling the RFC should know about, though, because it survives the
move and a port can get it silently wrong:

`ast.binding.ontologyVersion` — the stamp that makes an AST verifiable — is
`onto1:<sha256-16>` over a canonical serialization of **`allNodes()`**
(`server/cortex-ontology-version.ts:80`), i.e. the *composed* tree: seed spine +
registered ext nodes, after the boot fixpoint and the zone/depth finalize. Two
implementations that compose the same git data in a different order, or that
differ on which orphans `registerExtNodes` drops, produce **different
fingerprints from identical input** — and then every cross-checked AST is
rejected while both sides believe they are correct.

That is not an argument against moving it. It is an argument that the *composition*
has to become a specified contract, not just an implementation (see §5).

## 3. The honest UI-vs-backend split

47 `/agent/v1/*` routes, 80 `/api/*` routes. The agent surface is almost entirely
backend — but it is **not all cortex**, and that distinction matters more than
the backend/UI one:

**Cortex (should move under the directive):** `validate`, `validate/opcodes`,
`taxonomy/search`, `taxonomy/node/:id`, `graph`, `relations`,
`relations/candidates`, `search/semantic`, `embeddings`, `embeddings/pending`,
`features`, `features/vectors`, and the planned `context`.

**KEAP product backend (should stay — nothing to do with reasoning):**
`fs/status`, `fs/sync` (watches user files bind-mounted into the KEAP
container), `tables*` (the DataTables feature the nOS face consumes),
`captures`, `metadata`, `objects*`, `content/resolve`, `content/services`,
`curator/*`, `lint*`, `promotions`, `topics*`.

So "celý backend na nOS" read literally would move fs-sync and the face's
DataTables into the anatomy, which serves nobody. **The line that actually
matches the directive is cortex-vs-product, not backend-vs-UI.** KEAP
legitimately keeps a backend: the one that serves its own product surfaces.

On the UI side, note that `taxonomy_layout` (the U1 spatial bake — "spatial
memory", star positions) and the topic clusters are *UI* state, but they are
deterministic functions of the tree. Whoever holds the tree can bake them; they
do not need to travel.

## 4. Option C, or a fourth cut?

**I do not think C achieves the directive, and I would not build it.**

Its defining move — each side materializes the git SoT into its own store —
means two independent ingest implementations and two copies of the ontology. That
buys three problems:

1. **Two materializations, two chances to diverge.** `roundtrip.mjs` proves
   `ingest ∘ dump = identity` for *one* implementation. A second one needs its own
   equivalence proof against the first, or the `ontologyVersion` stamps diverge
   (§2) and the binding mechanism becomes decorative.
2. **The index problem doubles.** KEAP keeps an ANN index for explore's semantic
   search; nOS builds another for late-binding. Two embed passes, two 500 MB
   shadows unless both are tuned, two recall gates to keep honest.
3. **It does not remove KEAP's backend.** KEAP still runs ingest, FTS, the
   embedding store and graph assembly to render. So C satisfies "celý backend na
   nOS" no better than A does — it just adds a *second* backend. That is the
   sharpest objection: C is not a smaller B, it is A plus duplication.

**Option D (proposed): one store, in nOS — but promote the spine to data first.**

1. **Move the spine out of `src/game/data/taxonomy.ts` into
   `knowledge/canonical/`.** It should have been data all along; today the server
   imports the ontology's backbone from the frontend's source tree. This is the
   prerequisite for *any* port, it makes the git SoT complete for the first time,
   and it is independently worth doing — it removes a genuine architectural wart
   and brings the 790 seed nodes under the same lint + round-trip gate the
   1 051 grown ones already have.
2. **Stand up the cortex backend in the anatomy** over the reasoning tables
   (4.2 MB) plus the shared block, rebuilding the indexes there — with the ANN
   parameters fixed and the recall gate run before/after.
3. **KEAP renders from the nOS cortex API** and keeps its product backend
   (fs-sync, DataTables, captures, curator, lint) plus UI-only state.
4. **`validate` ports** rather than being rewritten: the tokenizer, the D1 scope
   model, late binding with mandatory ambiguity rejection, and the binding stamps
   are the spec, as the RFC says. I would port it *with its test suite* — 215
   unit tests and the e2e — because that suite encodes the decisions, not just
   the behaviour.

D is B done in the right order. The reason B looks large in the RFC is the
561 MB file and the spine; the first is 99% regenerable index and the second is
a file move plus an ingest change.

**If the operator prefers to keep it minimal**, A is defensible on one condition:
say plainly that KEAP keeps a *cortex* backend, and that the directive means
"nOS owns execution, credentials and the corpus". That is a coherent product, it
is where we are today, and it costs nothing. What I would not do is C, which pays
the migration cost of B and keeps the backend of A.

## 5. Is the git format a sufficient boundary?

**For the data, nearly. For the composition, no — and that gap is the one that
would bite a port silently.**

What the git SoT does carry (and this part is solid): the R3 layer in
`knowledge/_schema/ontology-format.md` — the verb registry *including moderated
growth the code seed cannot carry*, and every typed edge with its **moderation
verdict** and full provenance (confidence, justification, model, `createdAt`).
`canonical-format.md` carries the taxonomy delta: grown nodes, K1 description
overrides EN/CS, briefs, ToE relations. Both are CI-gated for round-trip
identity, and the ontology layer is compared as raw bytes rather than a parsed
field list precisely so a lossy dump cannot pass.

What it does **not** carry, in the order a port would hit it:

1. **The 790-node seed spine** (§1). Not in git as data at all.
2. **The composition rules.** `ontologyVersion` hashes the *composed* tree, so a
   port needs a normative definition of: registration order (the boot fixpoint —
   `registerExtNodes` drops nodes whose parent has not yet resolved, which is why
   ingest order once dropped a whole subtree silently), which orphans are dropped,
   the zone/depth finalize pass, and how K1 overrides layer on. Today that
   contract exists only as KEAP's implementation.
3. **ANN parameters** — but those are configuration, not contract, and the port
   should choose better ones anyway (§1).
4. **The recall fixtures.** `e2e/fixtures/selfmodel-recall.json` and the gate's
   semantics (in-scope relative ranking, ancestors exempt, exit 4 = skipped
   loudly) are what make "the retrieval means something" checkable. A cortex
   backend without a recall gate is a search box with opinions.

So my answer to Q5: make the boundary sufficient rather than assuming it is.
Promoting the spine (§4.1) closes gap 1; writing the composition down as a spec
with a conformance fixture — a canonical input tree and the `onto1:` fingerprint
it must produce — closes gap 2 and gives the port a pass/fail target instead of a
prose description.

## 6. On holding the executor PR-1

Agreed, and for a reason beyond the network path: under D the executor's phase-2
validation and KEAP's phase-1 stop being a cross-team contract at all, so three
of the RFC's open questions dissolve rather than getting answered. Settling this
first is the cheaper order.

Nothing here blocks you: `feat/cortex-validate` is built, gated and verified live
(late binding resolving `tax:node[Mathematics]` → `02.01`, ambiguity refusing
with candidates rather than picking, zero side effects proven by row census). It
runs wherever we decide it runs.

## 7. One correction to carry forward

The frozen plan's checklist item 1 anchors `ent:` to `object_type_definitions`.
That came from my round-2 review, and it was wrong: the table is created by
migration 001 and touched by **zero lines of code** — no reader, no writer, no
accessor, no rows. Validating against it would ship a route that appears to
typecheck `ent:` and in fact rejects everything. KEAP's P1 refuses `ent:`
explicitly instead, with a constant per-namespace `namespace_not_resolvable`
that is computed before any DB call. Populating that registry is a P3
prerequisite, and it is nOS-side work under any of these options.
