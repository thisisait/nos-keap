export const meta = {
  name: 'keap-lint-burndown',
  description: 'Burn the standing lint debt (121 errors / 154 problems) to zero errors with real types, then gate lint in CI',
  whenToUse: 'Plan item 5c hygiene. Parallel per-file fixers (disjoint partitions), loop-until-clean, then flip .github/workflows/app.yml to gate lint. Launch on a feature branch.',
  phases: [
    { title: 'Inventory', detail: 'eslint JSON → per-file buckets' },
    { title: 'Fix', detail: 'parallel fixers over disjoint file sets, loop until 0 errors' },
    { title: 'Gate', detail: 'build + e2e + eslint 0 errors' },
    { title: 'CI', detail: 'make lint a required step in app.yml' },
  ],
}

const ROOT = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const RULES = `
Fixing rules (violating any = the work is wrong):
- REAL fixes only: type the code properly (no-explicit-any → actual interfaces/structural types; unused vars → remove or use). eslint-disable comments are allowed ONLY where the rule is genuinely wrong for the line, with a one-line justification — expect near zero of these.
- ZERO behavioral changes: no logic edits, no refactors beyond what the type demands. If a correct fix would change behavior, SKIP it and report it instead.
- Do NOT run npm run build or playwright (other fixers run in parallel) — verify with 'npx eslint <your files>' and 'npx tsc --noEmit' scoped mentally to your edits only; the Gate phase runs the full suite once.
- Touch ONLY the files assigned to you. Do not commit — the workflow commits once at the end.
`

phase('Inventory')
const inv = await agent(`In ${ROOT} run 'npx eslint . --format json' (large output — write it to a temp file and parse with node). Return the per-file error/warning counts as a JSON array sorted by errors desc: [{file, errors, warnings, rules: [top rule ids]}]. Also return the grand totals.`, { effort: 'low', schema: { type: 'object', required: ['files', 'totalErrors', 'totalWarnings'], properties: { files: { type: 'array', items: { type: 'object', required: ['file', 'errors'], properties: { file: { type: 'string' }, errors: { type: 'number' }, warnings: { type: 'number' }, rules: { type: 'array', items: { type: 'string' } } } } }, totalErrors: { type: 'number' }, totalWarnings: { type: 'number' } } } })
log(`lint debt: ${inv.totalErrors} errors / ${inv.totalWarnings} warnings across ${inv.files.length} files`)

phase('Fix')
let remaining = inv.files.filter((f) => f.errors > 0)
const skipped = []
let round = 0
while (remaining.length && round < 3) {
  round++
  // Disjoint partitions of ~4 files → no two fixers touch the same file.
  const groups = []
  for (let i = 0; i < remaining.length; i += 4) groups.push(remaining.slice(i, i + 4))
  const reports = (await parallel(groups.map((g, i) => () =>
    agent(`${RULES}\nFix ALL eslint errors (warnings too where trivial) in these files of ${ROOT}:\n${g.map((f) => `- ${f.file} (${f.errors} errors; rules: ${(f.rules ?? []).join(', ')})`).join('\n')}\nReturn: files fully cleaned, and any error you SKIPPED with the reason.`, { label: `fix:r${round}g${i}`, phase: 'Fix', schema: { type: 'object', required: ['cleaned', 'skipped'], properties: { cleaned: { type: 'array', items: { type: 'string' } }, skipped: { type: 'array', items: { type: 'string' } } } } })))).filter(Boolean)
  skipped.push(...reports.flatMap((r) => r.skipped))
  const recheck = await agent(`In ${ROOT} run 'npx eslint . --format json' again (temp file + node parse). Return per-file ERROR counts only for files that still have errors, plus grand totals.`, { effort: 'low', schema: { type: 'object', required: ['files', 'totalErrors'], properties: { files: { type: 'array', items: { type: 'object', required: ['file', 'errors'], properties: { file: { type: 'string' }, errors: { type: 'number' }, rules: { type: 'array', items: { type: 'string' } } } } }, totalErrors: { type: 'number' } } } })
  log(`round ${round}: ${recheck.totalErrors} errors remain`)
  remaining = recheck.files.filter((f) => f.errors > 0)
}

phase('Gate')
const gate = await agent(`In ${ROOT}: npm run build (tsc runs here — type fixes must compile); npx playwright test; npx eslint . final totals. If build or e2e BROKE, bisect to the offending lint fix, repair it properly (keeping the lint fix intent), and re-run until green. Then 'git add -A && git commit' ONE commit: "chore(lint): burn error debt to N (real types, zero behavior change)". Report final numbers.`, { effort: 'xhigh', schema: { type: 'object', required: ['buildOk', 'e2ePassed', 'e2eFailed', 'lintErrors', 'lintWarnings'], properties: { buildOk: { type: 'boolean' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' }, lintErrors: { type: 'number' }, lintWarnings: { type: 'number' } } } })

phase('CI')
if (gate.buildOk && gate.lintErrors === 0 && gate.e2eFailed === 0) {
  await agent(`In ${ROOT} edit .github/workflows/app.yml: add a required lint step (npx eslint . --max-warnings ${gate.lintWarnings}) to the app gate — errors now block CI, warnings frozen at the current count. Commit "ci(app): gate lint (0 errors, warnings frozen)". Do not push.`, { effort: 'low' })
} else {
  log(`CI flip SKIPPED — gate not clean (errors=${gate.lintErrors}, e2eFailed=${gate.e2eFailed})`)
}
return { gate, skipped }
