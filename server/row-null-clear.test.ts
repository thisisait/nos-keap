import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * null DELETES a cell. The grid could never clear one: an emptied input
 * became `undefined`, JSON.stringify dropped the key, the server merged {}
 * over the row and the "deleted" value repainted on refetch. null is the one
 * spread-able clear that survives the wire; the driver strips null-valued
 * keys AFTER the merge, so required-column validation sees a true absence.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-nullclear-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let tables: typeof import('./tables');

const OWNER = 'test-owner';

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  tables = await import('./tables');
  await tables.storeFor('libsql').createTable(OWNER, {
    id: 'jobs',
    title: 'Jobs',
    driver: 'libsql',
    schema: {
      columns: [
        { key: 'name', label: 'Name', kind: 'text', role: 'attribute', required: true, onDelete: 'restrict' },
        { key: 'note', label: 'Note', kind: 'text', role: 'attribute', required: false, onDelete: 'restrict' },
      ],
    },
    anchors: [],
    visibility: 'private',
  });
  await tables.storeFor('libsql').upsertRow('jobs', 'j1', { name: 'print', note: 'rush' }, OWNER);
});

describe('a table cell can actually be cleared', () => {
  it('null removes the cell; untouched cells survive the patch', async () => {
    const row = await tables.storeFor('libsql').upsertRow('jobs', 'j1', { note: null }, OWNER);
    expect('note' in row.values, 'the cleared cell came back — null did not delete').toBe(false);
    expect(row.values.name).toBe('print');
  });

  it('clearing a REQUIRED cell is refused, not stored as a hole', async () => {
    await expect(
      tables.storeFor('libsql').upsertRow('jobs', 'j1', { name: null }, OWNER),
    ).rejects.toThrow(/invalid row/);
  });
});
