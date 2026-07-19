export const meta = {
  name: 'keap-relations-stage1',
  description: 'Track R3 stage 1 — typed-relation pipeline + store: schema, cross-type recall, agent candidates/write-back (Sonnet-typing host-side)',
  whenToUse: 'R3 stage 1 of 2. Backend data backbone: KEAP generates candidate pairs from the vector index and stores Sonnet-typed cross-type relations with provenance + moderation status. LLM stays host-side; the e2e stubs the classifier. Launch on feat/relations-stage1; the session releases afterwards. Stage 2 (keap-relations-stage2) builds moderation + rendering + the brain endpoint on top.',
  phases: [
    { title: 'Scout', detail: 'map concept_relations, embeddings/vector index, agent surface, migrations, Track-T governance' },
    { title: 'Implement', detail: 'migration + relation_types registry + recall + agent candidates/relations endpoints + e2e' },
    { title: 'Verify', detail: 'adversarial refuters + fixer' },
    { title: 'Gate', detail: 'build + lint baseline + e2e' },
  ],
}

const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- Spatial memory: taxonomy stars never move; all layout is deterministic and keyed by immutable ids.
- The fs-sync USERS pass (server/fs-sync.ts) is behaviorally FROZEN.
- OKF doctrine: SIMILARITY stays a rendered VIEW, never a stored edge. Only TYPED (classified) relations get stored — as first-class rows WITH provenance.
- The LLM (Sonnet) classification runs HOST-SIDE, mirroring embed-sync: KEAP surfaces candidate pairs + the controlled vocab + both nodes' text, and ACCEPTS typed results via an agent bearer endpoint. KEAP never calls an LLM in-container.
- Existing ToE relations MUST keep working: migrate them (kind=node, source='toe', status='confirmed'); /api/graph "Vazby" overlay and ?relations=all behave exactly as before.
- Controlled vocabulary: relation types come from a registry; an unknown proposed type does NOT silently insert — it lands as a proposed relation_type for later moderation (Track-T style), the relation stored against it as proposed.
- Provenance is mandatory on every derived row: source, confidence, justification, model, created_at, status.
- Lint: record BASELINE=$(npx eslint . --max-warnings 999 | tail -1) BEFORE changing anything; errors must stay 0 and warnings must not grow past the CI cap. Type new code properly, never eslint-disable.
- Every UI string goes to src/i18n/locales/en.json AND cs.json (stage 1 is backend-heavy, but any admin label counts).
- e2e: npm run build && npx playwright test must pass; new behavior gets a spec assertion. Unit contracts (vitest, server/**) welcome for pure logic.
- Commit completed work on the CURRENT branch (conventional message). NEVER touch main, never tag, never push, never bump the nOS pin.
`

phase('Scout')
const scout = await agent(`In /Users/pazny/projects/knowledge-explorer-and-preserver, map exactly how relations, embeddings, and the agent surface work today, for a feature that DERIVES typed cross-type relations (recall via embeddings → Sonnet-typing host-side → stored with provenance + moderation):
1) server/db.ts: the concept_relations table (from_id,to_id,type,explored,source) + saveConceptRelation + how migrations run (the NNN-*.sql or in-code migration mechanism, migration numbering — the last one was 005-topic-clusters). How would a 006 generalize it to cross-type endpoints (node OR object ids) + confidence/justification/status/model WITHOUT breaking the ToE rows?
2) server/graph.ts: how relations ship in /api/graph (typedOnly / ?relations=all, the {source,target,type,explored} map) and how getVisibleObjects scopes objects — a derived relation must respect visibility of BOTH endpoints.
3) server/embeddings.ts + the libsql vector index (embeddings table, F32_BLOB(768), libsql_vector_idx): exact query to get top-K nearest neighbors for a given node/object embedding, ACROSS kinds (node and object embeddings share the 768-d nomic space). Note the kind/id keying in the embeddings table.
4) server/agent.ts: the bearer-auth pattern (agentAuth('ro'|'rw'), ok/fail, the /agent/v1/tables shape) to model two new endpoints: GET /agent/v1/relations/candidates and POST /agent/v1/relations.
5) server/taxonomy.ts Track-T ext-nodes + governance (registerExtNode, listExtNodes, zones): the model for a relation_types registry that seeds a base vocab and grows under moderation.
Return a terse implementation brief with exact file/line anchors: the migration shape, the recall SQL, the two agent endpoint contracts (request/response), and the relation_types seed list.`, { schema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } } })

phase('Implement')
const impl = await agent(`${INVARIANTS}
Implement Track R3 stage 1 — the typed-relation pipeline + store — in /Users/pazny/projects/knowledge-explorer-and-preserver using this scout brief:
${scout.brief}

Requirements:
- MIGRATION (006-typed-relations): generalize relation storage to cross-type. A relations model with (id, from_ref, to_ref, from_kind, to_kind, type, confidence REAL, justification TEXT, source, status, model, created_at); from_kind/to_kind ∈ {node,object}; source ∈ {toe,derived,manual}; status ∈ {proposed,confirmed,rejected}. Migrate existing concept_relations rows in as node↔node, source='toe', status='confirmed', confidence from the 'explored' rating. Keep /api/graph's current Vazby behaviour byte-identical for the migrated ToE set (confirmed + typed-only default).
- relation_types REGISTRY: a table (type PK, label, color, description, status ∈ {seed,proposed,confirmed}) seeded with a base ~15 controlled types (depends-on, prerequisite-for, supports, refutes, contradicts, generalizes, specializes, exemplifies, defines, supersedes, causes, derived-from, analogous-to, duality, related-concept). Growable: a proposed type inserts as status='proposed' (moderation lands in stage 2).
- RECALL (server/relations.ts): candidatePairs() — for each node/object with an embedding, top-K nearest neighbours from the vector index ACROSS kinds, above a similarity threshold, deduped (a↔b once), skipping pairs already stored, incremental (only new/changed embeddings). Pure, deterministic, bounded (cap + log).
- AGENT ENDPOINTS (server/agent.ts): GET /agent/v1/relations/candidates (agentAuth ro) → { pairs: [{from_ref,from_kind,to_kind,to_ref, fromText, toText, similarity}], vocab: [{type,label,description}] } — the host job feeds these to Sonnet. POST /agent/v1/relations (agentAuth rw) → accepts [{from_ref,from_kind,to_ref,to_kind,type,confidence,justification}]; validates type against the registry (unknown → insert a proposed relation_type + store the relation as proposed against it), stores each as source='derived', status='proposed', model from a header/env; idempotent (dedup on from_ref,to_ref,type — ON CONFLICT update confidence/justification); rejects endpoints that don't resolve to a real node/object.
- No LLM call inside KEAP. The classifier is host-side; the e2e simulates it by POSTing a deterministic typed batch.
- e2e (new spec e2e/relations.spec.ts): seed objects + fake embeddings (or reuse the topics embed path); GET candidates (assert top-K, cross-type, dedup, visibility of both endpoints); POST a typed batch incl. one unknown type (assert stored proposed with provenance, unknown type became a proposed relation_type, idempotent re-POST is a no-op); confirm ToE rows still render as before.
- ROADMAP.md: add Track R3 with a one-line stage-1 shipped note.
Build + lint + e2e locally until green, then commit. Return a summary of files changed + decisions taken.`, { effort: 'high' })

phase('Verify')
const verdicts = await parallel([
  () => agent(`Adversarially REFUTE the DATA/SECURITY side of the latest commits on the current branch in /Users/pazny/projects/knowledge-explorer-and-preserver: "${impl.slice(0, 1800)}". Attack: (a) visibility leaks — a derived relation whose endpoint is a private object must not surface to a non-admin via /api/graph or /agent; (b) ToE migration correctness — did any existing concept_relations row change type/explored/rendering? (c) cross-type endpoint resolution — a relation to a deleted/nonexistent node/object; (d) idempotency + dedup of POST; (e) SIMILARITY never stored as an edge (only classified types). Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
  () => agent(`Adversarially REFUTE the PIPELINE/CONTRACT side of the latest commits on the current branch in /Users/pazny/projects/knowledge-explorer-and-preserver: recall determinism + incrementality (does it re-emit already-stored pairs? unbounded?), the vector kNN query correctness across kinds, controlled-vocab enforcement (unknown type must NOT silently join the seed vocab — it must be status='proposed'), provenance completeness on every derived row, and the agent endpoints' auth scopes (ro vs rw). Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
])
const problems = verdicts.filter(Boolean).flatMap((v) => (v.refuted ? v.findings : []))
if (problems.length) {
  await agent(`${INVARIANTS}
Fix these verified findings in /Users/pazny/projects/knowledge-explorer-and-preserver (current branch), then re-run build+lint+e2e and commit:
${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`, { effort: 'high' })
}

phase('Gate')
const gate = await agent(`In /Users/pazny/projects/knowledge-explorer-and-preserver run the release gates and report honestly: 1) npm run build; 2) npx eslint . (report the final error + warning totals); 3) npm test (vitest, report pass/fail); 4) npx playwright test (report pass/fail counts). Do NOT fix anything.`, { effort: 'low', schema: { type: 'object', required: ['buildOk', 'lintErrors', 'lintWarnings', 'unitPassed', 'e2ePassed', 'e2eFailed'], properties: { buildOk: { type: 'boolean' }, lintErrors: { type: 'number' }, lintWarnings: { type: 'number' }, unitPassed: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' } } } })
return { impl, problems, gate }
