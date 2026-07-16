import { test, expect } from '@playwright/test';

/**
 * Files core — the explore toggle that relocates knowledge objects into a 3D
 * core at the galaxy-ring center (folder constellations by default, rays back
 * to taxonomy anchors). Seeds objects through the human API (dev fallback
 * identity), then drives the toggle + reorder bar.
 */
test.describe.configure({ mode: 'serial' });

const SEED = [
  {
    id: 'e2e-core-report',
    type: 'page',
    title: 'q2-report.md',
    frontmatter: { source: 'fs', path: 'documents/reports/q2-report.md' },
    // [[01.01]] anchors the file to Physics — the core keeps a ray to it.
    body: 'Quarterly physics notes, see [[01.01]].',
  },
  {
    id: 'e2e-core-photo',
    type: 'image',
    title: 'photo.png',
    frontmatter: { source: 'fs', path: 'library/photos/photo.png' },
  },
  { id: 'e2e-core-loose', type: 'note', title: 'Loose card' },
];

test.describe('files core', () => {
  test('graph payload ships every object with path + owner', async ({ request }) => {
    for (const o of SEED) {
      const res = await request.post('/api/objects', { data: o });
      expect(res.ok()).toBeTruthy();
    }
    const graph = (await (await request.get('/api/graph')).json()) as {
      data: { objects: Array<{ id: string; anchors: string[]; path?: string; owner?: string }> };
    };
    const byId = new Map(graph.data.objects.map((o) => [o.id, o]));
    // Anchored file: path + the taxonomy anchor extracted from its body.
    expect(byId.get('e2e-core-report')?.path).toBe('documents/reports/q2-report.md');
    expect(byId.get('e2e-core-report')?.anchors).toContain('01.01');
    // Unanchored objects now ship too — the core view needs them.
    expect(byId.get('e2e-core-photo')?.anchors).toEqual([]);
    expect(byId.get('e2e-core-photo')?.path).toBe('library/photos/photo.png');
    expect(byId.get('e2e-core-loose')?.path).toBeUndefined();
    expect(byId.get('e2e-core-report')?.owner).toBe('local');
  });

  test('core toggle forms the 3D core and offers reorder modes', async ({ page }) => {
    const graphResponse = page.waitForResponse((r) => r.url().includes('/api/graph') && r.ok());
    await page.goto('/explore');
    await graphResponse;
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });

    // Off by default — no reorder bar.
    const coreButton = page.getByRole('button', { name: 'Core', exact: true });
    await expect(coreButton).toBeVisible();
    await expect(page.getByRole('button', { name: 'Folders' })).toHaveCount(0);

    await coreButton.click();
    // Reorder bar appears: Folders (default, active), Taxonomy, Topics (TBD).
    const folders = page.getByRole('button', { name: 'Folders' });
    await expect(folders).toBeVisible();
    await expect(page.getByRole('button', { name: 'Topics' })).toBeDisabled();
    await page.waitForTimeout(2500); // camera flight into the ring center
    await page.screenshot({ path: 'e2e/screenshots/core-fs.png' });

    await page.getByRole('button', { name: 'Taxonomy', exact: true }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'e2e/screenshots/core-taxonomy.png' });

    // Toggle off — the bar goes away, the camera flies back out.
    await coreButton.click();
    await expect(page.getByRole('button', { name: 'Folders' })).toHaveCount(0);
  });

  test('cleanup: seeded objects removed', async ({ request }) => {
    for (const o of SEED) {
      const res = await request.delete(`/api/objects/${o.id}`);
      expect(res.ok()).toBeTruthy();
    }
    const graph = (await (await request.get('/api/graph')).json()) as {
      data: { objects: Array<{ id: string }> };
    };
    expect(graph.data.objects.find((o) => o.id.startsWith('e2e-core-'))).toBeUndefined();
  });
});
