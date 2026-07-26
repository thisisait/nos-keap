# The KEAP taxonomy — dataset card

What this data **is**, what it covers, where it came from and what it cannot be
trusted for. For how to load, dump and validate it, see `README.md` beside this
file; for the byte-level formats, `_schema/`.

Measured 2026-07-26 against this tree. Every number here is reproducible with
`node knowledge/lint.mjs`.

## In one paragraph

A curated, bilingual (English + Czech) taxonomy of general human knowledge —
**2 393 concept nodes across 12 top-level domains, six depth levels, and 4 643
cross-references** — plus a controlled vocabulary of 16 relation verbs for typed,
moderated edges on top. It is a *navigational scaffold*: a shape for organising
knowledge and hanging real material on, not an encyclopaedia and not an
authority.

**Every named branch now has content.** As of 2026-07-26 all 95 first-level
branches have children; the figure was 55 empty that morning. Depth is still very
uneven — see *Domains* — but nothing is a bare label any more.

## Composition

| | count |
| --- | --- |
| top-level domains | 12 |
| nodes | **2 393** (790 spine + 1 603 extensions) |
| depth levels | 0–5 |
| cross-references | 4 643, of which **209 are hand-curated cross-domain edges** |
| relation verbs (controlled) | 16 |
| typed moderated edges | **0** — see *Two relation layers* |
| first-level branches with no children | **0** (was 55) |
| English descriptions | 2 393 / 2 393 (100 %) |
| Czech descriptions | 2 245 / 2 393 (**94 %**) |

Nodes per level: 12 · 95 · 527 · 847 · 897 · 15.

### Domains — and the coverage you actually get

**Read this before planning anything against this data.** Coverage is complete in
breadth and very uneven in depth. Two domains hold **51 %** of all nodes; that is
down from 67 % but it is still the dominant fact about this corpus.

| id | domain | spine | extensions | total |
| --- | --- | --- | --- | --- |
| 01 | Natural sciences | 70 | 741 | **811** |
| 02 | Formal sciences | 135 | 270 | **405** |
| 04 | Social sciences | 41 | 275 | **316** |
| 03 | Applied sciences | 211 | 48 | **259** |
| 05 | Humanities | 71 | 111 | **182** |
| 07 | Practical skills | 81 | 9 | 90 |
| 08 | Survival & emergency | 76 | 12 | 88 |
| 09 | Reference documentation | 11 | 63 | 74 |
| 06 | Arts | 56 | 5 | 61 |
| 10 | Cultural preservation | 16 | 37 | 53 |
| 11 | Digital preservation | 11 | 16 | 27 |
| 12 | Post-disaster rebuilding | 11 | 16 | 27 |

**What that means in practice.** Physics, chemistry, biology and mathematics are
detailed to four and five levels — hundreds of nodes each, from the original
import pipeline. Everything else is a correct two-or-three-level structure: the
subfields of a discipline are named and described, but you will not find the
individual concepts inside them. A query about *thermodynamic potentials* lands
on a node; a query about *the Coase theorem* lands on Law and Economics but not
on the theorem.

`_provenance/` shows why: derivation artifacts exist for math, chemistry,
biology, physics and the cross-domain graph — domains 01 and 02, and nothing
else. The pipeline that grew the taxonomy in depth was only ever pointed at the
natural and formal sciences. The rest was written by hand on 2026-07-26.

### How the rest was grown

Eight batches in four waves, all bilingual, all `ext` nodes leaving the seed
spine untouched:

- **Connective concepts** — information theory, systems theory, measurement and
  metrology, philosophy of science, knowledge organisation. These went first
  because everything else links into them.
- **Missing disciplines** — public health and epidemiology, sports science,
  veterinary science, accounting, management, communication and rhetoric. Six
  fields the corpus did not contain at all.
- **Empty core branches** — anthropology, education, demography, archaeology,
  religious and cultural studies, classics, gender and ethnic studies,
  architecture, telecommunications, biotechnology, nanotechnology.
- **The preservation domains** — reference works, dictionaries, manuals, maps,
  tables, protocols, schematics, patents, archives; folklore, custom, foodways,
  song, ritual and craft; compression, encryption, backup and recovery;
  tool-making, field chemistry, basic medicine and community organisation.

Placement note: none of these got a new first-level branch. All twelve domains
already use their L1 slots, the seed spine is deliberately stable, and `ext`
nodes are the designed mechanism for growth beyond it. Where the fit is
imperfect — accounting and management under Economics, sports science under
Medicine — the node says so in its own description rather than pretending.

### The 209 curated edges

Until this point the corpus had **no hand-made links between domains**. All 4 434
existing relations are within-domain artefacts of how each was grown, which meant
twelve taxonomies rather than one.

The new edges are marked `source: curated-xref` and connect, among others:
geomorphology to geology and hazards to seismology; syntax and semantics to
formal languages and logic; civics to law and economics; entropy to statistical
mechanics and to compression; systems theory to physiology, ecology and control
engineering; measurement to the philosophy of science; knowledge organisation to
lexical semantics and databases.

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
- **Uniformly deep.** Breadth is complete — every branch has content — but two
  domains still hold 51 % of the nodes. Outside the natural and formal sciences
  you get a correct structure of named subfields, not the concepts inside them.
  Check the depth of your area before assuming coverage.
- **A basis for training without correcting for that skew.** An embedding space
  fitted to this corpus as it stands over-represents physics and mathematics by
  roughly an order of magnitude relative to every other domain. Reweight or grow
  first — do not discover this in the loss curve.
- **Uniformly bilingual.** 6 % of nodes have no Czech description.
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
