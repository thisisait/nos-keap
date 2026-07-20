export const meta = {
  name: 'keap-selfmodel-gate',
  description: 'KEAP consumer gate for the nOS self-model fixture — ingest it, then assert the three invariants the contract pins',
  whenToUse:
    'When the nOS side has a self-model fixture to validate against KEAP (tests/fixtures/selfmodel/ in the nOS repo, or any canonical tree with a slug root). Runs the fixture through the REAL import path (knowledge/ingest.mjs against a throwaway DB) and asserts identity, visibility and removal — the three things the cross-repo contract says fail silently. Read-only against the live system: it never touches the live DB, never runs a converge. Args: { fixtureDir: string (canonical tree), addedServiceDir?: string (the SAME tree plus one service, for the two-run identity check) }.',
  phases: [
    { title: 'Ingest', detail: 'apply the fixture to a scratch DB via the real ingest path, twice if a second tree is given' },
    { title: 'Assert', detail: 'parallel checks: identity stability, anchor resolution, title distinctness, description quality' },
    { title: 'Report', detail: 'merge into a pass/fail verdict with the failing cases named' },
  ],
}

const OPTS = (() => {
  if (!args) return {}
  if (typeof args !== 'string') return args
  try {
    return JSON.parse(args)
  } catch {
    log(`args was an unparseable string (${args.slice(0, 80)}) — nothing to gate`)
    return {}
  }
})()

const REPO = '/Users/pazny/projects/knowledge-explorer-and-preserver'
const FIXTURE = OPTS.fixtureDir
const ADDED = OPTS.addedServiceDir ?? null

if (!FIXTURE) {
  log('No fixtureDir given — nothing to gate.')
  return { ok: false, note: 'fixtureDir required' }
}

const VERDICT = {
  type: 'object',
  required: ['ok', 'findings'],
  properties: {
    ok: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['check', 'ok', 'detail'],
        properties: {
          check: { type: 'string' },
          ok: { type: 'boolean' },
          detail: { type: 'string' },
          cases: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

// Scratch DB per run. roundtrip-setup builds the subset of the schema ingest
// touches; the live DB is never opened — a gate that can corrupt what it guards
// is not a gate.
const SETUP = `cd ${REPO} && export SCRATCH=$(mktemp -d) && node knowledge/roundtrip-setup.mjs >/dev/null 2>&1`

phase('Ingest')
const ingest = await agent(`Apply a self-model fixture through KEAP's REAL import path and report what landed.

1) Scratch DB + first ingest:
${SETUP} && KEAP_DATA_DIR=$SCRATCH node knowledge/ingest.mjs --canonical '${FIXTURE}' 2>&1 | tail -20

Note the SCRATCH path from your own shell — every later command must reuse it.
${
  ADDED
    ? `2) Second ingest over the SAME scratch DB, from a tree that adds one service:
KEAP_DATA_DIR=$SCRATCH node knowledge/ingest.mjs --canonical '${ADDED}' 2>&1 | tail -20

The INGEST_RESULT line carries reidentified: [{id, was, now}] — ids that kept
their slot but changed name. For a legitimate extension this MUST be empty; a
non-empty list means adding a service moved an existing one's identity.`
    : '2) No second tree given — skip the two-run identity check and say so.'
}

3) Dump what is in the scratch DB, for the assertions that follow:
KEAP_DATA_DIR=$SCRATCH node -e 'const D=require("libsql");const d=new D(process.env.KEAP_DATA_DIR+"/keap.db",{readonly:true});console.log(JSON.stringify({nodes:d.prepare("SELECT id,parent_id,name FROM taxonomy_nodes_ext ORDER BY id").all(),descs:d.prepare("SELECT node_id,description_en FROM node_descriptions").all()}))' > $SCRATCH/state.json && wc -c $SCRATCH/state.json

Report the scratch path, the two INGEST_RESULT lines verbatim, and any ⚠ lines.
If ingest errors, return that verbatim — do NOT retry with different flags.`, {
  schema: {
    type: 'object',
    required: ['scratch', 'ok'],
    properties: {
      scratch: { type: 'string' },
      ok: { type: 'boolean' },
      firstResult: { type: 'string' },
      secondResult: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
      error: { type: 'string' },
    },
  },
  phase: 'Ingest',
})

if (!ingest?.ok || !ingest?.scratch) {
  log(`Ingest failed — nothing to assert. ${ingest?.error ?? ''}`)
  return { ok: false, findings: [{ check: 'ingest', ok: false, detail: ingest?.error ?? 'ingest did not complete' }] }
}
log(`Fixture ingested into ${ingest.scratch}. Asserting the contract invariants.`)

// The three invariants the contract pins, plus the description-quality objection.
// Each is checked independently: they fail for different reasons and a merged
// check would report the first and hide the rest.
const CHECKS = [
  {
    key: 'identity',
    prompt: `IDENTITY — do ids survive a legitimate extension?

Read the two INGEST_RESULT lines below. The second run added one service to the
same tree. \`reidentified\` lists ids that kept their slot but changed name.

first:  ${ingest.firstResult ?? '(none)'}
second: ${ingest.secondResult ?? '(no second run)'}

PASS when reidentified is empty on the second run (or there was no second run —
say so and pass, but note the check did not actually execute).
FAIL when any id changed meaning, and name each one: that is a card silently
re-pointed at a different node, which nothing downstream can detect.`,
  },
  {
    key: 'anchors',
    prompt: `VISIBILITY — does every anchor resolve?

The fixture's CARD bodies carry [[id]] anchors. A card whose anchor does not
resolve renders NOWHERE in the constellation and is dropped silently, so this is
the check that nothing else will make for us.

Node ids that exist: read them from ${ingest.scratch}/state.json (field .nodes[].id).
Anchors the cards claim: grep the fixture tree for wiki refs —
  grep -rho '\\[\\[[a-z0-9.-]*\\]\\]' '${FIXTURE}' | sort -u

Compare. PASS when every anchor that looks like a taxonomy id (dotted lowercase
slug, or dotted 2-digit) is present in the node set. FAIL naming each orphan.
Ignore [[object:...]] refs — those are card-to-card, not anchors.`,
  },
  {
    key: 'titles',
    prompt: `DISTINCTNESS — are node names distinguishable?

Read .nodes[].name from ${ingest.scratch}/state.json.

Nine identically-named cards is what made the previous self-model an embedding
attractor: near-identical vectors that sit close to everything and specific to
nothing. The same failure at NODE level is worse, because nodes are what recall
aims INTO.

PASS when every name is unique within its parent, and no name repeats more than
twice across the whole tree. FAIL listing the repeats with their ids.`,
  },
  {
    key: 'descriptions',
    prompt: `DESCRIPTION QUALITY — are these recall targets or attractors?

Read .descs[] from ${ingest.scratch}/state.json.

The contract's own sentence: in a recall target, confident wrongness outranks
honest thinness. Templated descriptions ("<name> service in the <stack> stack")
across dozens of nodes recreate the attractor one layer up.

PASS when descriptions are substantive and mutually distinguishable: each says
what the thing DOES and how it differs from its siblings.
FAIL when they are templated — detect it by looking for a shared sentence
skeleton with only the name substituted, and quote two examples.
Also FAIL any description under 20 characters (the canonical schema's floor).`,
  },
]

phase('Assert')
const findings = await parallel(
  CHECKS.map((c) => () =>
    agent(`${c.prompt}

Return { "check": "${c.key}", "ok": <bool>, "detail": "<one sentence>", "cases": [<failing ids, at most 10>] }.
Be conservative: if you cannot READ the evidence, that is ok=false with the reason, never an assumed pass.`, {
      schema: {
        type: 'object',
        required: ['check', 'ok', 'detail'],
        properties: {
          check: { type: 'string' },
          ok: { type: 'boolean' },
          detail: { type: 'string' },
          cases: { type: 'array', items: { type: 'string' } },
        },
      },
      phase: 'Assert',
      label: `check:${c.key}`,
    }),
  ),
)

phase('Report')
const got = findings.filter(Boolean)
// A dropped agent is a FAILED check, not a passed one — a gate that treats
// missing evidence as success is worse than no gate.
const missing = CHECKS.filter((c) => !got.some((f) => f.check === c.key)).map((c) => ({
  check: c.key,
  ok: false,
  detail: 'check did not report — treat as failure, not as pass',
}))
const all = [...got, ...missing]
const ok = all.every((f) => f.ok)
log(`${ok ? 'PASS' : 'FAIL'} — ${all.filter((f) => f.ok).length}/${all.length} checks green`)
for (const f of all.filter((x) => !x.ok)) log(`  ✗ ${f.check}: ${f.detail}`)
return { ok, findings: all, scratch: ingest.scratch }
