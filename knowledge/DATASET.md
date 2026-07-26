# The KEAP taxonomy — dataset card

What this data **is**, what it covers, where it came from and what it cannot be
trusted for. For how to load, dump and validate it, see `README.md` beside this
file; for the byte-level formats, `_schema/`.

Measured 2026-07-26 against this tree. Every number here is reproducible with
`node knowledge/lint.mjs`.

## In one paragraph

A curated, bilingual (English + Czech) taxonomy of general human knowledge —
**2 040 concept nodes across 12 top-level domains, six depth levels, and 4 492
cross-references** — plus a controlled vocabulary of 16 relation verbs for typed,
moderated edges on top. It is a *navigational scaffold*: a shape for organising
knowledge and hanging real material on, not an encyclopaedia and not an
authority.

**Coverage is very uneven, and that is the first thing to know.** Two domains —
natural and formal sciences — hold 57 % of the nodes. The other ten are the
skeleton with nothing grown on it. See *Domains* below before assuming twelve
domains means twelve domains' worth of content.

## Composition

| | count |
| --- | --- |
| top-level domains | 12 |
| nodes | **2 040** (790 spine + 1 250 extensions) |
| depth levels | 0–5 |
| cross-references | 4 492 |
| relation verbs (controlled) | 16 |
| typed moderated edges | **0** — see *Two relation layers* |
| files | 107 canonical + 12 spine + 1 ontology partition set |
| English descriptions | 2 040 / 2 040 (100 %) |
| Czech descriptions | 1 899 / 2 040 (**93 %**) |

Nodes per level: 12 · 95 · 297 · 724 · 897 · 15. The mass sits at level 4, which
is where a concept becomes specific enough to attach material to.

### Domains — and the coverage you actually get

**Read this table before planning anything against this data.** Two of the twelve
domains hold **57 % of all nodes**; the other ten are the spine only, with no
curated extensions at all.

| id | domain | spine | extensions | total | state |
| --- | --- | --- | --- | --- | --- |
| 01 | Natural sciences | 70 | **741** | **811** | grown |
| 02 | Formal sciences | 135 | **219** | **354** | grown |
| 03 | Applied sciences | 211 | 0 | 211 | scaffold |
| 07 | Practical skills | 81 | 0 | 81 | scaffold |
| 08 | Survival & emergency | 76 | 0 | 76 | scaffold |
| 05 | Humanities | 71 | **56** | **127** | partly grown |
| 06 | Arts | 56 | 0 | 56 | scaffold |
| 04 | Social sciences | 41 | **234** | **275** | partly grown |
| 10 | Cultural preservation | 16 | 0 | 16 | stub |
| 09 | Reference documentation | 11 | 0 | 11 | stub |
| 11 | Digital preservation | 11 | 0 | 11 | stub |
| 12 | Post-disaster rebuilding | 11 | 0 | 11 | stub |

*grown* = the import pipeline ran here · *partly grown* = some branches have
depth, most do not · *scaffold* = named structure, no depth below it · *stub* =
L1 branches only.

**Grown by hand on 2026-07-26**, in four batches: Law (17 subfields on the
public/private and domestic/international divisions rather than any one
jurisdiction), the eight bare Economics branches along JEL field lines,
Geography, Linguistics, Literature, Political science and Sociology — the
secondary-school subjects that were missing. 290 nodes, all bilingual, plus **58
curated cross-domain edges**: geography into the Earth sciences, syntax and
semantics into logic and computer science, civics into law and economics.

Social sciences went from last place to third and the two-domain concentration
fell from 67 % to 57 %. The childless-branch count fell from 55 to 49 — which is
the honest measure of what remains.

This lines up exactly with `_provenance/`: derivation artifacts exist for math,
chemistry, biology, physics and the cross-domain graph — **domains 01 and 02, and
nothing else.** The pipeline that grew the taxonomy was only ever pointed at the
natural and formal sciences.

**49 of the 95 L1 branches (52 %) have no children at all.** The worst affected:

| domain | childless L1s | examples |
| --- | --- | --- |
| Reference documentation | 10 / 10 | all of them |
| Cultural preservation | 9 / 10 | Folklore, Traditions, Traditional recipes, Songs |
| Social sciences | 4 / 10 | Anthropology, Education, Demography, Archaeology |
| Humanities | 6 / 10 | Religious studies, Cultural studies, Classics, Media studies |
| Applied sciences | 4 / 10 | Architecture, Telecommunications, Biotechnology, Nanotechnology |
| Digital preservation | 4 / 5 | Compression, Encryption, Backup, Data recovery |
| Post-disaster rebuilding | 4 / 5 | Tool making, Essential chemistry, Basic medicine |

Only Natural sciences has none.

Domains 08–12 are deliberate additions: the taxonomy was grown for an offline,
knowledge-preservation context, so it carries branches most general taxonomies do
not. That they are stubs is a matter of effort, not intent.

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
- **Complete or balanced.** Two domains hold 57 % of the nodes and seven have no
  curated depth at all; 52 % of L1 branches are childless. In practice this is a
  **detailed physics/chemistry/biology and mathematics taxonomy with a
  twelve-domain skeleton around it** — not a general one. If your subject is not
  a natural or formal science, expect to find the branch named and empty.
- **A basis for training without correcting for that skew.** An embedding space
  fitted to this corpus as it stands learns the shape of physics and mathematics
  and treats the other ten domains as sparse noise. Rebalance, reweight, or grow
  the corpus first — do not discover this in the loss curve.
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
