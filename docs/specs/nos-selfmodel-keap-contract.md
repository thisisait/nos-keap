# nOS self-model → KEAP: the contract

Answers to the two questions from the nOS side, verified against the code at
KEAP v1.18.1, plus one trap that changes the shape of the proposal.

Everything below is **what exists today** unless a section says otherwise.

---

## A1 — What `[[02.02]]` actually does

**The chain.** `body` → `extractRefs()` (`server/objects.ts:37`, regex over
`[[…]]` and markdown links) → stored on `knowledge_objects.links` →
`anchorNodeIds()` keeps `kind='node'` → shipped in `/api/graph` as `anchors[]`,
filtered to nodes that resolve (`server/graph.ts:209`).

**It is not an ontological relation.** No `relations` row is written. Anchors are
*placement + membership*, nothing more. (By contrast `[[object:<id>]]` refs DO
become drawn edges — a different layer, now behind the "Links" toggle.)

**What it decides — position, and visibility.**
- Only `anchors[0]` is used. The client groups cards by first anchor and pins each
  in an orbital slot around that star's **baked** coordinate
  (`src/pages/Explore.tsx:359-376`). Remaining anchors are panel/drawer facts.
- `if (!anchor) continue;` — a card with **no** anchor is not rendered in the
  ring/constellation view **at all**. It renders only in the files core. This is
  deliberate: "free-floating dust would break spatial memory."
- A **dangling** anchor (node id that does not exist) is dropped silently, which
  lands the card in the same state as unanchored.

**So: is removing the anchors safe?** Safe for data — nothing is deleted, nothing
orphans, no cascade. But the card *disappears from the constellation view* until
it is anchored somewhere that exists. Two consequences:

1. **Replacement anchoring must land in the same change.** Removing `[[02.02]]`
   without substituting is a visibility regression, not a cleanup.
2. **Order matters: taxonomy nodes must exist BEFORE the cards point at them.**
   Anchor first, ingest nodes second, and every card is silently invisible in
   between.

**Embedding impact of removing the anchor: negligible.** `objectText()` is
`type + title + description + tags + body`, so `[[02.02]]` is embedded as a
meaningless token. The anchor is not what is hurting recall — see A3.

---

## A2 — Position is BAKED LAYOUT, categorically not embedding

`server/layout.ts:bakeLayout()` is deterministic geometry:

```
roots:    angle = (i / categories.length) * 2π,  radius 1400,  z = ±160 lift
children: breadth-first from the parent's position
```

Persisted per node in `taxonomy_layout (node_id, x, y, z, layout_version)`,
served as `x/y/z` in `/api/graph`, and the client **pins** stars to them — only
semantic dust is force-simulated.

Embeddings drive the semantic neighbourhood, the side panel, topic clustering and
R3 candidate recall. They **never** move a taxonomy star.

So "give nOS a position" means *pin a region in the baked layout*. That is real
and controllable — not something to be solved by rewriting text.

---

## ⚠ The trap: do NOT add nOS to the static seed

`ensureLayout()` re-bakes iff `computeLayoutVersion(staticNodes())` changes, and
`bakeLayout` places roots at `angle = i / categories.length`.

**Adding a 13th root to `src/game/data/taxonomy.ts` changes the divisor, so every
existing domain's angle moves.** The whole galaxy rearranges and all spatial
memory — every user's mental map of where things are — is destroyed in one
release. The code comments call a version change "a release-level seed change".

Therefore nOS must be a **delta (ext) root**, never a seed root. Grown nodes are
appended and "must never trigger (or be moved by) a full re-bake."

---

## A3 — Why the current tree hurts recall (confirms your measurement)

`objectText()` embeds `type + title + description + tags + body`. For the nine
stack cards that is: the same title (`_stack.md`), a folder path, and one
near-identical sentence. Nine nearly-identical vectors is a dense artificial
cluster that is close to everything and specific to nothing.

Measured live before the fix: those cards were the top recall hits for *Nuclear
Engineering*, *String Microstate Counting* and *Self-Assembly & Discrete
Supramolecular Architectures*. Two nodes ("Databases", "NoSQL Databases") ate 25
of 50 candidate slots in a sweep.

**Distinct titles and genuinely distinct bodies are the fix, and they are on the
nOS side.** KEAP will not paper over this by de-duplicating display names — that
would hide the signal without repairing the vector.

---

## What KEAP supports today

- **Arbitrary depth under an existing parent.** `id` matches
  `^\d{2}(\.\d{2})*$`, `level` = dot count. So nOS → stacks → systems is three
  levels: `90`, `90.01`, `90.01.01`.
- **Grown nodes via the delta**, `knowledge/canonical/<L0>/<L1>.json` applied by
  `knowledge/ingest.mjs` — idempotent, sha256-marked per file. **This is the only
  import path.** Never `docker exec` into the live DB.
- **Cards anchored to any node**, with per-card visual overrides.
- **Typed relations + moderation + the `/agent/v1/graph` brain endpoint** (R3),
  already carrying 31 confirmed edges.

## What KEAP must still build (my side, not yours)

Exactly two holes, both blocking a first-tier nOS node:

1. **`registerExtNode` cannot create a root.** `server/taxonomy.ts:195`:
   `const parent = nodesById.get(row.parentId); if (!parent) return null;`
2. **`appendExtNodeToLayout` cannot place a root.** `server/layout.ts:152`
   requires `layout.get(ext.parentId)`; a root has no parent, so it gets no
   position — and a node without a position has its cards skipped
   (`star.x === undefined`).

Plan: allow `parentId: null` for ext nodes in a **reserved id range `90`–`99`**
(so a user root can never collide with seed domains `01`–`12`), and give roots an
explicit layout placement that does not disturb the seed ring. Canonical schema +
`lint.mjs` + round-trip follow.

---

## Recommended shape

**Taxonomy (nodes, via the delta):** `nOS (90)` → stack (`90.NN`) → system
(`90.NN.MM`). Three levels, ~10 stacks, ~60 systems.

**Skills (cards, not nodes):** one card per `## skill` heading, anchored to its
system node. Keeps the taxonomy structural and gives the router one embedding per
callable action — the **Trigger:** phrases become query-side anchors directly. One
card per *system* would average 7–11 unrelated actions into a single vector,
which is precisely the failure mode that made `_stack.md` an attractor.

**Your two open items, which KEAP cannot resolve for you:**
- `docs/systems/` covers 22 systems; the live self-model describes 60. The router
  will answer confidently for a third of the estate and be silent for the rest —
  worth deciding whether that is acceptable or whether coverage comes first.
- SKILLS.md targets `dev.local` domains and `~/stacks/...` paths. Routing to
  endpoints that no longer exist is worse than not routing, so that reconcile
  should land before the cards are embedded.
