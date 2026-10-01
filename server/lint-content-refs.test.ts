import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * broken-content-ref must judge `keaptable:` refs against data_tables. Measured
 * 2026-10-01 on a fresh nOS estate: 111 medium findings, every one a table card
 * or projected row of a table that existed — `keaptable` is not a content
 * service, so resolveContentRef could never succeed for it.
 *
 * KEAP_DATA_DIR is set BEFORE `await import('./db')` (server/relations.test.ts:13).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-lintref-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let tables: typeof import('./tables');
let lint: typeof import('./lint');

const OWNER = 'u-test';

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  tables = await import('./tables');
  lint = await import('./lint');
  await tables.storeFor('libsql').createTable(OWNER, {
    id: 'caddy',
    title: 'Caddy settings',
    driver: 'libsql',
    schema: { columns: [{ key: 'name', label: 'Name', kind: 'text', role: 'dimension' }] },
    anchors: [],
    visibility: 'private',
    sharedWith: [],
  } as never);
  // A row object whose table was dropped (dropTable deletes only the card).
  db.saveObject(OWNER, { id: 'table-gone:row-1', type: 'record', title: 'Orphan row', resource: 'keaptable:gone#r1', links: [], visibility: 'private' } as never);
  db.saveObject(OWNER, { id: 'obj-kiwix', type: 'note', title: 'Wiki', resource: 'kiwix:wikipedia_en', links: [], visibility: 'private' } as never);
  db.saveObject(OWNER, { id: 'obj-unknown', type: 'note', title: 'Nowhere', resource: 'nosuch:x', links: [], visibility: 'private' } as never);
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const brokenRefs = () =>
  lint.runLint().findings.filter((f) => f.checkId === 'broken-content-ref').map((f) => f.refId);

describe('lint broken-content-ref', () => {
  it('a keaptable ref to an existing table resolves', () => {
    expect(brokenRefs()).not.toContain('table-caddy');
  });

  it('a keaptable ref whose table is gone stays a finding, named as such', () => {
    const f = lint.runLint().findings.find((x) => x.refId === 'table-gone:row-1');
    expect(f?.severity).toBe('medium');
    expect(f?.message).toContain('no such table');
  });

  it('content-service refs are unchanged: known resolves, unknown is flagged', () => {
    const refs = brokenRefs();
    expect(refs).not.toContain('obj-kiwix');
    expect(refs).toContain('obj-unknown');
  });
});
