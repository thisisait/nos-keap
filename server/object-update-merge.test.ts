import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

/**
 * UPDATE = merge, CREATE = the request — the object-upsert law both doors
 * (POST /agent/v1/objects and POST /api/objects) now share.
 *
 * db.saveObject replaces every column, so before this law a field the handler
 * left undefined was a field it deleted: an agent (or Admin → Objects, whose
 * Draft never carried visibility/frontmatter) touching a title flipped the
 * card private — vanishing it from every other viewer's graph — nulled its
 * frontmatter (fs provenance, table view blocks) and replaced curated links
 * with []. Behavioural through the real agent door over HTTP: the law lives
 * in the handler, so the handler is what this suite drives.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-objmerge-'));
process.env.KEAP_DATA_DIR = TMP;
process.env.KEAP_AGENT_TOKEN_RW = 'rw-test-token';

let db: typeof import('./db');
let server: http.Server;
let base: string;

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  const { default: express } = await import('express');
  const { registerAgentRoutes } = await import('./agent');
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  db.saveObject('alice', {
    id: 'card-1',
    type: 'note',
    title: 'Shared card',
    description: 'curated description',
    tags: ['keep-me'],
    frontmatter: { source: 'fs', path: '/doctrine/card-1.md' },
    body: 'original body',
    links: [{ kind: 'object', target: 'card-2' }] as never,
    visibility: 'shared',
  });
});

afterAll(() => {
  server?.close();
});

function post(payload: unknown) {
  return fetch(`${base}/agent/v1/objects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer rw-test-token' },
    body: JSON.stringify(payload),
  });
}

describe('POST /agent/v1/objects on an existing id', () => {
  it('a title touch-up keeps visibility, frontmatter, links, description and tags', async () => {
    const res = await post({ id: 'card-1', type: 'note', title: 'Shared card, retitled' });
    expect(res.status).toBe(200);
    const o = db.getObject('card-1');
    expect(o?.title).toBe('Shared card, retitled');
    expect(o?.visibility, 'the update privatized a shared card').toBe('shared');
    expect(o?.frontmatter, 'the update wiped frontmatter (fs provenance)').toMatchObject({
      source: 'fs',
    });
    expect(o?.links?.length, 'the update dropped curated links').toBeGreaterThan(0);
    expect(o?.description).toBe('curated description');
    expect(o?.tags).toEqual(['keep-me']);
    expect(o?.userId, 'the update stole the card from its owner').toBe('alice');
  });

  it('an explicit empty string still clears a field', async () => {
    await post({ id: 'card-1', type: 'note', title: 'Shared card', description: '' });
    expect(db.getObject('card-1')?.description).toBeUndefined();
  });

  it('an explicit visibility change is honored', async () => {
    await post({ id: 'card-1', type: 'note', title: 'Shared card', visibility: 'private' });
    expect(db.getObject('card-1')?.visibility).toBe('private');
    await post({ id: 'card-1', type: 'note', title: 'Shared card', visibility: 'shared' });
    expect(db.getObject('card-1')?.visibility).toBe('shared');
  });

  it('a CREATE still defaults to private and links-from-body', async () => {
    await post({ id: 'card-new', type: 'note', title: 'Fresh', body: 'see [[object:card-1]]' });
    const o = db.getObject('card-new');
    expect(o?.visibility).toBe('private');
    expect(o?.links?.length).toBeGreaterThan(0);
  });
});
