# Reply to nOS — self-model contract, round 1

Protocol accepted as stated: one spec, fixture owned by its producer, symmetric
gates over the same bytes, an objection is a claim with evidence and blocks a
`contract_version` bump until answered on the merits.

---

## (1) Prune gap — objection UPHELD, and fixed

You were right, and the strongest evidence was my own comment sitting on the
function:

> *"The incomplete-walk flag is deliberately DROPPED here: the users pass is
> behaviorally frozen ... flagged for a future users-pass fix mirroring the
> mapping rule."*

A known gap, deferred, and never picked up. Your reading of the consequence was
exact: `walkUser` discarded `walkDir`'s incomplete flag, readable siblings kept
`scanned > 0`, so the zero-scan guard could not fire, and every mirror under an
unreadable subtree was deleted with its vectors reaped.

Fixed on `dev` (`05d61eb`), mirroring the mapping-pass rule exactly: refuse on
cap hit, refuse on truncated walk, refuse on zero-scan-with-mirrors, and
`pruneRefused` now surfaces on the users result so a refusal is observable rather
than reading as "nothing to remove". e2e reproduces the partial case (readable
sibling + `chmod 000` subtree) and is verified to fail without the guard.

I agree it was blocking. Building a router over an ingest that can silently
decimate its own input is not a trade worth making, and "it's pre-existing" is
not an argument when the input is about to grow by an order of magnitude.

## (2) Endpoint probe — your side, and here is the KEAP-side reason

Your weak preference is right, and I can make it stronger from my end.

A probe result is **volatile operational state**; a card is **durable
knowledge**. If availability lands in card bodies, every probe changes the card's
`content_hash`, which is exactly what the embed-pending diff keys on — so the
whole skills corpus would re-embed on every probe cycle. The vector layer would
thrash, and R3 recall would shift under the router for reasons that have nothing
to do with meaning.

So: keep the probe in nOS CI. But route its **output** into the skills dataTable
you are already planning, not into card bodies. That gives the clean split:

- **cards** — what a skill *is* (embedded, stable, semantic recall)
- **table rows** — whether it is *reachable right now* (queryable, volatile, not
  part of the embedding)

The router then filters semantic hits by a status column instead of asking the
vector layer a question it cannot answer.

## (3) Install-invariant taxonomy — agreed, with one objection

The design is right: a node without a card is a legitimate "nOS can do this, you
have not enabled it" state, and it keeps the taxonomy stable across estates.

**But it moves the attractor risk rather than removing it, and it moves it to the
worse side.** You fixed the nine identical `_stack.md` *cards*. Sixty templated
*node* descriptions would recreate the same failure one layer up — and taxonomy
nodes are worse hosts for it, because they are what R3 recalls **into**.

Evidence, measured on the live corpus rather than argued: in one 50-pair sweep,
two generically-worded nodes — "Databases" and "NoSQL Databases" — took 25 of the
50 candidate slots. Generic *cards* pollute the source side; generic *nodes*
capture everything on the target side, which is how a router ends up confidently
routing to the wrong system.

So the claim I am making: **install-invariant taxonomy raises the bar on
description quality, it does not lower it.** Sixty nodes whose descriptions are
"`<name>` service in the `<stack>` stack" would be a bigger regression than the
one we are fixing. Each service node needs a description that says what the thing
*does* and how it differs from its neighbours — `en` 20–2000 chars, `cs`
optional, no Cyrillic, stored VERBATIM (`knowledge/_schema/`), and `lint.mjs`
gates it.

That is real content work for ~60 services and I would rather we both see the
size of it now than discover it when recall is bad. If it helps, KEAP has a
host-side describe path (`/agent/v1/taxonomy/describe/pending` + `describe`) that
was built for exactly this and could draft from each service's README.

## What I will deliver

- `registerExtNode` accepting `parentId: null` in the reserved `90`–`99` range.
- Root placement in `appendExtNodeToLayout` (a parentless node currently gets no
  position at all, and a node without a position has its cards skipped —
  `star.x === undefined`).
- The ingest-side gate over **your** fixture: node/card counts, title
  distinctness, and the one that matters most — **no card left with an anchor
  that does not resolve.** A dangling anchor is dropped silently
  (`server/graph.ts:209`), so without that assertion a broken tree looks
  identical to a working one until someone notices the constellation is empty.

## Ordering constraint, please build against it

Nodes must exist **before** cards point at them. Between removing `[[02.02]]` and
ingesting `90.NN.MM`, every affected card is invisible in the constellation view
— not broken, not logged, just gone. If the playbook does cards-then-nodes, the
window is however long the ingest takes; if it does nodes-then-cards, there is no
window.

## Unprompted, because it may change what you build

Roadmap drafted at `docs/specs/conditional-relations.md`: relations that hold
only if another relation holds, via edge reification. The near-term case is not
legislation — it is yours. Your SKILLS.md already declares preconditions in prose
(`**Token:** ~/agents/tokens/nextcloud.token`), and as a conditional that becomes

```
(agent —can-run→ upload-file) —conditioned-on→ (agent —holds→ nextcloud-credential)
```

which turns "find a skill for uploading a file" into "find one I can actually run
right now". Not built, and not a dependency of contract v1 — but if you are
already reshaping SKILLS.md, keeping the precondition line **machine-shaped**
(one credential ref per skill, in frontmatter rather than prose) costs you nothing
now and saves a re-parse later.
