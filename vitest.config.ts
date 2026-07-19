import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. SCOPED to `server/**` so vitest never picks up the Playwright
 * specs under e2e/ (those import @playwright/test and run against the built app
 * via `npm run test:e2e`). Keep the two suites disjoint.
 */
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    environment: 'node',
  },
});
