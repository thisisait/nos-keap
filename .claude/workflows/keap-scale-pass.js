export const meta = {
  name: 'keap-scale-pass',
  description: 'U2″ Phase A — the close-view density prerequisite for hierarchical LOD: users-tree/untopiced ray aggregation, label LOD, force-sim freeze, and instancing IF measurement justifies it',
  whenToUse: 'Plan item 3, Phase A only (v1.13.x). MEASURED perf work: build a stress fixture, profile, implement the cheap-safe wins first, re-measure, and only add instancing if draw calls prove to be the bottleneck. Phase B (server-baked cluster aggregates + camera-driven impostor swap) and Phase C (shader nebulae) are SEPARATE later workflows — do NOT build them here. Launch on a feature branch.',
  phases: [
    { title: 'Profile', detail: 'stress fixture ~8k + baseline FPS/draw-calls/triangles' },
    { title: 'Implement', detail: 'S1 ray aggregation, S2 label LOD, S3 sim freeze, S4 instancing (gated on measurement)' },
    { title: 'Verify', detail: 'before/after re-measure + interaction + spatial-memory regression' },
    { title: 'Gate', detail: 'build + lint (0 err / max 31 warn) + e2e' },
  ],
}

const ROOT = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- Spatial memory: taxonomy stars never move. Deterministic layout keyed by immutable ids. A perf refactor must NOT change any node's position (verify positions byte-identical before/after).
- Interaction must keep working for every node class: clicking a taxonomy star / object body / folder hub / repo sphere / file cube opens its panel; hover tooltips resolve; the drawer/focus warp still fires. Raycast is load-bearing — instancing must preserve per-node picking.
- The fs-sync USERS pass (server/fs-sync.ts) is behaviorally FROZEN.
- Lint gates in CI now: 0 errors, max 31 warnings (npx eslint . --max-warnings 31). No eslint-disable. i18n en+cs for any new UI string.
- npm run build && npx playwright test green; commit per stage on the CURRENT branch; NEVER touch main, never tag, never push.
- Do NOT undo the existing perf guards (GraphCanvas.tsx): bulk links stay GL lines (linkWidth 0 → GL line, non-zero → TubeGeometry mesh, ~line 1020-1038); DPR cap 1.5 (~530-535); half-res UnrealBloom (~566-571); d3 cooldownTime 6000 + alphaDecay 0.04 (~1049-1050). See the PERF comments.
- This is Phase A ONLY. It must not block Phase B: leave a clean seam for server-computed cluster aggregates to arrive in /api/graph later (do not hardcode client-only aggregation in a way B would have to rip out).
`

const RECON = `
Recon (v1.12.1, cite when implementing — verify still current):
- NO instancing anywhere. nodeThreeObject (GraphCanvas.tsx:859-922) builds a fresh Mesh + fresh MeshBasicMaterial per node: buildAssetMesh (:359-395), buildFileCube (:435-454), buildRepoMesh (:419-432, new texture per repo). Shared geometries exist (_formGeo :301-307, _cubeGeo :398, _repoGeo :397); shared textures (_nebulaTex/_discTex/_cometTex :288-290). nodeThreeObjectExtend = !object && !repo (:1002) keeps a default library sphere for taxonomy/folder too.
- Label canvases UNBOUNDED: folder-hub labels (:874) and star labels (:898, level<=1||star) have NO cap; only file cubes cap at <=400 (fileLabels :849-852). Each SpriteText = one canvas + CanvasTexture.
- Ray aggregation (core.ts AGGREGATE_RAYS_AT=200 :50) covers ONLY mapped folders (fs order :543-555, gate :546) and populated topics (:475, gated on 'tid &&' so ~untopiced '' bucket is exempt). EXEMPT and unbounded: users-tree rays (fs order :539-542, per-object), taxonomy order (:447-452, always per-object), ~untopiced bucket. At 10k users-tree objects = ~10k+ ray links, no ceiling.
- Force sim: cooldownTime 6000 + collide+charge (:706-709) iterate ALL ~11k+ nodes for 6s on every graphData change (:722 dep) though nearly all are fx/fy/fz-pinned. Only semantic dust is unpinned. The recency/lens refresh() (:487-489, nodeThreeObject lens dep :922) rebuilds ALL object meshes on lens toggle.
- Payload (server/graph.ts): objects (:186-217) = the N-scaling term {id,title,type,assetType,form,glyph,hue,anchors,path,owner,mapping,topic,mtime}; objectLinks capped 5000 (:224). nodes fixed ~790 but fat (description+descriptionCs+features+meta).
`

phase('Profile')
const baseline = await agent(`In ${ROOT}: write a throwaway Node script (in the job tmp or /tmp, NOT the repo tree) that boots dist-server with a synthetic stress corpus — ~8000 fs files across ~200 dirs seeded via a KEAP_USER_FILES_DIR fixture + POST /agent/v1/fs/sync (pattern: e2e/shared-uids.spec.ts + playwright.config.ts webServer env; agent.ts non-UTF8 byte means grep it with -a). npm run build first. With @playwright/test chromium measure, for BOTH the ring view and the core view (toggle 'Core'): rAF FPS averaged over 3s, and renderer.info.render {calls, triangles} if reachable via the page. Report the numbers + a breakdown of where the cost is (draw calls from meshes? label canvases? link count? sim tick?). Clean the fixture up afterwards. Return the numbers AND the measurement script path (later phases re-run it for before/after).\n${RECON}`, { effort: 'high', schema: { type: 'object', required: ['numbers', 'breakdown', 'scriptPath'], properties: { numbers: { type: 'string' }, breakdown: { type: 'string' }, scriptPath: { type: 'string' } } } })
log(`baseline: ${baseline.numbers}`)

phase('Implement')
// Cheap-safe wins first (S1-S3), THEN instancing only if the baseline says draw
// calls dominate. Each stage re-checks build+lint; e2e runs in S4/verify.
let prior = ''
const CHEAP = [
  `S1 — ray aggregation parity. Extend the AGGREGATE_RAYS_AT hub-collapse (core.ts, currently mapped-folders + populated-topics only) to the users-tree bucket (fs order :539-542) and the ~untopiced bucket (topic order). Aggregate per-object rays into hub→distinct-anchor aggregates past the threshold, exactly like the mapping path (:543-555). Positions unchanged. This is a pure link-count reduction.`,
  `S2 — label LOD. Give folder-hub labels (:874) and star labels (:898) the same budget the file cubes already have (fileLabels :849-852): a count cap and/or a camera-distance cull, so a deep tree or a dense field does not allocate thousands of SpriteText canvases. Keep galaxy/constellation names always-on (orientation anchors) unless the field is huge. i18n unaffected.`,
  `S3 — force-sim freeze. Nearly every node is fx/fy/fz-pinned; only semantic dust is unpinned. Gate the d3 collide/charge so pinned nodes are skipped (or freeze the sim entirely when no unpinned node is present), and stop the lens/recency refresh() from rebuilding ALL object meshes on a toggle (:487-489, :922) — recolour in place instead. Must not move any pinned node.`,
]
for (const s of CHEAP) {
  prior = await agent(`${INVARIANTS}\n${RECON}\nImplement "${s}" in ${ROOT}. Build + lint (max 31 warn, 0 err) green, commit the stage. Return handoff notes + any measured intuition. If the recon line-numbers drifted, re-locate by the described code, don't trust the number blindly.`, { label: s.slice(0, 22), phase: 'Implement', effort: 'high' })
}
// S4 instancing — GATED. Re-measure after the cheap wins; only instance if draw
// calls are still the dominant cost (react-force-graph makes 1 Object3D/node via
// nodeThreeObject, so instancing means a scene-overlay of InstancedMesh with the
// RFG nodes kept invisible-but-raycastable, or an equivalent — a real design risk).
const midMeasure = await agent(`Re-run the stress measurement of ${ROOT} (script: ${baseline.scriptPath} — rebuild dist first). Report the SAME metrics as baseline. Then judge: after S1-S3, are DRAW CALLS still the dominant bottleneck (i.e. would InstancedMesh materially help), or is the frame now bound by something else / already smooth? Be honest and quantitative.`, { phase: 'Implement', effort: 'high', schema: { type: 'object', required: ['numbers', 'drawCallsDominant', 'recommendation'], properties: { numbers: { type: 'string' }, drawCallsDominant: { type: 'boolean' }, recommendation: { type: 'string' } } } })
log(`after cheap wins: ${midMeasure.numbers} — instancing warranted: ${midMeasure.drawCallsDominant}`)
if (midMeasure.drawCallsDominant) {
  prior = await agent(`${INVARIANTS}\n${RECON}\nS4 — instancing. Draw calls are still dominant (${midMeasure.recommendation}). Batch same-geometry bodies (file cubes, per-form object bodies, and/or stars) into InstancedMesh with per-instance colour, WITHOUT breaking per-node raycast/picking (react-force-graph gives each node its own Object3D via nodeThreeObject — you likely need a scene-overlay InstancedMesh plus invisible-but-raycastable node stubs, or nodeThreeObject returning shared handles; design it safely). Positions byte-identical. Build+lint+e2e green, commit. If mid-implementation instancing proves to break picking or spatial memory, STOP, revert that path, and document why — the cheap wins already shipped.`, { phase: 'Implement', effort: 'xhigh' })
} else {
  log(`S4 instancing SKIPPED — cheap wins sufficed (${midMeasure.recommendation}); recorded for Phase B.`)
}

phase('Verify')
const after = await agent(`Re-run the stress measurement of ${ROOT} (${baseline.scriptPath}, rebuild dist) and report the SAME metrics for a final before/after. Then regression-check: (a) spatial memory — a taxonomy node's baked position is unchanged vs baseline (compare /api/graph nodes x/y/z, or the layoutVersion); (b) interaction — click a taxonomy star, an object/cube, a folder hub, a repo sphere → each opens its panel; hover tooltips resolve. Report honestly including anything that got WORSE.`, { effort: 'high', schema: { type: 'object', required: ['before', 'after', 'positionsStable', 'interactionsOk', 'regressions'], properties: { before: { type: 'string' }, after: { type: 'string' }, positionsStable: { type: 'boolean' }, interactionsOk: { type: 'boolean' }, regressions: { type: 'array', items: { type: 'string' } } } } })
if (!after.positionsStable || !after.interactionsOk || after.regressions.length) {
  await agent(`${INVARIANTS}\nFix these Phase-A regressions in ${ROOT} (current branch), re-verify, commit:\n- positionsStable=${after.positionsStable}, interactionsOk=${after.interactionsOk}\n${after.regressions.join('\n')}`, { effort: 'xhigh' })
}

phase('Gate')
const gate = await agent(`In ${ROOT} run: npm run build; npx eslint . (report final problem total — CI requires 0 errors / <=31 warnings); npx playwright test (pass/fail). Report honestly, fix nothing.`, { effort: 'low', schema: { type: 'object', required: ['buildOk', 'lintErrors', 'lintWarnings', 'e2ePassed', 'e2eFailed'], properties: { buildOk: { type: 'boolean' }, lintErrors: { type: 'number' }, lintWarnings: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' } } } })
return { baseline: baseline.numbers, afterCheap: midMeasure.numbers, final: after.after, instanced: midMeasure.drawCallsDominant, gate }
