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

  test('mobile: neighbours panel is a drawer, ship mode hidden, canvas full-width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 }); // phone portrait
    await page.goto('/explore');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });

    // Ship camera (pointer-lock + WASD) is desktop-only → its toggle is absent.
    await expect(page.getByTestId('explore-camera-toggle')).toHaveCount(0);

    // The neighbours panel is a drawer: its toggle is present and the panel
    // content is NOT mounted until opened (no always-on w-72 rail stealing the
    // canvas). Radix mounts SheetContent (role=dialog) only while open.
    const toggle = page.getByTestId('explore-panel-toggle');
    await expect(toggle).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await toggle.click();
    await expect(page.getByRole('dialog')).toBeVisible(); // drawer opened
  });

  test('desktop: neighbours panel is the always-on right rail (no drawer toggle)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/explore');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    // The mobile drawer toggle must not exist; the ship toggle must.
    await expect(page.getByTestId('explore-panel-toggle')).toHaveCount(0);
    await expect(page.getByTestId('explore-camera-toggle')).toBeVisible();
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

/**
 * Edge layers are independent. The Ontology toggle used to gate only the typed
 * relations while [[object:…]] wiki refs drew unconditionally, so switching it
 * off still left the card core webbed with lines — the toggle looked broken
 * because a layer it never owned kept drawing.
 */
test.describe('explore edge-layer toggles', () => {
  test('ontology and links are separate toggles, each round-tripping through the URL', async ({
    page,
  }) => {
    await page.goto('/explore');
    const ontology = page.getByTestId('explore-ontology-toggle');
    const olinks = page.getByTestId('explore-olinks-toggle');
    await expect(ontology).toBeVisible();
    await expect(olinks).toBeVisible();

    // Both default on, so neither param is in a clean URL.
    expect(page.url()).not.toContain('rel=0');
    expect(page.url()).not.toContain('olinks=0');

    // Turning ontology off must NOT silence the links layer.
    await ontology.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('rel')).toBe('0');
    expect(new URL(page.url()).searchParams.get('olinks')).toBeNull();

    // ...and the links layer is independently switchable.
    await olinks.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('olinks')).toBe('0');
    expect(new URL(page.url()).searchParams.get('rel')).toBe('0');

    // Both restore.
    await ontology.click();
    await olinks.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('rel')).toBeNull();
    expect(new URL(page.url()).searchParams.get('olinks')).toBeNull();
  });

  test('a deep link with olinks=0 starts with the links layer off', async ({ page }) => {
    await page.goto('/explore?olinks=0');
    await expect(page.getByTestId('explore-olinks-toggle')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('olinks')).toBe('0');
  });
});
