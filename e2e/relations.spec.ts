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
  items: Array<{ kind: string; refId: string; seed: number }>,
) {
  const res = await request.post('/agent/v1/embeddings', {
    headers: RW,
    data: {
      model: REL_MODEL,
      dim: 768,
      items: items.map((it) => ({
        kind: it.kind,
        refId: it.refId,
        contentHash: `e2e-rel-${it.refId}`,
        vector: vec(it.seed),
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
    await embed(request, [
      { kind: 'taxonomy', refId: NODE, seed: 1 },
      { kind: 'object', refId: OBJ1, seed: 2 },
      { kind: 'object', refId: OBJ2, seed: 3 },
    ]);
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

  test('candidates anchored: neighbours of the node across kinds', async ({ request }) => {
    const r = await request.get(
      `/agent/v1/relations/candidates?anchorKind=node&anchorId=${encodeURIComponent(NODE)}&limit=50`,
      { headers: RO },
    );
    expect(r.ok()).toBeTruthy();
    const pairs = (await r.json()).data.pairs as Array<{ from_ref: string; to_ref: string }>;
    const refs = new Set(pairs.flatMap((p) => [p.from_ref, p.to_ref]));
    expect(refs.has(OBJ1)).toBe(true);
    expect(refs.has(OBJ2)).toBe(true);
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
