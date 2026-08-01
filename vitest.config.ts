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
 *
 * `scripts/**` carries the recall gate's decision layer (scripts/recall-lib.mjs).
 * It is here because the five defects that layer shipped with were invisible to
 * every gate in the chain: the only way to exercise the logic was to run the
 * whole gate against a live estate and read a summary that did not report the
 * quantity that was broken. Same `.mjs` rule, same reason — the `knowledge` job
 * filters to `knowledge/`, so these run in `app`, where npm ci is complete.
 */
export default defineConfig({
  test: {
    // `shared/**` joined the list with the L1 field-concept vocabulary: that
    // file is a GATE (a closed set with a membership check), not a type
    // declaration, and it is vendored into the nOS repo — so its tests have to
    // run somewhere. Adding the glob rather than parking the test under
    // server/ keeps it next to what it guards; a test that lives outside every
    // include glob passes by never running, which is the failure mode this
    // whole layer exists to remove.
    include: [
      'server/**/*.test.ts',
      'shared/**/*.test.ts',
      'knowledge/**/*.test.mjs',
      'scripts/**/*.test.mjs',
    ],
    environment: 'node',
  },
});
