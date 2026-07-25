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
 *   node scripts/recall-gate.mjs [--queries F] [--fixture DIR] [--skills DIR]
 *                                [--base URL] [--baseline F] [--update-baseline]
 *                                [--min-measured N|N%]
 *
 * THE DENOMINATOR IS PART OF THE RESULT. A gate that measures 14 of 261 cases
 * and exits 0 is not a passing gate, it is a lie with a green light — this repo
 * shipped exactly that once ("corpus exhausted") and does not intend to again.
 * Every number this script prints carries its base: measured/total,
 * passing/measured, and the unmeasurable remainder BROKEN DOWN BY CAUSE, so a
 * coverage collapse can never read as a pass.
 *
 * Two problems, two numbers, never mixed:
 *   REGRESSION   a case the recorded baseline says passed now FAILS. KEAP's
 *                fault (ranking moved). Exit 1.
 *   CORPUS GAP   a case whose expectations name nothing in the corpus under
 *                test. NOT a recall result at all — it is coverage that never
 *                happened, and it is the corpus owner's to close. Exit 4 when
 *                it eats the coverage the baseline recorded.
 *
 * Exit codes — four states, deliberately distinct:
 *   0  every measured case passed, and coverage did not shrink
 *   1  at least one measured case failed (name in the output; flagged NEW when
 *      the baseline recorded it passing)
 *   4  SKIPPED/LOUD: no embedder reachable, nothing measurable, coverage below
 *      --min-measured (default 50% of the set), or coverage lost against the
 *      baseline. NOT a pass —
 *      a gate that cannot run must never be readable as green (doctrine:
 *      gates.md).
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// --queries is FIRST CLASS: the query set is an input, not a constant, and the
// interesting sets live outside this repo (nOS owns the 261-case self-model set
// at tests/fixtures/selfmodel-recall.json — see `npm run gate:recall:nos`).
// The gate never copies a foreign set in; it reads it where its owner keeps it,
// so the two repos cannot silently diverge.
const QUERIES = arg('queries', 'e2e/fixtures/selfmodel-recall.json');
const MODE = LIVE_BASE ? 'live' : 'fixture';
// The baseline is per (query set × mode): fixture mode and live mode measure
// different corpora, and comparing across them would manufacture exactly the
// coverage lie this gate exists to prevent.
// The whole PATH is slugified, not just the basename: the in-repo set and the
// nOS set are both called selfmodel-recall.json, and a shared baseline file
// between two different query sets is the same class of mistake as a shared
// denominator between two different corpora.
const BASELINE = arg(
  'baseline',
  path.join(
    'e2e',
    'baselines',
    `${QUERIES.replace(/\.json$/, '').replace(/^[./]+/, '').replace(/[^A-Za-z0-9]+/g, '-')}.${MODE}.json`,
  ),
);
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const NO_BASELINE = process.argv.includes('--no-baseline');
// --min-measured 261 | 95% | 0 (to disable) — the declared denominator floor.
// It DEFAULTS to 50% rather than to nothing, because the failure being fixed
// here is precisely a green exit over a 5% sample: a gate must refuse to call
// itself passing when most of its set never ran, whether or not CI remembered
// to ask. Runs that legitimately measure a subset say so explicitly.
const MIN_MEASURED = arg('min-measured', '50%');
const OLLAMA = process.env.KEAP_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.KEAP_EMBED_MODEL ?? 'nomic-embed-text';
const DIR = path.join(REPO, 'e2e', '.recall-gate');

// Why a case could not be measured. These are NOT failures and never share a
// number with one: each says something different about whose problem it is.
const CAUSES = {
  'gap:both-absent': 'corpus gap — neither the expected node nor the expected card exists here',
  'gap:node-absent': 'corpus gap — the only expectation is a node id absent from this corpus',
  'gap:card-absent': 'corpus gap — the only expectation is a card title absent from this corpus',
  'ambiguous-title': 'ambiguous title — the title exists on several cards and nothing scopes it',
};
// Measured, but on LESS than the case named. Coverage that reads as real must
// say how much of the expectation it actually exercised.
const DEGRADED = {
  'degraded:card-absent': 'measured on the NODE only — the named card is not in this corpus',
  'degraded:node-absent': 'measured on the CARD only — the named node is not in this corpus',
};

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

if (!existsSync(QUERIES)) {
  console.error(`⚠ RECALL GATE SKIPPED: query set not found at ${QUERIES} — nothing was measured`);
  process.exit(4);
}
const spec = JSON.parse(readFileSync(QUERIES, 'utf8'));
const K = spec.k ?? 5;
console.error(`· query set: ${QUERIES} — ${spec.cases.length} case(s), k=${K}, mode=${MODE}`);

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
  const idsByTitle = new Map();
  for (let offset = 0; ; offset += 50) {
    const page = (await (
      await fetch(`${base}/agent/v1/objects?limit=50&offset=${offset}`, { headers: H, ...TL(30_000) })
    ).json()).data;
    for (const o of page.results ?? []) idsByTitle.set(o.title, [...(idsByTitle.get(o.title) ?? []), o.id]);
    if (!(page.results ?? []).length || offset + 50 >= (page.total ?? 0)) break;
  }
  const search = async (q) => {
    const r = (await (
      await fetch(`${base}/agent/v1/search/semantic?q=${encodeURIComponent(q)}&limit=30`, { headers: H, ...TL(30_000) })
    ).json()).data;
    return (r.results ?? []).map((h) => ({ kind: h.kind, refId: h.id, legs: h.legs ?? [] }));
  };
  // The list surface does not carry anchors; the detail surface does. Fetched
  // lazily and memoised (only for cards a case actually names), so anchor
  // scoping and the ancestor exemption behave IDENTICALLY in both modes —
  // previously --base ran with an empty anchor map and a weaker exemption,
  // which quietly made the live run stricter than the fixture run.
  const fetchAnchors = async (id) => {
    const d = (await (
      await fetch(`${base}/agent/v1/objects/${encodeURIComponent(id)}`, { headers: H, ...TL(30_000) })
    ).json()).data;
    return (d?.links ?? []).filter((l) => l.kind === 'node').map((l) => l.ref);
  };
  await runCaseSet({ nodeIds, idsByTitle, anchorsById: new Map(), fetchAnchors, search }, (code) => process.exit(code), 0);
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
  const idsByTitle = new Map();
  for (const o of graph.objects) idsByTitle.set(o.title, [...(idsByTitle.get(o.title) ?? []), o.id]);
  await runCaseSet(
    {
      nodeIds: new Set(graph.nodes.map((n) => n.id)),
      idsByTitle,
      anchorsById: new Map(graph.objects.map((o) => [o.id, o.anchors ?? []])),
      fetchAnchors: null,
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
async function runCaseSet({ nodeIds, idsByTitle, anchorsById, fetchAnchors, search }, stop, embedded) {
// An expectation that references nothing in the corpus is NOT a recall failure —
// it is an unmeasurable case, and conflating the two turns a coverage gap into
// a wall of false reds that buries the real signal. Unresolvable refs (a node
// absent from this tree, a card title with no card) drop the ref; a case with
// NO resolvable expectation is skipped and counted loudly, WITH ITS CAUSE.

// Anchors of a card, memoised. The fixture path has them all up front (/api/graph
// ships them); the live agent list surface does not, so they are fetched per id
// on demand. Same map either way — one code path below.
const anchorsOf = async (id) => {
  if (anchorsById.has(id)) return anchorsById.get(id);
  const a = fetchAnchors ? await fetchAnchors(id).catch(() => []) : [];
  anchorsById.set(id, a);
  return a;
};

// `title:` IS NOT A UNIQUE HANDLE, and pretending it was is a defect this gate
// shipped with: idByTitle was built last-write-wins, so on an estate where six
// skill names repeat across systems (create-document, list-users, list-databases,
// …) 30 cases named a duplicated title and 13 resolved to a card owned by a
// DIFFERENT system than the case meant. Measured result: 3 false reds (ERPNext's
// create-document ranked #1 while the gate graded Outline's) and 2 false greens.
// The fix is anchor scoping: a `title:` ref is resolved WITHIN the subtree of the
// node the same case names. Preference order — the card anchored at (or under)
// the expected node, else a card anchored at an ancestor of it; ties and
// no-match are UNRESOLVED rather than guessed, because a guess is how the false
// reds happened in the first place.
const scopeTitle = async (title, scopeNodes) => {
  const ids = idsByTitle.get(title) ?? [];
  if (ids.length <= 1) return { ids, why: ids.length ? null : 'card-absent' };
  if (!scopeNodes.length) return { ids: [], why: 'ambiguous' };
  const exact = [];
  const ancestor = [];
  for (const id of ids) {
    const anchors = await anchorsOf(id);
    for (const n of scopeNodes) {
      if (anchors.some((a) => a === n || a.startsWith(`${n}.`))) { exact.push(id); break; }
      if (anchors.some((a) => n.startsWith(`${a}.`))) { ancestor.push(id); break; }
    }
  }
  const picked = exact.length ? exact : ancestor;
  return picked.length ? { ids: picked, why: null } : { ids: [], why: 'ambiguous' };
};

// Resolve one case's ref list. Returns the resolved hits PLUS the per-half
// verdict, so the summary can say WHY something was not measured instead of
// lumping every miss into one anonymous "skipped" bucket.
const resolveRefs = async (refs, scopeOverride) => {
  // A forbid list is scoped by the case's EXPECT nodes, not by its own: "the
  // stack must not beat the skill" names the stack, and the stack is precisely
  // not the thing that scopes the skill's title.
  const scopeNodes = scopeOverride ?? refs.filter((r) => r.startsWith('node:')).map((r) => r.slice(5));
  const resolved = [];
  let nodeRefs = 0;
  let nodeHits = 0;
  let titleRefs = 0;
  let titleHits = 0;
  let ambiguous = 0;
  for (const ref of refs) {
    if (ref.startsWith('node:')) {
      nodeRefs++;
      const id = ref.slice(5);
      if (nodeIds.has(id)) { nodeHits++; resolved.push({ kind: 'taxonomy', refId: id }); }
    } else if (ref.startsWith('title:')) {
      titleRefs++;
      const { ids, why } = await scopeTitle(ref.slice(6), scopeNodes);
      if (why === 'ambiguous') ambiguous++;
      if (ids.length) { titleHits++; for (const id of ids) resolved.push({ kind: 'object', refId: id }); }
    }
  }
  return { resolved, nodeRefs, nodeHits, titleRefs, titleHits, ambiguous };
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
  const ids = [];
  for (const e of expectedResolved) {
    if (e.kind === 'taxonomy') ids.push(e.refId);
    else ids.push(...(anchorsById.get(e.refId) ?? []));
  }
  for (const id of ids) {
    const segs = id.split('.');
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('.'));
  }
  // never exclude something that is itself expected
  for (const e of expectedResolved) if (e.kind === 'taxonomy') out.delete(e.refId);
  return out;
};

const failures = [];
const passing = [];
const unmeasurable = []; // { q, cause, systems }
const degraded = []; // { q, cause }
const report = [];
const ranks = new Map();
let ancestorExemptions = 0;
let bothInTop = 0;
let cardOnly = 0;
let nodeOnly = 0;
for (const c of spec.cases) {
  const exp = await resolveRefs(c.expect);
  if (!exp.resolved.length) {
    // WHY nothing resolved is the whole point. "247 skipped" says nothing;
    // "247 skipped because this fixture holds 3 of the 22 systems the set asks
    // about" says whose problem it is and what closing it would cost.
    const cause = exp.ambiguous && !exp.nodeRefs
      ? 'ambiguous-title'
      : exp.nodeRefs && exp.titleRefs
        ? 'gap:both-absent'
        : exp.nodeRefs
          ? 'gap:node-absent'
          : 'gap:card-absent';
    unmeasurable.push({
      q: c.q,
      cause,
      systems: c.expect.filter((r) => r.startsWith('node:')).map((r) => r.slice(5)),
    });
    continue;
  }
  // Anchors of every resolved card, so properAncestors() sees the same lineage
  // in both modes (fixture had them from /api/graph; live now fetches them).
  for (const e of exp.resolved) if (e.kind === 'object') await anchorsOf(e.refId);
  // Measured, but on less than the case named — say so rather than let a node
  // hit stand in silently for the skill the case is actually about.
  if (exp.titleRefs && !exp.titleHits) degraded.push({ q: c.q, cause: 'degraded:card-absent' });
  else if (exp.nodeRefs && !exp.nodeHits) degraded.push({ q: c.q, cause: 'degraded:node-absent' });

  const hits = await search(c.q);
  const all = hits.map(hitKey);
  const legsByKey = new Map(hits.map((h) => [hitKey(h), h.legs ?? []]));
  const scoped = hits.filter((h) => inScope(h) && isRelevance(h)).map(hitKey);
  const top = scoped.slice(0, K);

  const expectedResolved = exp.resolved;
  const expected = expectedResolved.map(hitKey);
  const ancestors = properAncestors(expectedResolved);
  const ranked = top.filter((k2) => !(k2.startsWith('taxonomy:') && ancestors.has(k2.slice('taxonomy:'.length))));
  const excluded = top.filter((k2) => !ranked.includes(k2));
  const forbidden = (await resolveRefs(c.forbid ?? [], c.expect.filter((r) => r.startsWith('node:')).map((r) => r.slice(5)))).resolved
    .map(hitKey)
    .filter((f) => ranked.includes(f) || !excluded.includes(f));
  const bestExpected = Math.min(...expected.map((e) => (ranked.indexOf(e) + 1 || Infinity)));
  const bestForbidden = Math.min(...forbidden.map((f) => (ranked.indexOf(f) + 1 || Infinity)));

  const inTop = bestExpected !== Infinity;
  const cleanRank = bestForbidden === Infinity || bestExpected < bestForbidden;
  const ok = inTop && cleanRank;
  if (excluded.length) ancestorExemptions++;
  // `expect` is a UNION (system node OR skill card), so a pass does NOT mean the
  // skill won. Count which half carried it — a pass carried only by the system
  // node is a weaker result than it looks, and the summary says how many.
  if (ok) {
    const nodeIn = expectedResolved.some((e) => e.kind === 'taxonomy' && ranked.includes(hitKey(e)));
    const cardIn = expectedResolved.some((e) => e.kind === 'object' && ranked.includes(hitKey(e)));
    if (nodeIn && cardIn) bothInTop++;
    else if (cardIn) cardOnly++;
    else nodeOnly++;
    ranks.set(bestExpected, (ranks.get(bestExpected) ?? 0) + 1);
  }
  report.push({ q: c.q, ok, scopedRank: inTop ? bestExpected : null, ancestorsExcluded: excluded, corpusTop: all.slice(0, 5), scopedTop: ranked });
  if (!ok) {
    failures.push(c.q);
    console.error(`✗ "${c.q}"`);
    console.error(`    expected one of [${expected.join(', ')}] — best rank ${inTop ? bestExpected : 'MISS'}${!cleanRank ? `, but forbidden ${forbidden.find((f) => ranked.indexOf(f) + 1 === bestForbidden)} ranks ${bestForbidden}` : ''}`);
    console.error(`    ranked: ${ranked.map((k2) => `${k2}[${(legsByKey.get(k2) ?? []).join('+')}]`).join('  ')}`);
    if (excluded.length) console.error(`    (ancestors exempt: ${excluded.join('  ')})`);
  } else {
    passing.push(c.q);
    console.error(`✓ "${c.q}" → rank ${bestExpected}${excluded.length ? `  (ancestors exempt: ${excluded.join(' ')})` : ''}`);
  }
}

// ── 4) The report NAMES ITS DENOMINATOR ─────────────────────────────────────
// Rule of this file: no percentage is ever printed without the fraction that
// produced it. A bare "98% recall" over an invisible base is how "corpus
// exhausted" happened; this block exists so that reading the output honestly is
// the path of least resistance.
const total = spec.cases.length;
const measured = total - unmeasurable.length;
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : `n/a (0/${d})`);
const byCause = new Map();
for (const u of unmeasurable) byCause.set(u.cause, [...(byCause.get(u.cause) ?? []), u]);
const degradedByCause = new Map();
for (const d of degraded) degradedByCause.set(d.cause, (degradedByCause.get(d.cause) ?? 0) + 1);

console.error('');
console.error(`── RECALL GATE — ${QUERIES} (${MODE} mode, k=${K}, scope=${scopeRoot}) ──`);
console.error(`   cases in set   ${total}`);
console.error(`   MEASURED       ${pct(measured, total)} of the set`);
console.error(`   PASSING        ${pct(passing.length, measured)} of MEASURED  ← never of ${total}`);
console.error(`   FAILING        ${failures.length}/${measured} measured`);
console.error(`   UNMEASURABLE   ${unmeasurable.length}/${total} — not failures, and not passes either`);
for (const [cause, list] of [...byCause].sort((a, b) => b[1].length - a[1].length)) {
  console.error(`     ${String(list.length).padStart(5)}  ${cause} — ${CAUSES[cause]}`);
  // Which systems the gap is made of: the actionable half of a coverage number.
  const bySystem = new Map();
  for (const u of list) for (const s of new Set(u.systems)) bySystem.set(s, (bySystem.get(s) ?? 0) + 1);
  const top = [...bySystem].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) console.error(`            missing: ${top.map(([s, n]) => `${s}×${n}`).join(', ')}${bySystem.size > 8 ? `, +${bySystem.size - 8} more` : ''}`);
}
if (degraded.length) {
  console.error(`   DEGRADED       ${degraded.length}/${measured} measured on LESS than the case named`);
  for (const [cause, n] of [...degradedByCause].sort((a, b) => b[1] - a[1])) {
    console.error(`     ${String(n).padStart(5)}  ${cause} — ${DEGRADED[cause]}`);
  }
}
if (passing.length) {
  // `expect` is a union; a pass is not proof the skill won. Say which half won.
  console.error(`   PASS SHAPE     node+card ${bothInTop} · card only ${cardOnly} · SYSTEM NODE ONLY ${nodeOnly} (the named skill never made top-${K})`);
  const hist = [...ranks].sort((a, b) => a[0] - b[0]).map(([r, n]) => `rank${r} ${n}`).join(' · ');
  console.error(`   RANKS          ${hist}${ranks.get(K) ? `   ← ${ranks.get(K)} case(s) sit at rank ${K}, one slot from a miss` : ''}`);
  console.error(`   ANCESTOR EXEMPTION fired on ${ancestorExemptions}/${measured} measured case(s)`);
}

// ── 5) Baseline: REGRESSION and CORPUS GAP are different problems ───────────
// The baseline records which cases passed, so a later run can say "these five
// USED TO PASS and now fail" (KEAP's ranking moved — a regression) separately
// from "these forty were never measurable here" (the corpus does not contain
// what the set asks about — the corpus owner's problem). Sharing one number
// between those two is how a coverage collapse gets mistaken for a healthy gate.
let baseline = null;
if (!NO_BASELINE && existsSync(BASELINE)) {
  try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')); }
  catch { console.error(`⚠ baseline ${BASELINE} is unreadable — comparing against nothing`); }
}
const nowUnmeasurable = new Map(unmeasurable.map((u) => [u.q, u.cause]));
const nowPassing = new Set(passing);
const nowFailing = new Set(failures);
let regressions = [];
let newlyFailing = [];
let coverageLost = [];
let fixed = [];
let newCoverage = [];
if (baseline) {
  if (baseline.mode !== MODE || baseline.queries !== QUERIES) {
    console.error(`⚠ baseline was recorded for ${baseline.queries} in ${baseline.mode} mode — comparison would be apples to oranges, ignoring it`);
    baseline = null;
  }
}
if (baseline) {
  const wasPassing = new Set(baseline.passing ?? []);
  const wasFailing = new Set(baseline.failing ?? []);
  const wasUnmeasurable = new Set(Object.keys(baseline.unmeasurable ?? {}));
  regressions = [...nowFailing].filter((q) => wasPassing.has(q));
  newlyFailing = [...nowFailing].filter((q) => !wasPassing.has(q) && !wasFailing.has(q));
  coverageLost = [...nowUnmeasurable.keys()].filter((q) => wasPassing.has(q) || wasFailing.has(q));
  fixed = [...nowPassing].filter((q) => wasFailing.has(q));
  newCoverage = [...nowPassing, ...nowFailing].filter((q) => wasUnmeasurable.has(q));
  console.error('');
  console.error(`── vs baseline ${BASELINE} (recorded ${baseline.recorded ?? '?'}, measured ${baseline.measured}/${baseline.total}) ──`);
  console.error(`   REGRESSIONS    ${regressions.length}  (passed then, fail now — a KEAP ranking regression)`);
  for (const q of regressions) console.error(`     ✗ "${q}"`);
  if (newlyFailing.length) {
    console.error(`   NEW & FAILING  ${newlyFailing.length}  (case not in the baseline at all — a new expectation, not a regression)`);
    for (const q of newlyFailing) console.error(`     ✗ "${q}"`);
  }
  console.error(`   COVERAGE LOST  ${coverageLost.length}  (was measurable, now unmeasurable — a corpus gap, NOT a recall failure)`);
  for (const q of coverageLost.slice(0, 10)) console.error(`     ⚠ "${q}" — ${nowUnmeasurable.get(q)}`);
  if (coverageLost.length > 10) console.error(`     … +${coverageLost.length - 10} more`);
  console.error(`   NEW COVERAGE   ${newCoverage.length}  (unmeasurable then, measured now)`);
  console.error(`   FIXED          ${fixed.length}  (failed then, passes now)`);
} else if (!NO_BASELINE) {
  console.error('');
  console.error(`⚠ no baseline at ${BASELINE} — every failure below is reported as a plain failure, and`);
  console.error('  regression cannot be told from pre-existing debt. Record one with --update-baseline.');
}

const record = {
  queries: QUERIES,
  mode: MODE,
  k: K,
  scope: scopeRoot,
  recorded: new Date().toISOString(),
  total,
  measured,
  passingCount: passing.length,
  passing: [...passing].sort(),
  failing: [...failures].sort(),
  unmeasurable: Object.fromEntries([...nowUnmeasurable].sort((a, b) => a[0].localeCompare(b[0]))),
};
if (UPDATE_BASELINE) {
  mkdirSync(path.dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(record, null, 2)}\n`);
  console.error(`· baseline written: ${BASELINE} (${passing.length} passing, ${measured}/${total} measured)`);
}

console.log(`RECALL_RESULT ${JSON.stringify({
  queries: QUERIES,
  mode: MODE,
  cases: total,
  measured,
  passing: passing.length,
  failed: failures,
  unmeasurable: unmeasurable.length,
  unmeasurableByCause: Object.fromEntries([...byCause].map(([c, l]) => [c, l.length])),
  degradedByCause: Object.fromEntries(degradedByCause),
  passShape: { nodeAndCard: bothInTop, cardOnly, systemNodeOnly: nodeOnly },
  ranks: Object.fromEntries([...ranks].sort((a, b) => a[0] - b[0])),
  baseline: baseline
    ? { path: BASELINE, regressions, newlyFailing, coverageLost, newCoverage: newCoverage.length, fixed: fixed.length }
    : null,
  embedded,
  report,
})}`);

// ── 6) Exit: 0 pass · 1 regression · 4 loud skip ────────────────────────────
// Nothing measurable is the embedder-missing situation in another coat: loud
// non-green, never a pass. So is a run that measured a fraction of the set, or
// one that lost coverage the baseline had — those are gates that did not run,
// not gates that passed.
if (!measured) { console.error(`⚠ RECALL GATE: zero measurable cases out of ${total} — nothing was measured`); stop(4); }
if (failures.length) {
  const label = baseline
    ? `${regressions.length} regression(s), ${newlyFailing.length} new, ${failures.length - regressions.length - newlyFailing.length} known`
    : `${failures.length} failure(s), no baseline to classify them`;
  console.error(`✗ RECALL GATE FAILED — ${label}`);
  stop(1);
}
if (MIN_MEASURED && MIN_MEASURED !== '0' && MIN_MEASURED !== 'none') {
  const need = MIN_MEASURED.endsWith('%')
    ? Math.ceil((total * parseFloat(MIN_MEASURED)) / 100)
    : parseInt(MIN_MEASURED, 10);
  if (measured < need) {
    console.error(`⚠ RECALL GATE SKIPPED-LOUD: measured ${measured}/${total}, below the declared floor of ${need} (--min-measured ${MIN_MEASURED}).`);
    console.error('  Every measured case passed, but this run does not speak for the set. Not a pass.');
    stop(4);
  }
}
if (coverageLost.length) {
  console.error(`⚠ RECALL GATE SKIPPED-LOUD: ${coverageLost.length} case(s) the baseline measured are unmeasurable now.`);
  console.error('  The cases that still run all passed — but the gate covers less than it did. Not a pass.');
  stop(4);
}
console.error(`✓ RECALL GATE PASSED — ${pct(passing.length, measured)} of measured, measuring ${pct(measured, total)} of the set`);
stop(0);
}
