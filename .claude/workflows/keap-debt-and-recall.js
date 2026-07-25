export const meta = {
  name: 'keap-debt-and-recall',
  description: 'KEAP-side alignment: turn the recall gate from a 4-case tripwire into a 261-query instrument, and clear the standing debt',
  whenToUse: 'Runs in the KEAP repo on feat/align-debt, in parallel with the nOS cortex port (file-disjoint by repo).',
  phases: [
    { title: 'Measure', detail: 'how many of the 261 nOS queries are measurable, and why the rest are not' },
    { title: 'Instrument', detail: 'wire the full query set in as a reportable gate with an honest denominator' },
    { title: 'Debt', detail: 'branches, the 31 warnings, and the deployment inconsistencies' },
    { title: 'Verify', detail: 'two adversarial lenses' },
    { title: 'Report', detail: 'actual numbers' },
  ],
}

const KEAP = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const NOS = '/Users/pazny/projects/nOS'
const QUERIES = `${NOS}/tests/fixtures/selfmodel-recall.json`
const BRANCH = 'feat/align-debt'

const RULES = `
HARD CONSTRAINTS:
- You work in ${KEAP} on branch ${BRANCH}. NEVER touch main/dev, never tag, never release.
- ${NOS} is READ-ONLY to you (another workflow is writing there). Read its query fixture; edit nothing.
- DO NOT DEPLOY: no ansible, no docker restart, no converge, no writes to the live /data or any path under
  /Volumes/SSD1TB. Probing the live container read-only is fine.
- The eslint gate is 0 errors / max 31 warnings and the repo sits at exactly 31. Never raise it.
- \`npx tsc --noEmit\` stays clean. Knowledge gates stay green: spine-render --check, lint.mjs,
  onto1-conformance.mjs, roundtrip.mjs.
- Tests under knowledge/ must be .mjs, NOT .ts — that CI job installs --ignore-scripts, so no .ts file in the
  repo can be transformed there.
- Commit each stage with a real message.
`

const SCHEMA_MEASURE = {
  type: 'object', additionalProperties: false, required: ['summary', 'measurable', 'total', 'reasons'],
  properties: {
    summary: { type: 'string' },
    total: { type: 'number' }, measurable: { type: 'number' }, passing: { type: 'number' },
    reasons: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['reason', 'count'], properties: { reason: { type: 'string' }, count: { type: 'number' }, example: { type: 'string' } } } },
  },
}
const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'file', 'severity', 'failure_scenario'], properties: { title: { type: 'string' }, file: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor'] }, failure_scenario: { type: 'string' } } } } },
}
const VERDICT_SCHEMA = { type: 'object', additionalProperties: false, required: ['real', 'why'], properties: { real: { type: 'boolean' }, why: { type: 'string' } } }

phase('Measure')
const measured = await agent(`${RULES}

The recall gate currently carries FOUR hand-written cases at k=5 (e2e/fixtures/selfmodel-recall.json). That is
a tripwire for a gross regression, not an instrument. nOS generates 261 cases from the estate's SKILLS.md
trigger lines at ${QUERIES} — the doctrine there is explicit and must be respected: **KEAP owns the recall
MACHINERY, nOS owns the EXPECTATIONS.** So do NOT copy those 261 cases into this repo as a second source of
truth; the gate already accepts --queries.

Read scripts/recall-gate.mjs in full, then MEASURE. Run it against the 261-case set and establish, with real
numbers:
  - how many cases are measurable at all, and how many pass;
  - for the unmeasurable ones, WHY, grouped by cause with counts and one concrete example each. A prior
    interim read said card absence dominated — verify or refute that, do not repeat it.
The gate needs host Ollama (it is reachable) and \`npm run build\` first. Exit 4 means "skipped loudly" and is
NOT a pass — if you hit it, say so.

Report the honest denominator. A gate that silently measures 51 of 261 while reporting a percentage of 51 is
worse than one that measures 4, because it reads as coverage it does not have.`,
  { label: 'recall:measure', phase: 'Measure', schema: SCHEMA_MEASURE, effort: 'high' })

phase('Instrument')
const instrument = await agent(`${RULES}

Make the full query set a routine, honest gate. Measurement from the previous stage:
${JSON.stringify(measured, null, 1)}

Implement, in scripts/recall-gate.mjs and package.json:
- A mode that consumes an EXTERNAL query set by path (it already has --queries; make it first-class and
  documented) plus an npm script for the nOS set.
- A reported result that always names its DENOMINATOR: measured/total, passing/measured, and the unmeasurable
  count BROKEN DOWN BY CAUSE. Never print a bare percentage whose base is invisible — that is the "corpus
  exhausted" class of lie this codebase already regrets once.
- A regression baseline: record the current passing set so a future run can report which cases newly FAILED
  (a regression) separately from which are still unmeasurable (a corpus gap). Those are different problems and
  must not share a number.
- Keep exit semantics: 0 pass, 1 regression, 4 skipped-loudly.

Then fix what is cheaply fixable on the KEAP side only — do NOT edit nOS. If the dominant cause is card
absence or a corpus gap, that is nOS's to fix; report it rather than papering over it.

Document the whole thing in docs/specs/ (a short honest page: what the gate measures, what it cannot, and how
to read its output). Verify with a real run and report numbers.`,
  { label: 'recall:instrument', phase: 'Instrument', effort: 'high' })

phase('Debt')
const debt = await agent(`${RULES}

Clear the standing debt. Each item, with evidence, and NOTHING beyond this list — resist scope creep:

1. **Stale branches.** 15 local branches are already merged into main (git branch --merged main). Delete the
   merged ones, LOCAL ONLY, and never delete anything unmerged or any remote branch. List what you deleted and
   what you deliberately kept, with the reason.
2. **The 31 eslint warnings** — 22 react-hooks/exhaustive-deps + 7 react-refresh/only-export-components + 2
   others, all frontend, all sitting exactly AT the CI cap so any new warning fails the build. Fix them
   properly: a genuinely missing dependency gets added; a deliberately-omitted one gets an explanatory comment
   and a scoped disable naming WHY, not a blanket disable. If a fix would change runtime behaviour, leave it
   and say so — a wrong dependency array causes stale closures or render loops, and silence is worse than the
   warning. Lower the CI cap in .github/workflows/app.yml to whatever count you actually reach.
3. **The deployment inconsistency I flagged and nobody fixed.** compose bind-mounts
   /Users/pazny/keap/src/knowledge/canonical into the container while the rest of knowledge/ (ontology, spine)
   comes from the image — so the two halves of one SoT can sit at different versions. That checkout is also
   stale (v1.26.0, zero cortex code). This repo cannot change the nOS compose template, so: document the
   hazard precisely in docs/specs/ with what a converge would have to do differently, so the nOS side can act
   on a written statement rather than a memory of a conversation.
4. **Dead schema.** object_type_definitions is created by migration 001 and touched by zero lines of code.
   Do NOT drop the table (a migration to drop it costs more than it saves and the ent: work may yet want it) —
   add a comment at its DDL naming it as unused, and the one condition under which it becomes real.

Verify after each: tsc clean, npm test green, eslint at or below the new cap, knowledge gates green.`,
  { label: 'debt:clear', phase: 'Debt', effort: 'high' })

phase('Verify')
const LENSES = [
  { key: 'honesty', prompt: `Attack the recall gate's REPORTING for any way it can read as more coverage than it has. Hunt: a percentage whose denominator is invisible or wrong; unmeasurable cases silently counted as passes or silently dropped; the regression baseline masking a genuine new failure; exit 0 on a run that measured nothing; a case that "passes" because its expectation resolved to something unintended. Also verify the 261 cases were NOT copied into this repo as a second source of truth.` },
  { key: 'regression', prompt: `Attack the debt stage for behaviour change smuggled in as cleanup. Every react-hooks/exhaustive-deps fix that ADDED a dependency changes when an effect or callback re-runs — hunt for added deps that can cause a render loop, a refetch storm, or a reset of user state, and for any eslint-disable added without a reason that actually explains itself. Check no test was weakened or deleted, no type widened, and that the CI warning cap was lowered rather than raised.` },
]
const verified = await pipeline(
  LENSES,
  (l) => agent(`${RULES}
Adversarial review of ${BRANCH} (git diff dev...HEAD). Real defects with concrete failure scenarios only.
${l.prompt}`, { label: `verify:${l.key}`, phase: 'Verify', schema: FINDINGS_SCHEMA, effort: 'high' }),
  (res, lens) => parallel(((res && res.findings) || [])
    .slice().sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'major' ? -1 : 1)).slice(0, 3)
    .map((f) => () => agent(`${RULES}
READ-ONLY. Try to REFUTE: ${f.title} — ${f.file} — ${f.failure_scenario}
Default to real=false when you cannot trace it in the code.`, { label: `refute:${lens.key}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then((v) => ({ ...f, lens: lens.key, verdict: v })))),
)
const confirmed = verified.flat().filter(Boolean).filter((f) => f.verdict && f.verdict.real)
log(`verify: ${verified.flat().filter(Boolean).length} claimed, ${confirmed.length} confirmed`)

phase('Report')
const report = await agent(`${RULES}
${confirmed.length ? `First FIX these confirmed defects, each with a test that fails without the fix:\n${confirmed.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} — ${f.file}\n   ${f.failure_scenario}`).join('\n\n')}\n\nThen report.` : 'No confirmed defects. Report.'}

Run every gate and report ACTUAL numbers: npx tsc --noEmit · npx eslint . (error and warning counts, and the
cap now set in app.yml) · npm test · node knowledge/spine-render.mjs --check · lint.mjs · onto1-conformance.mjs
· roundtrip.mjs · the recall gate against the 261 set (measured/total, passing/measured).
Confirm nothing under ${NOS} was modified and nothing touched main/dev.
State plainly what is still owed and what only nOS can fix.`,
  { label: 'report:final', phase: 'Report', effort: 'high' })

return { measured, instrument: instrument.slice(0, 2500), debt: debt.slice(0, 2500), claimed: verified.flat().filter(Boolean).length, confirmed: confirmed.map((f) => ({ lens: f.lens, severity: f.severity, title: f.title })), report }
