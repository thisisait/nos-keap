export const meta = {
  name: 'keap-content-panel',
  description: 'From node to file: full markdown preview, table mini-grid, and open-where-it-lives deep links in the detail panel',
  whenToUse: 'Plan item 4 (after nOS URL contracts, but ships inert without them). Launch on a feature branch.',
  phases: [
    { title: 'Scout', detail: 'panel, object body path, tables, nOS URL contracts' },
    { title: 'Implement', detail: '2 stages: server/env contract, client panel' },
    { title: 'Verify', detail: 'security + UX refuters + fixer' },
    { title: 'Gate', detail: 'build + lint baseline + e2e' },
  ],
}

const ROOT = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- SECURITY: object bodies are untrusted text. Markdown rendering must stay in the existing sanitized pattern (see DetailPanel BriefBody: [[refs]] + http(s)-only anchors, NO raw HTML, no dangerouslySetInnerHTML, no javascript: hrefs). Deep-link URL templates come from ENV, never from object data.
- Visibility: the full-body fetch must go through the same auth/ownership checks as GET /api/objects/:id already does — verify, don't assume.
- Lint baseline must not grow; i18n en+cs; npm run build && npx playwright test green; commit per stage on the CURRENT branch; never touch main.
- The fs-sync USERS pass is FROZEN.
`

phase('Scout')
const scout = await agent(`In ${ROOT}, brief the "content panel" feature:
1) DetailPanel.tsx: current object drawer content (excerpt? which fields), the BriefBody sanitized renderer, folder/repo sections added recently.
2) Server: GET /api/objects/:id (what body it returns, auth), object frontmatter (source, path, size, mtime; fs-mapping objects carry mapping id).
3) TableStore: how data tables render today (src/ components for grids — e2e/tables.spec.ts shows the surface); can a read-only mini-grid be embedded in the panel?
4) Deep links: check ../nOS/docs/doctrine/filesystem.md and ../nOS/roles/pazny.keap READ-ONLY if the tree exists (tolerate absence!) for how per-user files map to services (Puter/euro-office). Design an ENV contract: KEAP_OPEN_URL_TEMPLATES (JSON: {class: template with {path},{uid} placeholders}) — unset = feature hidden.
Return a terse brief with file anchors.`, { schema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } } })

phase('Implement')
const s1 = await agent(`${INVARIANTS}
Stage 1 (server) in ${ROOT}, per brief:\n${scout.brief}\n
- Ensure the object detail fetch exposes the FULL stored body (it is already capped at mirror time) + frontmatter needed by the panel.
- Add the KEAP_OPEN_URL_TEMPLATES env contract (parse once, validate: only http(s) templates; expose resolved open-URL per object in the detail payload; absent env = field absent).
- e2e: API assertions for the open-URL resolution + its absence when unset.
Build+lint+e2e green, commit, return handoff notes.`, { effort: 'high' })
await agent(`${INVARIANTS}
Stage 2 (client) in ${ROOT}. Server notes:\n${s1}\n
- DetailPanel object drawer: full markdown-lite preview (EXTEND the BriefBody sanitized renderer — headings/lists/code fences as plain styled blocks; still no raw HTML), scrollable.
- Data-table objects: read-only mini-grid (first N rows) reusing the existing table components; link to the full table page.
- "Open" button from the server-resolved open-URL (target _blank, rel noreferrer noopener).
- i18n en+cs; e2e: a UI spec asserting the panel renders a seeded markdown object's body and a table object's grid.
Build+lint+e2e green, commit, return summary.`, { effort: 'high' })

phase('Verify')
const verdicts = await parallel([
  () => agent(`Adversarially audit the latest content-panel commits in ${ROOT} for SECURITY: XSS through markdown (raw HTML, javascript: URLs, img onerror…), URL-template injection from object data, visibility/ownership of the full-body fetch. Try to construct concrete attacks. Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
  () => agent(`Adversarially audit the latest content-panel commits in ${ROOT} for UX/correctness: huge bodies (perf, scroll), binary/empty objects, tables with zero rows, missing env templates, i18n parity. Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
])
const problems = verdicts.filter(Boolean).flatMap((v) => (v.refuted ? v.findings : []))
if (problems.length) {
  await agent(`${INVARIANTS}\nFix these verified findings in ${ROOT} (current branch), re-run gates, commit:\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`, { effort: 'xhigh' })
}

phase('Gate')
const gate = await agent(`In ${ROOT} run: npm run build; npx eslint . (final total); npx playwright test. Report honestly, fix nothing.`, { effort: 'low', schema: { type: 'object', required: ['buildOk', 'lintTotal', 'e2ePassed', 'e2eFailed'], properties: { buildOk: { type: 'boolean' }, lintTotal: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' } } } })
return { problems, gate, nosContract: 'KEAP_OPEN_URL_TEMPLATES (JSON env) — hand the template values over to the nOS role when URL schemes are settled.' }
