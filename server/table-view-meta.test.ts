import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateViewMeta } from '../shared/contracts/table';

/**
 * `view` — how a table asks to be RENDERED.
 *
 * WHY IT LIVES ON THE TABLE. "Is this a spreadsheet or an article list" is a
 * property of the DATA, not of one client. The face's grid sets
 * `white-space: nowrap`, which is correct for a status column and useless for a
 * `research` column holding three paragraphs — and which of those a table is,
 * is knowable once, at the table, instead of re-decided by every surface.
 *
 * The interesting cases are the REFUSALS and the PERSISTENCE, not "it stores a
 * string": a timeline with no date column is a list in arbitrary order wearing
 * a timeline's clothes, and a view block wiped by the next row write would look
 * exactly like a style that never saved.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-viewmeta-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let tables: typeof import('./tables');

const OWNER = 'u-test';
const COLUMNS = [
  { key: 'title', label: 'Title', kind: 'text', role: 'dimension', required: true },
  { key: 'research', label: 'Research', kind: 'text', role: 'attribute' },
  { key: 'created', label: 'Created', kind: 'date', role: 'dimension' },
  { key: 'status', label: 'Status', kind: 'select', role: 'dimension', options: ['new', 'done'] },
];

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  tables = await import('./tables');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('validateViewMeta', () => {
  it('accepts a blog view that names a real long-form column', () => {
    expect(validateViewMeta({ style: 'blog', titleColumn: 'title', bodyColumn: 'research' }, COLUMNS)).toEqual([]);
  });

  it('REFUSES a blog with no body column — the long-form cell IS the style', () => {
    const e = validateViewMeta({ style: 'blog', titleColumn: 'title' }, COLUMNS);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/requires bodyColumn/);
  });

  it('REFUSES a timeline with no date column — the order would be arbitrary', () => {
    expect(validateViewMeta({ style: 'timeline', titleColumn: 'title' }, COLUMNS)[0]).toMatch(/requires dateColumn/);
  });

  it('refuses a reference to a column that does not exist', () => {
    // The failure mode this prevents: a view block outlives a column rename and
    // renders an untitled list forever, with nothing red.
    expect(validateViewMeta({ style: 'grid', titleColumn: 'nope' }, COLUMNS)[0]).toMatch(/unknown column: nope/);
    expect(validateViewMeta({ style: 'grid', metaColumns: ['status', 'ghost'] }, COLUMNS)[0]).toMatch(/metaColumns\[1\]/);
  });

  it('refuses a date column whose kind cannot carry a date', () => {
    expect(
      validateViewMeta({ style: 'timeline', titleColumn: 'title', dateColumn: 'status' }, COLUMNS)[0],
    ).toMatch(/must be a date\/number\/text/);
  });

  it('the grid needs nothing — an absent view block is the default', () => {
    expect(validateViewMeta({ style: 'grid' }, COLUMNS)).toEqual([]);
    expect(validateViewMeta({}, COLUMNS)).toEqual([]);
  });
});

describe('view block persistence', () => {
  it('rides the create request into the card frontmatter', async () => {
    await tables.storeFor('libsql').createTable(OWNER, {
      id: 't-view',
      title: 'Ideas',
      driver: 'libsql',
      schema: { columns: COLUMNS },
      anchors: [],
      visibility: 'private',
      view: { style: 'blog', titleColumn: 'title', bodyColumn: 'research', metaColumns: ['status'] },
    } as never);
    const card = db.getObject('table-t-view')!;
    expect(card.frontmatter?.view).toMatchObject({ style: 'blog', bodyColumn: 'research' });
  });

  it('SURVIVES a row write — the re-sync must not wipe the declared style', async () => {
    // syncCard is called with no view arg on every upsert; without the
    // fall-back-to-prior rule each row write would silently reset the table to
    // the grid, which is indistinguishable from a style that never saved.
    await tables.storeFor('libsql').upsertRow('t-view', 'r1', { title: 'GeoLibre', research: 'long text' }, OWNER);
    expect(db.getObject('table-t-view')!.frontmatter?.view).toMatchObject({ style: 'blog' });
  });

  it('survives a schema reconcile too', async () => {
    const t = tables.getTable('t-view')!;
    tables.updateTableSchema(t, {
      columns: [...t.schema.columns, { key: 'note', label: 'Note', kind: 'text', role: 'attribute' }],
    } as never);
    expect(db.getObject('table-t-view')!.frontmatter?.view).toMatchObject({ style: 'blog' });
  });

  it('a table that never asked for a style has no view key at all', async () => {
    await tables.storeFor('libsql').createTable(OWNER, {
      id: 't-plain',
      title: 'Plain',
      driver: 'libsql',
      schema: { columns: COLUMNS },
      anchors: [],
      visibility: 'private',
    } as never);
    expect(db.getObject('table-t-plain')!.frontmatter).not.toHaveProperty('view');
  });
});
