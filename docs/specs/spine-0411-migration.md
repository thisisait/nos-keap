# Spine T2 revision — 04.04.11/04.04.12 migration runbook

Companion to the Spine T2 revision spec (branch `feat/spine-t2-revision`,
deliverable A2). Covers what changed in `04.04.json`, why the id rename is
safe under the operator-approved vector big-reset, the converge order, and
the complete reference inventory for `04.04.11` / `04.04.12` with a required
fix per hit.

## What changed here

`knowledge/canonical/04-social-sciences/04.04.json`:

- Removed the two ext subtrees that had drifted into Economics for want of a
  closer parent: `04.04.11` "Accounting and Financial Reporting" (+ children
  `.01`–`.07`) and `04.04.12` "Management and Organisation" (+ children
  `.01`–`.07`) — 16 nodes total.
- Removed the 8 `concept_relations` entries whose `from` was one of those 16
  ids (`04.04.11.02→04.04.08.03`, `04.04.11.04→04.06.10`,
  `04.04.11.06→04.06.10.01`, `04.04.12.01→02.05.01.04`,
  `04.04.12.03→02.05.02`, `04.04.12.04→04.01`, `04.04.12.05→04.09`,
  `04.04.12.07→04.06.10.01`).
- Everything else in the file (all of `04.04.01`–`04.04.10` and their
  relations) is byte-identical.

The content itself is not deleted — it is re-homed verbatim by deliverable
A1 into `knowledge/canonical/04-social-sciences/04.11.json` under new ids.
A1's file landed during this task; the final id mapping is:

| Old id | New id | Name |
|---|---|---|
| `04.04.12` | `04.11.02` | Management and Organisation |
| `04.04.12.01` | `04.11.02.01` | Organisational Structure |
| `04.04.12.02` | `04.11.02.02` | Strategy |
| `04.04.12.03` | `04.11.02.03` | Operations and Process Management |
| `04.04.12.04` | `04.11.02.04` | Human Resource Management |
| `04.04.12.05` | `04.11.02.05` | Leadership and Motivation |
| `04.04.12.06` | `04.11.02.06` | Project Management |
| `04.04.12.07` | `04.11.02.07` | Risk and Governance |
| `04.04.11` | `04.11.03` | Accounting and Financial Reporting |
| `04.04.11.01` | `04.11.03.01` | Double-Entry Bookkeeping |
| `04.04.11.02` | `04.11.03.02` | Financial Statements |
| `04.04.11.03` | `04.11.03.03` | Recognition and Measurement |
| `04.04.11.04` | `04.11.03.04` | Accounting Standards |
| `04.04.11.05` | `04.11.03.05` | Management Accounting |
| `04.04.11.06` | `04.11.03.06` | Audit and Assurance |
| `04.04.11.07` | `04.11.03.07` | Financial Analysis |

The ontology-layer fixes below use this table.

## Ingest semantics (why this edit alone is enough for the KEAP-owned file)

`knowledge/ingest.mjs` applies one file per transaction, wipe-then-insert,
keyed by the file's declared domain (`04.04`). The wipe deletes every
`taxonomy_nodes_ext` / `node_descriptions` / `node_metadata` row with
`id = '04.04' OR id LIKE '04.04.%'`, then re-inserts exactly what the file
now contains — so simply removing the two subtrees from `04.04.json` is
sufficient to delete them from the DB on next ingest; no explicit "delete"
step is needed for those tables.

**The one wipe that is scoped differently:** `concept_relations` wipes are
scoped by `from_id` only, never `to_id` (`ingest.mjs:142-143`). This is why
the 8 xref relations above had to be deleted by hand rather than relying on
the subtree's disappearance to imply it — a row with `to` pointing into
`04.04.11`/`04.04.12` from a file this agent doesn't own would have survived
untouched (there are none; confirmed below). It is also why A1 must re-add
these 8 relations under the new `from` ids in `04.11.json` — they do not
migrate themselves.

Idempotency: ingest is a no-op on an unchanged file (sha256 in
`knowledge_imports`); once this edit lands, running ingest twice is safe.

## ID-rename consequences (vector big-reset approved)

The operator has approved a full vector big-reset at converge — this
migration does **not** attempt to preserve embeddings, and none of the
guidance below tries to. Per node id, 7 DB tables hold rows keyed on the old
`04.04.11*` / `04.04.12*` ids (16 node ids total; counts from the read-only
snapshot):

| Table | Rows | Migration path |
|---|---|---|
| `taxonomy_nodes_ext` | 16 | Deleted by A2's ingest (wipe on `04.04`), re-created by A1's ingest (insert on `04.11`) under new ids. No manual action. |
| `node_descriptions` | 16 | Same as above — wiped with `04.04`, re-inserted with `04.11` from the `en`/`cs` A1 carries over verbatim. |
| `node_features` | 16 | **Not file-driven and NOT wiped.** `ingest.mjs applyDomain()` deletes only from `taxonomy_nodes_ext`, `node_descriptions`, `taxonomy_metadata`, `concept_relations`; `upsertNodeFeatures` (`server/db.ts`) is a pure upsert with no delete path. The 16 old rows survive as orphans — **manual `DELETE FROM node_features WHERE node_id IN (…16 ids…)` required** (converge step 2 below). |
| `taxonomy_layout` | 16 | **NOT wiped either.** The only full-wipe path (`saveLayout`) fires on a seed `layout_version` bump, which this migration does not do; boot only appends missing stars, never removes stale ones. Orphans additionally trip `server/lint.ts checkSubstrate()`: layout rows = old + 23 vs live nodes = old − 16 + 23 → a permanent HIGH-severity `layout-drift` finding that **no restart clears**. Same manual DELETE, same step 2. |
| `embeddings` (kind=`taxonomy`) | 16 | Not deleted by ingest. Cleanup happens in the **embed-sync prune pass** (`pruneEmbeddings`, triggered by the pending-diff computation) — attribute it there, not to "the wipe", so nobody skips embed-sync thinking ingest sufficed. Big-reset approved: do not carry vectors across the rename. |
| `relations` (typed, from_ref/to_ref) | 16 rows touching the two prefixes | **Lives in the separate R3 ontology layer, additive-only, never wiped by `ingest.mjs`.** These rows do NOT disappear when the ext nodes do — they will dangle (reference deleted node ids) until someone repoints or retires them by hand. See "Ontology-layer relations" below; this is not automatic. |
| `concept_relations` (curated-xref) | 8 rows, mirroring 8 of the 16 `relations` rows | Deleted by this file's edit (see above) on next ingest of `04.04`. Re-created only once A1's `04.11.json` adds them back under the `from`-id law. Until A1's file ingests, these 8 edges simply don't exist — acceptable mid-migration state, not a bug. |
| `node_metadata` | 0 rows for these prefixes (table empty here) | Nothing to do. |

Total: 104 node-keyed DB rows across 7 tables were the pre-migration
footprint; only `relations` (16 rows, ontology layer) requires a manual fix
that ingest cannot perform for it, because that layer is additive-only and
never wiped.

### Ontology-layer relations (manual fix required, NOT ingest-driven)

`knowledge/ontology/relations/*.json` feeds the separate R3 typed-relation
system (`relations` table), which is additive-only and has no wipe-on-file
tied to the canonical domain files at all. Deleting the ext nodes from
`04.04.json` does **not** clean these up. Full inventory and required fix:

**`knowledge/ontology/relations/04-social-sciences.json`** (6 hits — inside
this spec's A2 file list):

| Line(s) | Edge | Required fix |
|---|---|---|
| 344 | `04.04.08 --prerequisite-for--> 04.04.11` | Repoint `to` → `04.11.03`. |
| 354 | `04.04.11 --derived-from--> 04.04` | **Semantically wrong after the move, not just an id needing renaming** (see call-out below) — do not blindly repoint `from` to `04.11.03`; re-derive or drop the edge. Matches DB row `r-92a2e70054a6f8c4`. |
| 366 | `04.04.11 --specializes--> 09.05` | Repoint `from` → `04.11.03`. |
| 378 | `04.04.12.03 --derived-from--> 03.05` | Repoint `from` → `04.11.02.03`. |
| 704 | `04.06.07.05 --causes--> 04.04.11.06` | Repoint `to` → `04.11.03.06`. |
| 968 | `04.06.13.05 --requires--> 04.04.11.06` | Repoint `to` → `04.11.03.06`. |

**`knowledge/ontology/relations/02-formal-sciences.json`** (2 hits — this
file is **outside** A2's assigned file list in the spec, which names only
the 04-social-sciences relations file plus specific appendix files for
xrefs; flagged here because it would otherwise dangle silently):

| Line | Edge | Required fix |
|---|---|---|
| 608 | `02.02.11.09 --analogous-to--> 04.04.12.01` | Repoint `to` → `04.11.02.01`. |
| 980 | `02.05.01 --generalizes--> 04.04.12.01` | Repoint `to` → `04.11.02.01`. |

Neither of these files is touched by this A2 commit — the spec's ground
rules state "nobody in this spec touches `knowledge/ontology/`" and this
layer's edits go through a separate ownership/moderation gate
(`relationPartition`) that this task does not have. **This runbook is the
required handoff**: whoever owns the ontology layer (or the reviewing agent,
per the spec's "Fable does final review+fixes") must apply the 8 fixes above
once A1's new ids are known, or accept the two rows as intentionally
retired.

### Call-out: `r-92a2e70054a6f8c4` is not a renaming problem

DB relations row `r-92a2e70054a6f8c4` and its ontology-layer source (line
354 above) encode `04.04.11 --derived-from--> 04.04`: "Accounting is
derived from Economics." That claim was defensible while Accounting lived
as an ext child of Economics for lack of a better parent. Once Accounting
moves into `04.11 Business & Management` under its own T2, "derived-from
Economics" becomes a substantive claim the corpus no longer supports the
same way — Accounting is now a peer discipline, not descended from a parent
that has changed. This needs a human/reviewer judgment call (drop the edge,
or replace it with a weaker `related-concept` toward `04.04`), not a
mechanical id substitution.

### nOS mirror (read-only reference for A2; NOT fixed by this branch)

`/Users/pazny/projects/nOS` carries a byte-identical checked-in copy of the
exact 3 KEAP files this migration touches, at the same line numbers, under
`files/anatomy/cortex/knowledge/`:

- `canonical/04-social-sciences/04.04.json` (38 hits)
- `ontology/relations/04-social-sciences.json` (6 hits)
- `ontology/relations/02-formal-sciences.json` (2 hits)

This is the cortex-organ port of the KEAP knowledge tree — a MANUAL copy
from `~/keap/src` (there is no re-port workflow; `cortex-drift.py` is the
drift detector, nOS agent 2026-09-06). The spec designates the nOS repo as
**read-only reference** for this inventory — no KEAP-side change can or
should touch it. Flagging explicitly: this mirror silently goes stale the
moment `04.04.json` changes here, since nothing re-syncs it automatically.
Re-porting = copying the changed files from a v1.45.0 checkout at the pin
bump — a decision and an act for the operator / nOS side, out of scope for
this KEAP branch.

**Port lesson (nOS agent, 2026-09-07): the 3-file list above is the
RETIRED-ID inventory (the DELETE targets), not the release's full knowledge
footprint.** v1.45.0 actually changed TEN knowledge data files (this
domain's three plus 02.02, 04.05, 04.08, 06.05, 07.08, 10.04 and the three
NEW pack files 04.11/07.11/07.12) — a mirror re-port keyed on the
id-inventory silently misses new packs and xref-only edits. The reliable
re-port signal is the full `knowledge/` tree diff between pins, or
cortex-drift.py itself; never a migration doc's inventory list.

### Repo-wide scope confirmation

`docs/`, `server/`, and all `*.test.ts` / `*.test.js` files were searched
for `04.04.11` / `04.04.12` and returned zero hits — no test or doc file
outside the canonical/ontology trees references these ids. No other
canonical file's `relations[]` points at `04.04.11*`/`04.04.12*` either
(confirmed by repo-wide grep after this edit).

## Converge order

1. **Ingest** — run `knowledge/ingest.mjs` (not `--dry-run`) once all
   agents' canonical files have landed, so `04.04` (removal) and `04.11`
   (A1's re-home) apply in the same converge pass. Order between the two
   files does not matter to ingest (each is its own transaction, domain-
   scoped), but landing them together avoids a window where the content
   exists nowhere.
2. **Manual DB cleanup** (in-container, libSQL — never host sqlite3): the
   three row families ingest cannot touch, keyed on the 16 retired ids:
   `DELETE FROM node_features WHERE node_id IN (…)`,
   `DELETE FROM taxonomy_layout WHERE node_id IN (…)` (else the permanent
   `layout-drift` HIGH lint finding described above), and
   `DELETE FROM relations WHERE from_ref LIKE '04.04.11%' OR from_ref LIKE
   '04.04.12%' OR to_ref LIKE '04.04.11%' OR to_ref LIKE '04.04.12%'` — the
   ontology layer is additive-only, so the repointed file edges INSERT new
   rows under new relation ids while the old rows would dangle forever.
   *(The 8 file-side edge fixes named above were applied on this branch by
   the reviewing agent, 2026-09-06 — including the semantic call on
   `r-92a2e70054a6f8c4`: `04.04.11 --derived-from--> 04.04` became
   `04.11.03 --related-concept--> 04.04`.)*
3. **Restart** the server process so in-memory taxonomy state
   (`registerExtNode`/`registerExtNodes`) reloads from the post-ingest DB.
4. **Embed-sync** — regenerate embeddings for the changed domains (`04.04`,
   `04.11`, and the 5 xref-appended files) at minimum, or run the full
   corpus big-reset the operator approved. Do not attempt to carry old
   `taxonomy` embeddings across the id rename.
   **Durability lesson (found live, 2026-09-07):** a bulk
   `DELETE FROM embeddings` desyncs the libsql vector index's shadow
   tables — every subsequent insert 500s with `vector index(insert):
   failed to insert shadow row`. After any bulk embeddings wipe, rebuild
   the index before repopulating:
   `DROP INDEX IF EXISTS embeddings_vec_idx;` then re-create it with the
   tuned DDL from `server/db.ts` (`compress_neighbors=float8`,
   `max_neighbors=20`). A restart alone does NOT fix it —
   `retuneVectorIndex` only rebuilds when the stored DDL differs.
5. **Recall gates** — re-run the recall/quality gates now that the vector
   index has changed; expect different results near the moved subtree and
   validate they still make sense (Accounting/Management content should now
   surface for business-flavoured queries via `04.11`, not `04.04`).
6. **Baseline re-record** — once recall gates pass, re-record whatever
   baseline snapshot the recall-gate tooling compares future runs against,
   since the pre-migration baseline is now stale by design.

## Cross-domain xref relations appended by this deliverable

Per the spec's food-triangle (`06.05` Culinary Arts ↔ `07.08` Cooking ↔
`10.04` Traditional Recipes) and navigation (`08.06` Navigation ↔ `04.08.03`
Cartography and Geoinformatics) xrefs, all target files existed — nothing to
report as a missing-endpoint case. Each direction is filed under whichever
side is its `from`, per the from-id-only wipe law:

- `06.05.json`: `06.05.05 → 10.04.01` (Culinary Traditions as Craft →
  Regional Cuisines), `06.05.03 → 07.08.04` (Food Science → Nutrition
  Science).
- `07.08.json`: `07.08.04 → 06.05.03` (the reverse pair above),
  `07.08.03 → 10.04.02` (Food Preservation → Preservation Techniques).
- `10.04.json`: `10.04.01 → 06.05.05`, `10.04.02 → 07.08.03` (the reverse
  pairs above) — completing all three edges of the triangle bidirectionally
  (6 relation objects total, 2 per file-pair boundary).
- `08.06.json`: `08.06 → 04.08.03` (Navigation → Cartography and
  Geoinformatics).
- `04.08.json`: `04.08.03 → 08.06` (the reverse direction).

All 6 new entries use `type: "related-concept"`, `source: "curated-xref"`,
`explored: null` — matching the existing convention already in use in each
of these files (verified before writing: `06.05.json`, `10.04.json` and
`04.08.json` already carry `curated-xref`/`related-concept` rows).

## Self-check performed

- `python3 -m json.tool` clean on all 6 edited files.
- `node knowledge/lint.mjs` → clean (`790` seed nodes, delta nodes/files
  count consistent with the wider branch's concurrent edits from other
  deliverables).
- `KEAP_DATA_DIR=<snapshot> node knowledge/ingest.mjs --dry-run --canonical
  knowledge/canonical` → `04.04` applies at "66 nodes, 40 rel" (down from
  82 nodes / 48 rel pre-edit), the 5 xref files apply with their relation
  counts incremented by the 2 new entries each; no errors.
- Repo-wide grep for `04.04.11`/`04.04.12` after the edit: zero hits left in
  `knowledge/canonical/`.
- No new node ids were created by this deliverable (migration-only, per
  spec instruction); ordinal density and parent resolution are therefore
  unaffected — the surviving `04.04.01`–`04.04.10` block is untouched
  byte-for-byte.
