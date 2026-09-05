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

  it('accepts a chat view naming both halves of the exchange', () => {
    expect(
      validateViewMeta({ style: 'chat', askColumn: 'title', bodyColumn: 'research' }, COLUMNS),
    ).toEqual([]);
  });

  it('REFUSES a chat with only one half — an exchange needs both', () => {
    // The style shipped 2026-09-01 for nOS caddy-sessions, where a row is a
    // turn. With only `bodyColumn` the renderer has an answer and no question,
    // which is a grid row that has learned to look like a conversation.
    expect(validateViewMeta({ style: 'chat', bodyColumn: 'research' }, COLUMNS)).toHaveLength(1);
    expect(validateViewMeta({ style: 'chat', askColumn: 'title' }, COLUMNS)).toHaveLength(1);
  });

  it('REFUSES an askColumn naming a column that does not exist', () => {
    expect(
      validateViewMeta({ style: 'chat', askColumn: 'nope', bodyColumn: 'research' }, COLUMNS)[0],
    ).toContain('askColumn');
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

/**
 * facets / highlights / offer — the generative-UI keys.
 *
 * The column check matters MORE for these than for `titleColumn`, because these
 * are the keys a model is expected to fill. A facet naming a column that does
 * not exist renders an empty dropdown; a highlight predicate naming one selects
 * zero rows and labels the emptiness with the author's confident words.
 */
describe('validateViewMeta — the generative keys', () => {
  const GOOD = {
    style: 'timeline',
    dateColumn: 'created',
    facets: ['status', 'title'],
    highlights: [{ label: 'done', when: [{ column: 'status', op: 'eq', value: 'done' }] }],
    offer: { label: 'x', action: 'focus-highlight', when: [{ column: 'status', op: 'eq', value: 'new' }] },
  };

  it('accepts a block whose every column exists', () => {
    expect(validateViewMeta(GOOD, COLUMNS)).toEqual([]);
  });

  it('refuses a facet over a column that does not exist', () => {
    expect(validateViewMeta({ ...GOOD, facets: ['ghost'] }, COLUMNS)[0]).toMatch(/facets\[0\].*unknown column: ghost/);
  });

  it('refuses a highlight predicate over a column that does not exist', () => {
    const e = validateViewMeta(
      { ...GOOD, highlights: [{ label: 'x', when: [{ column: 'ghost' }] }] },
      COLUMNS,
    );
    expect(e[0]).toMatch(/highlights\[0\]\.when\[0\]\.column/);
  });

  it('refuses an offer predicate over a column that does not exist', () => {
    expect(
      validateViewMeta({ ...GOOD, offer: { ...GOOD.offer, when: [{ column: 'ghost' }] } }, COLUMNS)[0],
    ).toMatch(/offer\.when\[0\]\.column/);
  });

  it('refuses a facet over a column whose values are unbounded', () => {
    // A facet over a `date` or `json` column is not a filter, it is one option
    // per row wearing a filter's clothes.
    expect(validateViewMeta({ ...GOOD, facets: ['created'] }, COLUMNS)[0]).toMatch(/low-cardinality/);
  });

  it('does NOT validate the offer action — the catalog is the renderer\'s, not the store\'s', () => {
    // KEAP cannot know which actions a given client implements; the client
    // refuses an id it has no arm for. Pinning the list here would mean
    // declaring a capability on behalf of a runtime this store cannot see.
    expect(validateViewMeta({ ...GOOD, offer: { ...GOOD.offer, action: 'whatever' } }, COLUMNS)).toEqual([]);
  });

  it('a re-declared view lands on a table that ALREADY EXISTS', async () => {
    // The reconcile path is the one every real table takes, and it was
    // write-once for `view` until 2026-08-28: syncCard's preserve-prior rule
    // (right for a row write) also swallowed a re-seed, so a `view:` edited in
    // state/keap-tables/*.table.yml reached nothing and nothing went red.
    await tables.storeFor('libsql').createTable(OWNER, {
      id: 't-redeclare',
      title: 'Redeclare',
      driver: 'libsql',
      schema: { columns: COLUMNS },
      anchors: [],
      visibility: 'private',
      view: { style: 'grid' },
    } as never);
    const t = tables.getTable('t-redeclare')!;
    tables.updateTableSchema(t, { columns: t.schema.columns } as never, {
      style: 'timeline',
      dateColumn: 'created',
      facets: ['status'],
      metaColumns: [],
    } as never);
    expect(db.getObject('table-t-redeclare')!.frontmatter?.view).toMatchObject({
      style: 'timeline',
      facets: ['status'],
    });
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

  it('is READABLE back — a write nobody can verify is a claim, not a fact', async () => {
    // `GET /api/tables/:id` omitted `view` while `PATCH` accepted one, so the
    // only confirmation a style had landed was the PATCH's own 200 — a success
    // marker written by the code that attempted the work. This pins the lift
    // at the store level (the route composes `getTable` with the card, and the
    // card is where the block actually lives).
    const t = tables.getTable('t-view')!;
    const card = db.getObject(`table-${t.id}`);
    expect(card?.frontmatter?.view).toMatchObject({ style: 'blog' });
    // The table row itself carries none of it — which is exactly why the route
    // has to reach for the card rather than returning `t` alone.
    expect(t).not.toHaveProperty('view');
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
