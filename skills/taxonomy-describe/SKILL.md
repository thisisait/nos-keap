# Skill: taxonomy-describe (K1)

> Track K, skill #1. Runs as an nOS ceremony (librarian agent, on-demand
> Pulse job `describe-taxonomy`). Authored + versioned HERE — the skill is
> itself an OKF-ish document: this file is the instruction set, `contract.json`
> is the I/O schema every run must honor.

## Purpose

Give every taxonomy node a **load-bearing description** in English and Czech.
Descriptions are not decoration: they are the node's search text, embedding
text and the librarian's own judgment context (DescGraph doctrine,
arXiv 2601.01280 — an entity-relation graph with natural-language descriptions
beats every other memory structure). A node without a description is dead
weight: 778 of the 790 seed nodes shipped without one.

## Contract

- **Intake**: `GET /agent/v1/taxonomy/describe/pending?limit=40` (ro token).
  The server decides WHAT needs describing and assembles all context the
  skill may use: `{id, name, path, zone, currentDescription, childNames,
  siblingNames}`. The skill never crawls the tree itself.
- **Output**: `POST /agent/v1/taxonomy/describe` (rw token) with
  `{items: [{nodeId, descriptionEn, descriptionCs, rationale?}]}` —
  max 50 per call, validated against `contract.json`.
- **Governance**: every item lands as a promotions row `kind='desc'`.
  **Nothing writes the tree directly.** The moderator approves in
  Admin › Moderation (bulk approve exists for exactly this skill's volume).
  On approval the override lands in `node_descriptions`, the in-memory tree,
  FTS and the embeddings pending diff — in the same step (consumer-first,
  the llms.txt lesson).
- **Idempotence**: the pending intake already excludes nodes with a curated
  override or an open desc proposal; re-running the skill on an unchanged
  corpus proposes nothing. Refreshing an EXISTING curated description is a
  deliberate re-proposal (different flow), not this skill.

## Writing rules

1. **Describe the concept, not the label.** "Kinematics" must not become
   "The study of kinematics." Say what the node covers, what belongs under
   it, and what distinguishes it from its siblings (`siblingNames` exists
   precisely so descriptions carve boundaries — overlap between siblings is
   what the lint's `overlap-review` later flags).
2. **1–3 sentences, 20–2000 chars.** Dense beats long: the text feeds a
   768-dim embedding, not a textbook.
3. **English is canonical** (embeddings + FTS + hybrid search read it).
   **Czech is the UI localization** — a real translation carrying the same
   boundaries, not a word-by-word calque.
4. **Use the path for scope.** `Natural Sciences > Physics > Kinematics`
   means the description may assume physics context and must not re-explain
   it.
5. **Never invent children.** `childNames` is evidence of what the node
   actually contains; describe the umbrella those children share.
6. **Rationale ≤ 1 sentence** naming the evidence used (children, siblings,
   domain knowledge).

## House style

The corpus reads as ONE reference work — descriptions share a single
grammar and register with the briefs (see skills/taxonomy-brief):

- Encyclopedic register: present tense, active voice, no hedging, no
  meta-language ("This node covers...") — the first sentence names the
  concept and its genus directly ("Kinematics is the geometry of
  motion...").
- Fixed terminology: one term per concept, reused verbatim across nodes;
  siblings use the SAME term for a shared boundary on both sides. Czech
  uses established Czech terminology, never calques.
- No rhetorical questions, no direct reader address, no exclamation marks.

## Batch discipline

- Default batch: 40 nodes per run (one LLM session, one review batch).
- Work top-down: the intake serves nodes in tree order; parents before
  children means later batches can lean on approved parent descriptions.
- The full backlog (~778 nodes) is ~20 runs. The ceremony reports
  `proposed/errors` counts and the remaining total after every run.
