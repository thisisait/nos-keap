import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * Option C — KEAP_FS_SHARED_UIDS: a reserved uid's per-user-tree mirrors
 * (the nOS self-model mounted as uid 'nos-docs') become tenant-shared, so
 * every user's /api/graph lists them; ordinary uids stay private. The
 * webServer runs with KEAP_FS_SHARED_UIDS=nos-docs and an initially-absent
 * KEAP_USER_FILES_DIR (fixtures land here, then an explicit sync runs).
 * Non-admin identity: without KEAP_TRUSTED_PROXY the identity middleware
 * honors X-Authentik-* headers when present — 'bob' carries no admin group.
 */
test.describe.configure({ mode: 'serial' });

const RW = { Authorization: 'Bearer e2e-rw' };
const BOB = {
  'X-Authentik-Username': 'bob',
  'X-Authentik-Uid': 'bob',
  'X-Authentik-Groups': 'nos-users',
};

test.describe('shared uids (Option C)', () => {
  test.beforeAll(() => {
    const root = path.resolve('e2e/.userfiles');
    mkdirSync(path.join(root, 'nos-docs', 'documents'), { recursive: true });
    mkdirSync(path.join(root, 'alice', 'documents'), { recursive: true });
    writeFileSync(
      path.join(root, 'nos-docs', 'documents', 'architecture.md'),
      'nOS platform overview — see [[04]] for computing.\n',
    );
    writeFileSync(path.join(root, 'alice', 'documents', 'diary.md'), 'private notes\n');
    // A repo inside alice's tree — `.git` presence flags it in fsDirs; the
    // marker itself is a hidden entry, so it must never mirror as an object.
    mkdirSync(path.join(root, 'alice', 'documents', 'proj', '.git'), { recursive: true });
    writeFileSync(path.join(root, 'alice', 'documents', 'proj', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(root, 'alice', 'documents', 'proj', 'main.ts'), 'export const answer = 42;\n');
    writeFileSync(path.join(root, 'alice', 'documents', 'proj', 'tool.py'), 'print("hi")\n');
  });

  test('sync mirrors the tree; shared uid objects are tenant-shared', async ({ request }) => {
    const sync = await (
      await request.post('/agent/v1/fs/sync', { headers: RW })
    ).json();
    expect(sync.data.upserted).toBeGreaterThanOrEqual(2);

    // Admin sees both mirrors; the shared-uid one is visibility 'shared',
    // the ordinary uid stays private (users-pass freeze).
    const graph = (await (await request.get('/api/graph')).json()) as {
      data: { objects: Array<{ id: string; owner?: string }> };
    };
    const nos = graph.data.objects.find((o) => o.owner === 'nos-docs');
    const alice = graph.data.objects.find((o) => o.owner === 'alice');
    expect(nos).toBeTruthy();
    expect(alice).toBeTruthy();
    const nosFull = (await (await request.get(`/api/objects/${nos!.id}`)).json()).data;
    expect(nosFull.visibility).toBe('shared');
    const aliceFull = (await (await request.get(`/api/objects/${alice!.id}`)).json()).data;
    expect(aliceFull.visibility).toBe('private');
  });

  test("non-admin sees the shared uid's mirrors, never another user's private ones", async ({
    request,
  }) => {
    const graph = (await (
      await request.get('/api/graph', { headers: BOB })
    ).json()) as { data: { objects: Array<{ id: string; owner?: string }> } };
    expect(graph.data.objects.some((o) => o.owner === 'nos-docs')).toBe(true);
    expect(graph.data.objects.some((o) => o.owner === 'alice')).toBe(false);
  });

  test('agent fs status reports the shared uids', async ({ request }) => {
    const status = (await (
      await request.get('/agent/v1/fs/status', { headers: { Authorization: 'Bearer e2e-ro' } })
    ).json()).data;
    expect(status.sharedUids).toEqual(['nos-docs']);
  });

  test('fsDirs flags repos for the owner/admin, never leaks private trees', async ({ request }) => {
    type DirStat = { path: string; bytes: number; repo: boolean; exts: Array<[string, number]> };
    // Admin: alice's repo dir ships with byte totals + extension buckets.
    const admin = (await (await request.get('/api/graph')).json()) as { data: { fsDirs: DirStat[] } };
    const proj = admin.data.fsDirs.find((d) => d.path === 'documents/proj');
    expect(proj?.repo).toBe(true);
    expect(proj!.bytes).toBeGreaterThan(0);
    expect(proj!.exts.map(([e]) => e)).toEqual(expect.arrayContaining(['ts', 'py']));
    // The `.git` marker never mirrors as an object.
    const graph = (await (await request.get('/api/graph')).json()) as {
      data: { objects: Array<{ path?: string }> };
    };
    expect(graph.data.objects.some((o) => o.path?.includes('.git'))).toBe(false);
    // Non-admin: alice's private repo dir must not leak through stats.
    const bob = (await (
      await request.get('/api/graph', { headers: BOB })
    ).json()) as { data: { fsDirs: DirStat[] } };
    expect(bob.data.fsDirs.some((d) => d.path === 'documents/proj')).toBe(false);
  });
});
