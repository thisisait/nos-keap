export const meta = {
  name: 'keap-scale-pass',
  description: 'Renderer scale prep for 10k+ nodes: users-tree ray aggregation, label LOD, instancing/shared-GPU pass — measured before/after',
  whenToUse: 'Plan item 3 (v1.11a). Perf work is MEASURED work: the workflow builds a stress fixture, profiles, implements, and proves the delta. Launch on a feature branch.',
  phases: [
    { title: 'Profile', detail: 'stress fixture + baseline FPS/draw calls' },
    { title: 'Design', detail: 'strategy within react-force-graph constraints' },
    { title: 'Implement', detail: '3 stages: ray aggregation, label LOD, GPU pass' },
    { title: 'Verify', detail: 'before/after probe + interaction regression' },
    { title: 'Gate', detail: 'build + lint baseline + e2e' },
  ],
}

const ROOT = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- Spatial memory + deterministic layout keyed by immutable ids; positions must not change from a perf refactor.
- Clicking, hover tooltips and the drawer must keep working for every node class (raycast!).
- The fs-sync USERS pass (server/fs-sync.ts) is FROZEN.
- Lint baseline (npx eslint . before changes) must not grow; i18n en+cs for any new UI string.
- npm run build && npx playwright test green; commit per stage on the CURRENT branch; never touch main.
- Known perf history (do not regress): bulk links are GL lines (width 0 — tubes are per-link draw calls), DPR capped 1.5, bloom at half-res, sim cooldown 6s. See GraphCanvas.tsx PERF comments.
`

phase('Profile')
const baseline = await agent(`In ${ROOT}: write a throwaway Node script (use $CLAUDE-job tmp or /tmp, NOT the repo) that boots dist-server with a synthetic stress corpus — ~8000 fs files across ~200 dirs seeded via a KEAP_USER_FILES_DIR fixture + POST /agent/v1/fs/sync (pattern: e2e/shared-uids.spec.ts + playwright.config.ts webServer env). With @playwright/test chromium measure, for BOTH the ring view and the core view: rAF FPS over 3s, and renderer.info (drawcalls/triangles) if reachable. npm run build first. Report numbers + where time goes (labels? meshes? links?). Clean the fixture up. Return the measurement script path too — later phases re-run it.`, { effort: 'high', schema: { type: 'object', required: ['numbers', 'scriptPath'], properties: { numbers: { type: 'string' }, scriptPath: { type: 'string' } } } })

phase('Design')
const design = await agent(`Design the scale pass for ${ROOT} given this baseline:\n${baseline.numbers}\n\nScope (plan item 3):
a) users-tree per-object RAY aggregation — mapped folders already collapse per-object rays into hub aggregates past 200 anchored objects (core.ts AGGREGATE_RAYS_AT); the users tree does not. Unify.
b) Label LOD — SpriteText plates are per-node canvas textures; cap/cull by camera distance or count budget (folder labels, cube names, star labels).
c) GPU/object pass — react-force-graph creates ONE Object3D per node (nodeThreeObject). Evaluate honestly: shared geometries/materials audit (some exist), sprite pooling, and whether a custom InstancedMesh overlay for file cubes is worth the raycast plumbing — recommend, do not assume.
Deliver a 3-stage implementation plan with file anchors and expected wins; write it to ${ROOT}/docs/specs/scale-pass-spec.md and commit.`, { effort: 'xhigh' })

phase('Implement')
let prior = ''
for (const s of ['S1 ray aggregation (users tree)', 'S2 label LOD', 'S3 GPU/object pass']) {
  prior = await agent(`${INVARIANTS}
Implement "${s}" in ${ROOT} per docs/specs/scale-pass-spec.md (read first). Prior notes:\n${prior || '(first stage)'}\nBuild+lint green, commit the stage, return handoff notes. If the spec's approach proves wrong mid-way, STOP that path, document why in the notes, and do the minimal correct alternative.`, { label: s, phase: 'Implement', effort: 'high' })
}

phase('Verify')
const after = await agent(`Re-run the stress measurement of ${ROOT} (script from earlier: ${baseline.scriptPath} — rebuild dist first, adapt if stages changed APIs) and report the SAME numbers as the baseline for before/after comparison. Then interaction regression: clicking a folder hub opens its panel, clicking a file object opens its drawer, hover tooltips work (drive via playwright screenshots + assertions). Report honestly — including any metric that got WORSE.`, { effort: 'high', schema: { type: 'object', required: ['numbers', 'interactionsOk', 'regressions'], properties: { numbers: { type: 'string' }, interactionsOk: { type: 'boolean' }, regressions: { type: 'array', items: { type: 'string' } } } } })
if (!after.interactionsOk || after.regressions.length) {
  await agent(`${INVARIANTS}\nFix these scale-pass regressions in ${ROOT} (current branch), re-verify, commit:\n${after.regressions.join('\n')}`, { effort: 'xhigh' })
}

phase('Gate')
const gate = await agent(`In ${ROOT} run: npm run build; npx eslint . (final total); npx playwright test. Report honestly, fix nothing.`, { effort: 'low', schema: { type: 'object', required: ['buildOk', 'lintTotal', 'e2ePassed', 'e2eFailed'], properties: { buildOk: { type: 'boolean' }, lintTotal: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' } } } })
return { baseline: baseline.numbers, after: after.numbers, gate }
