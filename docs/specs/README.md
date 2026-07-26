# docs/specs

Every file opens with a `Status:` line; that line is authoritative.

| document | governs |
| --- | --- |
| `cortex-validate.md` | the `/agent/v1/validate` language: phases, error codes, binding stamp |
| `cortex-cutover.md` | P-5 — where reasoning is answered from (`CORTEX_BACKEND_URL`) |
| `cortex-full-scope-decision.md` | how much of KEAP becomes the cortex organ; C1–C4 staging |
| `onto1-composition-contract.md` | the byte-identity contract both onto1 implementations satisfy |
| `nos-selfmodel-keap-contract.md` | the cross-repo self-model contract |
| `recall-gate.md` | gate semantics v2 |
| `durability-and-integrity.md` | store integrity doctrine |
| `deploy-knowledge-mount-split.md` | container mount doctrine |
| `table-graph-metadata-spec.md` | DataTables |
| `topic-mode-spec.md` | explorer UI behaviour |
| `ontology-anchoring.md` | domain packs + context injector — **design, not built** |
| `conditional-relations.md` | R4 over typed relations — **design, not built** |

**Unresolved work does not live here.** Anything known-and-unpaid is a fee in
nOS `docs/hidden_fees/` — that is the one place to look for what we owe. Specs
describe what is; fees describe what will cost. A spec that starts explaining a
workaround is a fee that landed in the wrong file.

## These specs are leaving

nOS `docs/plans/cortex-self-core.md` moves the runtime out of this repo. KEAP
becomes **data and weights only** — no server, no UI. Every spec above describes
runtime and therefore follows its code out, at the stage named in
nOS `docs/plans/cortex-specs-ledger.md`. Eight already have a vendored copy in
the organ.

What replaces them here is documentation of **the dataset**: what the taxonomy
covers, how the ontology is structured, how weights are versioned and what they
were trained on. None of it is written yet.

Read the ledger before adding a spec here — it may already belong in nOS.
