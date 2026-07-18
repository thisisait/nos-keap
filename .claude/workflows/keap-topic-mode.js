export const meta = {
  name: 'keap-topic-mode',
  description: 'By-topic reorder in the files core: server-side clustering over object embeddings, stable cluster identity, labeled topic constellations',
  whenToUse: 'Plan item 2 (v1.10b) — the big one. Design judge panel → staged implementation → adversarial verify. Launch on a feature branch; expect hours of wall-clock.',
  phases: [
    { title: 'Scout', detail: 'embeddings, core geometry, UI toggle state' },
    { title: 'Design', detail: '3 designs → judges → synthesized spec (committed)' },
    { title: 'Implement', detail: '4 sequential stages: clustering, payload, layout, UI+e2e' },
    { title: 'Verify', detail: 'stability/correctness/perf refuters + fixer' },
    { title: 'Gate', detail: 'build + lint baseline + e2e' },
  ],
}

const ROOT = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- Spatial memory: taxonomy stars never move. Topic clusters MUST have stable identity across syncs — a re-run over grown data must not reshuffle existing topics' slots (anchor new cluster runs to previous centroids; persist centroids in the DB).
- All layout is deterministic: same graph payload → identical positions, keyed by immutable ids (see src/components/explorer/core.ts headers for the pattern).
- The fs-sync USERS pass (server/fs-sync.ts) is behaviorally FROZEN.
- Lint: record the baseline problem count of 'npx eslint .' BEFORE changes; must not grow. No eslint-disable.
- Every UI string → src/i18n/locales/en.json AND cs.json.
- e2e: npm run build && npx playwright test green; new server behavior gets API-level spec coverage (vectors can be seeded via POST /agent/v1/embeddings with a dummy contentHash — see e2e patterns).
- Commit per completed stage on the CURRENT branch. NEVER touch main, never tag, never push.
`

phase('Scout')
const scout = await agent(`In ${ROOT}, produce a terse technical brief for building the files-core "Topics" reorder mode (currently a disabled button):
1) Embeddings: server/embeddings.ts + db (vector table, EMBED_DIM, kinds; how many object vectors exist; how vectors are read — vectorSearchAvailable, pending queue).
2) Core geometry: src/components/explorer/core.ts — CoreOrder type, how 'fs' and 'taxonomy' orders compute positions, where 'topic' plugs in; the deterministic-id contract; Explore.tsx core.order UI ('explore.core.order.*' i18n keys, the disabled Topics button + topicSoon tooltip).
3) Graph payload path (server/graph.ts) and where cluster assignments could ship (per-object topic id + a topics array with labels).
4) DB migration conventions (server/migrations.ts) for persisting cluster centroids/labels.
Return exact file/line anchors.`, { schema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } } })

phase('Design')
const LENSES = [
  'STABILITY-FIRST: cluster identity across re-runs is the prime constraint (centroid anchoring, hysteresis, slot assignment); UX follows.',
  'SEMANTICS-FIRST: best possible topical grouping (k selection, outlier handling, label quality from titles/tags/top-terms); stability follows.',
  'UX-FIRST: what the user sees — topic constellations legible at a glance, labels, transitions between orders, empty/degraded states (no vectors); backend follows.',
]
const designs = await parallel(LENSES.map((lens, i) => () =>
  agent(`Design the KEAP files-core "Topics" mode end-to-end. Repo brief:\n${scout.brief}\n\nYour lens: ${lens}\n\nDeliver a complete design: server clustering (algorithm, k choice, when it runs — sync-triggered vs on-demand, persistence schema), payload shape, client layout math (reusing core.ts patterns), UI, degraded modes, e2e strategy. Be concrete — file paths, function signatures, DDL.`, { label: `design:${i}`, phase: 'Design' })))
const judged = await parallel(designs.filter(Boolean).map((d, i) => () =>
  agent(`Score this Topics-mode design 0-50 across: cluster stability across syncs (0-15), determinism/spatial-memory fit (0-10), implementation risk (0-10, higher=safer), UX quality (0-10), perf at 10k objects (0-5). Be harsh; list the 3 weakest points.\n\n${d}`, { label: `judge:${i}`, phase: 'Design', schema: { type: 'object', required: ['score', 'weaknesses'], properties: { score: { type: 'number' }, weaknesses: { type: 'array', items: { type: 'string' } } } } })))
const spec = await agent(`Synthesize ONE implementation spec for KEAP Topics mode from these scored designs (graft the best ideas of the losers into the winner; resolve every weakness the judges found or explicitly accept it with a reason).
${designs.filter(Boolean).map((d, i) => `--- DESIGN ${i} (score ${judged[i]?.score ?? '?'}; weaknesses: ${(judged[i]?.weaknesses ?? []).join('; ')})\n${d}`).join('\n\n')}

Write the spec to ${ROOT}/docs/specs/topic-mode-spec.md (numbered decision log included), commit it on the current branch, and return: the spec path + a 20-line executive summary + the 4-stage implementation split (S1 server clustering+persistence, S2 payload+API, S3 core.ts layout, S4 UI+i18n+e2e).`, { effort: 'xhigh' })

phase('Implement')
const stages = [
  'S1: server clustering + centroid persistence (migration + module + sync trigger)',
  'S2: /api/graph payload — per-object topic assignment + topics[] with labels, visibility-scoped',
  'S3: core.ts topic layout — deterministic constellation geometry, stable slots, ~untopiced fallback cluster',
  'S4: Explore.tsx UI (enable Topics button), i18n en+cs, e2e spec with seeded synthetic vectors',
]
let prior = ''
for (const s of stages) {
  prior = await agent(`${INVARIANTS}
Implement stage "${s}" of the Topics mode in ${ROOT}, following docs/specs/topic-mode-spec.md EXACTLY (read it first). Prior stage notes:\n${prior || '(first stage)'}\n\nBuild + lint + (for S4: e2e) until green, then commit the stage. Return handoff notes for the next stage (what exists now, any spec deviations with reasons).`, { label: s.slice(0, 20), phase: 'Implement', effort: 'high' })
}

phase('Verify')
const DIMS = [
  'STABILITY: prove or refute that a second clustering run over the same+grown data keeps existing topics in their slots. Read the code paths; construct the failure scenario if any.',
  'CORRECTNESS: payload scoping (private objects leaking into shared topic labels/counts?), determinism of the layout, degraded modes (zero vectors, one object, all-identical vectors).',
  'PERF+UX: clustering cost at 10k objects on the sync path, payload size, render cost of topic constellations; UI states.',
]
const findings = (await parallel(DIMS.map((d, i) => () =>
  agent(`Adversarially audit the Topics implementation on the current branch of ${ROOT} (read docs/specs/topic-mode-spec.md + the stage commits). Dimension: ${d} Default to reporting a finding when uncertain.`, { label: `verify:${i}`, phase: 'Verify', schema: { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'object', required: ['title', 'severity'], properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor'] }, detail: { type: 'string' } } } } } } })))).filter(Boolean).flatMap((v) => v.findings)
const majors = findings.filter((f) => f.severity === 'major')
if (majors.length) {
  await agent(`${INVARIANTS}
Fix these MAJOR verified findings in ${ROOT} (current branch), re-run build+lint+e2e, commit:\n${majors.map((f, i) => `${i + 1}. ${f.title} — ${f.detail ?? ''}`).join('\n')}`, { effort: 'xhigh' })
}

phase('Gate')
const gate = await agent(`In ${ROOT} run the release gates and report honestly: npm run build; npx eslint . (final problem total); npx playwright test (pass/fail counts). Do NOT fix anything.`, { effort: 'low', schema: { type: 'object', required: ['buildOk', 'lintTotal', 'e2ePassed', 'e2eFailed'], properties: { buildOk: { type: 'boolean' }, lintTotal: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' } } } })
return { specSummary: spec.slice(0, 3000), findings, gate }
