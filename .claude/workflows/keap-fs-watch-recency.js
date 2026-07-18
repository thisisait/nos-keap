export const meta = {
  name: 'keap-fs-watch-recency',
  description: 'fs.watch-driven near-instant sync (interval stays as fallback) + recency lens (mtime age gradient) in explore',
  whenToUse: 'Plan item 5a+5b (v1.11b). Two lanes, run sequentially (both touch server). Launch on a feature branch.',
  phases: [
    { title: 'Scout', detail: 'sync triggers, mount lifecycle, lens plumbing' },
    { title: 'Implement', detail: 'S1 fs-watch, S2 recency lens' },
    { title: 'Verify', detail: 'watch-edge refuters + fixer' },
    { title: 'Gate', detail: 'build + lint baseline + e2e' },
  ],
}

const ROOT = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- The fs-sync USERS pass mirror semantics (ids, skip keys, prune guards) are FROZEN — a watcher may only change WHEN sync runs, never WHAT it does.
- Watcher discipline: never follow symlinks; debounce bursts (>=2s); never watch a non-existent root (re-arm via the surviving interval); cap watcher count; EMFILE/ENOSPC degrade to interval-only with ONE warning, not a crash loop. Node fs.watch recursive works on macOS + Linux (Node >=20 in the container) — verify at runtime, degrade if not.
- Spatial memory: the recency lens recolors ONLY — zero position changes.
- Lint baseline must not grow; i18n en+cs; npm run build && npx playwright test green; commit per stage on the CURRENT branch; never touch main.
`

phase('Scout')
const scout = await agent(`In ${ROOT}, brief two features:
A) fs-watch: server/fs-sync.ts triggers today (boot after listen, KEAP_FS_SYNC_INTERVAL_S, POST /agent/v1/fs/sync). Where USER_FILES_DIR + mapping roots (server/fs-roots.ts) resolve; how mount absence is handled (exists:false retention). Where a watcher module would hook in (index.ts boot order).
B) recency lens: how objects ship in /api/graph (frontmatter has mtime — is it in the payload?), how the semantic lens works client-side (GraphCanvas LensState, lensColor, the Lens bar in Explore.tsx) so "Recent" can join as an axis-like option with an age gradient.
Return a terse brief with file anchors.`, { schema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } } })

phase('Implement')
const s1 = await agent(`${INVARIANTS}
S1 fs-watch in ${ROOT}, per brief:\n${scout.brief}\n
- New server module (e.g. server/fs-watch.ts): recursive watchers over KEAP_USER_FILES_DIR and each available mapping root; debounced (2s) trigger of the EXISTING sync entrypoints (users pass / syncMapping for the touched root — reuse, do not reimplement); env kill-switch KEAP_FS_WATCH=0.
- Status: fsSyncStatus gains an additive watch block (enabled, watchedRoots, lastEvent).
- e2e: spec that writes a file into the e2e userfiles dir and asserts the object appears WITHOUT calling /agent/v1/fs/sync (poll /api/graph, generous timeout).
Build+lint+e2e green, commit, return handoff notes.`, { effort: 'high' })
await agent(`${INVARIANTS}
S2 recency lens in ${ROOT}. S1 notes:\n${s1}\n
- Ship mtime on graph objects (additive field).
- Lens bar gains "Recent": objects (and optionally folder hubs by newest child) recolored on an age gradient (hot = this week, cold = old); taxonomy stars untouched. Legend/i18n en+cs.
- e2e: payload assertion for mtime presence on fs objects.
Build+lint+e2e green, commit, return summary.`, { effort: 'high' })

phase('Verify')
const verdicts = await parallel([
  () => agent(`Adversarially audit the fs-watch commits in ${ROOT}: unmount storms (editor atomic-save bursts, rm -rf of a watched tree, mount disappearing mid-watch), watcher leaks on repeated arm/disarm, prune-guard interaction (a watch-triggered sync during an unmount must NOT mass-prune — the guards must hold), double-sync races with the interval. Default refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
  () => agent(`Adversarially audit the recency-lens commits in ${ROOT}: position immutability, payload size, missing-mtime objects, i18n parity, lens interaction with the existing axis lens. Default refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
])
const problems = verdicts.filter(Boolean).flatMap((v) => (v.refuted ? v.findings : []))
if (problems.length) {
  await agent(`${INVARIANTS}\nFix these verified findings in ${ROOT} (current branch), re-run gates, commit:\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`, { effort: 'xhigh' })
}

phase('Gate')
const gate = await agent(`In ${ROOT} run: npm run build; npx eslint . (final total); npx playwright test. Report honestly, fix nothing.`, { effort: 'low', schema: { type: 'object', required: ['buildOk', 'lintTotal', 'e2ePassed', 'e2eFailed'], properties: { buildOk: { type: 'boolean' }, lintTotal: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' } } } })
return { problems, gate }
