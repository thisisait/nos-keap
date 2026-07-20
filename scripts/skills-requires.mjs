/**
 * Mechanical `Requires:` producer — the deterministic half of the skill router.
 *
 * A skill card declares its preconditions as ONE body line
 * (contract: selfmodel rounds 4–8):
 *
 *     Requires: nos.iiab.nextcloud.credential, nos.iiab.nextcloud.admin-role
 *
 * comma-separated FULL node ids; an absent line means "no precondition", never
 * "unknown". This script reads every skill card through the agent surface,
 * parses that line, and writes `(skill card) —requires→ (credential node)` as
 * PROPOSED typed relations with mechanical provenance. No LLM is involved —
 * the line is a declaration, not a judgment, which is why confidence is 1.
 *
 * A target that does not resolve is NEVER posted: routing to a node that does
 * not exist is worse than not routing, so dangling refs are reported and
 * skipped. A standing dangling count means the producer and the taxonomy have
 * diverged — fix the tree or the card, not this script.
 *
 *   node scripts/skills-requires.mjs post [--dry-run] [--type skill]
 *
 * Env: KEAP_BASE_URL (default http://127.0.0.1:8091),
 *      KEAP_AGENT_TOKEN_RO / KEAP_AGENT_TOKEN_RW  (see relations-typing.mjs)
 */

const BASE = (process.env.KEAP_BASE_URL ?? 'http://127.0.0.1:8091').replace(/\/$/, '');
const TOKEN_RO = process.env.KEAP_AGENT_TOKEN_RO ?? process.env.KEAP_AGENT_TOKEN_RW ?? null;
const TOKEN_RW = process.env.KEAP_AGENT_TOKEN_RW ?? null;
const AGENT = (process.env.KEAP_AGENT_NAME ?? 'requires-producer').slice(0, 64);
const MODEL = 'mechanical:requires-line@1';

// Full node ids — dotted lowercase slugs (user subtrees) or dotted 2-digit runs
// (seed spine). Same acceptance as server/objects.ts classifyRef.
const NODE_ID_RE = /^(?:\d{2}(?:\.\d{2})*|[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)$/;
const REQUIRES_LINE = /^Requires:\s*(.+)$/m;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const TYPE = argv.includes('--type') ? argv[argv.indexOf('--type') + 1] : 'skill';

function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

async function call(method, path, body) {
  const headers = { authorization: `Bearer ${body ? TOKEN_RW : TOKEN_RO}`, 'x-keap-agent': AGENT };
  if (body) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    die(`cannot reach ${BASE} — ${e.message}`);
  }
  const json = await res.json().catch(() => null);
  return { ok: res.ok && json?.success !== false, status: res.status, data: json?.data ?? json };
}

if (argv[0] !== 'post') {
  console.error('usage: node scripts/skills-requires.mjs post [--dry-run] [--type skill]');
  process.exit(argv[0] ? 1 : 0);
}
if (!TOKEN_RO) die('no token — export KEAP_AGENT_TOKEN_RO (or RW)');

// 1) Page the whole skill corpus.
const cards = [];
for (let offset = 0; ; offset += 50) {
  const page = await call('GET', `/agent/v1/objects?type=${encodeURIComponent(TYPE)}&limit=50&offset=${offset}`);
  if (!page.ok) die(`listing skill cards failed (${page.status})`);
  const rows = page.data.results ?? [];
  cards.push(...rows);
  if (!rows.length || cards.length >= (page.data.total ?? 0)) break;
}

// 2) Read each body, parse the line, validate every target.
const relations = [];
const dangling = [];
const malformed = [];
let withLine = 0;
const nodeExists = new Map();
for (const c of cards) {
  const full = await call('GET', `/agent/v1/objects/${encodeURIComponent(c.id)}`);
  if (!full.ok) continue;
  const body = full.data.body ?? '';
  const m = REQUIRES_LINE.exec(body);
  if (!m) continue; // absent line = no precondition, by contract
  withLine++;
  for (const raw of m[1].split(',')) {
    const ref = raw.trim();
    if (!ref) continue;
    if (!NODE_ID_RE.test(ref)) {
      malformed.push({ card: c.id, ref });
      continue;
    }
    if (!nodeExists.has(ref)) {
      const probe = await call('GET', `/agent/v1/taxonomy/node/${encodeURIComponent(ref)}`);
      nodeExists.set(ref, probe.ok);
    }
    if (!nodeExists.get(ref)) {
      dangling.push({ card: c.id, ref });
      continue;
    }
    relations.push({
      from_ref: c.id, from_kind: 'object',
      to_ref: ref, to_kind: 'node',
      type: 'requires', confidence: 1,
      justification: `Declared by the Requires: line of skill card "${c.title}".`,
    });
  }
}

// 3) Report, then write (validate-all-then-write server side; proposed status).
for (const d of dangling) console.error(`  ✗ dangling: ${d.card} → ${d.ref} (node does not exist — NOT posted)`);
for (const d of malformed) console.error(`  ✗ malformed ref in ${d.card}: ${JSON.stringify(d.ref)}`);

let upserted = 0;
if (relations.length && !DRY) {
  if (!TOKEN_RW) die('no KEAP_AGENT_TOKEN_RW — needed to post');
  const res = await call('POST', '/agent/v1/relations', { model: MODEL, relations });
  if (!res.ok) die(`POST failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
  upserted = res.data.upserted ?? 0;
}
console.error(
  `✓ ${cards.length} skill card(s), ${withLine} with a Requires: line → ` +
    `${relations.length} relation(s)${DRY ? ' (dry-run, nothing sent)' : `, ${upserted} upserted`}` +
    `${dangling.length ? `, ${dangling.length} dangling SKIPPED` : ''}`,
);
console.log(`REQUIRES_RESULT ${JSON.stringify({ scanned: cards.length, withLine, posted: DRY ? 0 : upserted, dangling, malformed })}`);
