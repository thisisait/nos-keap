# _provenance/ — historical derivation artifacts (NOT the source of truth)

These are the per-domain files from the **pre-dump import pipeline** that first
grew each domain into the taxonomy. They are kept for history and reproducibility
of *how* a domain was built — they are **superseded by `knowledge/canonical/`**,
which is the live SoT (a faithful dump of the current curated state, including
every later curation these files don't capture).

Do not ingest from here. `knowledge/ingest.mjs` reads `canonical/` only.

```
_provenance/<domain>/
  <domain>-scaffold.json   # the ontology scaffold (skeleton)
  <domain>-blocks.json     # agent-consolidated thematic blocks
  <domain>-import.json     # the materialisable bundle import-domain.mjs consumed
```

- **math / chem / bio** carry the full `scaffold → blocks → import` derivation triple.
- **toe** carries its source graph (`toe-concept-graph.json`) + consolidated blocks.
- **physics** carries only the 8 `phys-*-import.json` bundles — the fable ontology
  pass authored import bundles directly (no separate scaffold/blocks stage), so its
  provenance is thinner by history, not by omission.
