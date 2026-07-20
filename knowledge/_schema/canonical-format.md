# Canonical format spec (`knowledge/canonical/<L0>/<L1>.json`)

One file per L1 domain. `lint.mjs` enforces this contract; `roundtrip.mjs` proves
`ingest`/`dump` round-trip it losslessly.

```jsonc
{
  "domain": "01.01",                 // the L1 id this file owns
  "nodes": [
    {
      "id": "01.01.03.01.01",        // numeric (seed spine) OR slug (`nos.infra.postgresql`)
      "level": 4,
      "kind": "ext",                 // "ext" = grown node | "seed-override" = K1 desc on a seed node
      "parentId": "01.01.03.01",     // ext only: strict prefix of id
      "name": "Zeroth Law & Temperature", // ext only
      "zone": "votable",             // ext only: votable | free | anchor
      "ordinal": 0,                  // ext only: sibling order (feeds U1 layout append)
      "en": "…canonical English description…",   // required, 20–2000 chars, VERBATIM
      "cs": "…flawless Czech mirror…",           // optional; no Cyrillic; ≤2000
      "brief": "…markdown body (### Concepts …) …" // optional; stored raw
    }
  ],
  "relations": [
    { "from": "01.01.11.01.01", "to": "01.01.11.01.02", "type": "related-concept",
      "explored": null, "source": "toe" }   // keyed by the `from` node's L1 file
  ]
}
```

## Rules (lint gates)
- `id` matches **either** form (`lint.mjs` `ID_RE`); `level` == dot count in both:
  - **numeric** `^\d{2}(\.\d{2})*$` — the seed spine (`01`…`12` and below).
  - **slug** `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$` — user subtrees, e.g. `nos`,
    `nos.infra`, `nos.infra.postgresql`. A slug id names the *thing*, so inserting
    a sibling renumbers nothing. This replaced the reserved numeric-root scheme
    (`90`–`99`), which encoded position and is cancelled — do not write it.
- `kind` ∈ {`ext`, `seed-override`}. `ext` nodes carry `parentId` (= id minus last
  segment), `name`, `zone`, integer `ordinal`. `seed-override` carries only the
  description layer (id/en/cs/brief) — it edits a seed node's text, not its structure.
- `en` required, 20–2000; `cs` optional, ≤2000; **no Cyrillic** in `en`/`cs`.
- `id` globally unique across all files; an `ext` parent under a grown root must resolve.
- Descriptions are VERBATIM (no whitespace-normalise / clip) — round-trip identity.
