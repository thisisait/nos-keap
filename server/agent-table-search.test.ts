import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// search-rows is a RESOLVER, not a discovery list: it answers "which rows MEAN
// this" and must be able to answer NONE. The floor is a real cosine distance
// (DEFAULT_MAX_DISTANCE, shared with relations) — never hybridSearch's RRF
// score, which is rank-based (~0.016 for everything) and so fires a threshold
// always or never (the same law cortex-resolve.ts is built on).
//
// Asserted against SOURCE, like agent-row-identity.test.ts: the vector layer
// (vector_distance_cos / vector32) is a libSQL extension the unit env does not
// load (vectorsOk=false), so a behavioural search returns [] for the wrong
// reason. What this cannot see — that a near vector actually returns the row —
// is the live estate's job (a projected table + a wired embedder).

const src = readFileSync(
  fileURLToPath(new URL('./agent.ts', import.meta.url)),
  'utf8',
).replace(/\0/g, '');

function handlerBody(route: string): string {
  const at = src.indexOf(route);
  expect(at, `route ${route} is gone from the agent surface`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  app.', at + 1);
  return src.slice(at, next > at ? next : src.length);
}

describe('search-rows resolves rows by meaning, and can resolve none', () => {
  const body = () => handlerBody("app.get('/agent/v1/tables/:slug/search'");

  it('the floor is a real cosine distance, the shared DEFAULT_MAX_DISTANCE', () => {
    expect(
      /n\.distance <= DEFAULT_MAX_DISTANCE/.test(body()),
      'search no longer filters neighbours by cosine distance against the shared ' +
        'floor — a resolver that cannot return NONE is the absence-as-result sin',
    ).toBe(true);
  });

  it('it uses the vector layer, never hybridSearch (whose RRF score has no floor)', () => {
    expect(body()).toContain('vectorNeighborsOf');
    expect(
      /hybridSearch/.test(body()),
      'search went through hybridSearch — its RRF score is bounded to ~0.016 ' +
        'regardless of match quality, so a threshold on it is meaningless',
    ).toBe(false);
  });

  it('results are addressable: each carries the row __id', () => {
    expect(/__id:\s*rowId/.test(body())).toBe(true);
  });

  it('an un-projected table is reported apart from a no-match (projected:false)', () => {
    expect(/projected:\s*false/.test(body())).toBe(true);
  });
});

describe('get-row fetches one row by its __id', () => {
  const body = () => handlerBody("app.get('/agent/v1/tables/:slug/rows/:rowId'");

  it('returns the row with its identity', () => {
    expect(/__id:\s*row\.id/.test(body())).toBe(true);
  });

  it('a missing row is a 404, not an empty 200', () => {
    expect(/if \(!row\) return fail\(res, 404/.test(body())).toBe(true);
  });
});
