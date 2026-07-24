export const meta = {
  name: 'keap-cortex-validate',
  description: 'nos-cortex-lang P1 — POST /agent/v1/validate: hand-written parser + ontology typecheck + late-binding + authz, zero side effects',
  whenToUse:
    'The KEAP half of nos-cortex-lang P1, per ../nOS/docs/plans/nos-cortex-lang.md §3-§6 and the round-2 review in docs/specs/nos-cortex-lang-review-02.md. Run on feat/cortex-validate.',
  phases: [
    { title: 'Scout', detail: 'agent-surface conventions, ontology resolution surfaces, the authz/identity reality' },
    { title: 'Design', detail: 'resolve the open decisions into a committed spec — identity model, opcode registry, AST schema, error taxonomy' },
    { title: 'Parser', detail: 'hand-written lexer/parser + AST + opcode registry, pure and unit-tested' },
    { title: 'Endpoint', detail: 'operand resolution, late-binding, authz, route, OpenAPI, tests' },
    { title: 'Verify', detail: 'four adversarial lenses — security, grammar, contract fidelity, side-effect freedom' },
    { title: 'Fix', detail: 'apply the confirmed findings' },
    { title: 'Gate', detail: 'tsc + eslint + unit + knowledge gates + e2e' },
  ],
}

const ROOT = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const PLAN = '/Users/pazny/projects/nOS/docs/plans/nos-cortex-lang.md'
const REVIEW = `${ROOT}/docs/specs/nos-cortex-lang-review-02.md`
const BRANCH = 'feat/cortex-validate'

// Constraints every agent must respect. Repeated verbatim into each prompt —
// these are the ones that cost a release or a red CI when they were missed.
const RULES = `
HARD CONSTRAINTS (violating any of these fails the stage):
- Repo root ${ROOT}. You are on branch ${BRANCH}. NEVER checkout/merge/push main or dev, never create a tag.
- NO NEW DEPENDENCIES. Do not add a parser generator, a PEG library, zod-to-anything, nothing.
  The grammar is LL(1) and the plan says a hand tokenizer. A new dep forces a package-lock
  regeneration that has broken this repo's CI three times (npm 11 writes a lock npm 10 rejects).
- The eslint gate is 0 errors and MAX 31 WARNINGS, and the repo currently sits at exactly 31.
  Any new warning fails CI. Run \`npx eslint .\` before you claim done.
- \`npx tsc --noEmit\` must stay clean.
- Unit tests are vitest, \`server/**/*.test.ts\` (TS is fine there — the app workflow installs
  with scripts). Do NOT put .ts tests under knowledge/: that CI job installs --ignore-scripts,
  so .wxt/tsconfig.json is absent and NO .ts file in the repo can be transformed there.
- Commit your work on ${BRANCH} with a real message. Do not amend other stages' commits.
`

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'anchors'],
  properties: {
    findings: { type: 'string', description: 'What you learned, in prose. Be specific and cite file:line.' },
    anchors: {
      type: 'array',
      description: 'The exact code locations a later stage will need.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'where'],
        properties: {
          what: { type: 'string' },
          where: { type: 'string', description: 'file:line' },
          note: { type: 'string' },
        },
      },
    },
    hazards: {
      type: 'array',
      description: 'Things that would silently break an implementer who did not know them.',
      items: { type: 'string' },
    },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'severity', 'failure_scenario'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'repo-relative path, with :line if known' },
          severity: { type: 'string', enum: ['major', 'minor'] },
          failure_scenario: { type: 'string', description: 'Concrete input/state -> wrong behaviour. Not a worry, a mechanism.' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'why'],
  properties: {
    real: { type: 'boolean', description: 'true only if you could trace the failure in the actual code' },
    why: { type: 'string' },
  },
}

// ── Scout ──────────────────────────────────────────────────────────────────
phase('Scout')

const scouts = await parallel([
  () =>
    agent(
      `${RULES}
READ-ONLY. Do not edit anything.

Scout how KEAP's agent surface is built, so a new POST /agent/v1/validate route matches it exactly.
Report: how routes register (server/agent.ts registerAgentRoutes), the ok()/fail() response envelope and
its exact JSON shape, agentAuth and the AgentScope model, how OPENAPI_SPEC is maintained and whether a new
route must be added there, the \`contracts\` field in /agent/v1/health and when it gets bumped, request
validation conventions (is zod used? where? see shared/contracts/), and how existing agent routes return
typed errors. Also: how e2e specs for agent routes are written (e2e/*.spec.ts) and how they obtain a token.`,
      { label: 'scout:surface', phase: 'Scout', schema: SCOUT_SCHEMA },
    ),
  () =>
    agent(
      `${RULES}
READ-ONLY. Do not edit anything.

Scout every surface KEAP has for RESOLVING an operand, because /agent/v1/validate must typecheck
tax: / ent: / kg: / rel: operands against the live ontology and must also support LATE BINDING
(the caller writes ent:product[human term] and KEAP resolves it to a canonical id).

Report precisely:
- How to test whether a taxonomy node id exists. Ids are DOTTED ('01.01.03', 'nos.services.bookstack').
  Seed spine vs grown ext nodes (taxonomy_nodes_ext) vs the in-memory tree (server/taxonomy.ts allNodes,
  registerExtNodes). Which function answers "does this id resolve" for BOTH kinds.
- object_type_definitions: its schema, who writes it, and whether it is the right backing for ent:.
- The 16 relation predicates: db.listRelationTypes / relation_types, and the status semantics
  (seed|proposed|confirmed) — which of those count as a valid rel: operand.
- kg: — decide from the code what a knowledge-graph node operand could resolve against
  (knowledge_objects? the graph payload?) and report what exists, do not invent.
- For LATE BINDING: what search paths exist — FTS (rebuildTaxonomyFts, searchNodes), vector/hybrid
  (server/search.ts, embeddings, vectorSearchAvailable), and what each returns including scores.
  A candidate resolver needs scores to detect an AMBIGUOUS multi-match.
- Whether vector search can be unavailable at runtime and what the fallback is.`,
      { label: 'scout:ontology', phase: 'Scout', schema: SCOUT_SCHEMA },
    ),
  () =>
    agent(
      `${RULES}
READ-ONLY. Do not edit anything.

Scout the AUTHORIZATION reality of the agent surface. This is the hardest open question in the plan
and the design stage depends on getting the facts right, not on a hopeful reading.

The plan (${PLAN} §5.1) requires that /agent/v1/validate resolve operands against "the CALLING IDENTITY,
never the system identity", and return a UNIFORM 'unknown operand' for both "does not exist" and
"exists but you may not read it" — because distinguishable errors are themselves the disclosure.

Establish and report:
- What identity, if any, agentAuth actually establishes (server/agent.ts:59). Note that req.agentName
  comes from the X-Keap-Agent header — say plainly whether that is authenticated or self-asserted.
- How normal (non-agent) requests establish a user + groups: the Authentik header-OIDC path,
  server/identity.ts, and what getVisibleObjects/canReadObject (server/db.ts:1018, :1325) actually take.
- server/rbac.ts: tierRank / readableVisibilities / readableVisibilitiesFor — the ladder and its inputs.
- The v1.17 fix where GET /api/objects/:id leaked tier-scoped cards: find it (routes.ts, around the
  object GET) and report the EXACT pattern used for the uniform not-found/not-readable response.
- Whether any existing /agent/v1/* route is per-viewer scoped, or whether the whole surface is
  system-scope. Check /agent/v1/graph in particular — there is a documented comment about its
  visibility model; quote it.

Conclude with the honest answer to: CAN a request on the agent surface, as it exists today, be resolved
against a calling identity at all? If not, enumerate the possible ways to obtain one and what each costs.`,
      { label: 'scout:authz', phase: 'Scout', schema: SCOUT_SCHEMA },
    ),
])

const scoutBrief = scouts
  .filter(Boolean)
  .map((s, i) => `### Scout ${i + 1}\n${s.findings}\n\nANCHORS:\n${(s.anchors || []).map((a) => `- ${a.what} — ${a.where}${a.note ? ` (${a.note})` : ''}`).join('\n')}\n\nHAZARDS:\n${(s.hazards || []).join('\n')}`)
  .join('\n\n')

// ── Design ─────────────────────────────────────────────────────────────────
phase('Design')

const design = await agent(
  `${RULES}

You are designing KEAP's half of nos-cortex-lang P1: POST /agent/v1/validate.

READ FIRST, in full:
- ${PLAN} (the frozen plan — §3 grammar, §4 two-phase validation, §5 validity≠security, §6.1 late binding,
  §6.3 precedent rot / TTL / version pinning)
- ${REVIEW} (the round-2 review this repo wrote; it is the source of §4-§6 of the plan)

SCOUT REPORTS:
${scoutBrief}

Your output is a SPEC committed to ${ROOT}/docs/specs/cortex-validate.md, and nothing else — write no
implementation code. Decide, with reasons, every question an implementer would otherwise decide by accident:

1. THE IDENTITY MODEL. This is the one that matters. The plan demands per-caller authz; the scout will
   likely tell you the agent surface has no authenticated caller identity at all (X-Keap-Agent is a
   self-asserted header). Do NOT paper over this. Choose one and justify it:
   (a) validate runs at a declared, restricted scope and says so in its response;
   (b) a new capability-scoped token type carrying an identity binding;
   (c) an explicit identity parameter, which is self-asserted and therefore NOT an authz basis;
   (d) something better.
   Whatever you choose, the uniform 'unknown operand' rule must still hold, and the response must never
   let a caller distinguish "absent" from "not yours". State plainly what the chosen model does and does
   NOT protect against, so nobody later mistakes it for more than it is.

2. THE OPCODE REGISTRY. Opcodes are code-owned and must NOT live in relation_types (the plan §2 explains
   why: that registry grows under moderation and an LLM could otherwise propose a new system capability).
   But Wing owns the handlers, not KEAP. Decide where KEAP's copy lives, what it declares per opcode
   (arity? named params? which are mutating? which namespaces each accepts?), and how it stays in sync
   with Wing's handler map without KEAP learning about db:/svc:/doc: RESOURCES. Note the distinction:
   knowing the NAMESPACE db: exists is fine; knowing which databases exist is the coupling §4 forbids.

3. THE AST SCHEMA. Exact JSON. It must carry, per §6.3: the resolved id AND the surface term it came from,
   the name that id had at resolution time (for drift invalidation later), ontology version and
   database.id (from /agent/v1/health), and a TTL or expiry. Decide what "ontology version" concretely is
   in this codebase — there may be no such field yet; if so, define it from something that already exists
   and is stable, and say what.

4. THE ERROR TAXONOMY. Typed, machine-consumable, and safe. At minimum: syntax error (with position),
   unknown opcode, unknown operand (the uniform one), ambiguous operand (WITH candidates — §6.1 requires
   the validator to refuse rather than pick), deferred-namespace (db:/svc:/doc: — parsed, not resolved,
   handed to Wing), and arity/param errors. Decide whether ambiguous-operand candidates are themselves a
   disclosure risk under your identity model, and if so what is returned instead.

5. DEFERRED VALIDATION. Exactly how phase-2 operands appear in the AST so Wing can finish the job, and
   what KEAP guarantees about them (structural well-formedness only).

6. MUTATING VERBS. §5.3 wants dry_run defaulted on mutating opcodes. Decide whether validate INJECTS that
   default into the AST (a meaning-level rule) or merely reports its absence, and justify.

7. WHAT P1 EXPLICITLY DOES NOT DO. Name it, so the implementer does not drift into P2/P3.

Also produce a table of at least 12 CONCRETE example inputs with their expected outcome (valid → AST shape
summary, or the exact typed error). These become the implementation's test vectors, so make them cover the
nasty cases: late binding that resolves, late binding that is ambiguous, an operand that exists but is not
readable, a deferred namespace, a rel: operand that is not one of the 16, a mutating verb without dry_run,
malformed syntax at a known offset. Every example must be consistent with the plan's grammar — the plan
says examples that do not typecheck become bad training material.

Commit the spec. Return a tight summary of the decisions you made and their consequences for the implementer.`,
  { label: 'design:spec', phase: 'Design', effort: 'high' },
)

// ── Parser (pure, no DB) ───────────────────────────────────────────────────
phase('Parser')

const parser = await agent(
  `${RULES}

Implement the PURE half of POST /agent/v1/validate: the lexer, parser, AST types and the opcode registry.
No database access, no express, no I/O — this module must be unit-testable in isolation.

THE SPEC you must follow is committed at ${ROOT}/docs/specs/cortex-validate.md. Read it first, in full.
The grammar is in ${PLAN} §3. The design summary:
${design}

Build, in ${ROOT}/server/ (pick file names consistent with the repo's conventions, e.g. cortex-lang.ts
and cortex-opcodes.ts):
- A hand-written tokenizer. The grammar is LL(1); no backtracking, no dependency.
- A parser producing the AST the spec defines, with ACCURATE ERROR POSITIONS (offset and/or line:col) —
  a syntax error without a position is useless to the repair loop the plan describes in §7.
- Operand parsing for BOTH forms: a native dotted id (tax:nos.services.bookstack, tax:01.01.03) and the
  late-binding form (ent:product[human term]). Note the term can contain spaces and non-ASCII
  ('ent:product[červené tričko L]' is a literal example from the plan). Decide and document how a ']'
  inside a term is handled.
- The code-owned opcode registry per the spec, with the per-opcode declarations the spec settled on.
- Structural-only validation here: namespace known, opcode known, arity/params. NO ontology lookups —
  those belong to the next stage.

Write thorough unit tests as server/cortex-lang.test.ts covering the spec's example table (the syntax
half of it) plus: every operator in the grammar, an empty pipeline, a trailing pipe, unbalanced brackets,
an unterminated string, a term with a bracket, unicode terms, and position accuracy on at least three
distinct syntax errors.

Verify with: npx tsc --noEmit && npx vitest run server/cortex-lang && npx eslint .
Commit on ${BRANCH}. Return: the module/export names you created, the AST shape you emit, and anything in
the spec you found under-specified and had to decide yourself (be explicit — the next stage depends on it).`,
  { label: 'impl:parser', phase: 'Parser', effort: 'high' },
)

// ── Endpoint (resolution + authz + route) ──────────────────────────────────
phase('Endpoint')

const endpoint = await agent(
  `${RULES}

Implement the RESOLVING half of POST /agent/v1/validate and wire the route. The parser stage is done and
committed; build on it, do not rewrite it.

SPEC: ${ROOT}/docs/specs/cortex-validate.md (read in full). Plan: ${PLAN} §4, §5, §6.1, §6.3.
PARSER STAGE REPORT:
${parser}
SCOUT ANCHORS:
${scoutBrief}

Implement:
- Ontology resolution for tax: / ent: / kg: / rel: operands per the spec, using the surfaces the scout
  found. Native dotted ids resolve by exact lookup — no fuzzy matching on an id.
- LATE BINDING for the ns:type[term] form: resolve the term against the live ontology. MANDATORY:
  a comparable-score multi-match returns the spec's AMBIGUOUS error and the validator DOES NOT CHOOSE.
  The plan (§6.1) is explicit about why: a valid-but-wrong id is indistinguishable from a correct one
  after the fact, which is exactly the failure knowledge/ingest.mjs's identity-drift detector exists for.
  Handle the case where vector search is unavailable at runtime.
- AUTHZ per the spec's identity model, with the UNIFORM 'unknown operand' for absent-vs-unreadable.
  Mirror the v1.17 pattern the scout located.
- Deferred (db:/svc:/doc:) operands surfaced in the AST for Wing. KEAP must NOT gain any knowledge of
  which databases/services/documents exist.
- The AST stamping the spec requires: resolved id + surface term + name-at-resolution, ontology version,
  database.id, TTL/expiry.
- The route itself: POST /agent/v1/validate in server/agent.ts, following the surface conventions the
  scout reported (envelope, agentAuth scope, OPENAPI_SPEC entry).

ABSOLUTE: ZERO SIDE EFFECTS. This endpoint performs no writes of any kind — no rows, no logs-to-DB, no
embedding generation, no cache mutation that a caller could observe. If resolution would normally warm
something, do not.

Tests: extend/add server-side unit tests for resolution + authz + ambiguity, and add an e2e spec
(e2e/) exercising the route end-to-end including a typed-error case and the deferred-namespace case,
following how existing agent e2e specs get their token.

Verify with: npx tsc --noEmit && npm test && npx eslint . (0 errors, and the warning count must not rise
above 31). Commit on ${BRANCH}. Return what you implemented, what you deferred, and every place you
diverged from the spec with the reason.`,
  { label: 'impl:endpoint', phase: 'Endpoint', effort: 'high' },
)

// ── Verify (adversarial, four distinct lenses) ─────────────────────────────
phase('Verify')

const LENSES = [
  {
    key: 'security',
    prompt: `Attack the authorization and disclosure properties of the new /agent/v1/validate.
Specifically hunt: (1) any way a caller can distinguish "operand does not exist" from "operand exists but
is not readable" — timing, error text, error code, candidate lists, field presence, response size;
(2) the ambiguous-operand candidate list leaking entries the caller may not read; (3) the identity model
being weaker in the code than the spec claims; (4) anything that lets the agent token's system scope act
as a per-user authorization; (5) injection into any SQL/FTS/vector query built from operand text —
the late-binding term is attacker-controlled free text.
The v1.17 precedent is that this exact class of leak shipped once already.`,
  },
  {
    key: 'grammar',
    prompt: `Attack the parser's correctness against the grammar in ${PLAN} §3.
Hunt: inputs that parse but should not, inputs that should parse but do not, wrong or off-by-one error
positions, mishandling of the late-binding term (spaces, non-ASCII, nested or escaped brackets, empty
term), the distinction between a dotted id and a term, arity/param checking gaps, and any place the
implementation accepts a rel: operand that is not one of the 16 predicates. Also check the spec's own
example table is actually covered by tests and that each example behaves as the spec says.`,
  },
  {
    key: 'contract',
    prompt: `Attack the implementation's fidelity to the FROZEN PLAN and the committed spec.
Read ${PLAN} §4, §5, §6.1, §6.3 and ${ROOT}/docs/specs/cortex-validate.md, then check the code actually
does what they say. Hunt in particular: KEAP gaining knowledge of db:/svc:/doc: RESOURCES (the coupling
§4 forbids — knowing the namespace exists is fine, knowing which databases exist is not); opcodes leaking
into or being read from relation_types; the AST missing any of the §6.3 stamps (resolved id AND surface
term AND name-at-resolution AND ontology version AND database.id AND TTL); the ambiguity rule being
softened into "pick the best match"; and anything the implementer marked done that is not.`,
  },
  {
    key: 'purity',
    prompt: `Attack the claim that /agent/v1/validate has ZERO SIDE EFFECTS, and its runtime robustness.
Trace every call the handler makes and prove or disprove that nothing writes: no INSERT/UPDATE/DELETE, no
embedding generation, no FTS rebuild, no layout bake, no file write, no observable cache mutation. Then
hunt robustness: behaviour when the vector layer is unavailable (vectorSearchAvailable false), on a
pathologically long input, on deeply nested or very many stages, on an empty body, on a non-string body,
and whether any input can make the handler throw an unhandled exception rather than return a typed error.
Also check the TTL/expiry is actually computed from something sane and is not trivially stale or infinite.`,
  },
]

const verified = await pipeline(
  LENSES,
  (l) =>
    agent(
      `${RULES}
You are an adversarial reviewer. Read the diff on ${BRANCH} against dev (git diff dev...HEAD) and the
files it touches. Your job is to find REAL defects, not to praise the work.

${l.prompt}

Report only findings you can trace to specific code. For each, give a concrete failure scenario: an input
or state that produces a wrong result. "This could be risky" is not a finding. If you find nothing real,
return an empty list — a false finding costs more than a missed one here.`,
      { label: `verify:${l.key}`, phase: 'Verify', schema: FINDINGS_SCHEMA, effort: 'high' },
    ),
  (res, lens) =>
    parallel(
      // Per-finding adversarial refutation is the stage that has actually caught
      // shipped bugs in this repo (R3 stage 2's typed edges never rendered, and
      // the build/lint/e2e gate passed clean), so it stays one refuter per
      // finding rather than a batch adjudicator. Capped at 3 per lens, majors
      // first, to keep the agent count predictable — a lens that finds more than
      // three real defects has bigger problems than triage order.
      ((res && res.findings) || [])
        .slice()
        .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'major' ? -1 : 1))
        .slice(0, 3)
        .map((f) => () =>
        agent(
          `${RULES}
READ-ONLY. Try to REFUTE this claimed defect in the code on ${BRANCH}:

  title: ${f.title}
  file: ${f.file}
  severity: ${f.severity}
  scenario: ${f.failure_scenario}

Read the actual code and decide whether the failure really occurs. Many claimed defects are already
handled elsewhere, or rest on a misreading. Default to real=false when you cannot trace the failure
concretely in the code.`,
          { label: `refute:${lens.key}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((v) => ({ ...f, lens: lens.key, verdict: v })),
      ),
    ),
)

const confirmed = verified.flat().filter(Boolean).filter((f) => f.verdict && f.verdict.real)
log(`verify: ${verified.flat().filter(Boolean).length} claimed, ${confirmed.length} survived refutation`)

// ── Fix ────────────────────────────────────────────────────────────────────
phase('Fix')

let fixReport = 'no confirmed findings — fix stage skipped'
if (confirmed.length) {
  fixReport = await agent(
    `${RULES}

Adversarial review of ${BRANCH} confirmed these defects. Fix each one properly — no suppressions, no
eslint-disable, no widening a type to make an error go away, no deleting a test that now fails.

${confirmed.map((f, i) => `${i + 1}. [${f.severity}] (${f.lens}) ${f.title}\n   file: ${f.file}\n   scenario: ${f.failure_scenario}\n   refuter could not refute it: ${f.verdict.why}`).join('\n\n')}

For each: fix it, and add or extend a test that FAILS without your fix and passes with it. If you believe
a finding is wrong, say so explicitly with the code reason instead of changing anything.

Verify with: npx tsc --noEmit && npm test && npx eslint . (0 errors, warnings must not exceed 31).
Commit on ${BRANCH}. Return a per-finding line: fixed / not-a-defect (with the reason), and the test that
now covers it.`,
    { label: 'fix:confirmed', phase: 'Fix', effort: 'high' },
  )
}

// ── Gate ───────────────────────────────────────────────────────────────────
phase('Gate')

const gate = await agent(
  `${RULES}

Final gate for ${BRANCH}. Run every check this repo gates on and report the REAL result — if something
fails and you cannot fix it cleanly, say so plainly rather than papering over it. Do not weaken a gate to
make it pass (no --max-warnings bump, no test skip, no eslint-disable).

Run, in order, from ${ROOT}:
1. npx tsc --noEmit
2. npx eslint .            (must be 0 errors; report the warning count — CI allows max 31)
3. npm test                (all vitest suites)
4. node knowledge/lint.mjs
5. node knowledge/roundtrip.mjs
6. npm run build
7. npm run test:e2e        (playwright; if it cannot run in this environment, say so explicitly and
                            report which specs exist for the new route instead of claiming a pass)

Fix anything trivially broken (an import, a type, a stale snapshot). If a failure is substantive, report
it rather than hacking around it.

Then verify the branch hygiene: git log --oneline dev..HEAD shows the stages' commits, git status is
clean, and NOTHING touched main, dev, or any tag.

Return a per-check PASS/FAIL table with the actual numbers (test counts, warning count), the branch
hygiene result, and a short honest assessment of what is and is not covered by tests — specifically
call out anything that only a human eyeball or a live system can confirm.`,
  { label: 'gate:final', phase: 'Gate', effort: 'high' },
)

return {
  design: design.slice(0, 4000),
  parser: parser.slice(0, 3000),
  endpoint: endpoint.slice(0, 3000),
  claimed: verified.flat().filter(Boolean).length,
  confirmed: confirmed.map((f) => ({ lens: f.lens, severity: f.severity, title: f.title, file: f.file })),
  fixReport: typeof fixReport === 'string' ? fixReport.slice(0, 3000) : fixReport,
  gate,
}
