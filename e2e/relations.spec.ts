import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Track R3 stage 1 — the typed cross-type relation pipeline + store.
 *
 * The host-side classifier is STUBBED here (KEAP never calls an LLM): the spec
 * drives the real contract end to end — seed objects + fake embeddings (one
 * taxonomy node + two objects on one axis so a cross-KIND pair surfaces) → GET
 * candidates (cross-type, deduped, both endpoints resolved, vocab offered) →
 * POST a deterministic typed batch including one UNKNOWN type → assert the edges
 * land status='proposed' with provenance, the unknown type became a PROPOSED
 * relation_type, the re-POST is idempotent (no dup, no re-growth), and the
 * proposed derived edges stay OUT of the /api/graph relations overlay (the
 * moderation gate — ToE overlay behaviour is unchanged).
 */
test.describe.configure({ mode: 'serial' });

const RO = { Authorization: 'Bearer e2e-ro' };
const RW = { Authorization: 'Bearer e2e-rw', 'Content-Type': 'application/json' };

const OBJ1 = 'rel-obj-alpha';
const OBJ2 = 'rel-obj-beta';
// Mirrors an fs-synced card: a SHORT non-empty description (the folder path) plus
// the real document in the body — the shape that used to starve the classifier.
const OBJ3 = 'rel-obj-fssynced';
const OBJ3_DESC = 'nOS/infra';
// Deliberately longer than DESCRIPTION_CAP (240) — the browse-surface preview cap
// must not be what bounds the classifier's evidence.
const OBJ3_BODY =
  'Wiring layer for PostgreSQL 16 in the infra compose stack: shared OLTP storage ' +
  'deployed as postgres:16.14-alpine, exposing port 5432 to the stack network. ' +
  'Backups run nightly to the host volume and are pruned after fourteen days. ' +
  'Connection pooling is handled upstream; the container itself stays stateless ' +
  'apart from its data volume. TAILMARKER-past-the-preview-cap.';
const AXIS = 300; // distinctive dim → orthogonal to other specs' vectors
// A distinct MINORITY model: cross-kind candidate recall is model-agnostic (it
// compares vectors by geometry), but topics clustering counts only the dominant
// object-vector model — so these three vectors never perturb the topics spec's
// exact object count. (The vector space is the same 768-d nomic space either way.)
const REL_MODEL = 'e2e-relations-model';

/** 768-d unit-ish vector: a dominant axis + a tiny per-ref perturbation. */
function vec(seed: number): number[] {
  const v = new Array<number>(768).fill(0);
  v[AXIS] = 1;
  v[100 + (seed % 600)] = 0.02;
  return v;
}

async function embed(
  request: APIRequestContext,
  items: Array<{ kind: string; refId: string; seed: number; vector?: number[] }>,
  model = REL_MODEL,
) {
  const res = await request.post('/agent/v1/embeddings', {
    headers: RW,
    data: {
      model,
      dim: 768,
      items: items.map((it) => ({
        kind: it.kind,
        refId: it.refId,
        contentHash: `e2e-rel-${it.refId}`,
        vector: it.vector ?? vec(it.seed),
      })),
    },
  });
  expect(res.ok()).toBeTruthy();
}

let NODE = ''; // a real taxonomy node id, embedded on AXIS so it neighbours the objects

test.describe('typed relations pipeline (R3 stage 1)', () => {
  test('seed: two objects + a taxonomy node embedded on one axis', async ({ request }) => {
    for (const id of [OBJ1, OBJ2]) {
      const r = await request.post('/api/objects', {
        data: { id, type: 'note', title: id, body: `body for ${id}` },
      });
      expect(r.ok()).toBeTruthy();
    }
    const graph = (await (await request.get('/api/graph')).json()).data as { nodes: Array<{ id: string }> };
    NODE = graph.nodes[0].id;
    expect(NODE).toBeTruthy();
    const r3 = await request.post('/api/objects', {
      data: { id: OBJ3, type: 'note', title: 'postgresql.md', description: OBJ3_DESC, body: OBJ3_BODY },
    });
    expect(r3.ok()).toBeTruthy();
    await embed(request, [
      { kind: 'taxonomy', refId: NODE, seed: 1 },
      { kind: 'object', refId: OBJ1, seed: 2 },
      { kind: 'object', refId: OBJ2, seed: 3 },
      { kind: 'object', refId: OBJ3, seed: 4 },
    ]);
  });

  test('candidate text carries the whole card, not just its description', async ({ request }) => {
    const r = await request.get('/agent/v1/relations/candidates?maxDistance=0.35&limit=50', { headers: RO });
    expect(r.ok()).toBeTruthy();
    const pairs = (await r.json()).data.pairs as Array<{
      from_ref: string;
      to_ref: string;
      fromText: string;
      toText: string;
    }>;
    const p = pairs.find((x) => [x.from_ref, x.to_ref].includes(OBJ3));
    expect(p, 'OBJ3 candidate present').toBeTruthy();
    const text = p!.from_ref === OBJ3 ? p!.fromText : p!.toText;

    // The regression: `description ?? body` short-circuited on the non-empty folder
    // path, so the classifier saw "postgresql.md. nOS/infra" for a card whose
    // embedding was built from the body. Both must reach the classifier now.
    expect(text).toContain(OBJ3_DESC);
    expect(text, 'body reaches the classifier').toContain('postgres:16.14-alpine');

    // ...and the 240-char browse-preview cap is not what bounds it: a marker past
    // that offset must survive, or ENDPOINT_TEXT_CAP is dead code.
    expect(text.length).toBeGreaterThan(240);
    expect(text, 'text past the preview cap survives').toContain('TAILMARKER-past-the-preview-cap');
  });

  test('candidates sweep: cross-type pairs only, deduped, both endpoints resolved, vocab offered', async ({
    request,
  }) => {
    const r = await request.get('/agent/v1/relations/candidates?maxDistance=0.35&limit=50', { headers: RO });
    expect(r.ok()).toBeTruthy();
    const data = (await r.json()).data as {
      model: string | null;
      pairs: Array<{
        from_ref: string;
        from_kind: string;
        to_ref: string;
        to_kind: string;
        fromLabel: string;
        toLabel: string;
        similarity: number;
      }>;
      vocab: Array<{ type: string; label: string }>;
    };

    // The node↔object pairs are present; object↔object (same kind) is NOT.
    const key = (p: { from_ref: string; to_ref: string }) => [p.from_ref, p.to_ref].sort().join('::');
    const nodeObjPairs = data.pairs.filter(
      (p) => [p.from_ref, p.to_ref].includes(NODE) && (p.from_kind === 'object' || p.to_kind === 'object'),
    );
    const withObj1 = nodeObjPairs.find((p) => [p.from_ref, p.to_ref].includes(OBJ1))!;
    const withObj2 = nodeObjPairs.find((p) => [p.from_ref, p.to_ref].includes(OBJ2))!;
    expect(withObj1, 'NODE↔OBJ1 candidate').toBeTruthy();
    expect(withObj2, 'NODE↔OBJ2 candidate').toBeTruthy();

    // Cross-type only: no candidate pairs OBJ1↔OBJ2 (same kind).
    expect(data.pairs.some((p) => key(p) === [OBJ1, OBJ2].sort().join('::'))).toBe(false);

    // Orientation: an object↔node pair puts the OBJECT as `from`.
    expect(withObj1.from_kind).toBe('object');
    expect(withObj1.to_kind).toBe('node');
    expect(withObj1.to_ref).toBe(NODE);

    // Deduped: each unordered pair appears once.
    const keys = data.pairs.map(key);
    expect(new Set(keys).size).toBe(keys.length);

    // Similarity high (same axis → distance ~0), both endpoints carry a label.
    expect(withObj1.similarity).toBeGreaterThan(0.8);
    expect(withObj1.fromLabel.length).toBeGreaterThan(0);
    expect(withObj1.toLabel.length).toBeGreaterThan(0);

    // Controlled vocabulary offered (seed types), no proposed verb yet.
    const types = data.vocab.map((v) => v.type);
    expect(types).toContain('supports');
    expect(types).toContain('depends-on');
    expect(types).not.toContain('illustrates');
  });

  test('candidates sweep honours sinceTs (incremental watermark, live on the surface)', async ({
    request,
  }) => {
    // A future watermark: no vector changed after it, so the corpus sweep must
    // re-consider nothing — proving sinceTs is wired through (previously the
    // endpoint ignored it and every call was a full corpus scan).
    const future = Math.floor(Date.now() / 1000) + 3600;
    const r = await request.get(
      `/agent/v1/relations/candidates?maxDistance=0.35&limit=50&sinceTs=${future}`,
      { headers: RO },
    );
    expect(r.ok()).toBeTruthy();
    const pairs = (await r.json()).data.pairs as Array<{ from_ref: string; to_ref: string }>;
    const touchesFixture = pairs.some((p) =>
      [p.from_ref, p.to_ref].some((x) => [OBJ1, OBJ2, NODE].includes(x)),
    );
    expect(touchesFixture, 'nothing changed after the watermark → fixture pairs excluded').toBe(false);
  });

  test('candidates anchored: cross-kind neighbours of the node only', async ({ request }) => {
    const r = await request.get(
      `/agent/v1/relations/candidates?anchorKind=node&anchorId=${encodeURIComponent(NODE)}&limit=50`,
      { headers: RO },
    );
    expect(r.ok()).toBeTruthy();
    const pairs = (await r.json()).data.pairs as Array<{
      from_ref: string;
      from_kind: string;
      to_ref: string;
      to_kind: string;
    }>;
    const refs = new Set(pairs.flatMap((p) => [p.from_ref, p.to_ref]));
    expect(refs.has(OBJ1)).toBe(true);
    expect(refs.has(OBJ2)).toBe(true);
    // Cross-type only: the anchored path must not surface same-kind neighbours
    // (regression guard — it previously returned node↔node / object↔object too).
    for (const p of pairs) expect(p.from_kind, JSON.stringify(p)).not.toBe(p.to_kind);
  });

  test('POST typed batch: known + unknown type land proposed with provenance', async ({ request }) => {
    const r = await request.post('/agent/v1/relations', {
      headers: { ...RW, 'x-keap-agent': 'e2e-classifier' },
      data: {
        model: 'claude-sonnet-e2e',
        relations: [
          {
            from_ref: OBJ1,
            from_kind: 'object',
            to_ref: NODE,
            to_kind: 'node',
            type: 'supports', // known seed type
            confidence: 0.91,
            justification: 'The document backs the concept.',
          },
          {
            from_ref: OBJ2,
            from_kind: 'object',
            to_ref: NODE,
            to_kind: 'node',
            type: 'illustrates', // UNKNOWN → grows the vocab as proposed
            confidence: 0.72,
            justification: 'The document is a worked example of the concept.',
          },
        ],
      },
    });
    expect(r.ok()).toBeTruthy();
    const body = (await r.json()).data as { upserted: number; proposedTypes: string[]; submittedBy: string };
    expect(body.upserted).toBe(2);
    expect(body.proposedTypes).toEqual(['illustrates']);
    expect(body.submittedBy).toBe('agent:e2e-classifier');

    // Read back: both stored proposed/derived with full provenance.
    const list = (await (
      await request.get('/agent/v1/relations?status=proposed&source=derived', { headers: RO })
    ).json()).data as {
      relations: Array<{
        fromRef: string;
        toRef: string;
        type: string;
        status: string;
        source: string;
        model: string | null;
        confidence: number | null;
        justification: string | null;
        createdAt: number | null;
      }>;
      types: Array<{ type: string; status: string }>;
    };
    const supports = list.relations.find((x) => x.type === 'supports' && x.fromRef === OBJ1)!;
    const illustrates = list.relations.find((x) => x.type === 'illustrates' && x.fromRef === OBJ2)!;
    expect(supports).toBeTruthy();
    expect(illustrates).toBeTruthy();
    for (const row of [supports, illustrates]) {
      expect(row.status).toBe('proposed');
      expect(row.source).toBe('derived');
      expect(row.toRef).toBe(NODE);
      expect(row.model).toBe('claude-sonnet-e2e');
      expect(typeof row.confidence).toBe('number');
      expect((row.justification ?? '').length).toBeGreaterThan(0);
      expect(typeof row.createdAt).toBe('number');
    }
    expect(supports.confidence).toBeCloseTo(0.91, 5);

    // The unknown type is now a PROPOSED relation_type (moderated growth).
    const illType = list.types.find((t) => t.type === 'illustrates')!;
    expect(illType.status).toBe('proposed');
  });

  test('idempotent re-POST: no duplicate rows, no re-growth of the vocab', async ({ request }) => {
    const before = (await (
      await request.get('/agent/v1/relations?source=derived', { headers: RO })
    ).json()).data.relations.length as number;
    const r = await request.post('/agent/v1/relations', {
      headers: { ...RW, 'x-keap-agent': 'e2e-classifier' },
      data: {
        relations: [
          {
            from_ref: OBJ2,
            from_kind: 'object',
            to_ref: NODE,
            to_kind: 'node',
            type: 'illustrates',
            confidence: 0.8, // refreshed value
            justification: 'Re-proposed with a slightly higher confidence.',
          },
        ],
      },
    });
    expect(r.ok()).toBeTruthy();
    // Already-known proposed type ⇒ not re-grown.
    expect((await r.json()).data.proposedTypes).toEqual([]);
    const after = (await (
      await request.get('/agent/v1/relations?source=derived', { headers: RO })
    ).json()).data.relations as Array<{ type: string; fromRef: string; confidence: number }>;
    expect(after.length).toBe(before); // no new row
    // The upsert refreshed confidence in place.
    const row = after.find((x) => x.type === 'illustrates' && x.fromRef === OBJ2)!;
    expect(row.confidence).toBeCloseTo(0.8, 5);
  });

  test('proposed derived edges stay OUT of the /api/graph relations overlay', async ({ request }) => {
    // The graph Vazby overlay renders only the ToE/confirmed set (stage-1
    // rendering is unchanged). A proposed derived edge must not leak in.
    const graph = (await (await request.get('/api/graph')).json()).data as {
      relations: Array<{ source: string; target: string; type: string }>;
    };
    expect(Array.isArray(graph.relations)).toBe(true);
    const leaked = graph.relations.some(
      (e) => [e.source, e.target].includes(OBJ1) || [e.source, e.target].includes(OBJ2) || e.type === 'illustrates',
    );
    expect(leaked).toBe(false);
  });

  test('validation: bad kind, out-of-range confidence, unresolved endpoint, empty justification all 400', async ({
    request,
  }) => {
    const base = { from_ref: OBJ1, from_kind: 'object', to_ref: NODE, to_kind: 'node', type: 'supports', confidence: 0.5, justification: 'ok' };
    const bad = [
      { ...base, from_kind: 'capture' }, // unsupported kind
      { ...base, from_kind: 'node', to_kind: 'node', to_ref: NODE, from_ref: NODE }, // same-kind (cross-type store only)
      { ...base, confidence: 1.5 }, // out of [0,1]
      { ...base, to_ref: 'no-such-node' }, // endpoint does not resolve
      { ...base, justification: '   ' }, // empty after trim
    ];
    for (const rel of bad) {
      const r = await request.post('/agent/v1/relations', { headers: RW, data: { relations: [rel] } });
      expect(r.status(), JSON.stringify(rel)).toBe(400);
    }
  });

  test('auth: candidates need a token; POST needs write scope', async ({ request }) => {
    expect((await request.get('/agent/v1/relations/candidates')).status()).toBe(401);
    expect(
      (await request.post('/agent/v1/relations', { headers: RO, data: { relations: [] } })).status(),
    ).toBe(403);
  });
});

/**
 * Track R3 stage 2 — moderation + cross-type rendering payload + the brain
 * endpoint. Builds on the stage-1 fixtures left in the serial run: OBJ1/OBJ2 are
 * proposed-derived edges to NODE ('supports' seed, 'illustrates' unknown→proposed
 * verb). Here an admin CONFIRMS/REJECTS edges and grows the vocabulary, and we
 * assert the confirmed set surfaces in /api/graph crossRelations + /agent/v1/graph
 * with provenance, rejected never renders, and a private object's edge is hidden
 * from a viewer who can't see it.
 */
interface AdminRel {
  id: string;
  fromRef: string;
  toRef: string;
  type: string;
  status: string;
  fromLabel: string;
  toLabel: string;
}
interface CrossRel {
  from: string;
  fromKind: string;
  to: string;
  toKind: string;
  type: string;
  color: string | null;
  confidence: number | null;
}

async function proposedRelations(request: APIRequestContext): Promise<AdminRel[]> {
  const r = await request.get('/api/admin/relations?status=proposed');
  expect(r.ok()).toBeTruthy();
  return (await r.json()).data.relations as AdminRel[];
}
async function crossRelations(
  request: APIRequestContext,
  headers?: Record<string, string>,
): Promise<CrossRel[]> {
  const r = await request.get('/api/graph', headers ? { headers } : undefined);
  expect(r.ok()).toBeTruthy();
  return ((await r.json()).data.crossRelations ?? []) as CrossRel[];
}

test.describe('relations moderation + rendering + brain endpoint (R3 stage 2)', () => {
  const PRIV = 'rel-obj-priv'; // alice's private object
  const ALICE = { 'X-Authentik-Username': 'alice' };
  const BOB = { 'X-Authentik-Username': 'bob' };

  test('admin lists proposed relations with resolved from/to labels', async ({ request }) => {
    const rels = await proposedRelations(request);
    const supports = rels.find((x) => x.type === 'supports' && x.fromRef === OBJ1)!;
    expect(supports, 'supports edge in the moderation queue').toBeTruthy();
    expect(supports.fromLabel.length).toBeGreaterThan(0);
    expect(supports.toLabel.length).toBeGreaterThan(0);
    expect(supports.status).toBe('proposed');
    // The proposed derived set is NOT in the confirmed overlay yet.
    const before = await crossRelations(request);
    expect(before.some((e) => e.from === OBJ1 && e.type === 'supports')).toBe(false);
  });

  test('confirm a relation → it enters /api/graph crossRelations with its registry colour', async ({
    request,
  }) => {
    const supports = (await proposedRelations(request)).find(
      (x) => x.type === 'supports' && x.fromRef === OBJ1,
    )!;
    const r = await request.post(`/api/admin/relations/${encodeURIComponent(supports.id)}`, {
      data: { status: 'confirmed' },
    });
    expect(r.ok()).toBeTruthy();

    const cross = await crossRelations(request);
    const edge = cross.find((e) => e.from === OBJ1 && e.to === NODE && e.type === 'supports')!;
    expect(edge, 'confirmed object↔node edge renders').toBeTruthy();
    expect(edge.fromKind).toBe('object');
    expect(edge.toKind).toBe('node');
    expect(edge.color).toBe('#34d399'); // the 'supports' seed colour
    expect(edge.confidence).toBeCloseTo(0.91, 5);
  });

  test('reject a relation → it never renders', async ({ request }) => {
    // A fresh proposed edge (distinct type on the same pair) to reject.
    const post = await request.post('/agent/v1/relations', {
      headers: { ...RW, 'x-keap-agent': 'e2e-classifier' },
      data: {
        relations: [
          {
            from_ref: OBJ1,
            from_kind: 'object',
            to_ref: NODE,
            to_kind: 'node',
            type: 'depends-on',
            confidence: 0.66,
            justification: 'To be rejected.',
          },
        ],
      },
    });
    expect(post.ok()).toBeTruthy();
    const dep = (await proposedRelations(request)).find(
      (x) => x.type === 'depends-on' && x.fromRef === OBJ1,
    )!;
    const r = await request.post(`/api/admin/relations/${encodeURIComponent(dep.id)}`, {
      data: { status: 'rejected' },
    });
    expect(r.ok()).toBeTruthy();
    const cross = await crossRelations(request);
    expect(cross.some((e) => e.type === 'depends-on' && e.from === OBJ1)).toBe(false);
  });

  test('vocab grow: approve a proposed type → confirmed with a colour, offered to the classifier', async ({
    request,
  }) => {
    const approve = await request.post('/api/admin/relation-types/illustrates', {
      data: { status: 'confirmed' },
    });
    expect(approve.ok()).toBeTruthy();
    const body = (await approve.json()).data as { status: string; color: string | null };
    expect(body.status).toBe('confirmed');
    expect(body.color, 'a colour is assigned on approval').toBeTruthy();

    // The confirmed verb is now offered in the classifier vocabulary.
    const cand = await request.get('/agent/v1/relations/candidates?limit=1', { headers: RO });
    const vocab = (await cand.json()).data.vocab as Array<{ type: string }>;
    expect(vocab.map((v) => v.type)).toContain('illustrates');

    // Confirm the illustrates EDGE and assert it renders with the approved colour.
    const ill = (await proposedRelations(request)).find(
      (x) => x.type === 'illustrates' && x.fromRef === OBJ2,
    )!;
    await request.post(`/api/admin/relations/${encodeURIComponent(ill.id)}`, {
      data: { status: 'confirmed' },
    });
    const edge = (await crossRelations(request)).find(
      (e) => e.from === OBJ2 && e.type === 'illustrates',
    )!;
    expect(edge, 'confirmed grown-verb edge renders').toBeTruthy();
    expect(edge.color).toBe(body.color);
  });

  test('brain endpoint: /agent/v1/graph ships confirmed typed edges with provenance', async ({
    request,
  }) => {
    const r = await request.get('/agent/v1/graph', { headers: RO });
    expect(r.ok()).toBeTruthy();
    const g = (await r.json()).data as {
      nodes: Array<{ id: string; kind: string; name: string }>;
      edges: Array<{
        from: string;
        to: string;
        fromKind: string;
        toKind: string;
        type: string;
        confidence: number | null;
        justification: string | null;
        source: string;
        model: string | null;
      }>;
      types: Array<{ type: string; status: string }>;
    };
    // Nodes: objects prefixed object:<id>, taxonomy bare.
    expect(g.nodes.some((n) => n.id === `object:${OBJ1}` && n.kind === 'object')).toBe(true);
    expect(g.nodes.some((n) => n.id === NODE && n.kind === 'node')).toBe(true);
    // The confirmed supports edge carries full provenance, endpoints resolved.
    const edge = g.edges.find((e) => e.from === `object:${OBJ1}` && e.type === 'supports')!;
    expect(edge, 'confirmed edge in the brain substrate').toBeTruthy();
    expect(edge.to).toBe(NODE);
    expect(edge.source).toBe('derived');
    expect(edge.model).toBe('claude-sonnet-e2e');
    expect((edge.justification ?? '').length).toBeGreaterThan(0);
    // A rejected edge is absent.
    expect(g.edges.some((e) => e.type === 'depends-on' && e.from === `object:${OBJ1}`)).toBe(false);
    // Vocabulary is the active set (seed + confirmed); the grown verb is present.
    expect(g.types.every((t) => t.status === 'seed' || t.status === 'confirmed')).toBe(true);
    expect(g.types.some((t) => t.type === 'illustrates' && t.status === 'confirmed')).toBe(true);
  });

  test('brain endpoint needs a bearer token', async ({ request }) => {
    expect((await request.get('/agent/v1/graph')).status()).toBe(401);
  });

  test('visibility: a private object edge is hidden from a viewer who cannot see it', async ({
    request,
  }) => {
    // Alice owns a PRIVATE object; a confirmed typed edge joins it to NODE.
    const create = await request.post('/api/objects', {
      headers: ALICE,
      data: { id: PRIV, type: 'note', title: 'alice private', body: 'secret' },
    });
    expect(create.ok()).toBeTruthy();
    const post = await request.post('/agent/v1/relations', {
      headers: { ...RW, 'x-keap-agent': 'e2e-classifier' },
      data: {
        relations: [
          {
            from_ref: PRIV,
            from_kind: 'object',
            to_ref: NODE,
            to_kind: 'node',
            type: 'supports',
            confidence: 0.9,
            justification: 'private-to-node edge.',
          },
        ],
      },
    });
    expect(post.ok()).toBeTruthy();
    const priv = (await proposedRelations(request)).find(
      (x) => x.type === 'supports' && x.fromRef === PRIV,
    )!;
    await request.post(`/api/admin/relations/${encodeURIComponent(priv.id)}`, {
      data: { status: 'confirmed' },
    });

    // Admin (local dev, seeAll) sees the edge…
    const asAdmin = await crossRelations(request);
    expect(asAdmin.some((e) => e.from === PRIV)).toBe(true);
    // …but Bob (non-admin, can't see alice's private card) does NOT.
    const asBob = await crossRelations(request, BOB);
    expect(asBob.some((e) => e.from === PRIV)).toBe(false);
  });

  // Finding 1 — a rejected verdict is STICKY: a re-POST of the exact triple by
  // the RW classifier must not resurrect the edge back to 'proposed'.
  test('reject is durable: re-POSTing a rejected triple does not resurrect it', async ({
    request,
  }) => {
    // A fresh seed-verb edge on a distinct (from,to,type) triple.
    const post = await request.post('/agent/v1/relations', {
      headers: { ...RW, 'x-keap-agent': 'e2e-classifier' },
      data: {
        relations: [
          { from_ref: OBJ2, from_kind: 'object', to_ref: NODE, to_kind: 'node', type: 'refutes', confidence: 0.9, justification: 'to be rejected then re-posted.' },
        ],
      },
    });
    expect(post.ok()).toBeTruthy();
    const row = (await proposedRelations(request)).find((x) => x.type === 'refutes' && x.fromRef === OBJ2)!;
    expect(row).toBeTruthy();
    const rej = await request.post(`/api/admin/relations/${encodeURIComponent(row.id)}`, {
      data: { status: 'rejected' },
    });
    expect(rej.ok()).toBeTruthy();

    // Re-POST the EXACT same triple (classifier re-run) with a higher confidence.
    const repost = await request.post('/agent/v1/relations', {
      headers: { ...RW, 'x-keap-agent': 'e2e-classifier' },
      data: {
        relations: [
          { from_ref: OBJ2, from_kind: 'object', to_ref: NODE, to_kind: 'node', type: 'refutes', confidence: 0.99, justification: 're-run.' },
        ],
      },
    });
    expect(repost.ok()).toBeTruthy();

    // The verdict is still 'rejected' — NOT reset to 'proposed'…
    const rejected = await request.get('/api/admin/relations?status=rejected');
    const still = ((await rejected.json()).data.relations as AdminRel[]).find(
      (x) => x.type === 'refutes' && x.fromRef === OBJ2,
    );
    expect(still, 'rejected row survives the re-POST').toBeTruthy();
    const proposedAgain = (await proposedRelations(request)).some(
      (x) => x.type === 'refutes' && x.fromRef === OBJ2,
    );
    expect(proposedAgain, 'not resurrected to proposed').toBe(false);
    // …and it never renders, even in the ?relations=all overlay.
    const all = await request.get('/api/graph?relations=all');
    const cross = ((await all.json()).data.crossRelations ?? []) as CrossRel[];
    expect(cross.some((e) => e.from === OBJ2 && e.type === 'refutes')).toBe(false);
  });

  // Finding 2 — vocab gate: an edge on a still-PROPOSED verb cannot be confirmed
  // (that would smuggle the uncurated verb into the overlay). Confirm the TYPE
  // first, then the edge.
  test('vocab gate: confirming an edge on an unapproved verb is blocked', async ({ request }) => {
    const post = await request.post('/agent/v1/relations', {
      headers: { ...RW, 'x-keap-agent': 'e2e-classifier' },
      data: {
        relations: [
          { from_ref: OBJ1, from_kind: 'object', to_ref: NODE, to_kind: 'node', type: 'motivates', confidence: 0.88, justification: 'unknown verb grows the palette.' },
        ],
      },
    });
    expect(post.ok()).toBeTruthy();
    expect((await post.json()).data.proposedTypes).toEqual(['motivates']);
    const edge = (await proposedRelations(request)).find((x) => x.type === 'motivates' && x.fromRef === OBJ1)!;

    // Confirming the EDGE while 'motivates' is still a proposed verb → 409.
    const blocked = await request.post(`/api/admin/relations/${encodeURIComponent(edge.id)}`, {
      data: { status: 'confirmed' },
    });
    expect(blocked.status()).toBe(409);
    expect((await crossRelations(request)).some((e) => e.type === 'motivates')).toBe(false);

    // Approve the TYPE, then the same confirm succeeds and the edge renders.
    const approve = await request.post('/api/admin/relation-types/motivates', {
      data: { status: 'confirmed' },
    });
    expect(approve.ok()).toBeTruthy();
    const okConfirm = await request.post(`/api/admin/relations/${encodeURIComponent(edge.id)}`, {
      data: { status: 'confirmed' },
    });
    expect(okConfirm.ok()).toBeTruthy();
    expect((await crossRelations(request)).some((e) => e.from === OBJ1 && e.type === 'motivates')).toBe(true);
  });

  // Finding 2b — a raw agent verb must be a bounded lowercase kebab slug; a
  // whitespace/uppercase or over-long string is rejected before it can grow the
  // palette (validate-all-then-write → the whole batch writes nothing).
  test('vocab hygiene: a malformed relation type is rejected', async ({ request }) => {
    for (const bad of ['Bad Type!', 'a'.repeat(65)]) {
      const r = await request.post('/agent/v1/relations', {
        headers: { ...RW, 'x-keap-agent': 'e2e-classifier' },
        data: {
          relations: [
            { from_ref: OBJ1, from_kind: 'object', to_ref: NODE, to_kind: 'node', type: bad, confidence: 0.5, justification: 'malformed verb.' },
          ],
        },
      });
      expect(r.status()).toBe(400);
    }
  });
});

/**
 * Recall diversity (R3 fill quality). An "attractor" — a generically-worded node
 * whose vector sits nearest to everything — used to eat a whole sweep in pure
 * distance order, so the classifier spent its batch re-deciding one node instead
 * of seeing the corpus. candidatePairs() now front-loads a per-ref-capped
 * selection and appends the remainder, so the batch diversifies WITHOUT dropping
 * anything. Both halves of that contract are asserted here.
 */
test.describe('candidate recall diversity (attractor defusal)', () => {
  const DAXIS = 305; // own neighbourhood — orthogonal to the AXIS cluster above
  const DMODEL = 'e2e-relations-diversity-model'; // stays a minority object model
  const DOBJS = [1, 2, 3, 4, 5].map((i) => `rel-div-obj-${i}`);
  let HOT = ''; // nearest to every object → the attractor
  let COOL = ''; // measurably farther, so pure distance order would starve it

  function dvec(offDim: number, offMag: number): number[] {
    const v = new Array<number>(768).fill(0);
    v[DAXIS] = 1;
    if (offMag) v[offDim] = offMag;
    return v;
  }

  test('seed: five objects between a near node and a farther one', async ({ request }) => {
    for (const id of DOBJS) {
      const r = await request.post('/api/objects', {
        data: { id, type: 'note', title: id, body: `diversity fixture ${id}` },
      });
      expect(r.ok()).toBeTruthy();
    }
    const graph = (await (await request.get('/api/graph')).json()).data as { nodes: Array<{ id: string }> };
    [HOT, COOL] = [graph.nodes[1].id, graph.nodes[2].id];
    expect(HOT && COOL && HOT !== COOL).toBeTruthy();

    await embed(
      request,
      [
        // HOT is pure axis; COOL carries an off-axis component, so EVERY object is
        // strictly nearer to HOT — pure distance order yields all 5 HOT pairs first.
        { kind: 'taxonomy', refId: HOT, seed: 0, vector: dvec(0, 0) },
        { kind: 'taxonomy', refId: COOL, seed: 0, vector: dvec(500, 0.15) },
        ...DOBJS.map((id, i) => ({ kind: 'object', refId: id, seed: i, vector: dvec(400 + i, 0.02) })),
      ],
      DMODEL,
    );
  });

  test('the sweep interleaves the attractor instead of letting it eat the batch', async ({ request }) => {
    const r = await request.get('/agent/v1/relations/candidates?maxDistance=0.35&limit=50', { headers: RO });
    expect(r.ok()).toBeTruthy();
    const pairs = (await r.json()).data.pairs as Array<{ from_ref: string; to_ref: string }>;

    // Only this fixture's pairs, in the order the server returned them.
    const mine = pairs.filter((p) => DOBJS.includes(p.from_ref) && [HOT, COOL].includes(p.to_ref));

    // Contract half 1 — NOTHING is dropped: all 5×2 pairs still ship.
    expect(mine.length, 'every object×node pair survives the reorder').toBe(DOBJS.length * 2);

    // Contract half 2 — the attractor is capped up front. Pure distance order puts
    // all 5 HOT pairs first; the per-ref cap holds it to 3 of the leading 6.
    const leading = mine.slice(0, 6);
    expect(leading.filter((p) => p.to_ref === HOT).length).toBeLessThanOrEqual(3);
    expect(leading.filter((p) => p.to_ref === COOL).length, 'the farther node gets in early').toBeGreaterThan(0);
  });

  test('cleanup: diversity fixture removed', async ({ request }) => {
    for (const id of DOBJS) expect((await request.delete(`/api/objects/${id}`)).ok()).toBeTruthy();
  });
});

/**
 * Anchored recall must survive a crowd of same-kind neighbours. Searching both
 * kinds and filtering afterwards let the ANN window fill with same-kind hits
 * before any cross-kind one appeared — against the live corpus (74 similar
 * service cards) that returned ZERO candidates for every card, silently. The
 * pre-existing anchored test anchors on a NODE, where cross-kind hits dominate
 * naturally, so it could not see this.
 */
test.describe('anchored recall survives same-kind crowding', () => {
  const CAXIS = 310;
  const CMODEL = 'e2e-relations-crowd-model';
  const CROWD = [1, 2, 3, 4, 5, 6].map((i) => `rel-crowd-obj-${i}`);
  let FAR_NODE = '';

  function cvec(offDim: number, offMag: number): number[] {
    const v = new Array<number>(768).fill(0);
    v[CAXIS] = 1;
    v[offDim] = offMag;
    return v;
  }

  test('seed: six tightly-packed cards, one node further out', async ({ request }) => {
    for (const id of CROWD) {
      const r = await request.post('/api/objects', {
        data: { id, type: 'note', title: id, body: `crowd fixture ${id}` },
      });
      expect(r.ok()).toBeTruthy();
    }
    const graph = (await (await request.get('/api/graph')).json()).data as { nodes: Array<{ id: string }> };
    FAR_NODE = graph.nodes[3].id;
    expect(FAR_NODE).toBeTruthy();

    await embed(
      request,
      [
        // Every card sits ~0.0001 from every other card; the node sits ~0.042 out.
        // So the six cards are ALL nearer to the anchor than the node is.
        ...CROWD.map((id, i) => ({ kind: 'object', refId: id, seed: i, vector: cvec(600 + i, 0.01) })),
        { kind: 'taxonomy', refId: FAR_NODE, seed: 0, vector: cvec(700, 0.3) },
      ],
      CMODEL,
    );
  });

  test('a card crowded by same-kind neighbours still recalls its node', async ({ request }) => {
    // limit=1 keeps the ANN window at 4 — smaller than the crowd of 5 same-kind
    // neighbours, which is exactly the condition that used to return nothing.
    const r = await request.get(
      `/agent/v1/relations/candidates?anchorKind=object&anchorId=${encodeURIComponent(CROWD[0])}&limit=1&maxDistance=0.35`,
      { headers: RO },
    );
    expect(r.ok()).toBeTruthy();
    const pairs = (await r.json()).data.pairs as Array<{ from_ref: string; to_ref: string; to_kind: string }>;

    expect(pairs.length, 'the crowd must not starve cross-kind recall').toBeGreaterThan(0);
    expect(pairs[0].from_ref).toBe(CROWD[0]);
    expect(pairs[0].to_kind).toBe('node');
    expect(pairs[0].to_ref).toBe(FAR_NODE);
    // ...and no same-kind pair sneaks through.
    expect(pairs.every((p) => p.to_kind === 'node')).toBe(true);
  });

  test('cleanup: crowd fixture removed', async ({ request }) => {
    for (const id of CROWD) expect((await request.delete(`/api/objects/${id}`)).ok()).toBeTruthy();
  });
});
