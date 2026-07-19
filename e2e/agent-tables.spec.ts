import { test, expect } from '@playwright/test';

/**
 * Agent-bearer DataTables surface (/agent/v1/tables) — the channel the nOS face
 * seeder + BFF use. Exercises the exact call sequence roles/pazny.keap/tasks/
 * seed-face-table.yml runs: probe(slug) → create → rows-probe → upsert rows,
 * and re-runs it to prove idempotency (slug-as-id, slug-as-row-id). The two
 * shape contracts the seeder depends on are asserted directly: the slug doubles
 * as the id, and rows are FLAT value objects with a top-level `slug`.
 */
test.describe.configure({ mode: 'serial' });

const RO = { Authorization: 'Bearer e2e-ro' };
const RW = { Authorization: 'Bearer e2e-rw', 'Content-Type': 'application/json' };
const SLUG = 'face-apps';

const DEF = {
  slug: SLUG,
  title: 'Face Apps',
  description: 'System app registry',
  driver: 'libsql',
  visibility: 'tier-users',
  anchors: [],
  columns: [
    { key: 'slug', label: 'Slug', kind: 'text' },
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'order', label: 'Order', kind: 'number' },
  ],
};
const ROWS = [
  { slug: 'files', name: 'Files', order: 1 },
  { slug: 'terminal', name: 'Terminal', order: 2 },
];

test.describe('agent tables surface', () => {
  test('probe on a missing table is a clean 404', async ({ request }) => {
    const r = await request.get(`/agent/v1/tables/${SLUG}`, { headers: RO });
    expect(r.status()).toBe(404);
  });

  test('auth: RW required to create, RO rejected', async ({ request }) => {
    const noTok = await request.post('/agent/v1/tables', { data: DEF });
    expect(noTok.status()).toBe(401); // missing bearer token
    const roTok = await request.post('/agent/v1/tables', {
      headers: { Authorization: 'Bearer e2e-ro', 'Content-Type': 'application/json' },
      data: DEF,
    });
    expect(roTok.status()).toBe(403); // valid token, wrong scope
  });

  test('create keys the table by its slug (slug === id)', async ({ request }) => {
    const c = await request.post('/agent/v1/tables', { headers: RW, data: DEF });
    expect(c.ok()).toBeTruthy();
    const body = (await c.json()).data;
    expect(body.id).toBe(SLUG);
    expect(body.title).toBe('Face Apps');
    expect(body.visibility).toBe('tier-users');
    // Probe now resolves.
    const p = await request.get(`/agent/v1/tables/${SLUG}`, { headers: RO });
    expect(p.ok()).toBeTruthy();
    expect((await p.json()).data.id).toBe(SLUG);
  });

  test('create is idempotent — re-create returns the existing table, no 500', async ({ request }) => {
    const again = await request.post('/agent/v1/tables', { headers: RW, data: DEF });
    expect(again.ok()).toBeTruthy();
    expect((await again.json()).data.id).toBe(SLUG);
  });

  test('rows: upsert then read back FLAT with a top-level slug', async ({ request }) => {
    for (const row of ROWS) {
      const u = await request.post(`/agent/v1/tables/${SLUG}/rows`, { headers: RW, data: row });
      expect(u.ok()).toBeTruthy();
    }
    const g = await request.get(`/agent/v1/tables/${SLUG}/rows`, { headers: RO });
    expect(g.ok()).toBeTruthy();
    const rows = (await g.json()).data.rows as Array<Record<string, unknown>>;
    // FLAT shape: the seeder reads `map(attribute='slug')` — slug is top-level.
    const slugs = rows.map((r) => r.slug).sort();
    expect(slugs).toEqual(['files', 'terminal']);
    const files = rows.find((r) => r.slug === 'files')!;
    expect(files.name).toBe('Files');
    expect(files.order).toBe(1);
  });

  test('row upsert is idempotent — re-seed the same slug does not duplicate', async ({ request }) => {
    await request.post(`/agent/v1/tables/${SLUG}/rows`, {
      headers: RW,
      data: { slug: 'files', name: 'Files', order: 1 },
    });
    const g = await request.get(`/agent/v1/tables/${SLUG}/rows`, { headers: RO });
    const rows = (await g.json()).data.rows as Array<Record<string, unknown>>;
    expect(rows.filter((r) => r.slug === 'files')).toHaveLength(1);
  });

  test('invalid slug is rejected', async ({ request }) => {
    const bad = await request.post('/agent/v1/tables', {
      headers: RW,
      data: { ...DEF, slug: 'Bad Slug/../x' },
    });
    expect(bad.status()).toBe(400);
  });

  test('cleanup: table visible to a tier-user in the human API', async ({ request }) => {
    // visibility 'tier-users' → a normal signed-in user sees the agent-seeded
    // table (the whole point: face config authored by the agent, read by users).
    const list = await request.get('/api/tables', {
      headers: { 'X-Authentik-Username': 'carol', 'X-Authentik-Uid': 'carol', 'X-Authentik-Groups': 'nos-users' },
    });
    expect(list.ok()).toBeTruthy();
    const tables = (await list.json()).data as Array<{ id: string }>;
    expect(tables.some((t) => t.id === SLUG)).toBe(true);
  });

  test('cleanup: drop the seeded table (no-header request = admin fallback)', async ({ request }) => {
    const del = await request.delete(`/api/tables/${SLUG}`);
    expect(del.ok()).toBeTruthy();
    const gone = await request.get(`/agent/v1/tables/${SLUG}`, { headers: RO });
    expect(gone.status()).toBe(404);
  });
});
