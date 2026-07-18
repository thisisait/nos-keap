export const meta = {
  name: 'keap-object-links',
  description: 'Draw object→object [[object:…]] refs as real edges in the explore ring/core',
  whenToUse: 'Plan item 1 (v1.10a). Small feature: graph payload + drawn edges + panel section + e2e. Launch on a feature branch; the session releases afterwards.',
  phases: [
    { title: 'Scout', detail: 'map refs storage, payload, link rendering' },
    { title: 'Implement', detail: 'server edges + client olink + panel + e2e' },
    { title: 'Verify', detail: 'adversarial refuters + fixer' },
    { title: 'Gate', detail: 'build + lint baseline + e2e' },
  ],
}

const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- Spatial memory: taxonomy stars never move; all layout is deterministic and keyed by immutable ids.
- The fs-sync USERS pass (server/fs-sync.ts) is behaviorally FROZEN: ids, skip keys, prune semantics untouched.
- Lint: record BASELINE=$(npx eslint . | tail -1) problem count BEFORE changing anything; the count must not grow. Type new code properly, never eslint-disable.
- Every UI string goes to src/i18n/locales/en.json AND cs.json.
- e2e: npm run build && npx playwright test must pass; new behavior gets a spec assertion.
- Commit completed work on the CURRENT branch (conventional message). NEVER touch main, never tag, never push.
`

phase('Scout')
const scout = await agent(`In /Users/pazny/projects/knowledge-explorer-and-preserver, map exactly how object→object references flow today, for a feature that DRAWS them as edges:
1) server/objects.ts extractRefs + ObjectRef: how are [[object:<id>]] refs parsed/stored on knowledge_objects.links? (The nOS self-model authors such refs; they are stored but not drawn.)
2) server/graph.ts /api/graph: what objects payload ships (id/anchors/path/owner/mapping), how visibility scoping works (getVisibleObjects), where a new objectLinks array would go.
3) Client: src/components/explorer/GraphCanvas.tsx CanvasLink types + linkColor/linkWidth (note: bulk links MUST be width 0 = GL lines, tubes only for sparse overlays); src/pages/Explore.tsx where links are assembled (obj: id prefixes); DetailPanel.tsx structure for a "linked objects" section.
4) e2e: which spec fits (e2e/core.spec.ts seeds objects via POST /api/objects).
Return a terse implementation brief with exact file/line anchors and the recommended payload shape (both-endpoints-visible filtering, dedupe, sane cap with log).`, { schema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } } })

phase('Implement')
const impl = await agent(`${INVARIANTS}
Implement "object→object links drawn as edges" in /Users/pazny/projects/knowledge-explorer-and-preserver using this scout brief:
${scout.brief}

Requirements:
- /api/graph ships objectLinks: [{source,target}] (object ids, un-prefixed) — only pairs where BOTH objects are in the requester's visible set; dedupe (a→b == one edge); cap 5000 with a console.warn when trimmed.
- Client: new CanvasLink flag olink; Explore.tsx pushes them prefixed obj:<id> with a nodeById-style existence filter; GraphCanvas draws them as GL LINES (linkWidth 0) in a distinct violet (dim the rgb — lines ignore alpha; see the existing '#12554c' ray comment).
- DetailPanel: object drawers get a "Linked objects" section (clickable, reuses the folder-contents list style); i18n en+cs.
- e2e: extend e2e/core.spec.ts — seed two objects where one body contains [[object:<other-id>]]; assert the graph payload edge exists, is deduped, and never references an invisible object.
- ROADMAP.md: one-line shipped note under the S2″/U2′ area.
Build + lint + e2e locally until green, then commit. Return a summary of files changed + decisions taken.`, { effort: 'high' })

phase('Verify')
const verdicts = await parallel([
  () => agent(`Adversarially REFUTE this implementation in /Users/pazny/projects/knowledge-explorer-and-preserver (read the latest commits on the current branch): "${impl.slice(0, 2000)}". Attack: visibility leaks (non-admin seeing edges to private objects), dangling refs (target object deleted), dedupe/cap correctness, determinism. Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
  () => agent(`Adversarially REFUTE the CLIENT side of the latest commits on the current branch in /Users/pazny/projects/knowledge-explorer-and-preserver: olink rendering (must be GL lines, not tubes), Explore link assembly (missing-node filtering), DetailPanel section, i18n completeness (en+cs parity). Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
])
const problems = verdicts.filter(Boolean).flatMap((v) => (v.refuted ? v.findings : []))
if (problems.length) {
  await agent(`${INVARIANTS}
Fix these verified findings in /Users/pazny/projects/knowledge-explorer-and-preserver (current branch), then re-run build+lint+e2e and commit:
${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`, { effort: 'high' })
}

phase('Gate')
const gate = await agent(`In /Users/pazny/projects/knowledge-explorer-and-preserver run the release gates and report honestly: 1) npm run build; 2) npx eslint . (report the final problem total); 3) npx playwright test (report pass/fail counts). Do NOT fix anything.`, { effort: 'low', schema: { type: 'object', required: ['buildOk', 'lintTotal', 'e2ePassed', 'e2eFailed'], properties: { buildOk: { type: 'boolean' }, lintTotal: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' } } } })
return { impl, problems, gate }
