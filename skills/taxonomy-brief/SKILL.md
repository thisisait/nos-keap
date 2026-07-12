# Skill: taxonomy-brief

> Track K, skill #2. Runs as an nOS ceremony (librarian agent, on-demand
> Pulse job `brief-taxonomy`). The node's ARTICLE, where the K1 description
> is its abstract: several explanatory paragraphs with links.

## Purpose

Give every root-taxonomy node a few explanatory paragraphs a human actually
wants to read — what the field is, why it matters, how it relates to its
neighbours — **with links**: `[[node-id]]` cross-references (the vazby that
make the universe navigable) and external `[text](url)` sources. Briefs live
in the curated note layer (`taxonomy_metadata.data.brief`/`briefCs`), so the
embeddings (kind `note`), the agent node detail and the lint consume them
with zero new read paths; the explorer's DetailPanel renders them with
clickable vazby.

## Contract

- **Intake**: `GET /agent/v1/taxonomy/brief/pending?limit=10&maxLevel=N`
  (ro token). Root-first: ordered by level, so the anchor core (levels 0-1,
  107 nodes) is briefed before the depths. Context per node: `{id, name,
  path, zone, level, description (K1), childNames, siblingNames}`.
- **Output**: `POST /agent/v1/taxonomy/brief` (rw token) with
  `{items: [{nodeId, briefEn, briefCs, rationale?}]}` — validated against
  `contract.json`.
- **Governance**: every item lands as a promotions row `kind='brief'`.
  Nothing writes the note layer directly. The moderator bulk-approves in
  Admin › Moderation; approval merges `brief`/`briefCs`/`briefMeta` into the
  node's curated data (attributed to the proposer).
- **Idempotence**: the intake excludes nodes that already carry a brief or
  an open brief proposal.

## Writing rules

1. **2-4 paragraphs, 300-12000 chars (en).** Paragraph one: what the field
   IS and covers. Paragraph two+: how it connects — to its siblings, its
   children, and neighbouring branches. A closing pointer to where to learn
   more.
2. **Vazby are mandatory**: at least one `[[node-id]]` reference (the server
   refuses a brief without one, and refuses unknown ids). Link the nodes a
   reader would genuinely jump to — siblings that share a boundary, children
   that anchor the field's main subfields, cross-branch relatives
   (Biophysics → [[biology branch]]). 2-5 vazby is the sweet spot.
3. **External links**: 1-3 standard markdown links to durable, canonical
   sources (Wikipedia, Stanford Encyclopedia, official docs). No link farms.
4. **Czech (`briefCs`) is a real translation** carrying the same paragraphs,
   vazby and links — not a calque, not a summary.
5. **Build on the K1 description** (served in the intake context) — the
   brief expands the abstract; it must not contradict it.
6. **Never invent structure.** `childNames`/`siblingNames` are the evidence;
   a brief that references non-existent subfields fails the vazba check
   anyway.

## Batch discipline

- Default batch: 10 nodes per run (paragraphs are long; keep the session
  focused). Anchor core = ~11 runs.
- POST in one batch; report per-item errors verbatim; the ceremony reports
  proposed/errors and the remaining total.
