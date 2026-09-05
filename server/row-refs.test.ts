import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The `rowRef` back-reference mirror (migration 007-row-refs), against a real
 * throwaway libSQL DB.
 *
 * WHY A MIRROR AT ALL. "Which rows point AT this one" backs three features — the
 * UI back-reference panel, `onDelete: 'restrict'`, and the graph's row→row edge
 * enumeration — and against `table_rows` alone every one of them is a full scan,
 * because rows are keyed (table_id, row_id) with the cells inside a JSON blob.
 * The alternative was an expression index per (table, rowRef column), which
 * needs runtime DDL every time a user adds a column, grows one index per
 * reference, and is only used by the planner when the query repeats the
 * expression byte-for-byte.
 *
 * WHAT THIS SUITE IS ACTUALLY FOR. A mirror's one real failure mode is DRIFT
 * from `data`. So the tests below do not merely check that a write produces an
 * edge — they mutate rows in the awkward ways (clear a cell, PATCH a different
 * column, re-point, delete) and then assert the mirror still equals what a full
 * `rebuildRowRefs()` would have produced. If a write path is ever added that
 * bypasses syncRowRefs, that equality is what breaks.
 *
 * KEAP_DATA_DIR is set BEFORE `await import('./db')` — the data dir is resolved
 * at module load, so a static top-level import would bind the wrong database
 * (the lesson server/relations.test.ts:13 records).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-rowrefs-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let tables: typeof import('./tables');

const OWNER = 'test-owner';

/** The mirror as a comparable set of "from.column -> to" strings. */
function mirror(): string[] {
  return (
    db
      .getDb()
      .prepare(
        'SELECT from_table, from_row, column_key, to_table, to_row FROM table_row_refs ORDER BY 1,2,3',
      )
      .all() as Array<Record<string, string>>
  ).map(
    (r) =>
      `${r.from_table}/${r.from_row}.${r.column_key} -> ${r.to_table}/${r.to_row}`,
  );
}

/** The invariant: the incrementally-maintained mirror == a full rebuild. */
function assertNoDrift() {
  const incremental = mirror();
  tables.rebuildRowRefs();
  expect(mirror(), 'the mirror drifted from table_rows').toEqual(incremental);
}

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  tables = await import('./tables');

  await tables.storeFor('libsql').createTable(OWNER, {
    id: 'party',
    title: 'Party',
    driver: 'libsql',
    schema: { columns: [{ key: 'legal_name', label: 'Legal name', kind: 'text', role: 'attribute', required: true, onDelete: 'restrict' }] },
    anchors: [],
    visibility: 'private',
    sharedWith: [],
  });
  await tables.storeFor('libsql').createTable(OWNER, {
    id: 'invoice',
    title: 'Invoice',
    driver: 'libsql',
    schema: {
      columns: [
        { key: 'number', label: 'Number', kind: 'text', role: 'attribute', required: true, onDelete: 'restrict' },
        { key: 'customer', label: 'Customer', kind: 'rowRef', role: 'dimension', required: false, refTable: 'party', onDelete: 'restrict' },
      ],
    },
    anchors: [],
    visibility: 'private',
    sharedWith: [],
  });
  await tables.storeFor('libsql').upsertRow('party', 'acme', { legal_name: 'ACME s.r.o.' }, OWNER);
  await tables.storeFor('libsql').upsertRow('party', 'globex', { legal_name: 'Globex a.s.' }, OWNER);
});

describe('the mirror tracks writes', () => {
  it('records an edge when a rowRef cell is written', async () => {
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-1', { number: '2026-001', customer: 'acme' }, OWNER);
    expect(tables.referencesTo('party', 'acme')).toEqual([
      { fromTable: 'invoice', fromRow: 'inv-1', columnKey: 'customer' },
    ]);
    assertNoDrift();
  });

  it('records NO edge for a row that leaves the reference empty', async () => {
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-2', { number: '2026-002' }, OWNER);
    expect(tables.referencesTo('party', 'acme')).toHaveLength(1);
    assertNoDrift();
  });

  it('moves the edge when the reference is re-pointed', async () => {
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-1', { customer: 'globex' }, OWNER);
    expect(tables.referencesTo('party', 'acme'), 'the old edge outlived the change').toEqual([]);
    expect(tables.referencesTo('party', 'globex')).toHaveLength(1);
    assertNoDrift();
  });

  it('survives a PATCH that does not mention the reference at all', async () => {
    // upsertRow merges, so `customer` is absent from the payload but present in
    // the merged row. A naive implementation that mirrored the PAYLOAD rather
    // than the merged result would drop the edge here.
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-1', { number: '2026-001-rev' }, OWNER);
    expect(tables.referencesTo('party', 'globex')).toHaveLength(1);
    assertNoDrift();
  });

  it('clears the edge when the cell is emptied', async () => {
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-1', { customer: '' }, OWNER);
    expect(tables.referencesTo('party', 'globex')).toEqual([]);
    assertNoDrift();
  });
});

describe("onDelete 'restrict' is enforced from the mirror", () => {
  it('refuses to delete a referenced row', async () => {
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-3', { number: '2026-003', customer: 'acme' }, OWNER);
    await expect(
      tables.storeFor('libsql').deleteRow('party', 'acme', OWNER),
    ).rejects.toThrow(/referenced by 1 row/);
  });

  it('names only ONE referrer — deleting is not a licence to enumerate', async () => {
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-4', { number: '2026-004', customer: 'acme' }, OWNER);
    await expect(tables.storeFor('libsql').deleteRow('party', 'acme', OWNER)).rejects.toThrow(
      /first: invoice\.customer/,
    );
  });

  it('allows the delete once the last reference is gone', async () => {
    await tables.storeFor('libsql').deleteRow('invoice', 'inv-3', OWNER);
    await tables.storeFor('libsql').deleteRow('invoice', 'inv-4', OWNER);
    await expect(tables.storeFor('libsql').deleteRow('party', 'acme', OWNER)).resolves.toBeUndefined();
    assertNoDrift();
  });

  it("takes the deleted row's OWN outgoing edges with it", async () => {
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-5', { number: '2026-005', customer: 'globex' }, OWNER);
    expect(tables.referencesTo('party', 'globex')).toHaveLength(1);
    await tables.storeFor('libsql').deleteRow('invoice', 'inv-5', OWNER);
    expect(tables.referencesTo('party', 'globex')).toEqual([]);
    assertNoDrift();
  });
});

describe('rebuild is a repair, and says so by matching', () => {
  it('reconstructs the mirror after it is wiped underneath', async () => {
    await tables.storeFor('libsql').upsertRow('invoice', 'inv-6', { number: '2026-006', customer: 'globex' }, OWNER);
    const before = mirror();
    db.getDb().prepare('DELETE FROM table_row_refs').run();
    expect(mirror()).toEqual([]);
    tables.rebuildRowRefs();
    expect(mirror()).toEqual(before);
  });

  it('drops the whole table cleanly, both directions', async () => {
    await tables.storeFor('libsql').dropTable('invoice');
    expect(mirror().filter((e) => e.includes('invoice'))).toEqual([]);
    expect(tables.referencesTo('party', 'globex')).toEqual([]);
  });
});

// ─── referential integrity on WRITE ────────────────────────────────────────
//
// MEASURED LIVE 2026-08-11, on the running estate, minutes after rowRef first
// reached it: a row carrying `customer: "ghost"` was ACCEPTED and stored. The
// integrity was ASYMMETRIC — `onDelete: 'restrict'` refuses to delete a row
// somebody points at, and nothing stopped anyone pointing at nothing. Every
// test above passed throughout, because they test what was written and nobody
// had written this.
//
// OWN FIXTURES, and the reason is worth the sentence: the suite above ends by
// DROPPING `invoice` and DELETING `party/acme`. A block appended here that
// leaned on either would fail on ordering rather than on behaviour — which is
// how the first draft of this block failed, twice, the second time caught by
// the very existence check it was written to prove.
describe('a rowRef may not point at nothing', () => {
  beforeAll(async () => {
    await tables.storeFor('libsql').createTable(OWNER, {
      id: 'bill',
      title: 'Bill',
      driver: 'libsql',
      schema: {
        columns: [
          { key: 'number', label: 'Number', kind: 'text', role: 'attribute', required: false, onDelete: 'restrict' },
          { key: 'customer', label: 'Customer', kind: 'rowRef', role: 'dimension', required: false, refTable: 'party', refDisplay: 'legal_name', onDelete: 'restrict' },
        ],
      },
      anchors: [],
      visibility: 'private',
      sharedWith: [],
    });
    await tables.storeFor('libsql').upsertRow('party', 'bill-cust', { legal_name: 'Billed Co.' }, OWNER);
  });

  it('refuses a reference to a row that does not exist', async () => {
    await expect(
      tables.storeFor('libsql').upsertRow('bill', 'b-ghost', { number: 'X', customer: 'ghost' }, OWNER),
    ).rejects.toThrow(/references party\.ghost, which does not exist/);
  });

  it('refuses a reference into a table that does not exist', async () => {
    await tables.storeFor('libsql').createTable(OWNER, {
      id: 'orphan-ref',
      title: 'Orphan ref',
      driver: 'libsql',
      schema: {
        columns: [
          { key: 'name', label: 'Name', kind: 'text', role: 'attribute', required: false, onDelete: 'restrict' },
          { key: 'target', label: 'Target', kind: 'rowRef', role: 'dimension', required: false, refTable: 'no-such-table', onDelete: 'restrict' },
        ],
      },
      anchors: [],
      visibility: 'private',
      sharedWith: [],
    });
    await expect(
      tables.storeFor('libsql').upsertRow('orphan-ref', 'r1', { name: 'x', target: 'anything' }, OWNER),
    ).rejects.toThrow(/points at table 'no-such-table', which does not exist/);
  });

  it('leaves NOTHING behind when it refuses — not the row, not the mirror', async () => {
    const before = mirror();
    await expect(
      tables.storeFor('libsql').upsertRow('bill', 'b-ghost2', { number: 'Y', customer: 'nope' }, OWNER),
    ).rejects.toThrow();
    const { rows } = await tables.storeFor('libsql').listRows('bill', { filter: [], limit: 100, expand: [] });
    expect(rows.map((r) => r.id)).not.toContain('b-ghost2');
    expect(mirror(), 'a refused write left a mirror edge').toEqual(before);
  });

  it('still accepts an absent or cleared reference — those are not claims', async () => {
    await tables.storeFor('libsql').upsertRow('bill', 'b-none', { number: 'Z' }, OWNER);
    await tables.storeFor('libsql').upsertRow('bill', 'b-none', { customer: '' }, OWNER);
  });
});

// ─── expand on read ────────────────────────────────────────────────────────
//
// `expand` sat in the contract (listRowsQuerySchema, max 4) doing nothing for
// two weeks. Measured live the same day: `?expand=customer` returned the raw
// slug. It was inert at BOTH ends — the store never resolved it, and the agent
// route passed a hard-coded `expand: []`, so the parameter never even arrived.
describe('expand resolves a rowRef to its display value', () => {
  it('adds <col>__display and leaves the raw id in place', async () => {
    await tables.storeFor('libsql').upsertRow('bill', 'b-exp', { number: 'E1', customer: 'bill-cust' }, OWNER);
    const { rows } = await tables
      .storeFor('libsql')
      .listRows('bill', { filter: [], limit: 100, expand: ['customer'] });
    const row = rows.find((r) => r.id === 'b-exp');
    // The id must survive: it is what a WRITE round-trips, and replacing it
    // would make an expanded read un-saveable.
    expect(row?.values.customer).toBe('bill-cust');
    expect(row?.values.customer__display).toBe('Billed Co.');
  });

  it('changes nothing when expand is not asked for', async () => {
    const { rows } = await tables
      .storeFor('libsql')
      .listRows('bill', { filter: [], limit: 100, expand: [] });
    expect(rows.find((r) => r.id === 'b-exp')?.values.customer__display).toBeUndefined();
  });

  it('refuses a typo rather than reporting "no label"', async () => {
    await expect(
      tables.storeFor('libsql').listRows('bill', { filter: [], limit: 10, expand: ['custmoer'] }),
    ).rejects.toThrow(/unknown expand column: custmoer/);
    await expect(
      tables.storeFor('libsql').listRows('bill', { filter: [], limit: 10, expand: ['number'] }),
    ).rejects.toThrow(/is not a rowRef and cannot be expanded/);
  });

  it('declares the capability now that it serves it', () => {
    expect(tables.storeFor('libsql').capabilities.joins).toBe(true);
  });
});

// ─── the question the mirror exists for, finally askable ───────────────────
//
// `referencesTo()` shipped with migration 007 and was reachable from NOWHERE —
// not the agent API, not the human one. It backed `onDelete: 'restrict'`
// internally and nothing else, so the two features its own docstring names (the
// back-reference panel, the graph's row→row edges) had no way to ask. Measured
// 2026-08-11 by curling for a referrers route and getting the forward-auth
// catch-all's 401, which is what an absent route looks like on that API.
describe('referencesTo answers, and distinguishes empty from absent', () => {
  it('lists every referrer with the column that points', async () => {
    await tables.storeFor('libsql').upsertRow('bill', 'b-ref1', { number: 'R1', customer: 'bill-cust' }, OWNER);
    await tables.storeFor('libsql').upsertRow('bill', 'b-ref2', { number: 'R2', customer: 'bill-cust' }, OWNER);
    const refs = tables.referencesTo('party', 'bill-cust');
    expect(refs).toEqual(
      expect.arrayContaining([
        { fromTable: 'bill', fromRow: 'b-ref1', columnKey: 'customer' },
        { fromTable: 'bill', fromRow: 'b-ref2', columnKey: 'customer' },
      ]),
    );
  });

  it('returns EMPTY for a row nobody points at — not an error', async () => {
    await tables.storeFor('libsql').upsertRow('party', 'lonely', { legal_name: 'Nobody Ltd.' }, OWNER);
    expect(tables.referencesTo('party', 'lonely')).toEqual([]);
  });

  it('returns EMPTY for a row that does not exist, and that is deliberate', () => {
    // "Nothing points at me" and "I am not there" are different answers. The
    // route must not 404 here: a caller asking whether a delete is safe would
    // read the 404 as a refusal to answer rather than as "safe".
    expect(tables.referencesTo('party', 'never-existed')).toEqual([]);
  });
});
