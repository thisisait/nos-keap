# The KEAP taxonomy — dataset card

What this data **is**, what it covers, where it came from and what it cannot be
trusted for. For how to load, dump and validate it, see `README.md` beside this
file; for the byte-level formats, `_schema/`.

Measured 2026-07-26 against this tree. Every number here is reproducible with
`node knowledge/lint.mjs`.

## In one paragraph

A curated, bilingual (English + Czech) taxonomy of general human knowledge —
**1 750 concept nodes across 12 top-level domains, six depth levels, and 4 434
cross-references** — plus a controlled vocabulary of 16 relation verbs for typed,
moderated edges on top. It is a *navigational scaffold*: a shape for organising
knowledge and hanging real material on, not an encyclopaedia and not an
authority.

## Composition

| | count |
| --- | --- |
| top-level domains | 12 |
| nodes | **1 750** (790 spine + 960 extensions) |
| depth levels | 0–5 |
| cross-references | 4 434 |
| relation verbs (controlled) | 16 |
| typed moderated edges | **0** — see *Two relation layers* |
| files | 107 canonical + 12 spine + 1 ontology partition set |
| English descriptions | 1 750 / 1 750 (100 %) |
| Czech descriptions | 1 609 / 1 750 (**92 %**) |

Nodes per level: 12 · 95 · 255 · 476 · 897 · 15. The mass sits at level 4, which
is where a concept becomes specific enough to attach material to.

### Domains

| id | domain | spine nodes |
| --- | --- | --- |
| 01 | Natural sciences | 70 |
| 02 | Formal sciences | 135 |
| 03 | Applied sciences | 211 |
| 04 | Social sciences | 41 |
| 05 | Humanities | 71 |
| 06 | Arts | 56 |
| 07 | Practical skills | 81 |
| 08 | Survival & emergency | 76 |
| 09 | Reference documentation | 11 |
| 10 | Cultural preservation | 16 |
| 11 | Digital preservation | 11 |
| 12 | Post-disaster rebuilding | 11 |

Domains 08–12 are deliberate: the taxonomy was grown for an offline,
knowledge-preservation context, so it carries branches most general taxonomies
do not.

## Structure

Two layers that compose into one tree:

- **The spine** (`spine/`, 790 nodes) — the stable skeleton, levels 0–2. Renders
  to `src/game/data/taxonomy.ts` as a generated artifact, CI-gated.
- **The delta** (`canonical/`, 1 750 nodes across 107 files) — one file per L1
  domain. Two node kinds: `seed-override` (790, a curated description replacing
  the spine's) and `ext` (960, nodes that exist only here).

Their composition is pinned by a content hash, `onto1:<sha256-16>`, over a
canonical serialisation of the composed tree plus the live relation verbs. Two
independent implementations must produce it byte-identically; six conformance
fixtures are the grading line (`onto1-conformance.mjs`).

### Two relation layers, two vocabularies

This trips people up, so it is stated plainly:

| layer | table | edges | vocabulary |
| --- | --- | --- | --- |
| **concept cross-references** | `concept_relations` | 4 434 | `references` (2 203), `related-concept` (730), `shared-structure` (725), `shared-math` (540), `conjecture` (103), `limit` (62), `duality` (58), `conflict` (13) |
| **typed moderated graph (R3)** | `relations` | **0** | the 16 controlled verbs in `ontology/relation-types.json` |

The first came out of the import pipeline and is versioned inside
`canonical/*.json`. The second is the moderated layer — every edge carries a
human verdict (`proposed` / `confirmed` / `rejected`) and provenance — and is
**currently empty**: the verb registry is seeded, no edges have been confirmed.
A consumer wanting semantic edges today has the first layer only.

The two vocabularies overlap on `duality` and `related-concept` and are otherwise
disjoint. Unifying them is unscheduled.

## Provenance

`_provenance/` keeps the derivation artifacts for each domain —
`scaffold → blocks → import` for math, chemistry and biology; a source concept
graph for the cross-domain layer; direct import bundles for physics. They are
**history, not source**: `ingest.mjs` reads `canonical/` only, and every later
curation lives there rather than in the provenance files.

**Descriptions are LLM-authored and then human-curated.** The domains were grown
by agent passes that scaffolded a skeleton, consolidated thematic blocks and
authored bundles; moderation and correction happened afterwards, in the canonical
layer. This is the most important thing to know about the data and it is why the
next section exists.

## Intended use, and what it is not

**Use it as** a scaffold — an addressable, stable set of concept ids to anchor
your own material against; a navigation structure; a vocabulary for typed
relations; a test corpus for retrieval systems.

**Do not use it as**:

- **An authority.** Descriptions are model-authored prose with human review, not
  sourced encyclopaedia entries. There are no citations. Treat a description as a
  *disambiguating gloss* — enough to tell two sibling concepts apart — not as a
  fact to act on.
- **Complete or balanced.** Applied sciences has 211 spine nodes and social
  sciences 41. That reflects how the domains were grown, not their relative
  importance.
- **Uniformly bilingual.** 8 % of nodes have no Czech description.
- **A semantic graph.** The moderated typed layer is empty.

## Weights — planned, not present

The long-term artefact is this taxonomy **plus trained embedding weights** over a
compression language, versioned together. None of it exists yet.

The mechanism is designed: weights get an `emb1:<hash>` stamp beside the existing
`onto1:<hash>`, and an embedding is valid only while **both** hold — weights are
meaningless apart from the vocabulary they were trained on. Published weights go
in git-LFS so a clone resolves them without access to anything private; training
checkpoints stay in the estate's object store.

Design: nOS `docs/plans/cortex-self-core.md` §4.

## Licensing — unresolved, and it blocks publication

**This repository carries no LICENSE file and `package.json` declares no
license.** By default that means all rights reserved: nobody can legally reuse,
redistribute or build on this data, which is incompatible with the stated goal of
a community-extended artefact.

It needs two decisions, and they are not the same one:

1. **The data.** Dataset licensing conventions differ from software — CC0,
   CC-BY, CC-BY-SA and ODbL all say materially different things about whether
   derived taxonomies must come back.
2. **The code** that reads and validates it.

Neither is decided here. Until they are, the repo is publishable in the technical
sense and not in the legal one.

## Consuming it

The files are plain JSON and need nothing from this repo to read. The tooling
beside them (`ingest.mjs`, `dump.mjs`, `lint.mjs`, `roundtrip.mjs`) exists for
round-trip fidelity into a live store — see `README.md`.

Round-trip identity is CI-gated: `ingest ∘ dump = identity` on content, with the
ontology layer compared as raw bytes rather than parsed fields, because every
field there is provenance.
