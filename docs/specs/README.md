# docs/specs — what is in force, and what is a record

Every document here opens with a `Status:` line; that line is authoritative and
this index is only navigation. Grouped by whether the document still governs
something.

The cross-repo view — which specs the nOS cortex organ vendors, and which move
or die at each stage of the transplant — is
`../../../nOS/docs/plans/cortex-specs-ledger.md`. It is in the other repo
because the transplant is; a KEAP reader who never opens nOS would otherwise
have no way to learn that eight of these files have a second copy.

## In force

| document | governs |
| --- | --- |
| `cortex-validate.md` | the `/agent/v1/validate` surface: language, phases, error codes, the binding stamp |
| `cortex-cutover.md` | P-5 — where reasoning is answered from, and why it is a switch and not a failover |
| `cortex-full-scope-decision.md` | how much of KEAP becomes the cortex organ; the C1–C4 staging |
| `onto1-composition-contract.md` | the byte-identity contract both onto1 implementations must satisfy |
| `nos-selfmodel-keap-contract.md` | the cross-repo self-model contract (two consumers: KEAP ingest, and the organ's own generator run) |
| `recall-gate.md` | gate semantics v2 — what it measures, what it cannot, how to read its output |
| `durability-and-integrity.md` | store integrity doctrine; §4 carries the open vector-index decision |
| `deploy-knowledge-mount-split.md` | container mount doctrine; §6.1 scores which asks the nOS side acted on |
| `table-graph-metadata-spec.md` | DataTables — the product feature the scope decision deliberately keeps |
| `topic-mode-spec.md` | explorer UI behaviour |

## Design, not built

| document | note |
| --- | --- |
| `conditional-relations.md` | R4 over typed relations. Nothing implemented |
| `ontology-anchoring.md` | domain packs + the LLM context injector; the organ's `/agent/v1/context` future |

## Record only

These are kept because the *reasoning* is worth having, not because anything
follows from them. Do not implement from this section without checking what
superseded it.

| document | why it is here |
| --- | --- |
| `cortex-backend-boundary-reply.md` | superseded by the scope decision; §1–2's measurements survive and are cited |
| `nos-cortex-lang-review-02.md` | round-2 language review; the decisions are in code now |
| `handoff-nos-agent-2026-07-24.md` | the 2026-07-22 wipe lesson — what produced `database.id` |
| `nos-selfmodel-reply-01.md` | round-1 protocol; absorbed wholly into the contract |

## House rules

1. **A document that stops being true gets a status change, not a deletion.**
   The reasoning is usually worth more than the conclusion, and a deleted
   document takes its own refutation with it.
2. **Cite file and line for anything asserted about code.** Line numbers drift;
   a wrong line is a visible defect, an uncited claim is not.
3. **Say what was measured and when.** Two of the corrections in this directory
   came from re-measuring a claim that had been true when written.
