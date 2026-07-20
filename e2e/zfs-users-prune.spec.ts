import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * Users-pass prune guards — the twin of the mapping-pass rule.
 *
 * walkUser used to DISCARD walkDir's incomplete flag, so a single unreadable
 * subdir silently truncated the found-set while readable siblings kept
 * scanned > 0. The zero-scan guard cannot see that case, so every mirror under
 * the unreadable subtree was deleted — and its vectors reaped with it. The
 * nOS self-model (uid 'nos-docs') syncs through exactly this path.
 */
test.describe.configure({ mode: 'serial' });

const RW = { Authorization: 'Bearer e2e-rw', 'Content-Type': 'application/json' };
const ROOT = path.resolve('e2e/.userfiles');
const UID = 'prunetest';
const SAFE = path.join(ROOT, UID, 'documents');
const LOCKED = path.join(SAFE, 'locked');

interface SyncResult {
  scanned: number;
  upserted: number;
  removed: number;
  pruneRefused?: boolean;
  danglingAnchors?: number;
}

const sync = async (request: import('@playwright/test').APIRequestContext) =>
  ((await (await request.post('/agent/v1/fs/sync?wait=1', { headers: RW, data: {} })).json()) as {
    data: SyncResult;
  }).data;

test.describe('users-pass prune guards', () => {
  test('seed: a sibling file plus a subtree that will become unreadable', async ({ request }) => {
    mkdirSync(LOCKED, { recursive: true });
    writeFileSync(path.join(SAFE, 'sibling.md'), 'readable sibling\n');
    writeFileSync(path.join(LOCKED, 'buried.md'), 'mirrored, then hidden\n');
    const r = await sync(request);
    expect(r.upserted).toBeGreaterThanOrEqual(2);
  });

  test('an unreadable subtree refuses the prune — buried mirrors survive', async ({ request }) => {
    chmodSync(LOCKED, 0o000); // readdir → EACCES, exactly like a dropped sub-mount
    let r: SyncResult;
    try {
      r = await sync(request);
    } finally {
      chmodSync(LOCKED, 0o755); // always restore, or the next rm -rf fails
    }
    // The regression: siblings keep scanned > 0, so the zero-scan guard is blind
    // and buried.md's mirror used to be deleted here.
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.pruneRefused, 'prune must be refused on a truncated walk').toBe(true);
    expect(r.removed, 'no mirror is reaped on a read hiccup').toBe(0);
  });

  test('subtree readable again → an ordinary reconcile prunes for real', async ({ request }) => {
    rmSync(path.join(LOCKED, 'buried.md'));
    const r = await sync(request);
    expect(r.pruneRefused ?? false).toBe(false);
    expect(r.removed, 'a genuine delete still prunes').toBe(1);
  });

  test('a card anchored to a node that does not exist is REPORTED, not silent', async ({
    request,
  }) => {
    // fs-sync runs on boot and on a timer, independent of whatever ingests the
    // taxonomy, so a card can legitimately arrive before its node. It then
    // renders nowhere (graph.ts drops the dangling anchor at read time) and
    // heals by itself once the node lands. The failure mode worth closing is
    // that happening with nothing said.
    // A SLUG anchor, which also proves classifyRef accepts the user-subtree id
    // shape — an unrecognised ref is dropped silently, so if the regex were
    // wrong this would report zero and look like success.
    // nos.ghost.* never exists — nos.infra.* DOES now (the selfmodel fixture is
    // ingested before boot), which is exactly why a "dangling" fixture must not
    // borrow a real-looking id from a tree someone may later make real.
    writeFileSync(path.join(SAFE, 'early.md'), 'anchored ahead of its node [[nos.ghost.futurenode]]\n');
    const r = await sync(request);
    expect(r.danglingAnchors ?? 0, 'the sync must report the unresolvable anchor').toBeGreaterThan(0);

    // An ordinary card does not trip it.
    rmSync(path.join(SAFE, 'early.md'));
    const clean = await sync(request);
    expect(clean.danglingAnchors ?? 0).toBe(0);
  });

  test('an emptied uid tree does not lose its mirrors while another uid has files', async ({
    request,
  }) => {
    // The exact shape a bind-mounted shared tree takes during bring-up: the
    // mountpoint exists, its content does not yet. The GLOBAL zero-scan guard
    // cannot see it — some other uid contributed files, so found.length > 0 —
    // and without a per-uid guard every mirror under the empty tree is deleted
    // along with its embeddings.
    // Its own uid, so the earlier fixture in this serial spec cannot keep the
    // tree non-empty and mask the very condition under test.
    const SHARED = path.join(ROOT, 'sharedtree', 'documents');
    const OTHER = path.join(ROOT, 'otheruser', 'documents');
    mkdirSync(SHARED, { recursive: true });
    mkdirSync(OTHER, { recursive: true });
    writeFileSync(path.join(OTHER, 'keeps-the-pass-non-empty.md'), 'unrelated user\n');
    writeFileSync(path.join(SHARED, 'shared-a.md'), 'shared tree content\n');
    writeFileSync(path.join(SHARED, 'shared-b.md'), 'shared tree content\n');
    let r = await sync(request);
    expect(r.upserted).toBeGreaterThanOrEqual(3);

    // Empty ONLY the shared tree, leaving the mountpoint itself in place.
    rmSync(path.join(SHARED, 'shared-a.md'));
    rmSync(path.join(SHARED, 'shared-b.md'));
    r = await sync(request);
    expect(r.pruneRefused, 'an emptied uid tree must not be pruned').toBe(true);
    expect(r.removed, 'its mirrors survive').toBe(0);

    rmSync(path.join(ROOT, 'otheruser'), { recursive: true, force: true });
    rmSync(path.join(ROOT, 'sharedtree'), { recursive: true, force: true });
    await sync(request);
  });

  test('cleanup', async ({ request }) => {
    rmSync(path.join(ROOT, UID), { recursive: true, force: true });
    await sync(request);
  });
});
