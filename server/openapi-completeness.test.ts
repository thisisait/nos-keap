import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A route cannot exist without a spec line. OPENAPI_SPEC is the agent
 * contract served at /agent/v1/openapi.json — an agent discovering the API
 * through it sees a false, smaller surface for every route the spec misses.
 * By the time the review caught it, THREE whole route families (tables,
 * curator, features/metadata — 18 operations) had drifted out, each shipped
 * release by release with nobody remembering the spec. So the diff is a test
 * now: registration IS the source of truth, the spec must cover it.
 */
const src = readFileSync(fileURLToPath(new URL('./agent.ts', import.meta.url)), 'utf8');

describe('every registered agent route appears in OPENAPI_SPEC', () => {
  const specAt = src.indexOf('const OPENAPI_SPEC');
  const spec = src.slice(specAt);

  it('the spec object exists', () => {
    expect(specAt).toBeGreaterThan(-1);
  });

  it('no route is missing from the contract', () => {
    const registered = new Set<string>();
    for (const m of src.matchAll(/app\.(get|post|delete|patch)\('(\/agent\/v1[^']*)'/g)) {
      registered.add(m[2].replace(/:([A-Za-z]+)/g, '{$1}'));
    }
    expect(registered.size).toBeGreaterThan(40); // the extraction still works
    const missing = [...registered].filter((p) => !spec.includes(`'${p}'`)).sort();
    expect(
      missing,
      'these registered routes have no OPENAPI_SPEC entry — an agent reading the ' +
        'contract cannot discover them; add a paths entry alongside the route',
    ).toEqual([]);
  });
});
