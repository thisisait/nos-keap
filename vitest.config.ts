import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. SCOPED so vitest never picks up the Playwright specs under
 * e2e/ (those import @playwright/test and run against the built app via
 * `npm run test:e2e`). Keep the two suites disjoint.
 *
 * `knowledge/**` carries the SoT round-trip tests: knowledge/roundtrip.mjs gates
 * the REPO's own files, which proves nothing about shapes the repo does not
 * currently contain — the ontology layer shipped with zero relations in it. The
 * unit suite is where the empty cases get real data.
 *
 * Those are `.mjs`, not `.ts`, and deliberately: they run in the `knowledge` CI
 * workflow, which installs with --ignore-scripts and therefore has no
 * .wxt/tsconfig.json for the root tsconfig to reference — the TS transform
 * cannot resolve a tsconfig at all there. Keeping them plain ESM keeps a
 * data-only gate free of the extension toolchain.
 */
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'knowledge/**/*.test.mjs'],
    environment: 'node',
  },
});
