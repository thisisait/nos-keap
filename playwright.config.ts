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
    // fs-mappings.spec.ts), interval 0 so syncs happen only via explicit POSTs,
    // and an ro agent token for the /agent/v1/fs/status coverage.
    // KEAP_USER_FILES_DIR stays unset — the per-user tree pipeline is inert.
    command: `rm -rf e2e/.data e2e/.fsroot && PORT=${PORT} KEAP_DATA_DIR=e2e/.data KEAP_FS_ROOTS=e2e=e2e/.fsroot KEAP_FS_SYNC_INTERVAL_S=0 KEAP_AGENT_TOKEN_RO=e2e-ro node dist-server/index.js`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
