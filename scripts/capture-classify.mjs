/**
 * Track K — K4 capture-classify: host-side classify-on-ingest plumbing.
 *
 * The review queue fills with captures nobody files. KEAP surfaces the queue +
 * per-capture taxonomy anchor SUGGESTIONS (real node ids from hybrid search);
 * a HOST-side classifier (Sonnet, driven by a Claude session) drafts an object
 * per capture — type, title, anchors — and the draft lands as a PROPOSAL in
 * the existing moderation queue. Nothing is auto-approved; KEAP itself never
 * calls an LLM. Same shape as scripts/relations-typing.mjs (the twice-proven
 * mold), same controlled-batch ceremony as knowledge/ingest.mjs.
 *
 *   fetch  GET  /agent/v1/captures?unpromoted=1 (+ per-capture
 *               GET /agent/v1/search/semantic kinds=taxonomy)     (RO) → batch
 *   post   POST /agent/v1/promotions per classified row           (RW) ← batch
 *   list   GET  /agent/v1/promotions                              (RO)
 *
 *   node scripts/capture-classify.mjs fetch [--limit N] [--source S] [--out FILE]
 *   node scripts/capture-classify.mjs post <classified.json> [--dry-run]
 *   node scripts/capture-classify.mjs list
 *
 * The classified file `post` reads is {proposals:[...]} (or a bare array) of:
 *   { captureId, object: { type, title, description?, anchors?: [nodeId],
 *     tags?, body? }, rationale? }
 * Rows with `skip: true` are counted and not posted — "nothing fits" is a
 * legal verdict, the classifier must never invent an anchor. Anchors must come
 * from the batch's suggestedAnchors (or a justified search) — propose() 400s
 * on unknown node ids either way.
 *
 * Env (same set as relations-typing.mjs):
 *   KEAP_BASE_URL, KEAP_AGENT_TOKEN_RO, KEAP_AGENT_TOKEN_RW, KEAP_AGENT_NAME
 * Tokens from the live container: docker exec iiab-keap-1 printenv KEAP_AGENT_TOKEN_RW
 */
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const BASE = (process.env.KEAP_BASE_URL ?? 'http://127.0.0.1:8091').replace(/\/$/, '');
const TOKEN_RO = process.env.KEAP_AGENT_TOKEN_RO ?? process.env.KEAP_AGENT_TOKEN_RW ?? null;
const TOKEN_RW = process.env.KEAP_AGENT_TOKEN_RW ?? null;
const AGENT = (process.env.KEAP_AGENT_NAME ?? 'capture-classifier').slice(0, 64);

const argv = process.argv.slice(2);
const cmd = argv[0];

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

async function call(method, path, { token, body, soft } = {}) {
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
    const msg = `${method} ${path} → ${res.status} ${json?.error ?? res.statusText}`;
    if (soft) {
      // per-row failures in a batch post must not kill the batch
      console.error(`  ✗ ${msg}`);
      throw new Error(msg);
    }
    die(msg);
  }
  return json?.data ?? json;
}

// ── fetch ──────────────────────────────────────────────────────────────────
async function doFetch() {
  needToken(TOKEN_RO, 'KEAP_AGENT_TOKEN_RO');
  const limit = Number(opt('limit', '30'));
  const source = opt('source');
  const pageSize = 50; // MAX_LIMIT on the agent surface

  const items = [];
  for (let offset = 0; items.length < limit; offset += pageSize) {
    const q = new URLSearchParams({ unpromoted: '1', limit: String(pageSize), offset: String(offset) });
    if (source) q.set('source', source);
    const page = await call('GET', `/agent/v1/captures?${q}`, { token: TOKEN_RO });
    const rows = page.items ?? [];
    items.push(...rows);
    if (!rows.length || offset + pageSize >= (page.total ?? 0)) break;
  }
  const batch = [];
  for (const c of items.slice(0, limit)) {
    // Anchor suggestions from the REAL taxonomy via hybrid search — the
    // classifier picks from these (or skips); it never invents node ids.
    const q = new URLSearchParams({
      q: [c.title, c.description].filter(Boolean).join(' ').slice(0, 200),
      kinds: 'taxonomy',
      limit: '5',
    });
    let hits = [];
    try {
      const data = await call('GET', `/agent/v1/search/semantic?${q}`, { token: TOKEN_RO });
      hits = (data.items ?? data.results ?? []).map((h) => ({
        id: h.id ?? h.refId,
        title: h.title ?? h.name ?? null,
        score: h.score ?? null,
      }));
    } catch {
      /* a capture with an unsearchable title still classifies — just unaided */
    }
    batch.push({
      captureId: c.id,
      title: c.title,
      description: c.description ?? null,
      url: c.url ?? null,
      source: c.source ?? null,
      metadata: c.metadata ?? null,
      suggestedAnchors: hits,
    });
  }
  const out = opt('out');
  const payload = { count: batch.length, captures: batch };
  if (out) {
    writeFileSync(out, JSON.stringify(payload, null, 2));
    console.error(`✓ ${batch.length} unpromoted captures → ${out}`);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    console.error(`✓ ${batch.length} unpromoted captures`);
  }
  console.error(`CAPCLS_RESULT ${JSON.stringify({ cmd: 'fetch', count: batch.length })}`);
}

// ── post ───────────────────────────────────────────────────────────────────
async function doPost() {
  needToken(TOKEN_RW, 'KEAP_AGENT_TOKEN_RW');
  const file = argv[1];
  if (!file || file.startsWith('--')) die('usage: post <classified.json> [--dry-run]');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : (raw.proposals ?? []);
  if (!rows.length) die('no proposals in the file');

  let posted = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.skip) {
      skipped += 1;
      continue;
    }
    if (typeof r.captureId !== 'string' || !r.object?.type || !r.object?.title) {
      console.error(`  ✗ malformed row (captureId + object.type + object.title required): ${JSON.stringify(r).slice(0, 120)}`);
      failed += 1;
      continue;
    }
    if (has('dry-run')) {
      console.error(`  · would propose ${r.captureId} → ${r.object.type} "${r.object.title}"`);
      posted += 1;
      continue;
    }
    try {
      const data = await call('POST', '/agent/v1/promotions', {
        token: TOKEN_RW,
        soft: true,
        body: { captureId: r.captureId, object: r.object, rationale: r.rationale },
      });
      console.error(`  ✓ ${r.captureId} → proposal ${data.id}`);
      posted += 1;
    } catch {
      failed += 1; // soft call printed the server's reason
    }
  }
  console.error(`CAPCLS_RESULT ${JSON.stringify({ cmd: 'post', posted, skipped, failed, dryRun: has('dry-run') })}`);
  if (failed) process.exit(1);
}

// ── list ───────────────────────────────────────────────────────────────────
async function doList() {
  needToken(TOKEN_RO, 'KEAP_AGENT_TOKEN_RO');
  const data = await call('GET', '/agent/v1/promotions', { token: TOKEN_RO });
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

if (cmd === 'fetch') await doFetch();
else if (cmd === 'post') await doPost();
else if (cmd === 'list') await doList();
else die('usage: capture-classify.mjs fetch|post|list  (see the header comment)');
