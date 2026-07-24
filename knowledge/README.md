# knowledge/ — the git source of truth for the KEAP taxonomy delta

The live KEAP graph = a **static seed spine** (`src/game/data/taxonomy.ts`, the
hardcoded L0-2 structure) + a **curated delta** on top (grown nodes, description
overrides, briefs, typed relations). This folder is the git SoT for that delta:
the `pazny.keap` nOS role populates the live DB *from here*, idempotently, on
every playbook run and on a blank — never by a hand-run `docker exec`.

```
knowledge/
  canonical/<L0>/<L1>.json   # THE SoT — one file per L1 domain (Physics, Math, …):
                             #   nodes (ext + seed-description-overrides) + relations
  ontology/                  # THE SoT for the R3 layer (see below)
    relation-types.json      #   the controlled verb registry, incl. moderated growth
    relations/<L0>.json      #   typed edges + their moderation verdict + provenance
  ingest.mjs                 # git → live DB, idempotent (per-file sha256 marker in
                             #   knowledge_imports; --dry-run). The single import path.
  dump.mjs                   # live DB → canonical + ontology (the inverse; NEVER host sqlite3)
  lint.mjs                   # validate canonical + ontology (schema, house-style, no Cyrillic)
  roundtrip.mjs              # CI gate: ingest → dump → diff == 0 (proven inverses)
  ontology-sot.test.ts       # the ontology round-trip on SYNTHETIC data (roundtrip.mjs
                             #   can only gate shapes the repo's files contain)
  _ontology.mjs              # shared partition/identity rules — the one definition of
                             #   which file owns which edge
  _schema/                   # canonical + ontology format spec (what lint enforces)
  _provenance/               # pre-dump derivation artifacts (history, NOT the SoT)
```

## The ontology layer (added 2026-07-24)

`relations` + `relation_types` — the moderated typed knowledge graph — had **no
git SoT** until now. They lived only in the container volume, so when the live
data directory was replaced on 2026-07-22 the entire moderated relation set went
with it. Nothing noticed for two days: every other layer rebuilt itself from its
source, so the corpus *looked* healthy. Moderation verdicts are human work; they
belong in version control, where they can also be reviewed in a diff.

Two things make this layer's rules differ from the canonical layer above:

- **Additive upsert, never wipe-then-insert.** `relations` has TWO writers — this
  importer and the live agent surface (the host-side classifier proposes edges,
  admins moderate them). Wiping a partition before inserting would delete every
  edge proposed since the last dump. Nothing is lost by never deleting: a derived
  edge is never hard-deleted anywhere in the system (the only `DELETE FROM
  relations` is the ToE mirror rebuild, scoped to `source='toe'`), because
  removal is expressed as `status='rejected'` — and a rejected row restored from
  git *also* stops the classifier re-proposing that pair after a rebuild.
- **`source='toe'` is never dumped here.** Those rows are a boot-time mirror of
  `concept_relations`, which `canonical/` already versions. Carrying them twice
  would create two sources of truth for one edge, free to drift apart.

**Order of operations matters:** `dump` before you hand-edit. Git wins on
re-ingest, so a stale file re-applies a stale moderation verdict — the importer
reports every such overwrite under `ontology.statusConflicts` in its
`INGEST_RESULT` trailer rather than doing it quietly, but the way to not need
that warning is to dump first.

## Contracts
- **In-container only.** `ingest`/`dump` use the libSQL driver; **never run host
  `sqlite3` against the live keap DB** (it corrupts the vector-indexed libSQL file).
- **Round-trip identity.** `ingest ∘ dump = identity` on content — CI-gated by
  `roundtrip.mjs`. Descriptions are stored VERBATIM (no clipping) to preserve it.
  The ontology layer is compared as raw file BYTES, not as a parsed field list:
  every field there is provenance, so "identical except for the column we forgot
  to compare" is not a pass.
- **One definition of ownership.** Which partition file owns a given edge is
  computed by `_ontology.mjs` and imported by dump, ingest and lint alike. If
  those three could disagree by one row, ingest would reset a file dump never
  wrote to — lint fails a misplaced row for exactly this reason.
- **Idempotent + version-driven.** A domain file is re-applied only when its sha256
  changed; a blank DB applies everything. Materialisation needs a container restart
  (boot: registerExtNode → applyDescriptionOverride → rebuildFts → ensureLayout
  APPEND — U1 layout of existing stars never re-bakes).

Full design: `docs/plans/keap-knowledge-ingest-pipeline.md` (in the nOS repo).
