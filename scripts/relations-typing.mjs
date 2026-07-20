/**
 * Track R3 — host-side typed-relation fill tool (the "brain" plumbing).
 *
 * KEAP surfaces geometry (cross-kind candidate pairs) + a controlled verb
 * vocabulary; a HOST-side classifier (Sonnet, driven by a Claude session or the
 * keap-relations-typing workflow) types each pair; the typed batch is written
 * back as PROPOSED relations with provenance. KEAP itself NEVER calls an LLM —
 * this tool is the deterministic I/O either side of the classification, mirroring
 * how the taxonomy was seeded in controlled batches (knowledge/ingest.mjs).
 *
 * The three subcommands map onto the agent surface (server/agent.ts):
 *   fetch  GET  /agent/v1/relations/candidates   (RO)  → a batch file to type
 *   post   POST /agent/v1/relations               (RW)  ← a typed batch file
 *   list   GET  /agent/v1/relations               (RO)  the stored rows + vocab
 *
 * Runs on the HOST (not in the container): it reaches the loopback-published
 * agent surface with a bearer token. Never touches the DB directly.
 *
 *   node scripts/relations-typing.mjs fetch [--limit N] [--maxDistance D]
 *        [--anchorId ID --anchorKind node|object] [--sinceTs T] [--out FILE]
 *   node scripts/relations-typing.mjs post <typed.json> [--dry-run]
 *   node scripts/relations-typing.mjs list [--status proposed] [--source derived]
 *
 * Env:
 *   KEAP_BASE_URL          default http://127.0.0.1:8091  (keap_port loopback)
 *   KEAP_AGENT_TOKEN_RO    bearer for fetch/list  (RW also works for reads)
 *   KEAP_AGENT_TOKEN_RW    bearer for post
 *   KEAP_AGENT_NAME        X-Keap-Agent label     (default relations-typer)
 *   KEAP_RELATION_MODEL    provenance model tag on POST (default from the batch)
 *
 * Get the tokens from the live container (redact when sharing):
 *   docker exec iiab-keap-1 printenv KEAP_AGENT_TOKEN_RW
 *
 * The typed-batch file `post` reads is either a bare array or {model?,relations:[]}
 * of: { from_ref, from_kind, to_ref, to_kind, type, confidence, justification }.
 * Cross-type only (from_kind !== to_kind); type must be a lowercase-kebab slug
 * (/^[a-z][a-z0-9-]{0,63}$/); an unknown type grows the vocab as PROPOSED.
 */
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const BASE = (process.env.KEAP_BASE_URL ?? 'http://127.0.0.1:8091').replace(/\/$/, '');
const TOKEN_RO = process.env.KEAP_AGENT_TOKEN_RO ?? process.env.KEAP_AGENT_TOKEN_RW ?? null;
const TOKEN_RW = process.env.KEAP_AGENT_TOKEN_RW ?? null;
const AGENT = (process.env.KEAP_AGENT_NAME ?? 'relations-typer').slice(0, 64);
const TYPE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const KINDS = new Set(['node', 'object']);

const argv = process.argv.slice(2);
const cmd = argv[0];

/** Pull `--flag value` out of argv; returns the value or a default. */
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}
const has = (name) => argv.includes(`--${name}`);

function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function needToken(tok, which) {
  if (!tok) {
    die(
      `no ${which} token. Set it from the live container:\n` +
        `    export ${which}=$(docker exec iiab-keap-1 printenv ${which})`,
    );
  }
}

async function call(method, path, { token, body } = {}) {
  const headers = { authorization: `Bearer ${token}`, 'x-keap-agent': AGENT };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`cannot reach ${BASE} — is the container up and the port published?\n    ${e.message}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || (json && json.success === false)) {
    die(`${method} ${path} → ${res.status} ${json?.error ?? res.statusText}`);
  }
  return json?.data ?? json;
}

// ── fetch ──────────────────────────────────────────────────────────────────
async function doFetch() {
  needToken(TOKEN_RO, 'KEAP_AGENT_TOKEN_RO');
  const q = new URLSearchParams();
  q.set('limit', String(Number(opt('limit', '40'))));
  if (opt('maxDistance')) q.set('maxDistance', String(Number(opt('maxDistance'))));
  if (opt('sinceTs')) q.set('sinceTs', String(Number(opt('sinceTs'))));
  const anchorId = opt('anchorId');
  const anchorKind = opt('anchorKind');
  if (anchorId || anchorKind) {
    if (!KINDS.has(anchorKind)) die('--anchorKind must be node|object');
    if (!anchorId) die('--anchorId required with --anchorKind');
    q.set('anchorId', anchorId);
    q.set('anchorKind', anchorKind);
  }
  const data = await call('GET', `/agent/v1/relations/candidates?${q}`, { token: TOKEN_RO });
  const batch = {
    model: data.model ?? null,
    count: data.pairs?.length ?? 0,
    vocab: data.vocab ?? [],
    pairs: data.pairs ?? [],
  };
  const out = opt('out');
  if (out) {
    writeFileSync(out, JSON.stringify(batch, null, 2));
    console.error(`✓ ${batch.count} candidate pairs → ${out}  (vocab: ${batch.vocab.length} verbs)`);
  } else {
    process.stdout.write(JSON.stringify(batch, null, 2) + '\n');
    console.error(`✓ ${batch.count} candidate pairs  (vocab: ${batch.vocab.length} verbs)`);
  }
  console.error(`RELTYPE_RESULT ${JSON.stringify({ cmd: 'fetch', count: batch.count })}`);
}

// ── post ───────────────────────────────────────────────────────────────────
/** Validate locally BEFORE sending — the server is validate-all-then-write, so
 *  one bad row rejects the whole batch. Fail fast with a precise index. */
function validate(relations) {
  if (!Array.isArray(relations) || !relations.length) die('typed batch is empty');
  relations.forEach((r, i) => {
    const at = `relations[${i}]`;
    if (!r || typeof r !== 'object') die(`${at} is not an object`);
    for (const f of ['from_ref', 'to_ref', 'type', 'justification']) {
      if (typeof r[f] !== 'string' || !r[f].trim()) die(`${at}.${f} must be a non-empty string`);
    }
    if (!KINDS.has(r.from_kind)) die(`${at}.from_kind must be node|object`);
    if (!KINDS.has(r.to_kind)) die(`${at}.to_kind must be node|object`);
    if (r.from_kind === r.to_kind) die(`${at}: from_kind and to_kind must differ (cross-type only)`);
    if (!TYPE_RE.test(r.type)) die(`${at}.type '${r.type}' must match ${TYPE_RE} (lowercase-kebab)`);
    const c = Number(r.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) die(`${at}.confidence must be a number in [0,1]`);
  });
}

async function doPost() {
  const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : opt('in');
  if (!file) die('usage: post <typed.json> [--dry-run]');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`);
  }
  const relations = Array.isArray(parsed) ? parsed : parsed.relations;
  const model = process.env.KEAP_RELATION_MODEL ?? (Array.isArray(parsed) ? undefined : parsed.model);
  validate(relations);
  if (has('dry-run')) {
    console.error(`✓ ${relations.length} typed relations valid (dry-run — nothing sent)`);
    const byType = {};
    for (const r of relations) byType[r.type] = (byType[r.type] ?? 0) + 1;
    console.error(`  verbs: ${Object.entries(byType).map(([t, n]) => `${t}×${n}`).join(', ')}`);
    return;
  }
  needToken(TOKEN_RW, 'KEAP_AGENT_TOKEN_RW');
  const data = await call('POST', '/agent/v1/relations', {
    token: TOKEN_RW,
    body: model ? { model, relations } : { relations },
  });
  console.error(
    `✓ upserted ${data.upserted} relations` +
      (data.proposedTypes?.length ? `; grew vocab (proposed): ${data.proposedTypes.join(', ')}` : ''),
  );
  console.error(`RELTYPE_RESULT ${JSON.stringify({ cmd: 'post', ...data })}`);
}

// ── list ───────────────────────────────────────────────────────────────────
async function doList() {
  needToken(TOKEN_RO, 'KEAP_AGENT_TOKEN_RO');
  const q = new URLSearchParams();
  if (opt('status')) q.set('status', opt('status'));
  if (opt('source')) q.set('source', opt('source'));
  q.set('limit', String(Number(opt('limit', '200'))));
  const data = await call('GET', `/agent/v1/relations?${q}`, { token: TOKEN_RO });
  const rows = data.relations ?? [];
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.error(
    `✓ ${rows.length} relations  [${Object.entries(byStatus).map(([s, n]) => `${s}:${n}`).join(', ')}]` +
      `  · vocab ${data.types?.length ?? 0} verbs`,
  );
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

const commands = { fetch: doFetch, post: doPost, list: doList };
if (!commands[cmd]) {
  console.error('usage: node scripts/relations-typing.mjs <fetch|post|list> [opts]');
  console.error('  fetch [--limit N] [--maxDistance D] [--anchorId ID --anchorKind K] [--sinceTs T] [--out FILE]');
  console.error('  post  <typed.json> [--dry-run]');
  console.error('  list  [--status proposed] [--source derived] [--limit N]');
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
