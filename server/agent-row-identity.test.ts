import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A row the agent surface cannot NAME is a row it cannot ask about.
//
// MEASURED 2026-08-11, minutes after `/agent/v1/tables/:slug/rows/:rowId/referrers`
// shipped. That route is keyed by rowId, and the only way an agent meets a row is
// the listing beside it — which projected `r.values` and dropped `r.id`. So the
// two routes could not be used together: enumerate rows forever, never learn an
// id to ask about. The one exception was a row carrying a `slug`, which doubles
// as its id, so the feature worked for seeded rows and was invisible elsewhere.
//
// It is the same defect the /referrers comment itself describes — a capability
// that exists in the store and is reachable from nowhere. Shipping the route
// without the id moved the wall one hop instead of removing it.
//
// Asserted against the SOURCE rather than a live server because the projection
// is one expression; standing an Express app up to observe it would test more
// machinery and less law. What this cannot see: whether the id a caller receives
// actually resolves — that is `row-refs.test.ts` and the live estate's job.

const src = readFileSync(
  fileURLToPath(new URL('./agent.ts', import.meta.url)),
  'utf8',
).replace(/\0/g, '');

function handlerBody(route: string): string {
  const at = src.indexOf(route);
  expect(at, `route ${route} is gone from the agent surface`).toBeGreaterThan(-1);
  // Bounded by the NEXT route registration, not by a character count. The first
  // version of this helper took a fixed 1800-char window and failed on its own
  // subject: the fix it guards ships with a seventeen-line comment explaining
  // why, which pushed the line being asserted past the end of the window.
  const next = src.indexOf('\n  app.', at + 1);
  return src.slice(at, next > at ? next : src.length);
}

describe('the agent surface can name the rows it returns', () => {
  it('the row listing projects the row id', () => {
    const body = handlerBody("app.get('/agent/v1/tables/:slug/rows'");
    expect(
      /__id:\s*r\.id/.test(body),
      'the rows listing dropped __id again — /referrers is keyed by rowId and this ' +
        'is the only place an agent can learn one, so removing it makes that route ' +
        'unreachable for every row without a slug',
    ).toBe(true);
  });

  it('creating a row tells the caller which row it created', () => {
    const body = handlerBody("app.post('/agent/v1/tables/:slug/rows'");
    expect(
      /__id:\s*row\.id/.test(body),
      'the row upsert stopped returning __id — an agent that just created a row ' +
        'cannot ask what points at it',
    ).toBe(true);
  });

  it('identity is spread last, so a column cannot shadow it', () => {
    // `{ ...r.values, __id: r.id }` and not the reverse: a table is free to
    // declare a column called `__id`, and data must never be able to rename the
    // row it lives in.
    const body = handlerBody("app.get('/agent/v1/tables/:slug/rows'");
    // `, ...` after __id is fine (the __sharing meta rides behind it) — the
    // law is only that __id comes AFTER the values spread.
    const spread = body.match(/\{\s*\.\.\.r\.values,\s*__id:\s*r\.id[,\s}]/);
    expect(
      spread,
      'the identity key is no longer spread after the values, so a column named ' +
        '__id would overwrite the row id',
    ).not.toBeNull();
  });

  it('the referrers route still exists to consume it', () => {
    expect(src).toContain("/agent/v1/tables/:slug/rows/:rowId/referrers");
  });
});

// A row the agent can NAME (above) it must also be able to WRITE BACK.
//
// The POST is upsert-shaped: the store's upsertRow PATCHes an existing row id
// and inserts otherwise. But the door only ever derived the id from `values.slug`,
// so a slug-less table was write-once from the agent surface — the GET handed
// back an __id the POST then discarded, and an edit re-INSERTED a duplicate.
// The fix routes the caller's __id (the very key the listing returns) to the row
// id, and peels it off the stored values so identity is never a data column.
// Same source-law rationale as above: the handler is one expression, and the
// store's merge/insert behaviour is already covered by row-refs.test.ts.
describe('the agent surface can write back the row it named', () => {
  it('the write routes the caller __id to the row id, not only the slug', () => {
    const body = handlerBody("app.post('/agent/v1/tables/:slug/rows'");
    expect(
      /__id[^=]*=\s*values/.test(body),
      'the POST no longer reads __id off the body — a slug-less table re-INSERTS ' +
        'on every edit because the GET hands back an __id the write throws away',
    ).toBe(true);
  });

  it('__id is peeled off before the values are stored', () => {
    const body = handlerBody("app.post('/agent/v1/tables/:slug/rows'");
    const call = body.match(/upsertRow\(t\.id,\s*\w+,\s*(\w+),/);
    expect(
      call && call[1] !== 'values',
      'upsertRow is handed the raw `values` (with __id) — the row identity would ' +
        'be persisted as a column named __id',
    ).toBe(true);
  });
});
