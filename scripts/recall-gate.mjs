/**
 * Recall gate — the only check in the chain that measures MEANING.
 *
 * Everything else gates form: charsets, anchors, id stability, description
 * length. But the failure that started this whole track — nine `_stack.md`
 * cards outranking real content for *Nuclear Engineering* — was invisible to
 * every one of those checks. Sixty templated node descriptions would pass lint
 * (en ≥ 20 chars) and wreck recall identically: we measure length because it is
 * easy, while what fails is meaning.
 *
 * This gate asserts meaning directly: boot a throwaway KEAP from a canonical
 * fixture, embed the corpus with the REAL model through the REAL embed-sync
 * loop (pending → Ollama → POST back), then run known query→winner pairs
 * through the REAL hybrid search (RRF over lexical+vector+graph legs). The
 * claim is not "the description is long enough"; it is "on ‘upload a file to
 * cloud storage’ the Nextcloud skill wins, and no stack or root ranks above
 * it".
 *
 *   node scripts/recall-gate.mjs [--fixture DIR] [--skills DIR] [--queries F]
 *
 * Exit codes — three states, deliberately distinct:
 *   0  every case passed
 *   1  at least one case failed (a recall regression, name in the output)
 *   4  SKIPPED: no embedder reachable — loud, and NOT a pass. A gate that
 *      cannot run must never be readable as green (doctrine: gates.md).
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

const REPO = path.resolve('.');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
// --base http://…: query an ALREADY-RUNNING KEAP read-only — no scratch boot,
// no ingest, no embedding. The fixture mode proves a tree BEFORE it ships; the
// base mode measures the corpus that actually shipped (post-install, embedded
// by the live pulse job). Same queries, same semantics, same exit codes.
const LIVE_BASE = arg('base', null);
const FIXTURE = arg('fixture', 'e2e/fixtures/selfmodel');
const SKILLS = arg('skills', 'e2e/fixtures/selfmodel-skills');
const QUERIES = arg('queries', 'e2e/fixtures/selfmodel-recall.json');
const OLLAMA = process.env.KEAP_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.KEAP_EMBED_MODEL ?? 'nomic-embed-text';
const DIR = path.join(REPO, 'e2e', '.recall-gate');

// ── 0) The embedder must exist, or this is a SKIP, never a pass ─────────────
try {
  const tags = await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) })).json();
  if (!tags.models?.some((m) => m.name.startsWith(MODEL))) {
    console.error(`⚠ RECALL GATE SKIPPED: ${MODEL} not present on ${OLLAMA} — nothing was measured`);
    process.exit(4);
  }
} catch {
  console.error(`⚠ RECALL GATE SKIPPED: no embedder at ${OLLAMA} — nothing was measured`);
  process.exit(4);
}

const spec = JSON.parse(readFileSync(QUERIES, 'utf8'));
const K = spec.k ?? 5;

if (LIVE_BASE) {
  // Read-only live path: sections 1–2 (scratch + embed) do not apply. The live
  // estate runs KEAP_TRUSTED_PROXY=1, so the human /api surface 401s headerless
  // host requests — everything here goes through the agent surface with the RO
  // bearer (export KEAP_AGENT_TOKEN_RO=$(docker exec iiab-keap-1 printenv …)).
  const base = LIVE_BASE.replace(/\/$/, '');
  const tok = process.env.KEAP_AGENT_TOKEN_RO ?? process.env.KEAP_AGENT_TOKEN_RW;
  if (!tok) { console.error('✗ --base needs KEAP_AGENT_TOKEN_RO'); process.exit(1); }
  const H = { authorization: `Bearer ${tok}` };
  const TL = (ms) => ({ signal: AbortSignal.timeout(ms) });

  const brain = (await (await fetch(`${base}/agent/v1/graph`, { headers: H, ...TL(30_000) })).json()).data;
  const nodeIds = new Set(brain.nodes.filter((n) => n.kind === 'node' || !n.kind).map((n) => n.id));
  const idByTitle = new Map();
  for (let offset = 0; ; offset += 50) {
    const page = (await (
      await fetch(`${base}/agent/v1/objects?limit=50&offset=${offset}`, { headers: H, ...TL(30_000) })
    ).json()).data;
    for (const o of page.results ?? []) idByTitle.set(o.title, o.id);
    if (!(page.results ?? []).length || offset + 50 >= (page.total ?? 0)) break;
  }
  const search = async (q) => {
    const r = (await (
      await fetch(`${base}/agent/v1/search/semantic?q=${encodeURIComponent(q)}&limit=30`, { headers: H, ...TL(30_000) })
    ).json()).data;
    return (r.results ?? []).map((h) => ({ kind: h.kind, refId: h.id, legs: h.legs ?? [] }));
  };
  await runCaseSet({ nodeIds, idByTitle, anchorsById: new Map(), search }, (code) => process.exit(code), 0);
}

// ── 1) Scratch KEAP: ingest fixture → boot → fs-sync skills ─────────────────
// --reuse keeps an existing scratch (skips setup+embedding) for query iteration;
// --keep leaves the server and data up after the run.
const REUSE = process.argv.includes('--reuse') && existsSync(path.join(DIR, 'keap.db'));
const KEEP = process.argv.includes('--keep');
if (!REUSE) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const env = { ...process.env, KEAP_DATA_DIR: DIR };
  execFileSync('node', ['knowledge/roundtrip-setup.mjs'], { env, stdio: 'ignore' });
  execFileSync('node', ['knowledge/ingest.mjs', '--canonical', FIXTURE], { env, stdio: 'ignore' });
}
const USERFILES = path.join(DIR, 'userfiles');
// Skills are optional: a nodes-only canonical fixture still gates its node
// descriptions against the queries that have node expectations. Never mix a
// DIFFERENT tree's cards in to make titles resolve — that would measure a
// corpus nobody ships.
const HAS_SKILLS = SKILLS !== 'none' && existsSync(SKILLS);
if (!REUSE && HAS_SKILLS) cpSync(SKILLS, path.join(USERFILES, 'nos-docs', 'nOS', 'skills'), { recursive: true });
if (!HAS_SKILLS) console.error(`· no skills dir (${SKILLS}) — title: expectations will be unresolvable and SKIPPED, not failed`);

// Probe on '::' (dual-stack): the server listens unbound, so a leftover holder
// on IPv6 makes an IPv4-only probe lie about the port being free.
const freePort = (from) =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(freePort(from + 1)));
    srv.listen(from, '::', () => srv.close(() => resolve(from)));
  });
const PORT = await freePort(8150);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn('node', ['dist-server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    KEAP_DATA_DIR: DIR,
    KEAP_USER_FILES_DIR: USERFILES,
    KEAP_FS_SHARED_UIDS: 'nos-docs',
    KEAP_FS_SYNC_DIRS: 'documents,library,inbox,nOS',
    KEAP_FS_SYNC_INTERVAL_S: '0',
    KEAP_OLLAMA_URL: OLLAMA, // query-side embedding, the live path
    KEAP_AGENT_TOKEN_RO: 'gate-ro',
    KEAP_AGENT_TOKEN_RW: 'gate-rw',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stop = (code) => {
  server.kill();
  if (!KEEP) rmSync(DIR, { recursive: true, force: true });
  process.exit(code);
};
// Crash paths must not orphan the child: an earlier PayloadTooLarge crash left
// a server holding the port, and the NEXT run's requests silently landed on the
// stale instance — coherent-looking answers from the wrong database.
process.on('exit', () => server.kill());
process.on('uncaughtException', (e) => { console.error(e); stop(1); });
process.on('unhandledRejection', (e) => { console.error(e); stop(1); });

const rw = { authorization: 'Bearer gate-rw', 'content-type': 'application/json' };
const T = (ms) => ({ signal: AbortSignal.timeout(ms) });
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`, T(2000))).ok) break;
  } catch { /* booting */ }
  if (i > 60) { console.error('✗ server never came up'); stop(1); }
  await new Promise((r) => setTimeout(r, 500));
}
console.error('· server up, syncing skill cards');
await fetch(`${BASE}/agent/v1/fs/sync?wait=1`, { method: 'POST', headers: rw, body: '{}', ...T(30_000) });

// ── 2) Embed the WHOLE corpus through the REAL loop: page pending → batch-
// embed via Ollama (`input` accepts an array — one call per chunk, not per
// text) → POST back, until pending drains. The full corpus INCLUDING the seed
// spine is embedded deliberately: the fixture items must win their queries
// against everything the live vector leg would rank, not in an empty room.
// Pending pages at 500 and lists taxonomy first, so a single page never even
// reaches the fixture refs — that is why this loops.
let embedded = 0;
let dim = 768;
for (let round = 0; round < (REUSE ? 1 : 12); round++) {
  const pRes = await fetch(`${BASE}/agent/v1/embeddings/pending?limit=500`, { headers: rw, ...T(30_000) });
  if (!pRes.ok) { console.error(`✗ pending fetch failed (${pRes.status})`); stop(1); }
  const pending = (await pRes.json()).data;
  dim = pending.dim ?? dim;
  const batch = pending.items ?? [];
  if (!batch.length) break;
  console.error(`· round ${round + 1}: embedding ${batch.length} of ${pending.total} pending`);
  const items = [];
  for (let i = 0; i < batch.length; i += 64) {
    const chunk = batch.slice(i, i + 64);
    const r = await (await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: chunk.map((p) => p.text) }),
      ...T(120_000),
    })).json();
    const vecs = r.embeddings ?? [];
    for (let j = 0; j < chunk.length; j++) {
      if (Array.isArray(vecs[j])) {
        items.push({ kind: chunk[j].kind, refId: chunk[j].refId, contentHash: chunk[j].contentHash, vector: vecs[j] });
      }
    }
  }
  if (!items.length) { console.error('✗ embedder returned nothing for a non-empty batch'); stop(1); }
  // 500 vectors of 768 floats is ~3.5 MB of JSON — past the server's 2 MB body
  // limit — so the write goes back in slices, like the live embed-sync job's.
  for (let i = 0; i < items.length; i += 150) {
    const posted = await (await fetch(`${BASE}/agent/v1/embeddings`, {
      method: 'POST', headers: rw,
      body: JSON.stringify({ model: MODEL, dim, items: items.slice(i, i + 150) }),
      ...T(60_000),
    })).json();
    if (posted.success === false) { console.error(`✗ embeddings POST rejected: ${posted.error}`); stop(1); }
  }
  embedded += items.length;
}
console.error(`· corpus embedded: ${embedded} item(s)${REUSE ? ' (reuse — remainder assumed present)' : ''}`);
if (!embedded && !REUSE) { console.error('✗ nothing to embed — fixture produced no corpus'); stop(1); }

{
  const T2 = (ms) => ({ signal: AbortSignal.timeout(ms) });
  const graph = (await (await fetch(`${BASE}/api/graph`, T2(30_000))).json()).data;
  await runCaseSet(
    {
      nodeIds: new Set(graph.nodes.map((n) => n.id)),
      idByTitle: new Map(graph.objects.map((o) => [o.title, o.id])),
      anchorsById: new Map(graph.objects.map((o) => [o.id, o.anchors ?? []])),
      search: async (q) => {
        const r = (await (
          await fetch(`${BASE}/api/search/semantic?q=${encodeURIComponent(q)}&limit=30`, T2(30_000))
        ).json()).data;
        return (r.items ?? []).map((h) => ({ kind: h.kind, refId: h.refId, legs: h.legs ?? [] }));
      },
    },
    stop,
    embedded,
  );
}

// ── 3) Resolve refs, rank within scope, gate ────────────────────────────────
async function runCaseSet({ nodeIds, idByTitle, anchorsById, search }, stop, embedded) {
// An expectation that references nothing in the corpus is NOT a recall failure —
// it is an unmeasurable case, and conflating the two turns a coverage gap into
// a wall of false reds that buries the real signal. Unresolvable refs (a node
// absent from this tree, a card title with no card) drop the ref; a case with
// NO resolvable expectation is skipped and counted loudly.
const resolve = (ref) => {
  if (ref.startsWith('node:')) {
    const id = ref.slice(5);
    return nodeIds.has(id) ? { kind: 'taxonomy', refId: id } : null;
  }
  if (ref.startsWith('title:')) {
    const id = idByTitle.get(ref.slice(6));
    return id ? { kind: 'object', refId: id } : null;
  }
  return null;
};
const hitKey = (h) => `${h.kind}:${h.refId}`;

// The gate ranks WITHIN the self-model scope. The _stack.md failure was a
// RELATIVE one — generic self-model items capturing queries that specific ones
// should own — and that is the regression class this gate exists for. Absolute
// corpus-wide rank (against 790 curated seed nodes) is a different, stricter
// property; it is reported as diagnostics but never gated, or every generic
// phrasing would fail against the seed spine and the gate would be ignored.
const scopeRoot = spec.scope ?? 'nos';
const inScope = (h) =>
  h.kind === 'object' || (h.kind === 'taxonomy' && (h.refId === scopeRoot || h.refId.startsWith(scopeRoot + '.')));
// A hit whose ONLY leg is 'graph' is context, not relevance: the graph leg hops
// one step out from the real hits, which structurally boosts parents, siblings
// and children of everything relevant — a stack is every system's neighbour, so
// it would rank on topology no matter what its text says. The router routes on
// MEANING, so the gate ranks only hits that earned a lexical or vector leg.
const isRelevance = (h) => !Array.isArray(h.legs) || h.legs.length === 0 || h.legs.some((l) => l !== 'graph');

// Ancestors of the expected target are NAVIGATION, not competition. The graph
// leg exists to surface a hit's lineage, so a parent stack or the root ranking
// beside the target is the search working as designed — while a SIBLING or an
// unrelated item above the target is the _stack.md class: same-granularity
// capture, the thing this gate exists to catch. Proper ancestors of any
// expected ref are therefore excluded from the ranking (and reported, so the
// exemption is visible rather than silent).
const properAncestors = (expectedResolved) => {
  const out = new Set([scopeRoot]);
  const nodeIds = [];
  for (const e of expectedResolved) {
    if (e.kind === 'taxonomy') nodeIds.push(e.refId);
    else nodeIds.push(...(anchorsById.get(e.refId) ?? []));
  }
  for (const id of nodeIds) {
    const segs = id.split('.');
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('.'));
  }
  // never exclude something that is itself expected
  for (const e of expectedResolved) if (e.kind === 'taxonomy') out.delete(e.refId);
  return out;
};

const failures = [];
const skipped = [];
const report = [];
for (const c of spec.cases) {
  if (!c.expect.map(resolve).filter(Boolean).length) {
    skipped.push(c.q);
    continue;
  }
  const hits = await search(c.q);
  const all = hits.map(hitKey);
  const legsByKey = new Map(hits.map((h) => [hitKey(h), h.legs ?? []]));
  const scoped = hits.filter((h) => inScope(h) && isRelevance(h)).map(hitKey);
  const top = scoped.slice(0, K);

  const expectedResolved = c.expect.map(resolve).filter(Boolean);
  const expected = expectedResolved.map(hitKey);
  const ancestors = properAncestors(expectedResolved);
  const ranked = top.filter((k2) => !(k2.startsWith('taxonomy:') && ancestors.has(k2.slice('taxonomy:'.length))));
  const excluded = top.filter((k2) => !ranked.includes(k2));
  const forbidden = (c.forbid ?? [])
    .map(resolve).filter(Boolean).map(hitKey)
    .filter((f) => ranked.includes(f) || !excluded.includes(f));
  const bestExpected = Math.min(...expected.map((e) => (ranked.indexOf(e) + 1 || Infinity)));
  const bestForbidden = Math.min(...forbidden.map((f) => (ranked.indexOf(f) + 1 || Infinity)));

  const inTop = bestExpected !== Infinity;
  const cleanRank = bestForbidden === Infinity || bestExpected < bestForbidden;
  const ok = inTop && cleanRank;
  report.push({ q: c.q, ok, scopedRank: inTop ? bestExpected : null, ancestorsExcluded: excluded, corpusTop: all.slice(0, 5), scopedTop: ranked });
  if (!ok) {
    failures.push(c.q);
    console.error(`✗ "${c.q}"`);
    console.error(`    expected one of [${expected.join(', ')}] — best rank ${inTop ? bestExpected : 'MISS'}${!cleanRank ? `, but forbidden ${forbidden.find((f) => ranked.indexOf(f) + 1 === bestForbidden)} ranks ${bestForbidden}` : ''}`);
    console.error(`    ranked: ${ranked.map((k2) => `${k2}[${(legsByKey.get(k2) ?? []).join('+')}]`).join('  ')}`);
    if (excluded.length) console.error(`    (ancestors exempt: ${excluded.join('  ')})`);
  } else {
    console.error(`✓ "${c.q}" → rank ${bestExpected}${excluded.length ? `  (ancestors exempt: ${excluded.join(' ')})` : ''}`);
  }
}

if (skipped.length) {
  console.error(`⚠ ${skipped.length}/${spec.cases.length} case(s) SKIPPED — expectations reference nothing in this corpus (coverage gap, not recall)`);
}
const measured = spec.cases.length - skipped.length;
console.log(`RECALL_RESULT ${JSON.stringify({ cases: spec.cases.length, measured, skipped: skipped.length, failed: failures, embedded, report })}`);
// Nothing measurable is the embedder-missing situation in another coat: loud
// non-green, never a pass.
if (!measured) { console.error('⚠ RECALL GATE: zero measurable cases'); stop(4); }
stop(failures.length ? 1 : 0);
}
