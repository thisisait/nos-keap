import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * Mapped folders (fs_mappings) — the admin-managed read-only mirror of a
 * KEAP_FS_ROOTS mount into knowledge objects. The webServer announces one
 * throwaway root (KEAP_FS_ROOTS=e2e=e2e/.fsroot, wiped per run); fixtures are
 * written here with node:fs, syncs happen only via explicit POSTs (interval 0)
 * so every count below is deterministic. Serial: each step builds on the
 * mapping created in step 3 (dev-fallback admin identity `local`).
 */
test.describe.configure({ mode: 'serial' });

const FSROOT = path.resolve('e2e/.fsroot');

/** Graph payload slices this suite asserts on (see server/graph.ts). */
interface GraphData {
  data: {
    objects: Array<{
      id: string;
      title: string;
      type: string;
      anchors: string[];
      path?: string;
      owner?: string;
      mapping?: string;
      mtime?: number;
    }>;
    fsMappings: Array<{
      id: string;
      label: string;
      nested: boolean;
      taxonomyRoot?: string;
      taxonomyLinks: string[];
      tags: string[];
      enabled: boolean;
      count: number;
    }>;
  };
}

interface SyncResult {
  scanned: number;
  upserted: number;
  removed: number;
  unchanged: number;
  capped: boolean;
  pruneRefused: boolean;
  rootAvailable: boolean;
}

// The mapping created in step 3 — shared by every later step (serial mode).
let mapId = '';

test.describe('mapped folders', () => {
  test.beforeAll(() => {
    // Fixture tree: papers/{2024/intro.md,data.csv} is what gets mapped;
    // other/note.txt stays outside the mapping (and feeds the picker test).
    fs.mkdirSync(path.join(FSROOT, 'papers', '2024'), { recursive: true });
    fs.mkdirSync(path.join(FSROOT, 'other'), { recursive: true });
    // [[01.01]] in the body anchors intro.md to Physics — a BODY ref, distinct
    // from the mapping's taxonomy anchors which must stay off the objects.
    fs.writeFileSync(
      path.join(FSROOT, 'papers', '2024', 'intro.md'),
      '# Intro\n\nQuarterly physics notes, see [[01.01]].\n',
    );
    fs.writeFileSync(path.join(FSROOT, 'papers', 'data.csv'), 'a,b\n1,2\n');
    fs.writeFileSync(path.join(FSROOT, 'other', 'note.txt'), 'not mapped\n');
  });

  test('roots registry announces the e2e mount + the user-files tree', async ({ request }) => {
    const r = (await (await request.get('/api/fs/roots')).json()) as {
      data: {
        roots: Array<{ key: string; path: string; exists: boolean }>;
        userFiles: { dir: string | null; configured: boolean };
      };
    };
    expect(r.data.roots).toHaveLength(1);
    expect(r.data.roots[0].key).toBe('e2e');
    expect(r.data.roots[0].exists).toBe(true);
    // The per-user tree is configured (shared-uids.spec.ts exercises it) but
    // stays a SEPARATE pipeline — never announced as a mapping root above.
    expect(r.data.userFiles.configured).toBe(true);
  });

  test('browse lists the level with counts; traversal + hidden paths are 400', async ({ request }) => {
    const r = (await (await request.get('/api/fs/browse?root=e2e')).json()) as {
      data: {
        dirs: Array<{ name: string; dirCount: number; fileCount: number }>;
        fileCount: number;
        sampleFiles: string[];
        mappedBy: string | null;
      };
    };
    expect(r.data.dirs).toEqual([
      { name: 'other', dirCount: 0, fileCount: 1 },
      { name: 'papers', dirCount: 1, fileCount: 1 },
    ]);
    expect(r.data.fileCount).toBe(0);
    expect(r.data.mappedBy).toBeNull();

    expect((await request.get('/api/fs/browse?root=e2e&path=../..')).status()).toBe(400);
    expect((await request.get('/api/fs/browse?root=e2e&path=.hidden')).status()).toBe(400);
  });

  test('create mapping runs a synchronous first sync', async ({ request }) => {
    const res = await request.post('/api/fs/mappings', {
      data: {
        rootKey: 'e2e',
        relPath: 'papers',
        label: 'Papers',
        nestUnderFiles: false,
        schema: { type: 'document', frontmatter: { proj: 'e2e' } },
        tags: ['e2e'],
        taxonomyRoot: '01.02',
        taxonomyLinks: ['01.01'],
        visibility: 'shared',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      data: { mapping: { id: string }; firstSync: SyncResult };
    };
    mapId = body.data.mapping.id;
    expect(mapId).toMatch(/^m-[0-9a-f]{8}$/);
    expect(body.data.firstSync.scanned).toBe(2);
    expect(body.data.firstSync.upserted).toBe(2);
  });

  test('graph ships the mapping hub and mapping-relative mirrored objects', async ({ request }) => {
    const graph = (await (await request.get('/api/graph')).json()) as GraphData;
    const fm = graph.data.fsMappings.find((m) => m.id === mapId);
    expect(fm).toMatchObject({
      label: 'Papers',
      nested: false,
      taxonomyRoot: '01.02',
      taxonomyLinks: ['01.01'],
      tags: ['e2e'],
      enabled: true,
      count: 2,
    });
    const mirrored = graph.data.objects.filter((o) => o.owner?.startsWith('fsmap:'));
    expect(mirrored).toHaveLength(2);
    for (const o of mirrored) {
      expect(o.mapping).toBe(mapId);
      expect(o.type).toBe('document'); // schema.type override, even for .csv
      expect(o.owner).toBe(`fsmap:${mapId}`);
      // Recency lens payload (S2): fs objects ship the file's mtime — a real
      // recent timestamp (the fixtures were written moments ago).
      expect(typeof o.mtime).toBe('number');
      expect(o.mtime!).toBeGreaterThan(Date.now() / 1000 - 24 * 3600);
    }
    const intro = mirrored.find((o) => o.title === 'intro.md')!;
    // Path is MAPPING-relative (repointing keeps ids), the body ref anchors it,
    // and the mapping's taxonomy anchors are NOT injected into the object.
    expect(intro.path).toBe('2024/intro.md');
    expect(intro.anchors).toContain('01.01');
    expect(intro.anchors).not.toContain('01.02');

    const full = (await (await request.get(`/api/objects/${intro.id}`)).json()) as {
      data: { frontmatter: Record<string, unknown>; tags: string[]; visibility: string };
    };
    expect(full.data.frontmatter.proj).toBe('e2e'); // template merged
    expect(full.data.frontmatter.source).toBe('fs-mapping');
    expect(full.data.tags).toEqual(['e2e']);
    expect(full.data.visibility).toBe('shared');
  });

  test('resync is idempotent: unchanged files are skipped', async ({ request }) => {
    const r = (await (await request.post(`/api/fs/mappings/${mapId}/sync`)).json()) as {
      data: SyncResult;
    };
    expect(r.data.unchanged).toBe(2);
    expect(r.data.upserted).toBe(0);
    expect(r.data.removed).toBe(0);
  });

  test('a touched file defeats the size+mtime skip', async ({ request }) => {
    const csv = path.join(FSROOT, 'papers', 'data.csv');
    fs.appendFileSync(csv, '3,4\n');
    const later = new Date(Date.now() + 2000); // mtime granularity is 1s
    fs.utimesSync(csv, later, later);
    const r = (await (await request.post(`/api/fs/mappings/${mapId}/sync`)).json()) as {
      data: SyncResult;
    };
    expect(r.data.upserted).toBe(1);
    expect(r.data.unchanged).toBe(1);
  });

  test('a tags edit rewrites every object once (cfg-hash) and shows in graph', async ({ request }) => {
    const res = await request.patch(`/api/fs/mappings/${mapId}`, {
      data: { tags: ['e2e', 'v2'] },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { data: { resync: SyncResult } };
    // cfg mismatch defeats the unchanged-skip exactly once — both rewritten.
    expect(body.data.resync.upserted).toBe(2);
    const graph = (await (await request.get('/api/graph')).json()) as GraphData;
    expect(graph.data.fsMappings.find((m) => m.id === mapId)?.tags).toEqual(['e2e', 'v2']);
  });

  test('a deleted file is pruned on the next pass', async ({ request }) => {
    fs.rmSync(path.join(FSROOT, 'papers', 'data.csv'));
    const r = (await (await request.post(`/api/fs/mappings/${mapId}/sync`)).json()) as {
      data: SyncResult;
    };
    expect(r.data.scanned).toBe(1);
    expect(r.data.removed).toBe(1);
    expect(r.data.pruneRefused).toBe(false);
  });

  test('an unreadable subtree truncates the walk — prune refused, mirrors survive', async ({ request }) => {
    // A readable sibling keeps scanned > 0: this is the PARTIAL case the
    // zero-scan guard cannot see — sibling files still list while the subtree
    // holding every existing mirror silently drops out of the found-set.
    fs.writeFileSync(path.join(FSROOT, 'papers', 'sibling.md'), 'still readable\n');
    let r = (await (await request.post(`/api/fs/mappings/${mapId}/sync`)).json()) as {
      data: SyncResult;
    };
    expect(r.data.upserted).toBe(1); // sibling.md mirrored → 2 objects now
    const locked = path.join(FSROOT, 'papers', '2024');
    fs.chmodSync(locked, 0o000); // readdir → EACCES; a dropped sub-mount reads the same
    try {
      r = (await (await request.post(`/api/fs/mappings/${mapId}/sync`)).json()) as {
        data: SyncResult;
      };
    } finally {
      fs.chmodSync(locked, 0o755); // always restore — the next run's rm -rf needs it
    }
    expect(r.data.scanned).toBe(1); // only sibling.md — the zero-scan guard is blind here
    expect(r.data.pruneRefused).toBe(true);
    expect(r.data.removed).toBe(0); // intro.md's mirror SURVIVES the hiccup
    // Subtree readable again + sibling gone → an ordinary reconcile pass.
    fs.rmSync(path.join(FSROOT, 'papers', 'sibling.md'));
    r = (await (await request.post(`/api/fs/mappings/${mapId}/sync`)).json()) as {
      data: SyncResult;
    };
    expect(r.data.removed).toBe(1);
    expect(r.data.unchanged).toBe(1);
  });

  test('overlapping and reserved-root mappings are refused', async ({ request }) => {
    // Descendant of the existing mapping → 409.
    const child = await request.post('/api/fs/mappings', {
      data: { rootKey: 'e2e', relPath: 'papers/2024', label: 'Child' },
    });
    expect(child.status()).toBe(409);
    // Exact duplicate → 409 too.
    const dup = await request.post('/api/fs/mappings', {
      data: { rootKey: 'e2e', relPath: 'papers', label: 'Dup' },
    });
    expect(dup.status()).toBe(409);
    // 'users' is reserved at parse time — never a known root.
    const reserved = await request.post('/api/fs/mappings', {
      data: { rootKey: 'users', relPath: '', label: 'Nope' },
    });
    expect(reserved.status()).toBe(400);
  });

  test('isolation: mapping sync never touches non-fsm objects', async ({ request }) => {
    // A manual card claiming the users-tree provenance (source:'fs') — the
    // mapping pass prunes only its own fsmap: owner index and must not see it.
    const seed = await request.post('/api/objects', {
      data: {
        id: 'e2e-fsm-iso',
        type: 'page',
        title: 'x.md',
        frontmatter: { source: 'fs', path: 'documents/x.md' },
      },
    });
    expect(seed.ok()).toBeTruthy();
    const r = (await (await request.post(`/api/fs/mappings/${mapId}/sync`)).json()) as {
      data: SyncResult;
    };
    expect(r.data.removed).toBe(0);
    const after = (await (await request.get('/api/objects/e2e-fsm-iso')).json()) as {
      data: { frontmatter: Record<string, unknown> };
    };
    expect(after.data.frontmatter.source).toBe('fs');
    expect(after.data.frontmatter.mapping).toBeUndefined();
    // Cleanup — later steps assert exact mirrored-object counts.
    expect((await request.delete('/api/objects/e2e-fsm-iso')).ok()).toBeTruthy();
  });

  test('a visibility patch is enforced even while the mapping cannot resync', async ({ request }) => {
    // Non-admin viewer (dev fallback is header-driven, no admin groups) — the
    // audience a shared→private flip must actually hide the mirrors from.
    const bob = { 'x-authentik-username': 'bob' };
    let graph = (await (await request.get('/api/graph', { headers: bob })).json()) as GraphData;
    expect(graph.data.objects.filter((o) => o.mapping === mapId)).toHaveLength(1);

    // Disable first — in this state the sync engine can never run, which is
    // exactly the window the direct row flip has to cover.
    expect(
      (await request.patch(`/api/fs/mappings/${mapId}`, { data: { enabled: false } })).ok(),
    ).toBeTruthy();
    const res = await request.patch(`/api/fs/mappings/${mapId}`, {
      data: { visibility: 'private' },
    });
    expect(res.ok()).toBeTruthy();
    expect(((await res.json()) as { data: { resync: SyncResult | null } }).data.resync).toBeNull();

    // The mirror and its hub drop out of the non-admin graph immediately.
    graph = (await (await request.get('/api/graph', { headers: bob })).json()) as GraphData;
    expect(graph.data.objects.filter((o) => o.mapping === mapId)).toHaveLength(0);
    expect(graph.data.fsMappings.find((m) => m.id === mapId)).toBeUndefined();

    // Restore shared + enabled. The resync SKIPS every row (frontmatter.cfg
    // still matches the shared-era config) — proof the direct flip, not the
    // sync engine, moves the ACL in both directions.
    const restore = (await (
      await request.patch(`/api/fs/mappings/${mapId}`, {
        data: { visibility: 'shared', enabled: true },
      })
    ).json()) as { data: { resync: SyncResult } };
    expect(restore.data.resync.upserted).toBe(0);
    expect(restore.data.resync.unchanged).toBe(1);
    graph = (await (await request.get('/api/graph', { headers: bob })).json()) as GraphData;
    expect(graph.data.objects.filter((o) => o.mapping === mapId)).toHaveLength(1);
  });

  test('admin UI: status strip, mapping card, folder picker, delete confirm', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Mapped folders' }).click();

    // Status strip: the mounted root badge; mapping card with live counts.
    await expect(page.getByText(/e2e · \//)).toBeVisible();
    await expect(page.getByText('Papers', { exact: true })).toBeVisible();
    await expect(page.getByText('1 objects')).toBeVisible();

    // Sync now → toast with the pass's counts. .first(): the toast text is
    // duplicated into an aria-live announcement span while it is on screen,
    // which trips strict mode depending on timing.
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(
      page.getByText('Synced — 1 scanned, 0 updated, 0 removed.').first(),
    ).toBeVisible();

    // FolderBrowser: descend into the mapped folder → pre-emptive warning +
    // Save-path blocked; ascend; descend elsewhere and commit it.
    await page.getByRole('button', { name: 'Add mapping' }).click();
    await page.getByRole('button', { name: /^papers / }).click();
    await expect(page.getByText('Already covered by "Papers"')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use this folder' })).toBeDisabled();
    await page.getByRole('button', { name: '..' }).click();
    await page.getByRole('button', { name: /^other / }).click();
    await expect(page.getByText('1 files here')).toBeVisible();
    await expect(page.getByText('note.txt')).toBeVisible();
    await page.getByRole('button', { name: 'Use this folder' }).click();
    await expect(page.getByText('e2e/other', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/fs-mappings-admin.png', fullPage: true });
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Delete confirm carries the object count — and cancel keeps the mapping.
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(/its 1 mirrored objects/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Papers', { exact: true })).toBeVisible();
  });

  test('explore: the standalone constellation renders in the core view', async ({ page }) => {
    const graphResponse = page.waitForResponse((r) => r.url().includes('/api/graph') && r.ok());
    await page.goto('/explore');
    // Structure asserted via the payload (the canvas is opaque — same
    // convention as core.spec.ts): hub metadata + the mirrored object.
    const payload = (await (await graphResponse).json()) as GraphData;
    const fm = payload.data.fsMappings.find((m) => m.id === mapId)!;
    expect(fm.nested).toBe(false);
    expect(fm.count).toBe(1);
    expect(payload.data.objects.filter((o) => o.mapping === mapId)).toHaveLength(1);

    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    // Core is on by default — no toggle needed, just let the scene settle.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'e2e/screenshots/core-mapping.png' });
  });

  test('agent status carries the mapping block under the size budget', async ({ request }) => {
    const res = await request.get('/agent/v1/fs/status', {
      headers: { Authorization: 'Bearer e2e-ro' },
    });
    expect(res.ok()).toBeTruthy();
    const text = await res.text();
    expect(text.length).toBeLessThan(16384);
    const body = JSON.parse(text) as {
      data: {
        configured: boolean;
        roots: Array<{ key: string }>;
        mappings: {
          total: number;
          items: Array<{ id: string; label: string; enabled: boolean; rootAvailable: boolean; objectCount: number }>;
        };
      };
    };
    expect(body.data.roots.map((r) => r.key)).toEqual(['e2e']);
    const item = body.data.mappings.items.find((i) => i.id === mapId)!;
    expect(item).toMatchObject({ label: 'Papers', enabled: true, rootAvailable: true, objectCount: 1 });
  });

  test('delete purges the mapping and every mirrored object', async ({ request }) => {
    const res = await request.delete(`/api/fs/mappings/${mapId}`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { data: { removedObjects: number } };
    expect(body.data.removedObjects).toBe(1);
    const graph = (await (await request.get('/api/graph')).json()) as GraphData;
    expect(graph.data.objects.find((o) => o.id.startsWith('fsm:'))).toBeUndefined();
    expect(graph.data.fsMappings.find((m) => m.id === mapId)).toBeUndefined();
  });
});
