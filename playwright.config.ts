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
    command: `rm -rf e2e/.data && PORT=${PORT} KEAP_DATA_DIR=e2e/.data node dist-server/index.js`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
