/**
 * E2E smoke suite over the BUILT app (`npm run build` first): the webServer
 * boots dist-server against a throwaway data dir (e2e/.data, wiped per run),
 * exactly the artifact the Docker image ships. No Traefik in front, so the
 * server uses the single-tenant dev fallback identity (local / nos-admins) —
 * the identity boundary itself is covered by deploy/SMOKE_TEST.md.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 18300;

export default defineConfig({
  testDir: './e2e',
  // One worker: specs share the server DB and the tables journey mutates it.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Mapped-folders env: one throwaway root (e2e/.fsroot, fixtures written by
    // fs-mappings.spec.ts), interval 0 so the ONLY automatic syncs are the
    // fs-watch-triggered ones (fs-watch.spec.ts depends on exactly that; the
    // explicit-POST specs stay deterministic because every fs mutation resets
    // the watcher's 2s debounce, and their POSTs land well inside it), and
    // agent tokens for the /agent/v1/fs/* coverage. The per-user tree
    // (e2e/.userfiles, fixtures written by fs-watch/shared-uids specs — absent
    // at boot) exercises the late-mount re-probe (KEAP_FS_WATCH_REARM_S=1)
    // and the Option C shared-uid path: uid 'nos-docs' mirrors tenant-shared.
    // The self-model canonical fixture is ingested BEFORE the server boots —
    // the exact order the playbook uses (ingest → restart) — so the suite
    // exercises boot-time registration of a slug subtree, not just the API
    // surface. KEAP_FS_SYNC_DIRS mirrors production's extra `nOS` top class.
    command:
      `rm -rf e2e/.data e2e/.fsroot e2e/.userfiles && ` +
      `KEAP_DATA_DIR=e2e/.data node knowledge/roundtrip-setup.mjs && ` +
      `KEAP_DATA_DIR=e2e/.data node knowledge/ingest.mjs --canonical e2e/fixtures/selfmodel && ` +
      `PORT=${PORT} KEAP_DATA_DIR=e2e/.data KEAP_FS_ROOTS=e2e=e2e/.fsroot KEAP_USER_FILES_DIR=e2e/.userfiles KEAP_FS_SHARED_UIDS=nos-docs KEAP_FS_SYNC_DIRS=documents,library,inbox,nOS KEAP_FS_SYNC_INTERVAL_S=0 KEAP_FS_WATCH_REARM_S=1 KEAP_TENANT_DOMAIN=e2e.test KEAP_AGENT_TOKEN_RO=e2e-ro KEAP_AGENT_TOKEN_RW=e2e-rw node dist-server/index.js`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
