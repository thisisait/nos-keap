import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * S2⁶ Stage 2 — `syncRows()`, the row→knowledge_object projection ratified as
 * D3 (materialised, not computed-on-read) in docs/specs/table-graph-metadata-spec.md.
 *
 * WHY THIS EXISTS, in one sentence: before it, the cortex held ONE object per
 * table and nothing about its rows, so notes captured into a DataTable — the
 * intended face → cortex → agent loop — could not be found by search, embedding
 * or an agent, and the only way in was opening SQLite directly.
 *
 * The interesting cases are not "rows appear". They are RETRACTION: flipping
 * back to card-only, and deleting a row, must remove the objects again. An
 * orphaned row-object is worse than a missing one — the nightly corpus diff
 * would report it forever and be right to.
 *
 * KEAP_DATA_DIR is set BEFORE `await import('./db')`; the data dir resolves at
 * module load, so a static top-level import would bind the wrong database
 * (the lesson server/relations.test.ts:13 records).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-syncrows-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let tables: typeof import('./tables');

const OWNER = 'u-test';

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  tables = await import('./tables');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const SCHEMA = {
  columns: [
    { key: 'title', label: 'Title', kind: 'text', role: 'attribute' },
    { key: 'note', label: 'Note', kind: 'text', role: 'attribute' },
    { key: 'status', label: 'Status', kind: 'select', role: 'attribute' },
  ],
};

function makeTable(id: string, rowCount = 0) {
  return {
    id,
    title: 'Ideas',
    driver: 'libsql' as const,
    schema: SCHEMA as never,
    ownerId: OWNER,
    visibility: 'private' as const,
    rowCount,
    createdAt: 0,
    updatedAt: 0,
  };
}

function insertRow(tableId: string, rowId: string, values: Record<string, unknown>) {
  db.getDb()
    .prepare(
      'INSERT INTO table_rows (table_id, row_id, data, updated_by) VALUES (?, ?, ?, ?)',
    )
    .run(tableId, rowId, JSON.stringify(values), OWNER);
}

function rowObjects(tableId: string) {
  return db.getObjects(OWNER, true).filter((o) => o.id.startsWith(`table-${tableId}:row-`));
}

const ROWS_GRAPH = {
  mode: 'rows' as const,
  node: { labelColumn: 'title', kind: 'idea' },
  edges: [],
};

describe('syncRows', () => {
  it('materialises one object per row, titled from labelColumn', () => {
    const t = makeTable('t-basic');
    insertRow('t-basic', 'r1', { title: 'GeoLibre', note: 'GIS explorer?', status: 'new' });
    insertRow('t-basic', 'r2', { title: 'ECS hydrator', note: 'entity hydration', status: 'new' });

    tables.syncRows({ ...t, rowCount: 2 }, ROWS_GRAPH as never);

    const objs = rowObjects('t-basic');
    expect(objs).toHaveLength(2);
    expect(objs.map((o) => o.title).sort()).toEqual(['ECS hydrator', 'GeoLibre']);
    // node.kind drives the object type — that is what the legend keys off.
    expect(new Set(objs.map((o) => o.type))).toEqual(new Set(['idea']));
  });

  it('writes a body the embedder can use — column LABELS, not keys', () => {
    const objs = rowObjects('t-basic');
    const geo = objs.find((o) => o.title === 'GeoLibre')!;
    expect(geo.body).toContain('Title: GeoLibre');
    expect(geo.body).toContain('Note: GIS explorer?');
    // A router answering a question reads this; `title_or_link:` would be worse
    // for both a human and a model than `Title or link:`.
    expect(geo.body).not.toContain('title:');
  });

  it('inherits the table visibility and never widens it', () => {
    const t = { ...makeTable('t-vis'), visibility: 'shared' as const };
    insertRow('t-vis', 'r1', { title: 'x' });
    tables.syncRows({ ...t, rowCount: 1 }, ROWS_GRAPH as never);
    expect(rowObjects('t-vis')[0].visibility).toBe('shared');
  });

  it('is idempotent — re-syncing does not duplicate', () => {
    const t = makeTable('t-basic', 2);
    tables.syncRows(t, ROWS_GRAPH as never);
    tables.syncRows(t, ROWS_GRAPH as never);
    expect(rowObjects('t-basic')).toHaveLength(2);
  });

  it('RETRACTS objects for rows that no longer exist', () => {
    db.getDb().prepare('DELETE FROM table_rows WHERE table_id = ? AND row_id = ?').run('t-basic', 'r2');
    tables.syncRows(makeTable('t-basic', 1), ROWS_GRAPH as never);
    const objs = rowObjects('t-basic');
    expect(objs).toHaveLength(1);
    expect(objs[0].title).toBe('GeoLibre');
  });

  it("RETRACTS everything when the table flips back to mode 'card'", () => {
    tables.syncRows(makeTable('t-basic', 1), { mode: 'card', edges: [] } as never);
    expect(rowObjects('t-basic')).toHaveLength(0);
  });

  it('projects nothing when no graph block is declared at all', () => {
    const t = makeTable('t-none');
    insertRow('t-none', 'r1', { title: 'y' });
    tables.syncRows({ ...t, rowCount: 1 }, undefined);
    expect(rowObjects('t-none')).toHaveLength(0);
  });

  it('uses idColumn for a stable id when declared, else the row uuid', () => {
    const t = makeTable('t-id');
    insertRow('t-id', 'uuid-aaa', { title: 'Stable', note: 'n', status: 'SLUG-1' });
    tables.syncRows({ ...t, rowCount: 1 }, {
      mode: 'rows',
      node: { labelColumn: 'title', kind: 'idea', idColumn: 'status' },
      edges: [],
    } as never);
    expect(rowObjects('t-id')[0].id).toBe('table-t-id:row-SLUG-1');

    tables.syncRows({ ...t, rowCount: 1 }, ROWS_GRAPH as never);
    expect(rowObjects('t-id')[0].id).toBe('table-t-id:row-uuid-aaa');
  });

  it('still projects a row whose label cell is empty', () => {
    // Dropping it would make the corpus disagree with the table, and the
    // nightly diff would be right to complain about the difference.
    const t = makeTable('t-empty');
    insertRow('t-empty', 'r-blank', { note: 'no title here' });
    tables.syncRows({ ...t, rowCount: 1 }, ROWS_GRAPH as never);
    const objs = rowObjects('t-empty');
    expect(objs).toHaveLength(1);
    expect(objs[0].title).toContain('row ');
  });
});

describe('assertRowProjectionAllowed', () => {
  it('rejects at enable time above the cap rather than truncating', () => {
    expect(() =>
      tables.assertRowProjectionAllowed(tables.ROW_OBJECT_CAP + 1, ROWS_GRAPH as never),
    ).toThrow(/capped at/);
  });

  it('allows a table at exactly the cap', () => {
    expect(() =>
      tables.assertRowProjectionAllowed(tables.ROW_OBJECT_CAP, ROWS_GRAPH as never),
    ).not.toThrow();
  });

  it('ignores the cap for card-only tables', () => {
    expect(() =>
      tables.assertRowProjectionAllowed(10_000, { mode: 'card', edges: [] } as never),
    ).not.toThrow();
  });
});
