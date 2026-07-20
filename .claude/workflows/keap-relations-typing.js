export const meta = {
  name: 'keap-relations-typing',
  description: 'Track R3 fill — host-side Sonnet typing of cross-type candidate pairs into PROPOSED typed relations (controlled batches)',
  whenToUse: 'AFTER v1.16.0 is deployed and healthy. Populates the typed-relation graph: fetches cross-kind candidate pairs from the live agent surface, fans them out to typing subagents that classify each pair against the controlled verb vocabulary (conservative — skip when nothing fits), and writes the typed batch back as PROPOSED relations with provenance. Nothing is auto-confirmed; moderate in Admin → Relations afterwards. Needs the live container (iiab-keap-1) + agent tokens (sourced from the container). Args: { limit?: number, anchorId?: string, anchorKind?: "node"|"object", maxDistance?: number } — omit for a corpus sweep.',
  phases: [
    { title: 'Fetch', detail: 'GET cross-kind candidate pairs + the controlled vocab from the live agent surface' },
    { title: 'Type', detail: 'fan-out: each subagent types a small batch against the vocab (conservative)' },
    { title: 'Write', detail: 'merge typed rows, POST them back as PROPOSED relations with provenance' },
  ],
}

const LIMIT = Number(args?.limit ?? 60)
const CHUNK = 12 // pairs per typing subagent — small batches keep the classifier careful
const TOOL = 'scripts/relations-typing.mjs'
const REPO = '/Users/pazny/projects/knowledge-explorer-and-preserver'
// The agents source the bearer tokens from the container so no manual export is
// needed; the tool talks to the loopback-published agent surface (keap_port 8091).
const TOKENS = `cd ${REPO} && export KEAP_AGENT_TOKEN_RO=$(docker exec iiab-keap-1 printenv KEAP_AGENT_TOKEN_RO) && export KEAP_AGENT_TOKEN_RW=$(docker exec iiab-keap-1 printenv KEAP_AGENT_TOKEN_RW) && export KEAP_AGENT_NAME=relations-typing-wf`
// The batch goes agent→agent as a FILE, never as structured output. Endpoint text
// carries up to 1k chars per side, so a 50-pair batch is ~100 KB — asking an agent
// to echo that verbatim burns tokens and invites silent corruption of the very
// refs the write phase must echo exactly. Fetch writes it; typers slice it.
const BATCH_FILE = '"${CLAUDE_JOB_DIR:-/tmp}"/relations-batch.json'

const anchorFlags = args?.anchorId && args?.anchorKind
  ? ` --anchorId ${args.anchorId} --anchorKind ${args.anchorKind}`
  : ''
const maxDistFlag = args?.maxDistance ? ` --maxDistance ${args.maxDistance}` : ''

const PAIR_SCHEMA = {
  type: 'object',
  required: ['count', 'vocab'],
  properties: {
    count: { type: 'number' },
    model: { type: 'string' },
    vocab: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: { type: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } },
      },
    },
  },
}

const TYPED_SCHEMA = {
  type: 'object',
  required: ['typed'],
  properties: {
    typed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from_ref', 'from_kind', 'to_ref', 'to_kind', 'type', 'confidence', 'justification'],
        properties: {
          from_ref: { type: 'string' }, from_kind: { type: 'string' },
          to_ref: { type: 'string' }, to_kind: { type: 'string' },
          type: { type: 'string' }, confidence: { type: 'number' },
          justification: { type: 'string' },
        },
      },
    },
  },
}

phase('Fetch')
const batch = await agent(`Fetch the candidate batch TO A FILE, then report only its size and vocabulary.

Run exactly:
${TOKENS} && node ${TOOL} fetch --limit ${LIMIT}${anchorFlags}${maxDistFlag} --out ${BATCH_FILE}

Then read back ONLY the summary (do not print the pairs — they stay in the file):
${TOKENS} && node -e 'const b=require(process.argv[1]);console.log(JSON.stringify({count:b.pairs.length,model:b.model,vocab:b.vocab}))' ${BATCH_FILE}

Return that summary object. If the tool errors with a token or connection message, the container is down or the agent surface is not published — return {"count":0,"vocab":[]} and nothing else. Do NOT invent pairs.`, { schema: PAIR_SCHEMA, phase: 'Fetch' })

const count = batch?.count ?? 0
const vocab = batch?.vocab ?? []
if (!count) {
  log('No candidate pairs (empty corpus, no vector layer, or container down). Nothing to type.')
  return { fetched: 0, typed: 0, upserted: 0, note: 'no candidates' }
}
log(`Fetched ${count} cross-kind candidate pairs; vocab ${vocab.length} verbs. Typing in batches of ${CHUNK}.`)

const vocabList = vocab.map((v) => `- ${v.type}${v.label ? ` (${v.label})` : ''}${v.description ? `: ${v.description}` : ''}`).join('\n')
// Index ranges, not slices: the script never holds the pairs — each typer reads
// its own window out of the batch file.
const chunks = []
for (let i = 0; i < count; i += CHUNK) chunks.push([i, Math.min(i + CHUNK, count)])

phase('Type')
const typedChunks = await parallel(
  chunks.map(([lo, hi], idx) => () =>
    agent(`You are typing candidate relation pairs for KEAP's typed knowledge graph. Each pair is two nearby items in embedding space; decide whether a CONTROLLED-vocabulary verb genuinely describes a relation FROM the first item TO the second, reading "from <TYPE> to".

Read YOUR pairs (indices ${lo}..${hi - 1} of ${count}) with exactly this command:
${TOKENS} && node -e 'const b=require(process.argv[1]);console.log(JSON.stringify(b.pairs.slice(+process.argv[2],+process.argv[3]),null,1))' ${BATCH_FILE} ${lo} ${hi}

Controlled vocabulary (STRONGLY prefer these — propose a new verb only when none fits and the relation is clearly real):
${vocabList}

Rules:
- CONSERVATIVE: proximity in embedding space is NOT a relation. If no verb genuinely fits, OMIT the pair. A small, correct set beats a large, noisy one. Typing nothing for a batch is a valid outcome.
- Directionality matters: the edge reads from_ref → to_ref. Object→node "exemplifies/supports/defines" usually reads correctly; flip only by choosing a verb that fits the given direction (you cannot reorder the endpoints).
- confidence ∈ [0,1]: how sure you are the relation holds AND the verb is right (0.8+ obvious, 0.5–0.7 plausible, below 0.4 omit).
- justification: one grounded sentence citing the two texts — why THIS verb.
- A proposed new verb MUST be a lowercase-kebab slug matching /^[a-z][a-z0-9-]{0,63}$/ and mirror the vocabulary's style (e.g. "quantifies", "instantiates"). Reuse before you grow.
- Echo from_ref/from_kind/to_ref/to_kind EXACTLY as given. Never change kinds; from_kind must differ from to_kind.

This is batch ${idx + 1}/${chunks.length}. Return { "typed": [ ... ] } with only the pairs you confidently typed.`, { schema: TYPED_SCHEMA, phase: 'Type', label: `type:batch-${idx + 1}` }),
  ),
)

// Merge + dedup on (from_ref,to_ref,type); keep the higher-confidence duplicate.
const seen = new Map()
for (const c of typedChunks.filter(Boolean)) {
  for (const t of c.typed ?? []) {
    if (t.from_kind === t.to_kind) continue // guard: cross-type only
    const k = `${t.from_ref}|${t.to_ref}|${t.type}`
    if (!seen.has(k) || (seen.get(k).confidence ?? 0) < (t.confidence ?? 0)) seen.set(k, t)
  }
}
const typed = [...seen.values()]
log(`Typed ${typed.length} relations across ${chunks.length} batches (from ${count} candidates).`)
if (!typed.length) return { fetched: count, typed: 0, upserted: 0, note: 'classifier typed nothing' }

phase('Write')
const typedJson = JSON.stringify({ model: batch.model ?? 'claude-sonnet-5', relations: typed })
// The writer agent persists the batch to a temp file and POSTs it via the tool
// (validate-all-then-write server-side; the tool also validates locally first).
const result = await agent(`Write this JSON verbatim to a temp file and POST it, then return the tool's RELTYPE_RESULT payload (the {upserted, proposedTypes,...} object):

1) Write the JSON below to $CLAUDE_JOB_DIR/tmp/relations-typed.json (create the dir if needed):
${typedJson}

2) Run:
${TOKENS} && node ${TOOL} post "$CLAUDE_JOB_DIR/tmp/relations-typed.json"

If the tool reports a validation error, DO NOT edit the data to force it through — return the error verbatim. All rows land status=proposed; they are NOT auto-confirmed.`, {
  schema: {
    type: 'object',
    required: ['upserted'],
    properties: {
      upserted: { type: 'number' },
      proposedTypes: { type: 'array', items: { type: 'string' } },
      error: { type: 'string' },
    },
  },
  phase: 'Write',
})

log(`Done. ${result?.upserted ?? 0} PROPOSED relations written${result?.proposedTypes?.length ? `; grew vocab (proposed): ${result.proposedTypes.join(', ')}` : ''}. Moderate in Admin → Relations.`)
return { fetched: count, typed: typed.length, upserted: result?.upserted ?? 0, proposedTypes: result?.proposedTypes ?? [], error: result?.error }
