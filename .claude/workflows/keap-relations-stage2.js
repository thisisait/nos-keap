export const meta = {
  name: 'keap-relations-stage2',
  description: 'Track R3 stage 2 — moderation + cross-type edge rendering (verb labels) + the LLM brain endpoint /agent/v1/graph',
  whenToUse: 'R3 stage 2 of 2, AFTER keap-relations-stage1 has merged to dev. The human + consumption layer: admins moderate proposed relations and vocab growth, the explore Vazby overlay renders typed cross-type edges with their verb, and the typed graph is exposed to LLMs via /agent/v1/graph. Launch on feat/relations-stage2 branched from the updated dev.',
  phases: [
    { title: 'Scout', detail: 'map admin panel patterns, Vazby rendering, edge labels, agent graph shape' },
    { title: 'Implement', detail: 'moderation API+panel + vocab-grow + cross-type edge render + brain endpoint + e2e' },
    { title: 'Verify', detail: 'adversarial refuters + fixer' },
    { title: 'Gate', detail: 'build + lint baseline + e2e' },
  ],
}

const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- Spatial memory: taxonomy stars never move; all layout is deterministic and keyed by immutable ids.
- Stage 1 storage is the source of truth: relations carry (from_ref,to_ref,from_kind,to_kind,type,confidence,justification,source,status). Do NOT re-derive or re-classify here; this stage only MODERATES, RENDERS, and EXPOSES.
- Visibility is load-bearing everywhere: a rendered edge or an edge in the brain endpoint must have BOTH endpoints in the requester's visible set (getVisibleObjects). A non-admin never sees an edge touching a private object; the brain endpoint is bearer-scoped and must not leak.
- PERF: bulk/graph links stay GL lines (linkWidth 0); only sparse typed-relation overlays may afford tubes. Edge labels (SpriteText) are LOD-capped like the star/folder labels — never allocate thousands.
- Default render shows CONFIRMED relations; ?relations=all additionally shows high-confidence proposed. Rejected never renders.
- Vocab growth is moderated: a proposed relation_type only enters the live palette after admin approval (colour assigned); mirrors Track T / topics admin.
- Every UI string goes to src/i18n/locales/en.json AND cs.json.
- Lint: record BASELINE before changing anything; errors stay 0, warnings must not grow past the CI cap. Type new code properly, never eslint-disable.
- e2e: npm run build && npx playwright test must pass; every new behaviour gets a spec assertion.
- Commit completed work on the CURRENT branch (conventional message). NEVER touch main, never tag, never push, never bump the nOS pin.
`

phase('Scout')
const scout = await agent(`In /Users/pazny/projects/knowledge-explorer-and-preserver, map exactly what stage 1 left in place and how to build moderation + rendering + an LLM brain endpoint on it:
1) The stage-1 relations model (server/db.ts + server/relations.ts): the row shape, status values, the relation_types registry, and the read helpers /api/graph uses.
2) Admin panel + control-plane precedent: server/topics-routes.ts (/api/admin/topics*) and its React panel, plus any Track-T review UI — the pattern for a /api/admin/relations* moderation surface (list proposed, confirm/reject) and a relation_types approval flow.
3) Rendering: src/components/explorer/GraphCanvas.tsx REL_COLOR + linkColor/linkWidth for relation edges, the 'relation' CanvasLink flag; src/pages/Explore.tsx where relations are pushed into links (showRelations gate, nodeById existence filter) — and how to extend it to CROSS-TYPE endpoints (obj:<id> as well as node ids). Where an edge-midpoint verb LABEL (SpriteText) would attach, and the existing label LOD caps to reuse.
4) The agent graph endpoint: server/agent.ts patterns + server/graph.ts payload — the shape for GET /agent/v1/graph (nodes + typed edges + provenance), visibility-scoped, bearer (roadmap S2⁷).
Return a terse implementation brief with exact file/line anchors: the moderation endpoints, the cross-type edge assembly points, the label attach point + cap, and the brain endpoint payload.`, { schema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } } })

phase('Implement')
const impl = await agent(`${INVARIANTS}
Implement Track R3 stage 2 — moderation + rendering + the brain endpoint — in /Users/pazny/projects/knowledge-explorer-and-preserver using this scout brief:
${scout.brief}

Requirements:
- MODERATION API (/api/admin/relations*, admin-only): list proposed relations (with from/to labels, type, confidence, justification, source); confirm/reject one (proposed→confirmed/rejected). Vocab growth: list proposed relation_types; approve one (status→confirmed, assign a colour) or reject. Mirror the topics admin route/guard style.
- MODERATION PANEL: a React admin surface reusing the topics/Track-T panel style — a queue of proposed relations (confirm/reject) and a proposed-types approval list. i18n en+cs.
- RENDERING (Explore.tsx + GraphCanvas.tsx): extend the Vazby overlay to assemble typed edges for ALL kind pairs (node↔node, object↔object, object↔node) — prefix object endpoints obj:<id>, filter to endpoints actually drawn (existence filter, like objectLinks). Colour from the relation_types registry (extend REL_COLOR to be registry-driven), width by confidence, and a verb LABEL (SpriteText) at the edge midpoint — LOD-capped exactly like the star/folder labels, hover-only past the cap. Default renders confirmed; ?relations=all adds high-confidence proposed. Untyped [[object:…]] olinks upgrade to the typed edge when a relation exists (don't double-draw).
- BRAIN ENDPOINT: GET /agent/v1/graph (agentAuth ro) → { nodes: [...], edges: [{from,to,fromKind,toKind,type,confidence,justification,source}] }, visibility-scoped (bearer identity or admin-scope per the existing agent convention), confirmed edges by default. This is the LLM-consumable substrate — stable, documented shape.
- e2e (extend e2e/relations.spec.ts or a new spec): moderation flow (seed a proposed relation → confirm → it appears in /api/graph + renders; reject → it never renders); vocab-grow (propose a type → approve → renders with its colour); cross-type edge assembly (an object↔node typed edge draws); the brain endpoint returns typed edges and hides an edge to a private object from a non-admin bearer.
- ROADMAP.md: mark R3 stage 2 shipped + close S2⁷ (native agent graph endpoint).
Build + lint + e2e locally until green, then commit. Return a summary of files changed + decisions taken.`, { effort: 'high' })

phase('Verify')
const verdicts = await parallel([
  () => agent(`Adversarially REFUTE the SECURITY + MODERATION side of the latest commits on the current branch in /Users/pazny/projects/knowledge-explorer-and-preserver: "${impl.slice(0, 1800)}". Attack: (a) the brain endpoint /agent/v1/graph leaking an edge that touches a private object to a non-admin/other-tenant bearer; (b) /api/admin/relations* reachable without admin; (c) a rejected relation still rendering or still in the brain payload; (d) an unapproved proposed relation_type entering the live palette; (e) state-machine holes (confirm after reject, etc.). Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
  () => agent(`Adversarially REFUTE the RENDERING side of the latest commits on the current branch in /Users/pazny/projects/knowledge-explorer-and-preserver: cross-type edge assembly (an edge to an undrawn endpoint must be filtered, never crash force-graph); edges must stay GL LINES not tubes for the bulk case; the verb-label SpriteText must be LOD-capped (no thousands of canvases); untyped olink vs typed edge double-draw; i18n en+cs parity; determinism. Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
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
