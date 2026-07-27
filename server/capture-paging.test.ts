/**
 * The capture queue must be enumerable, and enumerable SOUNDLY.
 *
 * `GET /agent/v1/captures` caps at MAX_LIMIT (50) rows however large a limit is
 * asked for. Until it took an `offset` a machine reader could only ever see one
 * page — so a client comparing this store against another saw one page of each
 * and reported the difference between two arbitrary subsets as a difference
 * between two corpora.
 *
 * Measured 2026-07-27 against the nOS cortex organ: both stores held the SAME
 * 128 captures, and their first pages overlapped by 5. KEAP's rows had been
 * written over many nights, the organ's all in one fan-out, so `updated_at DESC`
 * put them in genuinely different orders — and the reader blamed the fan-out for
 * "delivering" rows that were simply on a page it never fetched.
 *
 * Two properties are pinned here, and the second is the one that is easy to lose:
 *   1. offset walks the whole queue;
 *   2. the ORDER is total. `updated_at DESC` alone is not — captures written in
 *      one batch share a timestamp to the second, and rows that tie may come
 *      back in any order per query. A page boundary landing inside a tie then
 *      skips one row and repeats another, so paging silently loses ids.
 */

import { describe, expect, it } from 'vitest';

const ORDERED_QUERY = /ORDER BY updated_at DESC, id/;

describe('capture queue paging', () => {
  it('orders by a TOTAL key so page boundaries cannot skip or repeat', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('./db.ts', import.meta.url), 'utf8'),
    );
    const fn = src.slice(src.indexOf('export function getAllMetadataApi'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const selects = body.match(/ORDER BY[^']*/g) ?? [];
    expect(selects.length, 'both the seeAll and per-user queries must order').toBe(2);
    for (const s of selects) {
      expect(
        ORDERED_QUERY.test(`ORDER BY ${s.replace(/^ORDER BY\s*/, '')}`),
        `"${s}" is not a total order — ties break arbitrarily and paging loses rows`,
      ).toBe(true);
    }
  });

  it('serves an offset, so the whole queue can be walked', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('./agent.ts', import.meta.url), 'utf8'),
    );
    const route = src.slice(src.indexOf("app.get('/agent/v1/captures'"));
    const handler = route.slice(0, route.indexOf('\n  });'));

    expect(handler, 'the route must read an offset').toMatch(/req\.query\.offset/);
    expect(
      handler,
      'the slice must start AT the offset — slice(0, limit) ignores it and serves page 0 forever',
    ).toMatch(/slice\(\s*offset\s*,\s*offset\s*\+\s*limit\s*\)/);
    expect(
      handler,
      'echo the offset back: a client that cannot tell whether paging was honoured has to guess, ' +
        'and guessing wrong is what produced a fabricated divergence in the first place',
    ).toMatch(/\boffset,/);
    expect(handler, 'a negative offset must clamp rather than wrap the slice').toMatch(
      /Math\.max\(\s*Number\(req\.query\.offset\)\s*\|\|\s*0\s*,\s*0\s*\)/,
    );
  });
});
