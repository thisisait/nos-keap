/**
 * Track K — K5 ontology-extend: the density-driven star-formation producer.
 *
 * The roadmap's "star formation" law: a dense nebula (a topic cluster the
 * taxonomy has no star for) is a taxonomy-node proposal waiting to be
 * written. KEAP already quantifies density (topic_clusters member counts +
 * c-TF-IDF terms) and already has the moderated proposal door
 * (/agent/v1/taxonomy/propose — free zones auto-approve, votable queue,
 * anchor core refuses). This tool is the deterministic I/O between them; the
 * WORDS (node name, description, which parent) come from a HOST-side LLM
 * working over the fetched batch — KEAP itself never calls one. Same mold as
 * scripts/relations-typing.mjs and scripts/capture-classify.mjs.
 *
 *   fetch  GET /agent/v1/topics?clusters=1&members=1 (+ per-cluster parent
 *          suggestions via GET /agent/v1/search/semantic kinds=taxonomy) (RO)
 *   post   POST /agent/v1/taxonomy/propose per proposal row              (RW)
 *
 *   node scripts/ontology-extend.mjs fetch [--minMembers N] [--out FILE]
 *   node scripts/ontology-extend.mjs post <proposals.json> [--dry-run]
 *
 * The proposals file `post` reads is {proposals:[...]} (or a bare array) of:
 *   { parentId, name, description, rationale? }
 * description is MANDATORY (DescGraph doctrine — the propose door 400s
 * without it). Rows with `skip: true` are counted, not posted: a cluster that
 * maps onto an EXISTING node is a skip, never a duplicate proposal — check
 * suggestedParents first; a strong hit usually means the star already exists.
 *
 * Env: KEAP_BASE_URL, KEAP_AGENT_TOKEN_RO, KEAP_AGENT_TOKEN_RW, KEAP_AGENT_NAME.
 * Tokens from the live container: docker exec iiab-keap-1 printenv KEAP_AGENT_TOKEN_RW
 */
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const BASE = (process.env.KEAP_BASE_URL ?? 'http://127.0.0.1:8091').replace(/\/$/, '');
const TOKEN_RO = process.env.KEAP_AGENT_TOKEN_RO ?? process.env.KEAP_AGENT_TOKEN_RW ?? null;
const TOKEN_RW = process.env.KEAP_AGENT_TOKEN_RW ?? null;
const AGENT = (process.env.KEAP_AGENT_NAME ?? 'ontology-extender').slice(0, 64);

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
  // ponytail: a fixed member floor, not a statistical density model — raise
  // --minMembers if the corpus grows past hand-review scale.
  const minMembers = Number(opt('minMembers', '12'));
  const data = await call('GET', '/agent/v1/topics?clusters=1&members=1', { token: TOKEN_RO });
  const dense = (data.clusters ?? [])
    .filter((c) => c.memberCount >= minMembers)
    .sort((a, b) => b.memberCount - a.memberCount);

  const batch = [];
  for (const c of dense) {
    // Candidate PARENTS from the real taxonomy: the LLM picks one of these
    // (or skips) — it never invents a parent id. A very strong first hit is
    // usually the sign the star already exists → skip, not propose.
    const q = new URLSearchParams({
      q: [c.label, ...(c.terms ?? [])].filter(Boolean).join(' ').slice(0, 200),
      kinds: 'taxonomy',
      limit: '5',
    });
    let parents = [];
    try {
      const hits = await call('GET', `/agent/v1/search/semantic?${q}`, { token: TOKEN_RO });
      parents = (hits.results ?? []).map((h) => ({
        id: h.id,
        name: h.name ?? h.title ?? null,
        path: h.path ?? null,
        score: h.score ?? null,
      }));
    } catch {
      /* unaided is still classifiable */
    }
    batch.push({
      clusterId: c.id,
      label: c.label,
      labelAuto: c.labelAuto,
      terms: c.terms ?? [],
      memberCount: c.memberCount,
      members: c.members ?? [],
      suggestedParents: parents,
    });
  }
  const out = opt('out');
  const payload = { minMembers, count: batch.length, clusters: batch };
  if (out) {
    writeFileSync(out, JSON.stringify(payload, null, 2));
    console.error(`✓ ${batch.length} dense clusters (≥${minMembers} members) → ${out}`);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    console.error(`✓ ${batch.length} dense clusters (≥${minMembers} members)`);
  }
  console.error(`ONTEXT_RESULT ${JSON.stringify({ cmd: 'fetch', count: batch.length })}`);
}

// ── post ───────────────────────────────────────────────────────────────────
async function doPost() {
  needToken(TOKEN_RW, 'KEAP_AGENT_TOKEN_RW');
  const file = argv[1];
  if (!file || file.startsWith('--')) die('usage: post <proposals.json> [--dry-run]');
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
    if (!r.parentId || !r.name || !r.description) {
      console.error(`  ✗ malformed row (parentId + name + description required): ${JSON.stringify(r).slice(0, 120)}`);
      failed += 1;
      continue;
    }
    if (has('dry-run')) {
      console.error(`  · would propose "${r.name}" under ${r.parentId}`);
      posted += 1;
      continue;
    }
    try {
      const data = await call('POST', '/agent/v1/taxonomy/propose', {
        token: TOKEN_RW,
        soft: true,
        body: { parentId: r.parentId, name: r.name, description: r.description, rationale: r.rationale },
      });
      console.error(`  ✓ "${r.name}" under ${r.parentId} → ${JSON.stringify(data).slice(0, 100)}`);
      posted += 1;
    } catch {
      failed += 1; // soft call printed the server's reason
    }
  }
  console.error(`ONTEXT_RESULT ${JSON.stringify({ cmd: 'post', posted, skipped, failed, dryRun: has('dry-run') })}`);
  if (failed) process.exit(1);
}

if (cmd === 'fetch') await doFetch();
else if (cmd === 'post') await doPost();
else die('usage: ontology-extend.mjs fetch|post  (see the header comment)');
