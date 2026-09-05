import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The SAFE_ROW_ID invariant, enforced by the DRIVER, not the routes.
 *
 * tables.ts:224 documents why the invariant exists (row ids become RustFS
 * object keys parsed as URLs — `..` traverses out of the table) and demanded
 * that "every route" call assertRowId. The agent door's `__id` write proved
 * that a per-route obligation does not hold: routes.ts remembered, agent.ts
 * did not, and a caller-supplied `__id: "../../<other>/rows/x"` reached the
 * driver unchecked. The fix moves the assert into upsertRow itself, so a
 * future route CANNOT forget it. Behavioural against the real libsql store —
 * the guard lives in the shared driver path, which is exactly what this
 * suite observes.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-rowid-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let tables: typeof import('./tables');

const OWNER = 'test-owner';

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  tables = await import('./tables');
  await tables.storeFor('libsql').createTable(OWNER, {
    id: 'notes',
    title: 'Notes',
    driver: 'libsql',
    schema: {
      columns: [
        { key: 'body', label: 'Body', kind: 'text', role: 'attribute', required: false, onDelete: 'restrict' },
      ],
    },
    anchors: [],
    visibility: 'private',
    sharedWith: [],
  });
});

describe('the driver refuses unsafe caller-supplied row ids', () => {
  it.each([
    '../../other/rows/x', // the rustfs cross-table traversal
    '../schema', // overwrites the table's own schema object
    'a.b', // '.' begins every traversal
    'q?x', // truncates the S3 key into a query string
    'x'.repeat(129), // over the length cap
  ])('rejects %j', async (bad) => {
    await expect(
      tables.storeFor('libsql').upsertRow('notes', bad, { body: 'x' }, OWNER),
    ).rejects.toThrow(/invalid row id/);
  });

  it('accepts a well-formed id and still generates one when absent', async () => {
    const named = await tables.storeFor('libsql').upsertRow('notes', 'note_1-A', { body: 'x' }, OWNER);
    expect(named.id).toBe('note_1-A');
    const minted = await tables.storeFor('libsql').upsertRow('notes', undefined, { body: 'y' }, OWNER);
    expect(minted.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});
