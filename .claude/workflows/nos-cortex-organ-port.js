export const meta = {
  name: 'nos-cortex-organ-port',
  description: 'P-4 — port KEAP v1.27.0 cortex modules into the nOS anatomy as pazny.cortex; prove onto1 byte-identity; do NOT deploy',
  whenToUse:
    'The C1 stage of docs/specs/cortex-full-scope-decision.md, per ../nOS/docs/plans/nos-cortex-organ-design.md build sequence steps 1-8. Runs in the nOS repo on feat/cortex-organ.',
  phases: [
    { title: 'Scout', detail: 'the nOS organ conventions, and the exact KEAP port set' },
    { title: 'Scaffold', detail: 'files/anatomy/cortex + toolchain frozen, pure modules green with zero DB' },
    { title: 'Store', detail: 'schema, git materialisation, ANN at the measured optimum' },
    { title: 'Gate', detail: 'the hard gate — onto1 byte-identity over the real tree' },
    { title: 'Daemon', detail: 'the loopback route, fail-closed auth, health' },
    { title: 'Verify', detail: 'three adversarial lenses' },
    { title: 'Fix', detail: 'confirmed findings only' },
    { title: 'Report', detail: 'honest state, including what is not covered' },
  ],
}

const KEAP = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const NOS = '/Users/pazny/projects/nOS'
const DESIGN = `${NOS}/docs/plans/nos-cortex-organ-design.md`
const SCOPE = `${KEAP}/docs/specs/cortex-full-scope-decision.md`
const CONTRACT = `${KEAP}/docs/specs/onto1-composition-contract.md`
const BRANCH = 'feat/cortex-organ'

const RULES = `
HARD CONSTRAINTS (violating any fails the stage):
- You work in the nOS repo at ${NOS}, on branch ${BRANCH}. NEVER touch main/dev there, never tag.
- ${KEAP} is READ-ONLY to you. Port FROM it; never edit it.
- PORT, NOT REWRITE. A rewrite breaks onto1 byte-identity and then the two sides silently
  reject each other's ASTs. cortex-lang.ts / cortex-opcodes.ts / shared/contracts/cortex.ts
  lift VERBATIM; cortex-resolve.ts / cortex-ontology-version.ts / cortex-validate.ts take
  IMPORT-PATH REWRITES ONLY. If you find yourself improving logic, stop — that is a defect.
- DO NOT DEPLOY. No ansible-playbook, no docker, no launchctl/systemctl, no converge, no
  writes anywhere under /Volumes/SSD1TB. Build sequence steps 9-13 (Ansible role, plugin,
  blank verify, KEAP cutover) are explicitly OUT OF SCOPE for this workflow.
- NO db_identity CARRY-OVER and NO SHARED keap.db. Both are written as intent in the design
  doc and both are WRONG — see ${SCOPE} "Two corrections". The organ mints its own identity
  and materialises everything from git.
- Node 22. npm (not pnpm). Validate the lockfile with \`npx npm@10 ci --dry-run\` before you
  commit it: npm 11 writes a lock npm 10 rejects, and that has broken CI in the KEAP repo
  three times.
- Commit each stage on ${BRANCH} with a real message.
`

const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: { type: 'string' },
    anchors: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['what', 'where'], properties: { what: { type: 'string' }, where: { type: 'string' }, note: { type: 'string' } } } },
    hazards: { type: 'array', items: { type: 'string' } },
  },
}
const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'file', 'severity', 'failure_scenario'], properties: { title: { type: 'string' }, file: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor'] }, failure_scenario: { type: 'string' } } } },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['real', 'why'],
  properties: { real: { type: 'boolean' }, why: { type: 'string' } },
}

phase('Scout')
const scouts = await parallel([
  () => agent(`${RULES}
READ-ONLY, no edits.
Scout how an nOS host organ is built, so pazny.cortex matches the estate rather than inventing a shape.
Read ${DESIGN} first (§2, §5, §6). Then study the FACE organ as the closest Node precedent and BONE as the
role precedent: files/anatomy/face/*, roles/pazny.bone/*, the CI workflow's face job, plugins/*/plugin.yml,
state/manifest.yml, and how a daemon is registered (plist/systemd_user). Report the concrete conventions a new
organ must follow: directory layout, package.json/tsconfig shape, how the build runs, how the daemon is declared,
how tokens/credentials are provisioned, and how tests are wrapped into tests/anatomy/ pytest shims.`,
    { label: 'scout:organ', phase: 'Scout', schema: SCOUT_SCHEMA }),
  () => agent(`${RULES}
READ-ONLY, no edits.
Determine the EXACT port set from KEAP v1.27.0 at ${KEAP} (branch dev, tag v1.27.0).
Read ${DESIGN} §4 for the intended list, then VERIFY it against the code — the design was written from a
summary and may be wrong about what a module actually imports.
For each of server/cortex-lang.ts, cortex-opcodes.ts, cortex-resolve.ts, cortex-ontology-version.ts,
cortex-validate.ts, shared/contracts/cortex.ts: list its exact imports and, transitively, the MINIMUM subset of
server/db.ts, server/migrations.ts, server/taxonomy.ts, server/rbac.ts, server/search.ts and
src/game/{data,types}/taxonomy that must come with them.
Critically: enumerate every DB read those modules make. The scope decision claims they read only the taxonomy
FTS index, relation_types and the store identity — ZERO reads of knowledge_objects. VERIFY that claim and say
plainly if it is false, because the whole C1-needs-no-migration argument rests on it.
Also list the test files, knowledge/ artifacts and docs/specs that must travel.`,
    { label: 'scout:portset', phase: 'Scout', schema: SCOUT_SCHEMA }),
])
const brief = scouts.filter(Boolean).map((s, i) => `### Scout ${i + 1}\n${s.findings}\n\nANCHORS:\n${(s.anchors || []).map((a) => `- ${a.what} — ${a.where}${a.note ? ` (${a.note})` : ''}`).join('\n')}\n\nHAZARDS:\n${(s.hazards || []).join('\n')}`).join('\n\n')

phase('Scaffold')
const scaffold = await agent(`${RULES}
Scaffold the organ and prove the PURE half lifted cleanly. Build sequence steps 1-3 of ${DESIGN} §6.

SCOUT REPORTS:
${brief}

Create ${NOS}/files/anatomy/cortex/ with the vendored port set, a package.json (type: module, Node 22, deps
pinned as KEAP ships them: libsql, zod, express; dev: typescript, vitest, tsx, @playwright/test) and a tsconfig.
Copy knowledge/{onto1-compose.mjs, onto1-conformance.mjs, spine/, fixtures/onto1/} and the relevant docs/specs.

Then: npm install, commit package-lock.json (validated with npx npm@10 ci --dry-run), and get the ZERO-DB tests
green — cortex-lang.test.ts and the opcode/registry-hash cases. That is the proof the verbatim modules lifted.

Do NOT wire the store yet. Report exactly which files you copied verbatim, which needed import-path rewrites,
and any place the scout's port set turned out to be wrong.`,
  { label: 'port:scaffold', phase: 'Scaffold', effort: 'high' })

phase('Store')
const store = await agent(`${RULES}
Wire the runtime store. Build sequence steps 4 and 6.

SCAFFOLD REPORT:
${scaffold}

The organ materialises its tree FROM GIT — the spine from knowledge/spine/*.json and the delta from
knowledge/canonical/ via the ported ingest path — into its own libsql store. It must NOT read KEAP's keap.db.
Store path comes from config (cortex_store_path), defaulting under the organ's own data dir.

Build the ANN index at the MEASURED optimum: compress_neighbors=float8 + max_neighbors=20 (65.6 MB,
~1.72 ms/query, recall@10 100% on the real corpus). NOT float1bit. Keep KEAP's vectorsOk try/catch so a
stock-SQLite build degrades to FTS-only rather than crashing.

Get cortex-resolve.test.ts green against the seeded store. Report the store schema you created, how the git
materialisation runs, and anything the ported code assumed about KEAP's DB that is not true here.`,
  { label: 'port:store', phase: 'Store', effort: 'high' })

phase('Gate')
const gate = await agent(`${RULES}
THE HARD GATE. Build sequence step 5. Do not paper over a failure here — a wrong digest means the organ
silently rejects KEAP's ASTs in production, which is the exact failure this whole contract exists to prevent.

Read ${CONTRACT} in full.

Two things must be true:
1. \`node knowledge/onto1-conformance.mjs\` passes all six fixtures inside the organ.
2. The organ reproduces onto1:76d1f3ad728b382b over the real tree. NOTE THE INPUT STATE THIS DIGEST IS
   DEFINED FOR: 790 spine nodes, ZERO ext rows, and the 16 SEED relation types. A different relation_types
   state legitimately yields a different digest — if you get a mismatch, first establish which state you are in
   before concluding the port is wrong.

Port onto1-agreement.test.ts so the organ's runtime composition is checked against the reference
implementation over the real tree, not only against the six fixtures — two implementations can agree on six
toy cases and diverge on 790 nodes.

If the digest does not match: find out WHICH field diverged (the canonical serialization is the diagnostic;
compare line by line) and fix the PORT, never the fixture or the contract. Report the first differing line if
you cannot close it.`,
  { label: 'port:onto1-gate', phase: 'Gate', effort: 'high' })

phase('Daemon')
const daemon = await agent(`${RULES}
Stand up the daemon and its route. Build sequence steps 7-8, and STOP THERE — no Ansible role, no plugin,
no converge.

GATE REPORT:
${gate}

Mount POST /agent/v1/validate and GET /agent/v1/validate/opcodes on loopback 127.0.0.1:8098, plus a /health
carrying ontologyVersion + databaseId + opcodeRegistryHash. Port server/tokens.ts VERBATIM — bearer comparison
must stay crypto.timingSafeEqual over sha256, never ===. Keep KEAP's fail-closed rule: no token configured
⇒ 503 "agent surface disabled", never an implicit identity.

The organ mints its OWN db_identity. Do not copy KEAP's.

Port e2e/validate.spec.ts and get it green against the BUILT bundle (npm run build → dist-server/index.js),
which is the artifact a host would run — tsx stays dev-only. Report what is mounted, what is not, and the
build output size.`,
  { label: 'port:daemon', phase: 'Daemon', effort: 'high' })

phase('Verify')
const LENSES = [
  { key: 'fidelity', prompt: `Attack the claim that this is a PORT and not a rewrite. Diff the vendored modules in ${NOS}/files/anatomy/cortex/ against their originals in ${KEAP}/server/ and ${KEAP}/shared/. cortex-lang.ts, cortex-opcodes.ts and shared/contracts/cortex.ts must be byte-identical apart from import paths; the resolver trio must differ ONLY in import paths. Report every semantic change, however well-intentioned — an "improvement" here is a defect, because it can move onto1 or the resolution result while every local test still passes.` },
  { key: 'isolation', prompt: `Attack the claim that the organ is independent of KEAP's runtime. Hunt any read of KEAP's keap.db, any path pointing into the KEAP container's /data or the host bind-mount, any assumption that KEAP is running, any shared file, any second writer. Also check the organ materialises its tree from git rather than from a copied database, and that its ANN index is actually built with float8 + max_neighbors=20 rather than defaults.` },
  { key: 'security', prompt: `Attack the auth and disclosure surface. Verify: tokenless ⇒ 503 (never open by accident); bearer compared with timingSafeEqual over sha256; validate is agentAuth('ro') and has zero side effects; the kg:/ent: refusal is still a constant computed from the namespace alone with NO DB call (a timing oracle is a disclosure); ambiguous-operand candidate lists are capped; and nothing binds to anything but 127.0.0.1. Also check the organ did not adopt KEAP's db_identity.` },
]
const verified = await pipeline(
  LENSES,
  (l) => agent(`${RULES}
You are an adversarial reviewer. Read the diff on ${BRANCH} (git diff dev...HEAD in ${NOS}) and the files it
touches. Find REAL defects with a concrete failure scenario — an input or state producing a wrong result.
"This could be risky" is not a finding; an empty list is a fine answer.

${l.prompt}`,
    { label: `verify:${l.key}`, phase: 'Verify', schema: FINDINGS_SCHEMA, effort: 'high' }),
  (res, lens) => parallel(((res && res.findings) || [])
    .slice().sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'major' ? -1 : 1)).slice(0, 3)
    .map((f) => () => agent(`${RULES}
READ-ONLY. Try to REFUTE this claimed defect on ${BRANCH}:
  ${f.title} — ${f.file}
  scenario: ${f.failure_scenario}
Read the actual code. Default to real=false when you cannot trace the failure concretely.`,
      { label: `refute:${lens.key}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then((v) => ({ ...f, lens: lens.key, verdict: v })))),
)
const confirmed = verified.flat().filter(Boolean).filter((f) => f.verdict && f.verdict.real)
log(`verify: ${verified.flat().filter(Boolean).length} claimed, ${confirmed.length} confirmed`)

phase('Fix')
let fixReport = 'no confirmed findings'
if (confirmed.length) {
  fixReport = await agent(`${RULES}
Fix these confirmed defects. No suppressions, no widened types, no deleted tests.

${confirmed.map((f, i) => `${i + 1}. [${f.severity}] (${f.lens}) ${f.title}\n   ${f.file}\n   ${f.failure_scenario}\n   refuter: ${f.verdict.why}`).join('\n\n')}

For each, add or extend a test that fails without the fix. If a finding is wrong, say so with the code reason
instead of changing anything. Re-run the full suite plus onto1-conformance and report real numbers.`,
    { label: 'fix:confirmed', phase: 'Fix', effort: 'high' })
}

phase('Report')
const report = await agent(`${RULES}
Final honest report for ${BRANCH}. Run every check and report ACTUAL numbers, not intentions:
  npm run build · npm test · npx vitest run (counts) · node knowledge/onto1-conformance.mjs ·
  the onto1 digest over the real tree · npm run test:e2e (or say plainly it cannot run here)
Confirm branch hygiene: nothing touched nOS main/dev, nothing under ${KEAP} was modified (git status there
must be clean), no deploy ran.
Then state what is NOT done — build sequence steps 9-13 are out of scope by design — and what only a live
converge or a human could confirm.`,
  { label: 'report:final', phase: 'Report', effort: 'high' })

return { scaffold: scaffold.slice(0, 2500), store: store.slice(0, 2500), gate: gate.slice(0, 3000), daemon: daemon.slice(0, 2000), claimed: verified.flat().filter(Boolean).length, confirmed: confirmed.map((f) => ({ lens: f.lens, severity: f.severity, title: f.title })), fixReport: String(fixReport).slice(0, 2500), report }
