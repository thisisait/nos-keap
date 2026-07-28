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
