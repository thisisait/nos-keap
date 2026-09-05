import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * An empty (or non-empty) answer from the agent surface must be TRUE.
 * Two ways it lied, one law each:
 *
 * 1. GET /agent/v1/captures?unpromoted=1 built its exclusion set from
 *    listPromotions() — LIMIT 200, newest first — so past that window,
 *    already-proposed captures were re-served as "unpromoted" (the librarian
 *    re-drafts them and silently overwrites the open proposal). db.ts's
 *    openPromotions docstring mandates every pending-exclusion set read the
 *    UNCAPPED open list; the describe/brief endpoints were fixed, this call
 *    site was the one left behind.
 *
 * 2. GET /agent/v1/relations?status=all returned [] — WHERE status='all'
 *    matches nothing, and "you typoed the filter" was indistinguishable from
 *    "no relations exist". Unknown filter values are a 400, never an empty
 *    list. (The admin route's status=all convention does not apply here.)
 */
const src = readFileSync(
  fileURLToPath(new URL('./agent.ts', import.meta.url)),
  'utf8',
);

describe('the agent surface never fabricates an empty (or full) answer', () => {
  it('the unpromoted exclusion set reads the uncapped open list', () => {
    const at = src.indexOf("req.query.unpromoted === '1'");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 400);
    expect(
      block.includes('db.openPromotions()'),
      'unpromoted=1 no longer reads openPromotions — past ~200 promotion rows the ' +
        'guard goes blind and already-proposed captures are re-served as unpromoted',
    ).toBe(true);
    expect(block.includes('db.listPromotions()')).toBe(false);
  });

  it('an unknown relations status/source filter is a 400, not an empty list', () => {
    const at = src.indexOf("app.get('/agent/v1/relations'");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('\n  app.', at + 1));
    expect(
      /!\['proposed', 'confirmed', 'rejected'\]\.includes\(status\)/.test(block),
      'the status filter is cast-through again — status=all silently returns []',
    ).toBe(true);
    expect(/!\['toe', 'derived', 'manual'\]\.includes\(source\)/.test(block)).toBe(true);
  });
});
