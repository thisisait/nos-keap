import { test, expect } from '@playwright/test';

/**
 * S2⁶ Stage 1 — the table graph-render contract + the visibility-ladder fix.
 *
 * Two things under test, both through the real API:
 *  (§4) VISIBILITY MATRIX — /api/graph now scopes objects by the rbac tier
 *       ladder, not a flat `visibility='shared'`. A tier-users card reaches a
 *       nos-users caller but NOT a nos-guests caller; shared reaches everyone;
 *       private stays owner+admin only; admin (seeAll) sees all.
 *  (§3) CARD VISUAL OVERRIDE — a table's frontmatter.graph.card {form,hue,glyph}
 *       overrides the default asteroid/hue-180, deterministically. An existing
 *       table with NO graph block stays byte-identical (regression). mode:'rows'
 *       is accepted but renders CARD-ONLY in Stage 1 (no per-row node objects).
 *
 * Tables are seeded through the agent RW surface (slug === id, deterministic),
 * owned by the fixed agent owner (nos-agent) — so a non-owner human caller's
 * visibility is governed purely by the card's tier, which is exactly the fix.
 */
test.describe.configure({ mode: 'serial' });

const RW = { Authorization: 'Bearer e2e-rw', 'Content-Type': 'application/json' };

// Identity header sets. No headers → the dev fallback identity (local /
// nos-admins) = admin/seeAll. A username + groups → that tier's caller.
const USER = { 'X-Authentik-Username': 'u-user', 'X-Authentik-Uid': 'u-user', 'X-Authentik-Groups': 'nos-users' };
const GUEST = { 'X-Authentik-Username': 'u-guest', 'X-Authentik-Uid': 'u-guest', 'X-Authentik-Groups': 'nos-guests' };

const COLS = [{ key: 'name', label: 'Name', kind: 'text' }];

type GraphObject = { id: string; form: string; hue: number; glyph: string; type: string };

async function graphObjects(
  request: import('@playwright/test').APIRequestContext,
  headers?: Record<string, string>,
): Promise<GraphObject[]> {
  const r = await request.get('/api/graph', headers ? { headers } : undefined);
  expect(r.ok()).toBeTruthy();
  return (await r.json()).data.objects as GraphObject[];
}

const hasCard = (objs: GraphObject[], slug: string) => objs.some((o) => o.id === `table-${slug}`);
const card = (objs: GraphObject[], slug: string) => objs.find((o) => o.id === `table-${slug}`);

test.describe('S2⁶ table graph metadata + visibility ladder', () => {
  test.beforeAll(async ({ request }) => {
    // A tier-users card with a CARD visual override (station/hue-100/db).
    const tierUsers = await request.post('/agent/v1/tables', {
      headers: RW,
      data: {
        slug: 's26-tier-users',
        title: 'S26 Tier Users',
        visibility: 'tier-users',
        columns: COLS,
        graph: { card: { form: 'station', hue: 100, glyph: 'db' } },
      },
    });
    expect(tierUsers.ok()).toBeTruthy();

    const shared = await request.post('/agent/v1/tables', {
      headers: RW,
      data: { slug: 's26-shared', title: 'S26 Shared', visibility: 'shared', columns: COLS },
    });
    expect(shared.ok()).toBeTruthy();

    const priv = await request.post('/agent/v1/tables', {
      headers: RW,
      data: { slug: 's26-private', title: 'S26 Private', visibility: 'private', columns: COLS },
    });
    expect(priv.ok()).toBeTruthy();

    // A plain shared table with NO graph block — the byte-identical regression.
    const plain = await request.post('/agent/v1/tables', {
      headers: RW,
      data: { slug: 's26-plain', title: 'S26 Plain', visibility: 'shared', columns: COLS },
    });
    expect(plain.ok()).toBeTruthy();

    // mode:'rows' — ACCEPTED by the schema, but Stage 1 renders card-only.
    const rows = await request.post('/agent/v1/tables', {
      headers: RW,
      data: {
        slug: 's26-rows',
        title: 'S26 Rows',
        visibility: 'shared',
        columns: COLS,
        graph: { mode: 'rows', node: { labelColumn: 'name' } },
      },
    });
    expect(rows.ok()).toBeTruthy();
    // Give the rows-mode table a row — Stage 1 must NOT materialise it as a node.
    const upsert = await request.post('/agent/v1/tables/s26-rows/rows', {
      headers: RW,
      data: { name: 'alpha' },
    });
    expect(upsert.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const slug of ['s26-tier-users', 's26-shared', 's26-private', 's26-plain', 's26-rows']) {
      await request.delete(`/api/tables/${slug}`); // no headers = admin fallback
    }
  });

  test('visibility matrix: tier-users card reaches nos-users, not nos-guests, and admin', async ({ request }) => {
    const asUser = await graphObjects(request, USER);
    const asGuest = await graphObjects(request, GUEST);
    const asAdmin = await graphObjects(request); // no headers = admin

    expect(hasCard(asUser, 's26-tier-users')).toBe(true); // nos-users entitled
    expect(hasCard(asGuest, 's26-tier-users')).toBe(false); // nos-guests below the tier
    expect(hasCard(asAdmin, 's26-tier-users')).toBe(true); // admin seeAll
  });

  test('visibility matrix: shared card is visible to every tier', async ({ request }) => {
    expect(hasCard(await graphObjects(request, USER), 's26-shared')).toBe(true);
    expect(hasCard(await graphObjects(request, GUEST), 's26-shared')).toBe(true);
    expect(hasCard(await graphObjects(request), 's26-shared')).toBe(true);
  });

  test('visibility matrix: private card is owner+admin only (invisible to both tiers)', async ({ request }) => {
    expect(hasCard(await graphObjects(request, USER), 's26-private')).toBe(false);
    expect(hasCard(await graphObjects(request, GUEST), 's26-private')).toBe(false);
    expect(hasCard(await graphObjects(request), 's26-private')).toBe(true); // admin
  });

  test('card override: graph.card renders the overridden form/hue/glyph', async ({ request }) => {
    const c = card(await graphObjects(request, USER), 's26-tier-users');
    expect(c).toBeDefined();
    expect(c!.form).toBe('station'); // overrode the default 'asteroid'
    expect(c!.hue).toBe(100); // overrode the default 180
    expect(c!.glyph).toBe('db'); // overrode the default 'table'
  });

  test('re-sync preservation: a row write does NOT wipe the graph block', async ({ request }) => {
    // upsertRow → refreshRowCount → syncCard({...t, rowCount}) with NO graph arg.
    // The override must survive (tables.ts merges existing.frontmatter.graph).
    const up = await request.post('/agent/v1/tables/s26-tier-users/rows', {
      headers: RW,
      data: { name: 'beta' },
    });
    expect(up.ok()).toBeTruthy();
    const c = card(await graphObjects(request, USER), 's26-tier-users');
    expect(c).toBeDefined();
    expect(c!.form).toBe('station'); // still overridden after the row write
    expect(c!.hue).toBe(100);
    expect(c!.glyph).toBe('db');
  });

  test('regression: a table with NO graph block is byte-identical (asteroid/hue-180/table)', async ({ request }) => {
    const c = card(await graphObjects(request), 's26-plain');
    expect(c).toBeDefined();
    expect(c!.form).toBe('asteroid');
    expect(c!.hue).toBe(180);
    expect(c!.glyph).toBe('table');
  });

  test("mode:'rows' renders card-only in Stage 1 — no per-row node objects", async ({ request }) => {
    const objs = await graphObjects(request);
    expect(hasCard(objs, 's26-rows')).toBe(true); // the card itself is present
    // Stage 2 would materialise `table-s26-rows:row-<id>` objects; Stage 1 must not.
    expect(objs.some((o) => o.id.startsWith('table-s26-rows:row'))).toBe(false);
    // And the card keeps the default look (no card override was declared).
    const c = card(objs, 's26-rows')!;
    expect(c.form).toBe('asteroid');
    expect(c.hue).toBe(180);
  });

  test('schema rejects a graph that references a non-existent column', async ({ request }) => {
    const bad = await request.post('/agent/v1/tables', {
      headers: RW,
      data: {
        slug: 's26-bad',
        title: 'S26 Bad',
        visibility: 'shared',
        columns: COLS,
        graph: { mode: 'rows', node: { labelColumn: 'does_not_exist' } },
      },
    });
    expect(bad.status()).toBe(400);
  });
});
