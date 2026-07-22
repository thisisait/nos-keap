import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Topics mode — the semantic-cluster reorder of the files core (server-side
 * spherical k-means over object vectors, birth-frozen identities). Drives the
 * REAL agent seam: seed objects through /api/objects, push synthetic 768-dim
 * unit vectors through /agent/v1/embeddings (no Ollama), cluster through
 * /agent/v1/topics/rebuild?wait=1, then assert the stability contract that is
 * the whole point of the design — re-runs are no-ops, growth never reshuffles
 * prior topics, hysteresis pins assignments, reset is the one sanctioned break.
 */
test.describe.configure({ mode: 'serial' });

const RO = { Authorization: 'Bearer e2e-ro' };
const RW = { Authorization: 'Bearer e2e-rw' };

// Two planted vocabularies. Each object carries a UNIQUE group-prefixed tag
// (weight ×3, corpus-frequency 1) so it survives the >60%-of-clusters stop
// rule even when K_MIN=3 splits one 5-object group across two clusters — every
// surviving label token then still contains "quantum" / "recipe" (§8.4, S1
// caveat: ≥3 distinctive-per-group tokens keep each cluster's label alive).
const QUANTUM = ['quantumaether', 'quantumboson', 'quantumcharm', 'quantumdelta', 'quantumecho'];
const RECIPE = ['recipealpha', 'recipebeta', 'recipegamma', 'recipedelta', 'recipeepsilon'];

const AXIS_A = 0; // group A (quantum) ≈ e₁
const AXIS_B = 1; // group B (recipe)  ≈ e₂

interface SeedObj {
  id: string;
  tag: string;
  axis: number;
  seed: number;
  embed: boolean;
  body?: string;
}

const SEED: SeedObj[] = [
  // Group A — quantum. qa-1 carries the [[01.01]] anchor for the ray path.
  ...QUANTUM.map((tag, i) => ({
    id: `e2e-topic-qa-${i + 1}`,
    tag,
    axis: AXIS_A,
    seed: i,
    embed: true,
    body: i === 0 ? 'anchored to [[01.01]] physics.' : undefined,
  })),
  // Group B — recipe.
  ...RECIPE.map((tag, i) => ({
    id: `e2e-topic-rb-${i + 1}`,
    tag,
    axis: AXIS_B,
    seed: i,
    embed: true,
  })),
  // Two objects left unembedded — they must stay unassigned (~untopiced fog).
  { id: 'e2e-topic-un-1', tag: 'loosealpha', axis: AXIS_A, seed: 90, embed: false },
  { id: 'e2e-topic-un-2', tag: 'loosebeta', axis: AXIS_B, seed: 91, embed: false },
];

const EMBEDDED_IDS = SEED.filter((o) => o.embed).map((o) => o.id);
const UNEMBEDDED_IDS = SEED.filter((o) => !o.embed).map((o) => o.id);
const ALL_IDS = SEED.map((o) => o.id);

/** Synthetic 768-dim vector: a dominant axis + a tiny deterministic per-object
 *  perturbation on a distinct dim (the server unit-normalizes). Group A on e₁,
 *  group B on e₂ → near-orthogonal, so the two vocabularies cluster apart. */
function vec(axis: number, seed: number): number[] {
  const v = new Array<number>(768).fill(0);
  v[axis] = 1;
  v[100 + (seed % 600)] = 0.03;
  return v;
}

async function createObject(request: APIRequestContext, o: SeedObj) {
  const res = await request.post('/api/objects', {
    data: { id: o.id, type: 'note', title: o.id, tags: [o.tag], body: o.body },
  });
  expect(res.ok()).toBeTruthy();
}

/** The embedding model the server advertises (KEAP_EMBED_MODEL default). The
 *  /pending list is saturated by the hundreds of unembedded taxonomy nodes
 *  (capped at 500), so object rows never surface there — clustering reads
 *  vectors by (kind='object', model) regardless of content_hash, so a dummy
 *  hash is the sanctioned seeding path (CLAUDE.md e2e pattern). */
async function embedModel(request: APIRequestContext): Promise<string> {
  const r = (await (await request.get('/agent/v1/embeddings/pending?limit=1', { headers: RO })).json())
    .data as { model: string };
  return r.model;
}

/** Push synthetic unit vectors through the real /agent/v1/embeddings contract
 *  with a per-object dummy content_hash and a per-call version tag (so a
 *  re-embed writes a genuinely new vector). */
async function embed(request: APIRequestContext, ids: string[], version = 'v1') {
  const model = await embedModel(request);
  const items = ids.map((id) => {
    const o = SEED.find((s) => s.id === id)!;
    return { kind: 'object', refId: id, contentHash: `e2e-topic-${id}-${version}`, vector: vec(o.axis, o.seed) };
  });
  const res = await request.post('/agent/v1/embeddings', {
    headers: RW,
    data: { model, dim: 768, items },
  });
  expect(res.ok()).toBeTruthy();
}

async function rebuild(request: APIRequestContext, reset = false) {
  const res = await request.post(`/agent/v1/topics/rebuild?wait=1`, { headers: RW, data: { reset } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data as {
    ok: boolean;
    k: number;
    n: number;
    moved: number;
    born: string[];
    retired: string[];
  };
}

interface Snapshot {
  assign: Record<string, string>; // objId → topicId (only assigned objects)
  topics: Record<string, { theta: number; label: string }>;
  ids: string[];
}

async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  const graph = (await (await request.get('/api/graph')).json()).data as {
    objects: Array<{ id: string; topic?: string }>;
    topics: Array<{ id: string; label: string; theta: number }>;
  };
  const assign: Record<string, string> = {};
  for (const o of graph.objects) if (o.topic) assign[o.id] = o.topic;
  const topics: Record<string, { theta: number; label: string }> = {};
  for (const tp of graph.topics) topics[tp.id] = { theta: tp.theta, label: tp.label };
  return { assign, topics, ids: graph.topics.map((tp) => tp.id).sort() };
}

/** Topic ids that hold at least one object with an id matching `prefix`. */
function topicsOf(snap: Snapshot, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const [objId, topicId] of Object.entries(snap.assign)) {
    if (objId.startsWith(prefix)) out.add(topicId);
  }
  return out;
}

test.describe('topics mode', () => {
  test('disabled-state first: no clusters ⇒ Topics button disabled with the truthful tooltip', async ({
    page,
  }) => {
    // Before any object vectors exist: /api/graph ships no topics, so the
    // reorder bar's Topics button is disabled with topicUnavailable (§8.1).
    const graphResponse = page.waitForResponse((r) => r.url().includes('/api/graph') && r.ok());
    await page.goto('/explore');
    await graphResponse;
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    // Core is on by default — the reorder bar is already visible.
    const topicsBtn = page.getByRole('button', { name: 'Topics' });
    await expect(topicsBtn).toBeDisabled();
    await expect(topicsBtn).toHaveAttribute(
      'title',
      'No topic clusters yet — waiting for object embeddings (keap-embed-sync)',
    );
  });

  test('seed + embed + first cluster: every embedded object assigned, no A/B mix, labels planted', async ({
    request,
  }) => {
    for (const o of SEED) await createObject(request, o);
    await embed(request, EMBEDDED_IDS);
    const run = await rebuild(request);
    expect(run.ok).toBeTruthy();
    expect(run.k).toBe(3); // clamp(round(√(10/4)),3,16) = 3
    expect(run.n).toBe(EMBEDDED_IDS.length);

    const snap = await snapshot(request);
    // Every embedded object is assigned; the two unembedded ones are not.
    for (const id of EMBEDDED_IDS) expect(snap.assign[id], `${id} assigned`).toBeTruthy();
    for (const id of UNEMBEDDED_IDS) expect(snap.assign[id]).toBeUndefined();

    // No topic mixes the two vocabularies.
    const membersByTopic = new Map<string, string[]>();
    for (const [objId, topicId] of Object.entries(snap.assign)) {
      const bucket = membersByTopic.get(topicId) ?? [];
      bucket.push(objId);
      membersByTopic.set(topicId, bucket);
    }
    for (const [, members] of membersByTopic) {
      const q = members.filter((m) => m.startsWith('e2e-topic-qa-')).length;
      const r = members.filter((m) => m.startsWith('e2e-topic-rb-')).length;
      expect(q === 0 || r === 0, `topic mixes A(${q}) and B(${r})`).toBeTruthy();
    }

    // Each group's topic label carries its planted vocabulary (label quality).
    for (const tid of topicsOf(snap, 'e2e-topic-qa-')) {
      expect(snap.topics[tid].label, `quantum label ${snap.topics[tid].label}`).toMatch(/quantum/i);
    }
    for (const tid of topicsOf(snap, 'e2e-topic-rb-')) {
      expect(snap.topics[tid].label, `recipe label ${snap.topics[tid].label}`).toMatch(/recipe/i);
    }
  });

  test('stability: an unchanged rebuild is a no-op (moved=0, identical ids/thetas/labels/assignments)', async ({
    request,
  }) => {
    const before = await snapshot(request);
    const run = await rebuild(request);
    expect(run.moved).toBe(0);
    expect(run.born).toEqual([]);
    expect(run.retired).toEqual([]);
    const after = await snapshot(request);
    expect(after).toEqual(before);
  });

  test('stability: growth adds one A object without disturbing prior topics', async ({ request }) => {
    const before = await snapshot(request);
    const newObj: SeedObj = { id: 'e2e-topic-qa-6', tag: 'quantumfermion', axis: AXIS_A, seed: 5, embed: true };
    SEED.push(newObj);
    await createObject(request, newObj);
    await embed(request, [newObj.id]);
    await rebuild(request);

    const after = await snapshot(request);
    // Every prior assignment, id and θ is byte-identical (warm start + frozen θ).
    expect(after.ids).toEqual(before.ids);
    for (const id of EMBEDDED_IDS) expect(after.assign[id]).toBe(before.assign[id]);
    for (const tid of before.ids) expect(after.topics[tid].theta).toBe(before.topics[tid].theta);
    // The newcomer joins one of the quantum (group A) topics.
    const aTopics = topicsOf(before, 'e2e-topic-qa-');
    expect(after.assign[newObj.id], 'newcomer assigned').toBeTruthy();
    expect(aTopics.has(after.assign[newObj.id])).toBeTruthy();
  });

  test('stability: re-embedding a member with slight jitter never flips its assignment (hysteresis)', async ({
    request,
  }) => {
    const before = await snapshot(request);
    const target = 'e2e-topic-qa-1';
    // Re-embed with a jittered-but-still-near-e₁ vector (new content_hash → a
    // genuinely new stored vector). The assignment must hold: a small move
    // never beats the current topic's distance by TAU (hysteresis).
    const jittered = vec(AXIS_A, 0);
    jittered[300] = 0.05; // extra perturbation, still dominated by e₁
    const model = await embedModel(request);
    const res = await request.post('/agent/v1/embeddings', {
      headers: RW,
      data: {
        model,
        dim: 768,
        items: [{ kind: 'object', refId: target, contentHash: `e2e-topic-${target}-jitter`, vector: jittered }],
      },
    });
    expect(res.ok()).toBeTruthy();
    await rebuild(request);

    const after = await snapshot(request);
    expect(after.assign[target]).toBe(before.assign[target]);
  });

  test('rename lock survives a rebuild; unlock restores the auto-label', async ({ request }) => {
    const list = (await (await request.get('/api/admin/topics')).json()).data as {
      topics: Array<{ id: string; label: string; labelAuto: string; labelLocked: boolean }>;
    };
    const target = list.topics[0];
    expect(target).toBeTruthy();

    const patched = await request.patch(`/api/admin/topics/${target.id}`, {
      data: { label: 'My topic' },
    });
    expect(patched.ok()).toBeTruthy();
    await rebuild(request);

    const afterRename = (await (await request.get('/api/admin/topics')).json()).data as {
      topics: Array<{ id: string; label: string; labelLocked: boolean }>;
    };
    const renamed = afterRename.topics.find((t) => t.id === target.id)!;
    expect(renamed.label).toBe('My topic');
    expect(renamed.labelLocked).toBe(true);

    // Unlock: {label:null} restores label_auto.
    const unlocked = await request.patch(`/api/admin/topics/${target.id}`, { data: { label: null } });
    expect(unlocked.ok()).toBeTruthy();
    const afterUnlock = (await (await request.get('/api/admin/topics')).json()).data as {
      topics: Array<{ id: string; label: string; labelAuto: string; labelLocked: boolean }>;
    };
    const restored = afterUnlock.topics.find((t) => t.id === target.id)!;
    expect(restored.labelLocked).toBe(false);
    expect(restored.label).toBe(restored.labelAuto);
  });

  test('payload + UI: objects carry topic, topics[] + meta.topics ship, and the Topics core renders', async ({
    request,
    page,
  }) => {
    const graph = (await (await request.get('/api/graph')).json()).data as {
      objects: Array<{ id: string; topic?: string }>;
      topics: Array<{ id: string; label: string; theta: number; count: number; terms?: string[] }>;
      meta: { topics?: { available: boolean; k: number; assigned: number } };
    };
    expect(graph.topics.length).toBeGreaterThan(0);
    for (const tp of graph.topics) {
      expect(typeof tp.id).toBe('string');
      expect(typeof tp.label).toBe('string');
      expect(typeof tp.theta).toBe('number');
      expect(typeof tp.count).toBe('number');
      expect(Array.isArray(tp.terms)).toBeTruthy();
    }
    expect(graph.meta.topics?.available).toBe(true);
    expect(graph.objects.some((o) => o.topic)).toBeTruthy();

    // UI: enable the core, switch to Topics (now enabled), assert the canvas.
    const graphResponse = page.waitForResponse((r) => r.url().includes('/api/graph') && r.ok());
    await page.goto('/explore');
    await graphResponse;
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    // Core is on by default — go straight to the (now enabled) Topics order.
    const topicsBtn = page.getByRole('button', { name: 'Topics' });
    await expect(topicsBtn).toBeEnabled();
    await topicsBtn.click();
    await page.waitForTimeout(2000); // camera flight into the ring center
    await expect(page.locator('canvas').first()).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/core-topics.png' });
  });

  test('reset replaces every topic identity (the one sanctioned break)', async ({ request }) => {
    const before = await snapshot(request);
    expect(before.ids.length).toBeGreaterThan(0);
    const run = await rebuild(request, true);
    expect(run.ok).toBeTruthy();
    const after = await snapshot(request);
    // Every id is minted fresh — no identity survives a reset.
    for (const id of after.ids) expect(before.ids).not.toContain(id);
    // Objects are re-clustered, so the corpus is still fully assigned.
    for (const id of EMBEDDED_IDS) expect(after.assign[id]).toBeTruthy();
  });

  test('cleanup: seeded objects removed', async ({ request }) => {
    for (const id of [...ALL_IDS, 'e2e-topic-qa-6']) {
      await request.delete(`/api/objects/${id}`);
    }
    const graph = (await (await request.get('/api/graph')).json()).data as {
      objects: Array<{ id: string }>;
    };
    expect(graph.objects.find((o) => o.id.startsWith('e2e-topic-'))).toBeUndefined();
  });
});
