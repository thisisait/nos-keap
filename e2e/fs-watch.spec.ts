import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * fs-watch — files written into the per-user tree appear as knowledge objects
 * with NO explicit sync call. The suite runs with KEAP_FS_SYNC_INTERVAL_S=0,
 * so the interval can never be the thing that synced: only the watcher can.
 * Two arrival paths are covered, in order:
 *   1. late mount: KEAP_USER_FILES_DIR is absent at boot (never watched — the
 *      discipline forbids watching a non-existent root); this spec creates it,
 *      the re-probe (KEAP_FS_WATCH_REARM_S=1) arms a watcher and schedules the
 *      one pass that mirrors files written BEFORE arming (no events for those);
 *   2. live event: a file written while the watcher is armed arrives via a
 *      real fs event → 2s debounce → users pass.
 * Serial: the second test's fixtures assume the first one armed the watcher.
 */
test.describe.configure({ mode: 'serial' });

const DOCS = path.resolve('e2e/.userfiles/local/documents');

/** Poll /api/graph (dev-fallback admin identity) until a title shows up. */
const graphHasTitle = (request: import('@playwright/test').APIRequestContext, title: string) =>
  expect
    .poll(
      async () => {
        const graph = (await (await request.get('/api/graph')).json()) as {
          data: { objects: Array<{ title: string }> };
        };
        return graph.data.objects.some((o) => o.title === title);
      },
      { timeout: 40_000, intervals: [1000] },
    )
    .toBe(true);

test.describe('fs-watch', () => {
  test('late-mount: a tree created after boot gets armed and mirrored, no sync call', async ({ request }) => {
    test.setTimeout(60_000);
    mkdirSync(DOCS, { recursive: true });
    writeFileSync(path.join(DOCS, 'watched-note.md'), '# Watched\n\nfs-watch e2e fixture, pre-arm.\n');
    await graphHasTitle(request, 'watched-note.md');
  });

  test('live event: a file written under the armed watcher appears, no sync call', async ({ request }) => {
    test.setTimeout(60_000);
    writeFileSync(path.join(DOCS, 'watched-note-2.md'), '# Watched twice\n\nfs-watch e2e fixture, post-arm.\n');
    await graphHasTitle(request, 'watched-note-2.md');
  });

  test('status carries the additive watch block with the armed users root', async ({ request }) => {
    const status = (
      (await (
        await request.get('/agent/v1/fs/status', { headers: { Authorization: 'Bearer e2e-ro' } })
      ).json()) as {
        data: {
          configured: boolean;
          watch: {
            enabled: boolean;
            degraded: boolean;
            watchedRoots: Array<{ key: string; path: string }>;
            lastEvent: { at: string; root: string } | null;
          };
        };
      }
    ).data;
    expect(status.watch.enabled).toBe(true);
    expect(status.watch.degraded).toBe(false);
    expect(status.watch.watchedRoots.map((r) => r.key)).toContain('users');
    expect(status.watch.lastEvent).toBeTruthy();
    expect(status.watch.lastEvent!.root).toBe('users');
  });
});
