# Topics mode — implementation spec (synthesis)

Status: approved for implementation · Branch: `feat/mapped-folders` (follow-on feature branch recommended: `feat/topic-mode`)
Synthesized from three competing designs; base = the stability-first design (winner), with the losers' best mechanics grafted in and every judge-identified weakness either resolved or explicitly accepted below.

**Guiding invariant** (the contract every piece obeys): *a topic id, once minted, never changes meaning, position, or membership without a measured cause* — centroid anchoring gives identity, hysteresis damps membership, birth-frozen θ pins geometry. Re-running the pipeline on unchanged data is a byte-level no-op.

---

## 0) Decision log (numbered)

Each entry names its origin (D0 = stability-first winner, D1 = semantics-first, D2 = UX-first) and the judge weakness it resolves (`R:`) or accepts (`A:`).

1. **Base architecture = D0**: warm-started spherical k-means with sticky identities, k-hysteresis, assignment hysteresis, birth-frozen θ, in-container TypeScript over stored `kind='object'` vectors. No RNG anywhere; same DB state ⇒ bit-identical output. Rejected from D1: silhouette k-scan (perf cliff + k oscillation), centroid re-matching at cosine ≥ 0.80 (absolute threshold in anisotropic space — wrong-id inheritance risk; warm-start preserves identity structurally, no matching pass exists to get wrong), PCA hub positions (recomputed axes move *every* hub on any topic birth/death — the opposite of spatial memory). Rejected from D2: variable ring separation `2π/max(count,12)` (re-spaces the whole ring when count changes; we keep a constant, the `SAT_MIN_SEP` doctrine), corpus-seeded k-means++ re-init (any corpus edit reshuffles wholesale).
2. **Event-loop safety — typed arrays + cooperative chunking** (`R:` D0-perf, D1-blocking, D2-blocking). `clusterTopics` becomes `async`. Vectors are read as **raw JSON strings** (no parse in the SQL layer), parsed tile-wise (200 rows/tile) directly into one preallocated `Float32Array(n×768)`, with `await setImmediate` between tiles; Lloyd assign/update steps are tiled the same way (500 rows/tile, ~5–10 ms/tile at 10k×768×k16). No hundreds-of-MB transient `number[]`; peak extra memory ≈ 30 MB F32 at 10k. Wall-clock at 10k is a few seconds *of background time*, but no single event-loop stall exceeds ~50 ms — `/api/graph` and the nOS health probe stay responsive. `worker_threads` was considered and deliberately deferred: the prod server is a single esbuild bundle (`build:server`) and dev runs under `tsx watch`; a worker entry would need a second bundle + env-dependent path resolution. Documented escalation path if the corpus ever exceeds ~50k vectors.
3. **Single-flight + coalescing** (`R:` D0 "no in-progress guard"). All runs serialize through an internal promise chain; `scheduleTopicRecluster` is a trailing-edge debounce (15 s, max-wait 60 s) so a bulk embed burst (≤500 items/POST, many POSTs) triggers at most one run per minute plus one final run. A schedule that fires while a run is in flight sets `rerunQueued` instead of stacking runs.
4. **Boot never threatens the health probe** (`R:` D0-perf boot clause). `startTopicSync()` is called *inside* the `app.listen` callback next to `startFsSync()` (index.ts already documents this placement as the health-probe-safe slot) and merely schedules: `if (topicsStale()) scheduleTopicRecluster(15_000)`. Combined with (2), boot clustering cannot stall the probe.
5. **Model-migration correctness** (`R:` D0 model hole). New `db.dominantObjectModel()`: `SELECT model, COUNT(*) c, MAX(updated_at) u FROM embeddings WHERE kind='object' GROUP BY model ORDER BY c DESC, u DESC, model ASC LIMIT 1` — deterministic, object-kind-scoped (never the arbitrary `LIMIT 1` row of `embeddingStats()`). `readObjectVectorsRaw(model)` filters `WHERE kind='object' AND model = ?`. The pipeline clusters **only** dominant-model vectors — mixed-space cosine math is structurally impossible. The reset guard fires when the dominant object model ≠ stored `topic_clusters.model`, i.e. at the majority flip, not at an arbitrary batch boundary; minority-model objects are simply "unembedded" (center group) until the flip.
6. **Labels — full c-TF-IDF pipeline grafted from D1** (`R:` D0 label quality). Per-member label doc: title tokens ×2 (filenames split on `[-_./]` + camelCase), tags ×3, description ×1, first 1000 chars of body ×1 (sources: `db.getObjects('', true)`, same rows `objectText()` reads). Tokenize Unicode-aware `/[^\p{L}\p{N}]+/u`, lowercase, **keep diacritics** (cs is a first-class locale), drop len<3 and numeric-only, inline en+cs stopword lists (~120+~120 words, shipped in `topics-math.ts`), plus the corpus-level stop rule: drop terms present in >60 % of clusters. Score `(tf_{t,c}/Σtf_c) · ln(1 + A/f_t)` (A = mean total tf per cluster, f_t = corpus frequency). Store top-8 as `terms_json`; label = top 1–3 terms joined `" · "` capped at 28 chars; collisions dedupe by appending the next distinctive term to the later cluster (ordered by id). Deterministic ties: lexicographic.
7. **Label freshness under gradual drift** (`R:` D0 hysteresis-staleness). New column `churn_accum REAL`: each run adds `(joined + left) / max(1, prevSize)` for the topic. `label_auto` is recomputed every run; it is promoted to `label` when `label` is empty **or `churn_accum ≥ 0.25` (cumulative, not single-run)** — promotion resets the accumulator. 10 %/run drift now promotes after ~3 runs instead of never. `label_locked = 1` always wins.
8. **Admin rename ships in v1** (`R:` D0 "bad labels unfixable"). `PATCH /api/admin/topics/:id {label}` sets `label_locked=1`; `{label: null}` unlocks and restores `label_auto`. A lean Admin "Topics" card (list, inline rename, Rebuild, Reset-with-confirm) lands in S4 — the fs-mappings admin-card precedent.
9. **θ stays birth-frozen; re-anchor is an explicit act** (`A:`+`R:` D0 stale-galaxy pin). Automatic θ updates are rejected — spatial memory beats semantic freshness, and rays already show where members *actually* anchor. Residual staleness is **accepted** for unattended topics. Escape hatch: `POST /api/admin/topics/:id/reanchor` recomputes θ from the current majority root galaxy — an admin action is a "measured cause" under the invariant. Full reset recomputes all θ.
10. **Ring placement without the global cascade** (`R:` D0 min-sep cascade, D2 ring re-spacing). The clockwise-push chain is replaced by **chain-spread**: sort hubs by `(θ, id)`; find maximal chains where the circular gap to the previous hub `< TOPIC_MIN_SEP` (constant 0.35, the `SAT_MIN_SEP` twin; feasible: `K_MAX·0.35 = 5.6 < 2π`); re-space each chain's members at exactly `TOPIC_MIN_SEP`, centered on the chain's circular mean, order preserved (wrap-around handled by unrolling angles). Deterministic, order-independent, and — the point — **a topic birth perturbs only the hubs inside its own collision chain**; every non-colliding hub renders at its exact frozen θ. The "never move a hub" claim is restated honestly: *hub angles are exact frozen θ up to local min-sep adjustment among near-colliding neighbors.*
11. **Ray budget at scale — aggregation ships in v1** (`R:` D0 deferred aggregation, D1 white-out, D2 unbudgeted rays). Topic order reuses the existing `AGGREGATE_RAYS_AT = 200` collapse (core.ts mapping precedent): per topic, if anchored members > 200, emit hub → distinct-anchor rays from `topic:<id>`; else per-object rays. Hub→member spokes stay per-member — same one-edge-per-file budget fs order already carries at corpus scale.
12. **Outlier unassignment rejected** (from D1; `A:` with reason). Every embedded object gets a topic. An assigned↔outlier flap axis would fight the assignment-hysteresis identity contract, and the μ−1.5σ adaptive rule still flaps near the threshold. The `~untopiced` center group covers unembedded/minority-model objects honestly; a far-from-centroid member simply renders in its sphere.
13. **Privacy** (`R:` D2 corpus-wide label leak). `topics[]` in `/api/graph` is filtered per request to topics with **≥1 visible member** for the requester, and `count` is the **visible** member count (computed from the already-scoped objects list — free join by object id). Topics whose members are all invisible to the viewer do not exist in their payload (no existence leak). **Accepted residual**: a visible topic's label/terms are c-TF-IDF aggregates that may include tokens from hidden sibling docs in the same cluster — same altitude as the existing aggregate `fsMappings[].count` doctrine; no verbatim titles survive tokenization+ranking for clusters ≥3 members, and the graph-scope predicate (own + shared) already makes cross-user visibility deliberate.
14. **Member-sphere sibling reshuffle accepted** (`A:` D2 fibDir churn). `fibDir(i, n, …)` re-positions siblings when one member joins — confined to the *one* topic whose membership changed (hysteresis makes that rare), byte-identical to taxonomy-order behavior users already know; per-id hashed directions would clump without a relaxation pass. Not worth the machinery.
15. **k hysteresis retained** (`R:` D2 k-invalidated warm start, D1 k oscillation). `kTarget = clamp(round(√(n/4)), 3, 16)`; current k moves at most ±1 per run and only when `|kTarget − kCur| ≥ 2`. Growth spawns exactly one topic (deterministic farthest-first seed); shrink retires exactly the smallest (tie: lexicographic id). Surviving clusters never re-seed. K_MAX=16 holds even at 10k (√2500 clamps).
16. **Centroids as JSON text, never F32_BLOB** (all three designs agree). Migrations run before/independently of the vector layer (db.ts vector-schema try/catch); topics stay readable when `vectorsOk=false`.
17. **E2E through the real agent seam** (all three agree) + grafts: D1's label-content assertions (planted vocabulary must appear in labels — label quality is directly testable), rename-lock survival test, and D2's `core.spec.ts` update for the changed disabled-state tooltip.

---

## 1) Server clustering

### 1.1 Modules

**`server/topics-math.ts`** (new) — pure functions, `Float32Array` throughout, no db imports, no RNG:

```ts
export interface LloydResult { assign: Int32Array; centroids: Float32Array; iters: number }
export function normalizeInPlace(data: Float32Array, n: number, dim: number): void;
export function lloydWarm(
  data: Float32Array, n: number, dim: number,
  seeds: Float32Array, k: number,
  opts: { maxIter: number; eps: number; onTile?: () => Promise<void> }, // onTile = setImmediate yield
): Promise<LloydResult>;                    // empty-during-iteration keeps its previous centroid
export function farthestFirstSeed(data: Float32Array, n: number, dim: number,
  existing: Float32Array, k: number, ids: string[]): number; // row index; ties by ascending ref_id
export interface LabelDoc { id: string; title: string; tags: string[]; description?: string; body?: string }
export function cTfIdfLabels(docsByCluster: Map<string, LabelDoc[]>):
  Map<string, { label: string; terms: string[] }>;           // decision #6 pipeline, en+cs stoplists inline
```

**`server/topics.ts`** (new) — orchestration + IO:

```ts
export interface TopicRunResult {
  ok: boolean; skipped?: 'no-vectors' | 'too-few';
  k: number; n: number; moved: number; born: string[]; retired: string[]; ms: number;
}
export function clusterTopics(opts?: { reset?: boolean }): Promise<TopicRunResult>; // serialized via promise chain
export function scheduleTopicRecluster(delayMs?: number): void; // trailing debounce 15s, max-wait 60s, coalescing
export function startTopicSync(): void;    // boot: if (topicsStale()) scheduleTopicRecluster(15_000)
export function topicsStale(): boolean;    // dominant-model mismatch, or object-vector max(updated_at)/count drift vs last run
// consts: MIN_OBJECTS=8, TAU=0.04, K_MIN=3, K_MAX=16, MAX_ITER=50, EPS=1e-4,
//         EMPTY_RUNS_PRUNE=3, LABEL_CHURN=0.25, TILE_PARSE=200, TILE_LLOYD=500,
//         DEBOUNCE_MS=15_000, DEBOUNCE_MAX_MS=60_000, BOOT_DELAY_MS=15_000
```

### 1.2 Run order (one `clusterTopics` pass)

1. **Model guard** (decision #5). `model = db.dominantObjectModel()`; if stored `topic_clusters.model ≠ model` → full reset (identities are meaningless across spaces). Reset + admin `reset:true` are the only sanctioned identity breaks; both logged in `topic_runs.params_json`.
2. **Load** `db.readObjectVectorsRaw(model)` (raw JSON strings); tile-parse+normalize into one `Float32Array(n×768)` with yields (decision #2). `n < MIN_OBJECTS` → `skipped:'too-few'`, existing assignments retained.
3. **k hysteresis** (decision #15) — adjust k by ±1 at most; on reset, k = kTarget directly, seed 1 = vector of the lexicographically smallest ref_id, remaining seeds farthest-first.
4. **Warm-started Lloyd**: seeds = stored centroids (seed-index ↔ topic-id correspondence is preserved directly — no matching pass). New seed (growth) via `farthestFirstSeed`; new id `'t-'+8hex` (the `m-` minting precedent) at birth.
5. **Assignment hysteresis**: persisted assignment keeps an object's previous topic unless `dCos(best) < dCos(current) − TAU` (TAU=0.04). New objects and orphans of retired topics take nearest. Stored centroids then recomputed as the normalized mean of the *final* members (next warm start reflects what users see).
6. **Birth-frozen θ**: at birth, `theta = atan2(z, x)` of the majority root galaxy among members' anchors (`getAncestors` + `db.getLayout()` — the same coordinates graph.ts ships); fallback `2π·hash01('topic:'+id)`. Written once; changed only by admin re-anchor or reset (decision #9).
7. **Labels** (decisions #6–#7): recompute `label_auto` + `terms_json`; accumulate churn; promote per the cumulative rule; never touch locked labels.
8. **Lifecycle**: 0 members → `empty_runs++`; prune row at `empty_runs ≥ 3`. Assignments whose object no longer exists are deleted (mirrors `pruneEmbeddings`); an object that lost only its vector keeps its assignment.
9. **Persist** everything through `db.applyTopicRun(...)` — one transaction; readers never see a half-written map.

### 1.3 Triggers (never per-request)

- **Sync-triggered (primary)**: in `POST /agent/v1/embeddings` (agent.ts, after `upsertEmbeddings`), if any item has `kind==='object'` → `scheduleTopicRecluster()`.
- **Boot**: `startTopicSync()` inside the `app.listen` callback next to `startFsSync()` (decision #4).
- **On-demand**: admin + agent endpoints (§3). `/api/graph` only ever reads persisted tables.

---

## 2) Persistence — migration `'005-topic-clusters'`

Append to `MIGRATIONS` in `server/migrations.ts`. Plain JSON-text centroids on purpose (decision #16).

```sql
CREATE TABLE IF NOT EXISTS topic_clusters (
  id            TEXT PRIMARY KEY,             -- 't-'+8 hex, server-minted, IMMUTABLE (keys client geometry)
  label         TEXT NOT NULL,
  label_auto    TEXT NOT NULL,
  label_locked  INTEGER NOT NULL DEFAULT 0,   -- 1 = admin-renamed; auto never overwrites
  terms_json    TEXT NOT NULL DEFAULT '[]',   -- JSON string[] top-8 c-TF-IDF terms (panel chips)
  churn_accum   REAL NOT NULL DEFAULT 0,      -- cumulative membership churn since last label promotion
  centroid_json TEXT NOT NULL,                -- JSON number[768], unit-normalized (warm-start seed)
  theta         REAL NOT NULL,                -- ring angle, frozen at birth; changes ONLY via admin reanchor/reset
  model         TEXT NOT NULL,                -- embedding model of the vector space
  member_count  INTEGER NOT NULL DEFAULT 0,   -- corpus-global (server bookkeeping; payload counts are per-viewer)
  empty_runs    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER DEFAULT (strftime('%s','now')),
  updated_at    INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS topic_assignments (
  object_id  TEXT PRIMARY KEY,                -- knowledge_objects.id == embeddings.ref_id (kind='object')
  topic_id   TEXT NOT NULL,
  distance   REAL NOT NULL,                   -- cosine distance at assignment time
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS topic_assignments_topic_idx ON topic_assignments(topic_id);
CREATE TABLE IF NOT EXISTS topic_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at      INTEGER DEFAULT (strftime('%s','now')),
  model       TEXT NOT NULL,
  k           INTEGER NOT NULL,
  n           INTEGER NOT NULL,
  moved       INTEGER NOT NULL,
  params_json TEXT NOT NULL                   -- {tau, kTarget, reset?, born, retired, ms}
);
```

`server/db.ts` additions (next to the embeddings block):

```ts
export function dominantObjectModel(): string | null;                          // decision #5 query
export function readObjectVectorsRaw(model: string): { id: string; v: string }[]; // vector_extract text, NOT parsed
export interface TopicClusterRow { id: string; label: string; labelAuto: string; labelLocked: boolean;
  terms: string[]; churnAccum: number; centroid: number[]; theta: number; memberCount: number;
  emptyRuns: number; model: string; updatedAt: number }
export function listTopicClusters(): TopicClusterRow[];
export function getTopicAssignments(): Map<string, string>;                    // object_id → topic_id
export function applyTopicRun(r: { clusters: TopicClusterRow[]; retired: string[];
  assignments: Array<{ objectId: string; topicId: string; distance: number }>;
  run: { model: string; k: number; n: number; moved: number; paramsJson: string } }): void; // ONE transaction
export function renameTopic(id: string, label: string | null): boolean;        // null → unlock + restore label_auto
export function setTopicTheta(id: string, theta: number): boolean;             // admin reanchor only
export function topicStats(): { available: boolean; k: number; assigned: number; lastRunAt: number | null };
```

---

## 3) HTTP surface

**Admin** (new `registerTopicRoutes` mounted next to `registerFsMappingRoutes` in `server/index.ts`; `requireAdmin` per the fs-mappings.ts pattern):

- `GET /api/admin/topics` — full `TopicClusterRow` list (sans centroid) + `topicStats()`.
- `PATCH /api/admin/topics/:id` — `{label: string | null}` (decision #8).
- `POST /api/admin/topics/:id/reanchor` — recompute θ from current majority galaxy (decision #9).
- `POST /api/admin/topics/rebuild` — `{reset?: boolean}`; default 202 `{scheduled:true}`; `?wait=1` awaits the serialized run and returns `TopicRunResult` (e2e/admin hook). 503 when `!db.vectorSearchAvailable()`.

**Agent** (agent.ts, next to the embeddings block; add to the help/OpenAPI manifest):

- `GET /agent/v1/topics` — `agentAuth('ro')` — `topicStats()` + last run summary.
- `POST /agent/v1/topics/rebuild` — `agentAuth('rw')` — same body/`wait` semantics as the admin twin (mirrors `/agent/v1/fs/sync`).

---

## 4) Payload — server/graph.ts + src/hooks/useExplorerData.ts

In the `/api/graph` handler, above the objects map: `const topicByObject = db.getTopicAssignments()`.

Per-object (after `mapping:`):

```ts
topic: topicByObject.get(o.id),   // scoping stays free — join keyed per visible-object id
```

Top-level, after the objects map (decision #13 — per-viewer filter + counts):

```ts
const visTopicCount = new Map<string, number>();
for (const o of objects) if (o.topic) visTopicCount.set(o.topic, (visTopicCount.get(o.topic) ?? 0) + 1);
// in ok(res, {...}), sibling of fsMappings:
topics: db.listTopicClusters()
  .filter((t) => visTopicCount.has(t.id))
  .map((t) => ({ id: t.id, label: t.label, theta: t.theta,
                 count: visTopicCount.get(t.id)!, terms: t.terms.slice(0, 5) })),
meta: { ...existing, topics: db.topicStats() },
```

Client types (`useExplorerData.ts`): `GraphObject.topic?: string`; `GraphTopic { id: string; label: string; theta: number; count: number; terms?: string[] }`; `GraphPayload.topics?: GraphTopic[]`; `meta.topics?: { available: boolean; k: number; assigned: number; lastRunAt: number | null }`. All additive+optional both directions.

---

## 5) Client layout — src/components/explorer/core.ts

Consts: `TOPIC_RING = 280` (TAX_RING band), `TOPIC_MIN_SEP = 0.35` (constant — decision #10). `CoreFolder` gains `topic?: string` (twin of `mapping?`). `computeCore` opts gain `topics?: Array<{ id: string; label: string; theta: number }>`.

`topicLayout(objects, topics): TreeOut`:

1. Partition by `o.topic`: assigned (id present in `topics`) vs everything else → `~untopiced` group at the origin — exact `~unanchored` precedent, hubless fog; unclustered objects hold the center.
2. **Hub placement — chain-spread** (decision #10): θ from payload (birth-frozen server-side); sort `(θ, id)`; resolve only colliding chains, symmetric spread at `TOPIC_MIN_SEP` around each chain's circular mean; `y = (hash01('ty:'+id) − 0.5) · 160`; center `[cosθ·TOPIC_RING, y, sinθ·TOPIC_RING]`. Deterministic + order-independent; a birth perturbs only its own chain.
3. Hub node per non-empty topic into `folders`: `{ id: 'topic:'+t.id, name: t.label, path: '~topic/'+t.id, depth: 0, count: n, topic: t.id }` (the `~topic/` path can never collide with `dirStatByPath`). Label stamped on the node only — **no geometry keys off the label** (the mapping-label rule).
4. Members: sorted by object id, `fibDir(i, n, `${t.id}:${o.id}`)` sphere of `r = min(200, 24 + 10·√n)` — byte-identical to taxonomyLayout (decision #14 accepts the sibling reshuffle). Spokes `fsLinks: {source: 'topic:'+t.id, target: 'obj:'+o.id}`. Update the `CoreLayout.fsLinks` doc comment to "fs + topic orders".
5. `computeCore` branch inserted **before** the fs fall-through (fixes today's hazard where `order='topic'` silently renders fs), with v1 ray aggregation (decision #11):

```ts
if (order === 'topic') {
  const base = topicLayout(objects, opts.topics ?? []);
  const hubIds = new Set(base.folders.filter((f) => f.topic).map((f) => f.id));
  const rays: Array<{ source: string; target: string }> = [];
  const byTopic = groupBy(objects, (o) => o.topic);           // '' bucket = untopiced
  for (const [tid, members] of byTopic) {
    const anchored = members.filter((o) => o.anchors.length > 0);
    const hubId = `topic:${tid}`;
    if (tid && anchored.length > AGGREGATE_RAYS_AT && hubIds.has(hubId)) {
      const targets = new Set<string>();
      for (const o of anchored) for (const a of o.anchors) targets.add(a);
      for (const a of targets) rays.push({ source: hubId, target: a });
    } else {
      for (const o of anchored)
        for (const a of new Set(o.anchors)) rays.push({ source: `obj:${o.id}`, target: a });
    }
  }
  return { ...base, rays, mrays: [] };
}
```

Determinism contract: layout is a pure function of `(object ids, assignment ids, topic ids, thetas)`; relabels restyle, never move.

---

## 6) UI — src/pages/Explore.tsx, Admin, i18n

- Pass `topics: graph.topics ?? []` into the `computeCore` opts.
- **Root-rename guard**: `name: f.depth === 0 && !f.mapping && !f.topic ? t('explore.core.root') : f.name` — without `!f.topic` every hub would be renamed "Files". Topic hubs get `categoryHue: 265` (violet ≈ semantic space, distinct from folder blue 215).
- Order bar: availability-driven —

```tsx
const topicsReady = (graph?.topics?.length ?? 0) > 0;
disabled={o === 'topic' && !topicsReady}
title={o === 'topic' && !topicsReady ? t('explore.core.topicUnavailable') : undefined}
```

  same condition in the `cursor-not-allowed` style branch. Defensive: `effectiveOrder = order === 'topic' && !topicsReady ? 'fs' : order` (topics can vanish on a payload refresh).
- Coverage caption in topic order when < 100 %: `topicCoverage` "{{assigned}}/{{total}} clustered", computed client-side from visible objects (no extra server field).
- Hub click rides the existing folder-node `openTarget` path → drawer shows label, count, and `terms` chips (lookup in `graph.topics`); the `taxonomyFocus` guard already skips synthetic ids.
- **Admin "Topics" card** (decision #8): list (label, auto-label, locked badge, member count), inline rename, Re-anchor per row, Rebuild, Reset-with-confirm — fs-mappings admin-card precedent.
- i18n (`en.json` `explore.core` block + `cs.json` mirror): replace `topicSoon` with `topicUnavailable` ("No topic clusters yet — waiting for object embeddings (keap-embed-sync)" / cs: "Zatím žádné tematické shluky — čeká se na vektory objektů (keap-embed-sync)"), add `untopiced` ("unsorted" / "nezařazené"), `topicCoverage` ("{{assigned}}/{{total}} clustered" / "{{assigned}}/{{total}} seskupeno"), plus the admin-card keys.

---

## 7) Degraded modes (all non-blocking)

| State | Behavior |
|---|---|
| `vectorsOk=false` (stock SQLite) | 005 tables are plain SQL — persisted topics/assignments **still ship and render**, frozen; `clusterTopics` → `skipped:'no-vectors'`; rebuild endpoints 503. |
| 0 object vectors (dev DB today) | `topics[]` empty → button disabled with `topicUnavailable` tooltip — the current dev experience, now truthful. |
| `n < MIN_OBJECTS` (8) | `skipped:'too-few'`; existing assignments retained. |
| Partial embedding coverage | Unembedded/minority-model/new objects gather in `~untopiced` at the origin; adopted by the next debounced run with zero disturbance to existing members. |
| Embed model swap | Guarded reset at the dominant-model flip (decision #5); logged in `topic_runs`; the one expected identity break. |
| Bulk embed burst | Debounce max-wait bounds runs to ~1/min; single-flight + coalescing prevents overlap (decision #3). |
| Old client / new server (and inverse) | All fields additive+optional; empty `topics[]` renders the fs fallback via `effectiveOrder`, never a silent wrong order. |
| Host Pulse job dead | Topics go stale, never wrong — graph reads persisted state only. |
| Viewer with zero visible members in a topic | Topic absent from their payload entirely (decision #13). |

---

## 8) E2E — `e2e/topics.spec.ts` (+ `core.spec.ts` touch)

Playwright, serial, core.spec.ts conventions; fresh DB + `e2e-ro`/`e2e-rw` agent tokens; `POST /agent/v1/embeddings` accepts arbitrary 768-dim vectors — no Ollama.

1. **Disabled-state first** (before seeding): no `topics` in `/api/graph` ⇒ button disabled with `topicUnavailable` tooltip. Update the existing `core.spec.ts` "Topics disabled" assertion to the new key (decision #17).
2. **Seed** 12 objects via `POST /api/objects` — two planted vocabularies ("quantum-…" ×5, "recipe-…" ×5, distinctive title/tag terms; one with a `[[01.01]]` anchor for ray assertions) + 2 left unembedded.
3. **Vectors via the real contract**: `GET /agent/v1/embeddings/pending` (ro) → canonical `contentHash`es → `POST /agent/v1/embeddings` (rw) with synthetic unit vectors: group A ≈ e₁+deterministic jitter, group B ≈ e₂+jitter.
4. **Cluster**: `POST /agent/v1/topics/rebuild?wait=1` (rw). Assert: every embedded object assigned; no topic mixes A and B; unembedded unassigned; **each group's topic label contains its planted term** (label quality is testable — decision #17).
5. **Stability battery** (the point of the spec): rebuild unchanged ⇒ `moved=0`, deep-equal ids/thetas/labels/assignments. Add one A-like object+vector, rebuild ⇒ prior assignments/ids/thetas unchanged, newcomer joins an A-topic. Re-POST one vector with slight jitter ⇒ assignment unchanged (hysteresis). `rebuild {reset:true}` ⇒ every id replaced (sanctioned break observable).
6. **Rename lock**: `PATCH /api/admin/topics/:id {label:'My topic'}` → rebuild ⇒ label survives; `{label:null}` ⇒ `label_auto` restored.
7. **Payload + UI**: objects carry `topic`; `topics[]` rows `{id,label,theta,count,terms}`; `meta.topics.available`; page test enables core, clicks Topics, asserts canvas + screenshot (WebGL node-click assertions stay out, per existing specs).

---

## 9) Implementation stages (each lands green independently — fs-mappings cadence)

**S1 — server clustering + persistence**
`server/migrations.ts` (005) · `server/db.ts` (readers/writers, `dominantObjectModel`) · `server/topics-math.ts` (new, pure) · `server/topics.ts` (new: chunked async pipeline, debounce, single-flight, stale check) · `server/agent.ts` embeddings-POST hook · `server/index.ts` `startTopicSync()` in the listen callback. Ships inert: nothing reads the tables yet.

**S2 — payload + API**
`server/graph.ts` (per-object `topic`, viewer-filtered `topics[]`, `meta.topics`) · `server/topics-routes.ts`/`registerTopicRoutes` (admin GET/PATCH/reanchor/rebuild) · `server/agent.ts` (`GET /agent/v1/topics`, `POST /agent/v1/topics/rebuild` + manifest) · `src/hooks/useExplorerData.ts` types. Ships dark: client renders nothing new; old clients unaffected.

**S3 — core.ts layout**
`CoreTopic`/`CoreFolder.topic` · `topicLayout` with chain-spread hubs · `computeCore` topic branch before the fs fall-through, with `AGGREGATE_RAYS_AT` collapse. Pure-function change, still unreachable until S4 enables the button.

**S4 — UI + i18n + e2e**
`src/pages/Explore.tsx` (opts.topics, effectiveOrder, enablement/tooltip, root-rename guard, hue 265, coverage caption, drawer terms) · Admin Topics card · `src/i18n/locales/en.json` + `cs.json` · `e2e/topics.spec.ts` (new) + `e2e/core.spec.ts` tooltip update.
