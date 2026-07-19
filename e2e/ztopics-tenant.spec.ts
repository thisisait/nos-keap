import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Topics mode — MULTI-TENANT label-leak guard (topic-mode-spec decision #13
 * hardening). The topic label + terms are a GLOBAL string shipped to every
 * viewer who can see ≥1 member, so they must never carry a token from an object
 * a co-viewer cannot see. This spec plants alice's PRIVATE docs and bob's docs
 * on an IDENTICAL embedding vector, so they are guaranteed to co-cluster, then
 * asserts that the cluster bob shares with alice ships NO alice-private token to
 * bob. Runs last (z-prefixed) and is fully self-contained: it seeds and deletes
 * its own objects, and reset-clusters over the current corpus.
 *
 * Identity: KEAP_TRUSTED_PROXY is unset under the e2e webServer, so an
 * X-Authentik-Username header selects the acting (non-admin) user; the agent
 * seam (/agent/v1) stays bearer-authed and identity-independent.
 */
test.describe.configure({ mode: 'serial' });

const RW = { Authorization: 'Bearer e2e-rw' };
const RO = { Authorization: 'Bearer e2e-ro' };
const AS_ALICE = { 'X-Authentik-Username': 'alice' };
const AS_BOB = { 'X-Authentik-Username': 'bob' };

// alice's distinctive PRIVATE token — a rare tag (c-TF-IDF weight ×3) that would
// rank into a pooled label. bob must never see it.
const ALICE_SECRET = 'zsecretalpha';

// Distinctive axes (dims the topics.spec journey never touches: it lives on
// e0/e1 + dims 100–300). Identical vectors ⇒ identical cluster assignment.
const V = 250; // alice ∪ bob co-cluster
const W = 400; // bob-only
const X = 500; // bob-only

interface Seed {
  id: string;
  as: Record<string, string>;
  tag: string;
  axis: number;
}

const ALICE: Seed[] = [1, 2, 3, 4].map((i) => ({
  id: `ztenant-alice-${i}`,
  as: AS_ALICE,
  tag: ALICE_SECRET,
  axis: V,
}));
const BOB: Seed[] = [
  ...[1, 2, 3, 4].map((i) => ({ id: `ztenant-bob-${i}`, as: AS_BOB, tag: 'zbobopen', axis: V })),
  ...[5, 6, 7].map((i) => ({ id: `ztenant-bob-${i}`, as: AS_BOB, tag: 'zbobwest', axis: W })),
  ...[8, 9, 10].map((i) => ({ id: `ztenant-bob-${i}`, as: AS_BOB, tag: 'zbobeast', axis: X })),
];
const ALL: Seed[] = [...ALICE, ...BOB];

function vec(axis: number): number[] {
  const v = new Array<number>(768).fill(0);
  v[axis] = 1;
  return v;
}

async function embedModel(request: APIRequestContext): Promise<string> {
  const r = (await (await request.get('/agent/v1/embeddings/pending?limit=1', { headers: RO })).json())
    .data as { model: string };
  return r.model;
}

interface GraphTopic {
  id: string;
  label: string;
  terms?: string[];
}
interface GraphObject {
  id: string;
  topic?: string;
  owner?: string;
}
async function graphAs(
  request: APIRequestContext,
  headers?: Record<string, string>,
): Promise<{ topics: GraphTopic[]; objects: GraphObject[] }> {
  const res = await request.get('/api/graph', headers ? { headers } : undefined);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data as { topics: GraphTopic[]; objects: GraphObject[] };
}

test.describe('topics multi-tenant label scoping', () => {
  test('a private object never leaks its distinctive token into a co-viewer topic label', async ({
    request,
  }) => {
    // 1) Seed each object under its owning identity (private by default).
    for (const s of ALL) {
      const res = await request.post('/api/objects', {
        headers: s.as,
        data: { id: s.id, type: 'note', title: `${s.id} note`, tags: [s.tag] },
      });
      expect(res.ok(), `create ${s.id}`).toBeTruthy();
    }

    // 2) Push identical-per-axis unit vectors through the agent seam.
    const model = await embedModel(request);
    const items = ALL.map((s) => ({
      kind: 'object',
      refId: s.id,
      contentHash: `ztenant-${s.id}`,
      vector: vec(s.axis),
    }));
    const embedRes = await request.post('/agent/v1/embeddings', {
      headers: RW,
      data: { model, dim: 768, items },
    });
    expect(embedRes.ok()).toBeTruthy();

    // 3) Reset-cluster the whole corpus (agent seam).
    const rebuild = await request.post('/agent/v1/topics/rebuild?wait=1', {
      headers: RW,
      data: { reset: true },
    });
    expect(rebuild.ok()).toBeTruthy();

    // 4) Admin (see-all) view proves the leak scenario is real: alice and bob
    //    DO share a topic (identical V vectors ⇒ same cluster, mixed owners).
    const admin = await graphAs(request);
    const topicOfBobV = admin.objects.find((o) => o.id === 'ztenant-bob-1')?.topic;
    expect(topicOfBobV, 'bob-1 assigned to a topic').toBeTruthy();
    const aliceInSame = admin.objects.some(
      (o) => o.owner === 'alice' && o.topic === topicOfBobV,
    );
    expect(aliceInSame, 'alice co-clustered with bob on the shared vector').toBeTruthy();

    // 5) THE GUARD — as bob: no visible topic's label or terms carries alice's
    //    private token, and the very topic bob shares with alice is unlabelled
    //    (its only labelable content is private to another owner).
    const bob = await graphAs(request, AS_BOB);
    expect(bob.topics.length, 'bob sees topics').toBeGreaterThan(0);
    for (const t of bob.topics) {
      expect(t.label.toLowerCase(), `label leak in ${t.id}`).not.toContain(ALICE_SECRET);
      for (const term of t.terms ?? []) {
        expect(term.toLowerCase(), `terms leak in ${t.id}`).not.toContain(ALICE_SECRET);
      }
    }
    const bobShared = bob.objects.find((o) => o.id === 'ztenant-bob-1')?.topic;
    expect(bobShared, 'bob sees the shared topic').toBeTruthy();
    const sharedTopic = bob.topics.find((t) => t.id === bobShared)!;
    expect(sharedTopic.label, 'mixed-owner cluster is unlabelled for bob').toBe('');
    expect(sharedTopic.terms ?? []).toEqual([]);
  });

  test('cleanup: tenant objects removed', async ({ request }) => {
    for (const s of ALL) await request.delete(`/api/objects/${s.id}`);
    const admin = await graphAs(request);
    expect(admin.objects.find((o) => o.id.startsWith('ztenant-'))).toBeUndefined();
  });
});
