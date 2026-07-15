import { test, expect } from '@playwright/test';

test.describe('universe explorer', () => {
  test('3D canvas mounts and the graph payload is baked', async ({ page }) => {
    const graphResponse = page.waitForResponse((r) => r.url().includes('/api/graph') && r.ok());
    await page.goto('/explore');

    const payload = (await (await graphResponse).json()) as {
      data: {
        nodes: Array<{ id: string; x?: number; y?: number }>;
        meta: { layoutVersion?: string };
      };
    };
    const nodes = payload.data.nodes;
    expect(nodes.length).toBeGreaterThan(10);
    // Spatial-memory contract: positions are baked server-side and versioned,
    // and the first galaxy sits at the ring's zero angle — always.
    expect(payload.data.meta.layoutVersion).toMatch(/^v\d+:[0-9a-f]{16}$/);
    const root = nodes.find((n) => n.id === '01');
    expect(root?.x).toBe(1400);
    expect(root?.y).toBe(0);

    // WebGL canvas from react-force-graph-3d.
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(4000); // let the force layout settle + stars render
    await page.screenshot({ path: 'e2e/screenshots/explorer.png' });
  });

  test('layout is deterministic across requests', async ({ request }) => {
    const one = await (await request.get('/api/graph')).json();
    const two = await (await request.get('/api/graph')).json();
    expect(one.data.meta.layoutVersion).toMatch(/^v\d+:[0-9a-f]{16}$/);
    expect(one.data.meta.layoutVersion).toBe(two.data.meta.layoutVersion);
    const pos = (r: { data: { nodes: Array<{ id: string; x?: number }> } }) =>
      r.data.nodes.filter((n) => n.x !== undefined).map((n: { id: string; x?: number }) => `${n.id}:${n.x}`);
    expect(pos(one).length).toBeGreaterThan(10);
    expect(pos(one)).toEqual(pos(two));
  });

  test('api surface: health, fallback identity, drivers', async ({ request }) => {
    const health = await (await request.get('/api/health')).json();
    expect(health.data.status).toBe('OK');

    // No Traefik headers + no KEAP_TRUSTED_PROXY => single-tenant dev identity.
    const me = await (await request.get('/api/me')).json();
    expect(me.data.username).toBe('local');
    expect(me.data.isAdmin).toBe(true);

    const drivers = await (await request.get('/api/tables/drivers')).json();
    const byName = Object.fromEntries(
      drivers.data.map((d: { driver: string; available: boolean }) => [d.driver, d.available]),
    );
    expect(byName.libsql).toBe(true);
    expect(byName.rustfs).toBe(false); // no KEAP_RUSTFS_* in the e2e env
  });
});
