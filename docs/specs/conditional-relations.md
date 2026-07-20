# Conditional relations (R4) — roadmap

Status: **design, not built.** Nothing here is implemented.

## The shape of the problem

The motivating case, from the legislation map:

> `citizen` —performs→ `driving a car`, and that edge holds **only if**
> `citizen` —has-been-issued→ `driving licence`.

The condition is not a property of either endpoint. It is a statement **about an
edge**, whose truth depends on **another edge**. Today's model cannot say it:
`relations` endpoints are `node | object`, so an edge can never be an endpoint.

## Why reification, and why it is cheap here

A relation row is already identified by `id = hash(from_ref|to_ref|type)` — every
edge **already has a stable name**. Making an edge addressable is therefore mostly
a typing change, not a new storage model:

```
kind: 'node' | 'object' | 'relation'

(citizen —performs→ driving)  —conditioned-on→  (citizen —has-issued→ licence)
└──────────── relation id ────┘                 └────────── relation id ────────┘
```

The alternative — a `condition_ref` column on the row — allows exactly one
condition per edge and cannot express disjunction or a condition on a condition.
Reification costs one enum value and gets the general case.

## Concept level, not instance level

KEAP's taxonomy holds *concepts*, not individuals: `citizen` is a class, not a
person. So a conditional edge is automatically a **rule** ("driving requires a
licence"), never a claim about a named human. That removes the need for
instance-level machinery, quantifiers, or a rules engine — and it is also the
boundary to defend: the moment someone wants "does *Pázny* hold a licence", that
is operational data and does not belong in the concept graph.

## Four things that break, and must be decided first

1. **The cross-type guard is violated by construction.** R3 enforces
   `from_kind !== to_kind` on every stored edge (`server/agent.ts:431`,
   `server/relations.ts`), deliberately — it is what keeps the classifier from
   inventing node↔node noise. A `relation → relation` edge is same-kind. The
   conditional layer therefore needs an explicit exemption keyed on the verb's
   scope, not a relaxation of the guard. Relaxing it globally would re-open the
   hole the guard was added to close.

2. **The vocabulary splits in two.** `exemplifies` relates entities;
   `conditioned-on` relates statements. Mixing them in one registry means the R3
   classifier would be offered a meta-verb for an entity pair it can never apply
   correctly. `relation_types` needs a `scope: 'entity' | 'meta'`, and the
   candidate endpoint must only offer entity verbs.

3. **Referential integrity.** A condition pointing at an edge that is later
   rejected or deleted must not silently become vacuous — a rule that quietly
   stops constraining anything is worse than no rule. Minimum: a rejected target
   invalidates the conditional; the graph must never ship a condition whose
   target does not resolve (the same rule `graph.ts:209` already applies to
   dangling anchors).

4. **Geometry has no answer, and does not need one.** An edge-to-edge line has no
   natural position. But re-reading the motivating description — *"click 'driving
   a car' and the graph highlights the relations with their verbs"* — the ask is
   **traversal on demand**, not persistent geometry. Conditions should light up a
   path on click and live in the side panel's ontology section; they should not
   be baked into the static scene. That is both easier and closer to what was
   actually asked for.

## Where the producer comes from

R3's classifier only emits cross-type `object ↔ node` edges from vector recall.
It cannot produce conditionals: proximity in embedding space does not imply a
dependency between two statements. Conditionals come from **reading a source**
(a statute, a runbook) — a different host-side job with a different prompt, and
almost certainly a lower auto-confidence and a stricter moderation default.

## The near-term payoff: the skill router

This is not only a legislation feature. `docs/systems/*/SKILLS.md` already
declares preconditions in prose:

```
## upload-file
**Method:** WebDAV
- **Token:** `~/agents/tokens/nextcloud.token`
```

As a conditional that becomes queryable:

```
(agent —can-run→ upload-file) —conditioned-on→ (agent —holds→ nextcloud-credential)
```

Which turns "find me a skill for uploading a file" into **"find me a skill for
uploading a file that I can actually run right now"** — the difference between a
semantic index and a router. The precondition data already exists; today it is
unstructured prose inside a card body.

## Suggested staging

1. `scope` on `relation_types`; candidate endpoint offers entity verbs only.
   (Small, and independently useful — it hardens the R3 vocabulary today.)
2. `kind: 'relation'` in storage + integrity rules + brain-endpoint exposure.
3. Panel: conditions in the ontology section, click-to-trace highlighting.
4. A conditional producer for one narrow corpus (skills preconditions), measured
   before anything is pointed at legislation.
