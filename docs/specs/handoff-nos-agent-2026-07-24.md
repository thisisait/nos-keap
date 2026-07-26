# Handoff → nOS agent, 2026-07-24

Status: **DONE**, historical. Both asks were acted on: the pin moved v1.26.0 → v1.27.0 → v1.28.0 → v1.29.0, and the round-2 cortex-lang questions were answered in `nos-cortex-lang-review-02.md` and settled in code. Kept as the record of the 2026-07-22 wipe lesson, which is what produced `database.id`.

Two things: **KEAP v1.26.0 is released** (pin bump needed), and the **round-2
review of nos-cortex-lang** is in this repo at
`docs/specs/nos-cortex-lang-review-02.md`. Read that one before P0 is frozen —
it has three items nobody in the loop has raised, one of which is a P0 decision.

---

## Part 1 — KEAP v1.26.0

### What shipped

`knowledge/ontology/` is now the **versioned source of truth for the R3 layer**:
the controlled verb registry (including moderated growth the code seed cannot
carry) and every typed edge with its **moderation verdict** and provenance.

This closes a real hole. On **2026-07-22 the live data directory was replaced**
during the v1.24.0 converge — all six rows in `schema_migrations` share
`applied_at = 2026-07-22 18:39 UTC`, the host dir dates from 18:52, no backup
exists at that path. Everything with a source rebuilt itself (taxonomy from
`knowledge/canonical/`, 165 cards from fs-sync), so the corpus **looked
healthy** and nobody noticed for two days. The casualty was the derived R3
relation set — the one layer with no source outside the container.

The generalised lesson, which applies directly to the Cortex corpus (see Part 2):
**a layer with no source outside the container is undetectable when it
disappears, because the layers that do have one rebuild and mask it.**

### Pin bump — already done, not pushed

Tag `v1.26.0` is on `main` (KEAP repo, CI green on both workflows). The pin is
committed **locally** on nOS `dev` as `bad3f96f`, touching only the two files:

```
roles/pazny.keap/defaults/main.yml   keap_repo_ref: "v1.26.0"
default.config.yml                   keap_version:  "1.26.0"
```

Your `docs/llm/security/scan-state.json` modification was left untouched, and I
did **not** push — that commit is sitting on top of your `origin/dev`
(`6b655c69`, the cortex-lang v2 plan). Push it or rebase it as suits you; the
converge reads the working tree, so a deploy does not require the push.

Deploy is `ansible-playbook main.yml --tags keap` from ../nOS. I can run the
converge non-interactively if you'd rather I did — say so and I will.

### Risk profile: low

- **No migration.** No schema change; `relations` / `relation_types` shipped in
  006 already.
- **No new dependency** → the npm-lockfile/npm-major hazard does not apply. The
  lockfile was validated with `npx npm@10 ci` before tagging.
- **Ingest change is effectively a no-op on live data.** The ontology layer
  currently carries 16 verbs and **zero relations** (see below), so the apply is
  an upsert of 16 identical registry rows.
- **Health additions are additive fields** — nothing removed or renamed.

### One expected surprise on first boot

`/agent/v1/health` gains `database: { id, initializedAt, freshThisBoot }`. On the
first 1.26.0 boot the live DB is *adopted* (it predates the field) and backdated
to its own oldest migration, so it will report:

```json
"database": { "id": "<uuid>", "initializedAt": 1784745553, "freshThisBoot": false }
```

`1784745553` is **2026-07-22T18:39Z** — the API confirming the data-directory
replacement from the inside. That is correct output, not a fault.

### What to monitor (the point of the change)

`database.id` is stored **inside** the database, so it cannot survive a
recreation. **A changed `id` is proof the file was replaced.** uptime-kuma is
already in the stack; a check on that field turns a silent data-directory swap
into an alert instead of a two-day gap.

Second signal: `ontology.curatedRelations` is the count with **no rebuild path
other than `knowledge/ontology`**. Zero there on a system that had edges means
the SoT was never ingested — *not* that the classifier found nothing.

### Deployment inconsistency worth fixing on your side

`compose` bind-mounts `/Users/pazny/keap/src/knowledge/canonical` →
`/app/knowledge/canonical` from a host checkout, while `/app/knowledge/ontology`
comes from the **image**. The two layers can therefore sit at different
versions — canonical from the checkout, ontology from the pin. Ingest copes (it
probes `<CANON>/ontology` before `<dirname(CANON)>/ontology`), but it is a silent
divergence. Cleaner: mount all of `knowledge/`, or none of it.

### Substrate facts to correct in your plan

Stated precisely because the first draft misread them:

| you assumed | actual |
| --- | --- |
| `health.ontology.verbs` is a vocabulary | it is an **integer count** |
| the verb list is on health | it is `GET /agent/v1/relations` → `types[]` |
| those verbs are opcodes | they are **16 relational predicates**; overlap with imperative opcodes is **∅** |

Contract file for the ontology format: `knowledge/_schema/ontology-format.md`.
Durability review: `docs/specs/durability-and-integrity.md`.

### Still open on the KEAP side (not blocking you)

`keap.db` is 561 MB, of which **514.6 MB is the ANN index shadow table** for
3356 vectors — the index is created with default parameters. Measured
alternatives bring it to 41–66 MB and cut the embed pass from 48 s to 6 s, but
the **recall cost is unmeasured**, so it waits behind a `gate:recall` run and a
rebuild migration. Flagging it because it affects any backup sizing you plan.

---

## Part 2 — nos-cortex-lang, round 2

Full document: `docs/specs/nos-cortex-lang-review-02.md`. Summary of what needs
to change before P0 freezes.

**The revision is sound.** All four round-1 corrections landed, and
`operands are ontology-typed, opcodes are code-owned` is a better thesis than the
one it replaced. The layer separation and the zero-blast-radius P1 are the two
decisions that are cheap now and impossible to retrofit — keep them.

### Follow-through the revision still owes

1. **Validation is two-phase, and the doc doesn't say so.** Only `tax:`, `kg:`,
   `rel:` (and `ent:`) are ontology-backed. `db:`, `svc:`, `doc:` do not exist in
   KEAP — Wing must validate those against its handler registry. Left implicit,
   the first implementer will "consolidate" validation by handing KEAP a list of
   databases, undoing the split. Anchor `ent:` to `object_type_definitions`.
2. **`/agent/v1/validate` is an enumeration oracle.** Answering "does this
   operand exist?" lets any caller enumerate the taxonomy and object corpus,
   including entries they may not read. KEAP had this exact bug until v1.17
   (`GET /api/objects/:id` leaked tier-scoped cards); the fix was 404 for
   not-found *and* not-readable alike. `validate` needs the same: resolve
   against the **calling** identity, and return a uniform `unknown operand`.
3. **Operand syntax doesn't match KEAP ids.** Ids are dotted
   (`nos.services.bookstack`, `01.01.03`), the grammar uses `/`. Use the native
   dotted form — exact lookup instead of a translation layer. And the worked
   examples don't typecheck: `rel:is-a` is not one of the sixteen predicates, and
   `rel:curated/depends-on` has a prefix that doesn't exist. Those examples
   become the primer's training material in P2.

### On the third-party critique that came with it

- **Late-binding operands: accepted, and it supersedes my round-1 advice.**
  Letting the LLM write `[tričko]` and having KEAP resolve it during validation
  is better than a context lookup turn — one API round-trip instead of two.
  `/agent/v1/context` drops from hard prerequisite to parallel work.
  **Mandatory guard:** never take the nearest match silently. Ambiguity returns a
  typed error with candidates. `knowledge/ingest.mjs` carries an identity-drift
  detector precisely because a valid-but-wrong id is indistinguishable from a
  correct one after the fact.
- **kNN and negation: real, but your §5 already contains it.** The dry-run gate
  means a mis-replayed precedent produces a *plan*, not an effect. Rather than a
  local extraction model, specify two rules: **replay never bypasses dry-run**,
  and **modifiers are never inherited** (retrieval supplies pipeline shape only).
  Earn the threshold with a replay gate of adversarial minimal pairs, on the
  model of `scripts/recall-gate.mjs`.
- **Constrained decoding: don't write the normalizer first.** A repairer that
  rewrites `@input.map(...)` guesses intent and reintroduces ambiguity into the
  layer built to remove it. The missed option is stronger: the Anthropic API
  *does* offer constrained decoding — it's called a tool schema. Emit the **AST
  as a structured tool call** and render the pipeline surface from it. The only
  objection was verbosity, and your own §7 concludes token count is not the
  constraint.
- **Control flow: real gap, wrong urgency.** Every branch in the grammar is a
  branch the local model must learn to predict. Keep the IR flat through P3 and
  decide on real cases. The critique's objection to `upsert()`-style verbs
  ("loses inspectability") doesn't hold — `dry_run` returns a plan that shows
  which branch was taken.
- **Hardware: aimed at the design you already abandoned.** Revised §6 is kNN over
  nomic (~137M params); the 12–16 GB figure doesn't apply. It does contain the
  strongest long-term idea though: **the P3 corpus is a fine-tuning set**, and a
  small model fine-tuned on your grammar beats a large general one at this narrow
  task. Worth carrying as an explicit P5 alternative.

### Three things nobody raised

1. **Precedents rot silently.** The operand vocabulary is a live ontology that
   grows under moderation. A precedent whose operand was renamed or retired will
   on replay resolve to *something else* rather than fail. Store the resolved id
   **and** the name it had at capture; invalidate on drift.
2. **The corpus is instance-level data — and that collides with your own privacy
   line.** `docs/specs/ontology-anchoring.md` §6 declares no instance-level data
   in the concept graph, *the product's privacy line, not a limitation*. But
   `(input, pipeline, outcome, operator-correction)` is instances by
   construction. Concrete hazard: §6 proposes kNN over the **existing nomic
   space** — if corpus inputs land in the same `embeddings` table, knowledge
   retrieval returns them (`/api/search`, hybrid recall, `/agent/v1/graph` all
   read it), and one user's knowledge question can surface another's operational
   input. There is precedent for a stray kind lingering there (the legacy `note:`
   embeddings are carried as known debt). **The corpus needs its own store and
   its own index, excluded from knowledge recall. This is a P0 decision — after
   P3 the data is already there.**
3. **Validate and execute happen at different times.** A converge between them
   changes the vocabulary under the AST. Either a short TTL or revalidation at
   dispatch.

### What KEAP owes you next

Neither exists yet; both are named as dependencies by your plan:

- `POST /agent/v1/validate` — parse + typecheck against the live ontology,
  returning AST or typed error, **zero side effects**, authz-aware per §2 above.
- `POST /agent/v1/context` — the budget-bounded citable injector (Track D,
  specced in `docs/specs/ontology-anchoring.md` §4).

Tell me which you want first and I'll schedule it. My recommendation is
`validate`, because late-binding makes it the entity-resolution path too, which
demotes `context` to the ambiguity fallback.
