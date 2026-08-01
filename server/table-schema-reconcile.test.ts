import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `updateTableSchema()` — the write path `data_tables.schema_json` did not have.
 *
 * WHY THIS EXISTS, and it is the finding that reshaped the whole L1 commit:
 * before this function, `schema_json` had exactly ONE writer (the INSERT in
 * createTable) and no UPDATE anywhere. A table's columns were immutable for
 * their entire lifetime; the only change path was DELETE → dropTable, which
 * deletes table_rows AND table_row_history. So declaring a new per-column fact
 * — an L1 concept today, an L2 vector slot later — could not reach a converged
 * install at all: it would land in git, the offline gate would go green, and
 * the database would keep the concept-less schema with nothing red anywhere.
 * That is a gate that passes while delivering nothing.
 *
 * The interesting cases are therefore not "the write happens". They are the
 * REFUSALS: rows already hold values, so a reconcile that drops a column or
 * re-kinds one would strand or silently reinterpret them.
 *
 * KEAP_DATA_DIR is set BEFORE `await import('./db')` — the data dir resolves at
 * module load (the lesson server/relations.test.ts:13 records).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-schemarec-'));
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

const BASE_COLUMNS = [
  { key: 'name', label: 'Name', kind: 'text', role: 'dimension', required: true },
  { key: 'status', label: 'Status', kind: 'select', role: 'dimension', options: ['on', 'off'] },
  { key: 'port', label: 'Port', kind: 'number', role: 'attribute' },
];

async function makeTable(id: string) {
  return tables.storeFor('libsql').createTable(OWNER, {
    id,
    title: 'Systems',
    description: undefined,
    driver: 'libsql',
    schema: { columns: BASE_COLUMNS } as never,
    anchors: [],
    visibility: 'private',
  } as never);
}

describe('updateTableSchema', () => {
  it('declares concepts onto the columns of an EXISTING table', async () => {
    const t = await makeTable('t-declare');
    const next = {
      columns: [
        { ...BASE_COLUMNS[0], concept: 'identity.name' },
        { ...BASE_COLUMNS[1], concept: 'lifecycle.status' },
        { ...BASE_COLUMNS[2], concept: 'net.port' },
      ],
    };
    tables.updateTableSchema(t, next as never);

    // Re-read from the DATABASE, not the returned object — the point of the
    // whole exercise is that the declaration reaches storage.
    const reread = tables.getTable('t-declare')!;
    expect(reread.schema.columns.map((c) => c.concept)).toEqual([
      'identity.name',
      'lifecycle.status',
      'net.port',
    ]);
  });

  it('re-renders the card so the corpus stops describing the old columns', async () => {
    const card = db.getObject('table-t-declare')!;
    const cols = card.frontmatter?.columns as Array<{ key: string; concept?: string }>;
    expect(cols.find((c) => c.key === 'status')?.concept).toBe('lifecycle.status');
  });

  it('ADDS a column — rows simply have no value for it yet', async () => {
    const t = tables.getTable('t-declare')!;
    tables.updateTableSchema(t, {
      columns: [...t.schema.columns, { key: 'icon', label: 'Icon', kind: 'text', role: 'attribute', concept: 'ui.icon' }],
    } as never);
    expect(tables.getTable('t-declare')!.schema.columns.map((c) => c.key)).toContain('icon');
  });

  it('REFUSES to drop a column — rows still hold its values', async () => {
    const t = tables.getTable('t-declare')!;
    expect(() =>
      tables.updateTableSchema(t, { columns: t.schema.columns.filter((c) => c.key !== 'port') } as never),
    ).toThrow(/would be dropped/);
    // and the refusal is total — nothing was half-written
    expect(tables.getTable('t-declare')!.schema.columns.map((c) => c.key)).toContain('port');
  });

  it('REFUSES to change a kind — stored values would be reinterpreted', async () => {
    const t = tables.getTable('t-declare')!;
    const next = t.schema.columns.map((c) => (c.key === 'port' ? { ...c, kind: 'text' } : c));
    expect(() => tables.updateTableSchema(t, { columns: next } as never)).toThrow(/would change kind/);
  });

  it('reports EVERY violation at once, not just the first', async () => {
    const t = tables.getTable('t-declare')!;
    const next = t.schema.columns
      .filter((c) => c.key !== 'icon')
      .map((c) => (c.key === 'port' ? { ...c, kind: 'text' } : c));
    expect(() => tables.updateTableSchema(t, { columns: next } as never)).toThrow(/dropped[\s\S]*kind|kind[\s\S]*dropped/);
  });

  it('re-renders projected row bodies with the concept token', async () => {
    // The graph block goes in at CREATE, the way the nOS seeder declares it —
    // updateTableSchema re-syncs graph-less and must recover the block from the
    // card, exactly as syncCard's own re-sync path does. Passing it only to a
    // direct syncRows call would leave the card without it and prove nothing.
    await tables.storeFor('libsql').createTable(OWNER, {
      id: 't-rows',
      title: 'Systems',
      driver: 'libsql',
      schema: { columns: BASE_COLUMNS },
      anchors: [],
      visibility: 'private',
      graph: { mode: 'rows', node: { labelColumn: 'name', kind: 'idea' }, edges: [] },
    } as never);
    await tables.storeFor('libsql').upsertRow('t-rows', 'r1', { name: 'GeoLibre', status: 'on' }, OWNER);

    const before = db.getObject('table-t-rows:row-r1')!;
    expect(before.body).toContain('Status: on');

    tables.updateTableSchema(tables.getTable('t-rows')!, {
      columns: [
        { ...BASE_COLUMNS[0], concept: 'identity.name' },
        { ...BASE_COLUMNS[1], concept: 'lifecycle.status' },
        BASE_COLUMNS[2],
      ],
    } as never);

    const after = db.getObject('table-t-rows:row-r1')!;
    expect(after.body).toContain('Status [lifecycle.status]: on');
    // The bracket token is a LEXICAL affordance (FTS/BM25 across tables that
    // label the same meaning differently) — not a claim about the embedding,
    // which is one vector over a truncated body. See rowBody's docblock.
    expect(after.body).toContain('Name [identity.name]: GeoLibre');
  });
});
