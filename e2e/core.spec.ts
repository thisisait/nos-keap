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
  {
    id: 'e2e-core-linker',
    type: 'note',
    title: 'Linking card',
    // Two refs to the same card must dedupe to ONE edge; the ghost ref points
    // at a nonexistent object and must ship no edge at all.
    body:
      'See [[object:e2e-core-report]] and again [[object:e2e-core-report]], plus [[object:e2e-core-ghost]].',
  },
];

test.describe('files core', () => {
  test('graph payload ships every object with path + owner', async ({ request }) => {
    for (const o of SEED) {
      const res = await request.post('/api/objects', { data: o });
      expect(res.ok()).toBeTruthy();
    }
    const graph = (await (await request.get('/api/graph')).json()) as {
      data: {
        objects: Array<{ id: string; anchors: string[]; path?: string; owner?: string; mapping?: string }>;
        objectLinks: Array<{ source: string; target: string }>;
      };
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
    // Isolation regression (mapped folders): users-tree/manual objects never
    // gain mapping provenance — fsm: mirrors are the only carriers.
    expect(byId.get('e2e-core-report')?.mapping).toBeUndefined();
    expect(byId.get('e2e-core-loose')?.mapping).toBeUndefined();
    // Object→object refs ship as edges: deduped (two body refs = one edge)…
    const edges = graph.data.objectLinks;
    expect(
      edges.filter((l) => l.source === 'e2e-core-linker' && l.target === 'e2e-core-report'),
    ).toHaveLength(1);
    // …and a ref to a nonexistent/non-visible object never ships an edge.
    expect(
      edges.some((l) => l.source === 'e2e-core-ghost' || l.target === 'e2e-core-ghost'),
    ).toBe(false);
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
    // Reorder bar appears: Folders (default, active), Taxonomy, Topics
    // (disabled — no object vectors seeded here, so no clusters ship).
    const folders = page.getByRole('button', { name: 'Folders' });
    await expect(folders).toBeVisible();
    const topicsBtn = page.getByRole('button', { name: 'Topics' });
    await expect(topicsBtn).toBeDisabled();
    // Disabled-state tooltip is the truthful "waiting for embeddings" key,
    // not the old "coming soon" copy (topicUnavailable, decision #17).
    await expect(topicsBtn).toHaveAttribute(
      'title',
      'No topic clusters yet — waiting for object embeddings (keap-embed-sync)',
    );
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
