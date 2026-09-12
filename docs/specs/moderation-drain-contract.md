# Moderation drain contract (weekly brief drain, nOS loop ↔ KEAP)

Settled 2026-09-12 (operator go: threshold 9/10 per domain, weekly cadence,
nOS-side loop prepares, operator applies). The loop PREPARES verdicts and
surfaces them; APPLY always runs under the operator's human session — no agent
path can decide, by design.

## 1. Reader (agent surface, RO token)

`GET /agent/v1/promotions?status=proposed&limit=5000`

- `limit` accepted up to 5000 (default 100 — pass it explicitly, the default
  hides the tail of a 300+ queue).
- Items (newest first): `{ id, kind, captureId, proposedBy, rationale?,
  object, status, votes, createdAt }`.
- For `kind='brief'`: `captureId = "brief:<nodeId>"`, `object = { nodeId,
  briefEn, briefCs? }`. Derive domain from `nodeId` (first segment: `01`–`12`
  or `nos`).
- Fill-vs-overwrite: `GET /agent/v1/taxonomy/node/:id` → `curated.brief`
  present ⇒ overwrite, absent ⇒ fill. (Same endpoint 404s ⇒ dead target.)
- Everything in the queue already passed proposal-time validation
  (300–12000 chars, ≥2 paragraphs, ≥1 live `[[ref]]`, http(s)-only links);
  approve re-validates refs and throws if the taxonomy moved since.

## 2. Apply (human /api, admin session — operator only)

- Single: `POST /api/promotions/:id/decide` `{ decision: "approve"|"reject" }`.
- Batch (selected set — the verdict JSON's ids, per domain):
  `POST /api/promotions/decide-brief-bulk`
  `{ decision: "approve"|"reject", ids: ["<promotion-id>", … ≤1000] }`
  → `{ decision, decided, errors: [{ id, error }] }`.
  - Brief-kind only (`not a brief promotion` per other kinds).
  - Idempotent-safe: already-decided ids come back as
    `promotion already approved|rejected` error entries; a re-run of the same
    batch decides 0 and fails nothing.
  - A verdict of "retarget" is expressed as: `reject` the dead-target id, then
    re-propose under the new nodeId (`POST /agent/v1/taxonomy/brief`).
- Approve side-effect: brief lands in `taxonomy_metadata.data.brief[Cs]` +
  `briefMeta`, corpus FTS flips immediately, the note-kind embedding goes
  stale via content_hash → normal `/agent/v1/embeddings/pending` → the
  existing keap-embed-sync pulse drains it.

## 3. Backport (MANDATORY after every approve batch)

Approve writes only `taxonomy_metadata`, and `knowledge/ingest.mjs` WIPES that
table per changed canonical file on converge — an un-backported brief vanishes
the next time its domain file is touched. Canonical is the source of truth.

Numeric domains (01–12), run after the batch:

```sh
docker cp knowledge/dump.mjs iiab-keap-1:/tmp/dump.mjs
docker exec -e OUT_DIR=/tmp/kdump iiab-keap-1 node /tmp/dump.mjs
docker cp iiab-keap-1:/tmp/kdump/. ./knowledge/canonical/
git diff --stat knowledge/canonical/   # review: only brief additions expected
git add knowledge/canonical/ && git commit
```

(`--inspect` flag = dry-run: counts + samples, writes nothing.) Then the
normal release → pin bump → nOS mirror re-port keyed on the full knowledge/
tree diff (runbook 99d290b).

`nos.*` briefs: KEAP's canonical has NO nos/ subtree — those nodes are seeded
from the nOS-side knowledge files. dump.mjs still emits them under
`OUT_DIR/nos/`, but their durable home is the nOS repo; porting an approved
nos.* brief into your seed files is the nOS half of the backport, else your
own converge wipes it.

## 4. Division of labour

- nOS loop (weekly): reader → stratified ~10% spot-check per domain →
  verdict JSON (git-tracked; auto-retarget dead targets, nos.* → human,
  fills per 9/10 domain threshold) → surface to operator.
- Operator: reviews verdict JSON, applies via decide-brief-bulk under their
  session, runs the backport commit.
- KEAP (this repo): owns the endpoints above; interface changes announced
  over the relay before shipping.
