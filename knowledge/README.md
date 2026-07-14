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
  ingest.mjs                 # git → live DB, idempotent (per-file sha256 marker in
                             #   knowledge_imports; --dry-run). The single import path.
  dump.mjs                   # live DB → canonical (the inverse; NEVER host sqlite3)
  lint.mjs                   # validate canonical (schema, house-style, no Cyrillic)
  roundtrip.mjs              # CI gate: ingest → dump → diff == 0 (proven inverses)
  _schema/                   # canonical format spec (what lint enforces)
  _provenance/               # pre-dump derivation artifacts (history, NOT the SoT)
```

## Contracts
- **In-container only.** `ingest`/`dump` use the libSQL driver; **never run host
  `sqlite3` against the live keap DB** (it corrupts the vector-indexed libSQL file).
- **Round-trip identity.** `ingest ∘ dump = identity` on content — CI-gated by
  `roundtrip.mjs`. Descriptions are stored VERBATIM (no clipping) to preserve it.
- **Idempotent + version-driven.** A domain file is re-applied only when its sha256
  changed; a blank DB applies everything. Materialisation needs a container restart
  (boot: registerExtNode → applyDescriptionOverride → rebuildFts → ensureLayout
  APPEND — U1 layout of existing stars never re-bakes).

Full design: `docs/plans/keap-knowledge-ingest-pipeline.md` (in the nOS repo).
