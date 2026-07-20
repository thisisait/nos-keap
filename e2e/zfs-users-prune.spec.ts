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

  test('cleanup', async ({ request }) => {
    rmSync(path.join(ROOT, UID), { recursive: true, force: true });
    await sync(request);
  });
});
