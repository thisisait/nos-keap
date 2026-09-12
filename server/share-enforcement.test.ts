import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

/**
 * dtt-share-model ENFORCEMENT, behavioural over HTTP through the real doors.
 *
 * Human door: the full model — table grades + grants, row narrowing + grants,
 * absence-safe reads (404/filtered, never a leaking 403), owner-class-only
 * sharing changes, restricted rows never aggregate. Agent door: phase-1
 * plumbing — stamps row owners, stores patches, returns __sharing, refuses
 * nothing (the face BFF serves user tables through it; see visibility.ts).
 *
 * Identity is real: KEAP_TRUSTED_PROXY=1 + X-Authentik-* headers through
 * identityMiddleware, exactly the production path (minus the proxy secret,
 * unset here).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-share-'));
process.env.KEAP_DATA_DIR = TMP;
process.env.KEAP_TRUSTED_PROXY = '1';
process.env.KEAP_AGENT_TOKEN_RW = 'rw-test-token';
delete process.env.KEAP_PROXY_SHARED_SECRET;

let server: http.Server;
let base: string;

const USERS = {
  alice: { 'x-authentik-username': 'alice', 'x-authentik-groups': 'nos-users' },
  bob: { 'x-authentik-username': 'bob', 'x-authentik-groups': 'nos-users' },
  root: { 'x-authentik-username': 'root', 'x-authentik-groups': 'nos-admins' },
} as const;

async function call(
  who: keyof typeof USERS,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...USERS[who],
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { data?: unknown };
  return { status: res.status, data: json.data };
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function tables(v: unknown): Array<{ id: string }> {
  return Array.isArray(v) ? (v as Array<{ id: string }>) : [];
}
function rows(v: unknown): Array<{ id?: string; __id?: string; __sharing?: { owner?: string; visibility?: string } }> {
  const list = rec(v).rows;
  return Array.isArray(list) ? list : [];
}

const COLS = {
  columns: [{ key: 'note', label: 'Note', kind: 'text', role: 'attribute' }],
};

beforeAll(async () => {
  const db = await import('./db');
  await db.initDb();
  const { default: express } = await import('express');
  const { registerAgentRoutes } = await import('./agent');
  const { registerApiRoutes } = await import('./routes');
  const { identityMiddleware } = await import('./identity');
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app); // pre-identity, like index.ts
  app.use(identityMiddleware);
  registerApiRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
});

describe('table-level grades and grants (human door)', () => {
  let tid: string;

  it('a private table is ABSENT for a non-owner, visible to its owner and admin', async () => {
    const created = await call('alice', 'POST', '/api/tables', {
      title: 'Alice diary',
      schema: COLS,
      visibility: 'private',
    });
    expect(created.status).toBe(200);
    tid = rec(created.data).id as string;
    expect((await call('bob', 'GET', `/api/tables/${tid}`)).status).toBe(404);
    expect((await call('alice', 'GET', `/api/tables/${tid}`)).status).toBe(200);
    expect((await call('root', 'GET', `/api/tables/${tid}`)).status).toBe(200);
    const bobList = await call('bob', 'GET', '/api/tables');
    expect(tables(bobList.data).some((t) => t.id === tid)).toBe(false);
  });

  it('a READ grant opens reads, not writes — and never the declaration', async () => {
    await call('alice', 'PATCH', `/api/tables/${tid}`, {
      sharedWith: [{ principal: 'user:bob', access: 'read' }],
    });
    expect((await call('bob', 'GET', `/api/tables/${tid}`)).status).toBe(200);
    expect(tables((await call('bob', 'GET', '/api/tables')).data).some((t) => t.id === tid)).toBe(true);
    expect((await call('bob', 'POST', `/api/tables/${tid}/rows`, { values: { note: 'hi' } })).status).toBe(403);
    // a grantee never edits the shares (owner-class only)
    expect(
      (await call('bob', 'PATCH', `/api/tables/${tid}`, { sharedWith: [] })).status,
    ).toBe(403);
  });

  it('a WRITE grant writes rows; the declaration still refuses', async () => {
    await call('alice', 'PATCH', `/api/tables/${tid}`, {
      sharedWith: [{ principal: 'user:bob', access: 'write' }],
    });
    const w = await call('bob', 'POST', `/api/tables/${tid}/rows`, { id: 'b1', values: { note: 'from bob' } });
    expect(w.status).toBe(200);
    expect(rec(rec(w.data).sharing).owner, 'row owner stamps from the creating principal').toBe('user:bob');
    expect((await call('bob', 'DELETE', `/api/tables/${tid}`)).status).toBe(403);
  });

  it("the 'system' grade is owner/admin-only on the human door", async () => {
    const created = await call('alice', 'POST', '/api/tables', {
      title: 'Machine ledger',
      schema: COLS,
      visibility: 'system',
    });
    expect(created.status).toBe(200);
    expect((await call('bob', 'GET', `/api/tables/${rec(created.data).id}`)).status).toBe(404);
    expect((await call('root', 'GET', `/api/tables/${rec(created.data).id}`)).status).toBe(200);
  });
});

describe('row-level narrowing, grants and the __ meta keys (human door)', () => {
  let tid: string;

  beforeAll(async () => {
    const created = await call('alice', 'POST', '/api/tables', {
      title: 'Team notes',
      schema: COLS,
      visibility: 'tier-users',
    });
    tid = rec(created.data).id as string;
    await call('alice', 'POST', `/api/tables/${tid}/rows`, { id: 'open1', values: { note: 'public note' } });
    await call('alice', 'POST', `/api/tables/${tid}/rows`, {
      id: 'secret1',
      values: { note: 'alice only', __visibility: 'private' },
    });
  });

  it('a row narrows below its table: absent for the tier reader, present for the owner', async () => {
    const bobRows = rows((await call('bob', 'GET', `/api/tables/${tid}/rows`)).data).map((r) => r.id);
    expect(bobRows).toContain('open1');
    expect(bobRows).not.toContain('secret1');
    const aliceRows = rows((await call('alice', 'GET', `/api/tables/${tid}/rows`)).data).map((r) => r.id);
    expect(aliceRows).toContain('secret1');
  });

  it('restricted rows never aggregate, for ANYONE — including the owner', async () => {
    const agg = await call('alice', 'POST', `/api/tables/${tid}/aggregate`, {
      dimensions: [],
      measures: [{ fn: 'count', column: 'note' }],
      filter: [],
    });
    expect(agg.status).toBe(200);
    expect((agg.data as Array<{ count_note?: number }>)[0]?.count_note).toBe(1); // secret1 excluded by law
  });

  it('__owner is refused; row sharing changes are owner-class only', async () => {
    expect(
      (
        await call('alice', 'POST', `/api/tables/${tid}/rows`, {
          id: 'open1',
          values: { __owner: 'user:alice' },
        })
      ).status,
    ).toBe(400);
    await call('alice', 'PATCH', `/api/tables/${tid}`, {
      sharedWith: [{ principal: 'user:bob', access: 'write' }],
    });
    // bob holds table WRITE, edits values fine — but may not re-share the row
    expect(
      (await call('bob', 'POST', `/api/tables/${tid}/rows`, { id: 'open1', values: { note: 'edited' } }))
        .status,
    ).toBe(200);
    expect(
      (
        await call('bob', 'POST', `/api/tables/${tid}/rows`, {
          id: 'open1',
          values: { __visibility: 'private' },
        })
      ).status,
    ).toBe(403);
    await call('alice', 'PATCH', `/api/tables/${tid}`, { sharedWith: [] });
  });

  it('a ROW grant on a private table: existence + exactly the granted rows', async () => {
    const created = await call('alice', 'POST', '/api/tables', {
      title: 'Mostly secret',
      schema: COLS,
      visibility: 'private',
    });
    const pid = rec(created.data).id as string;
    await call('alice', 'POST', `/api/tables/${pid}/rows`, { id: 'hidden', values: { note: 'no' } });
    await call('alice', 'POST', `/api/tables/${pid}/rows`, {
      id: 'forBob',
      values: { note: 'yes', __shared_with: [{ principal: 'user:bob', access: 'write' }] },
    });
    // the row grant lights the table up in bob's listing…
    expect(tables((await call('bob', 'GET', '/api/tables')).data).some((t) => t.id === pid)).toBe(true);
    // …but only the granted row is in the page
    const granted = rows((await call('bob', 'GET', `/api/tables/${pid}/rows`)).data).map((r) => r.id);
    expect(granted).toEqual(['forBob']);
    // write grant on the row lets bob edit IT, not create siblings
    expect(
      (await call('bob', 'POST', `/api/tables/${pid}/rows`, { id: 'forBob', values: { note: 'edited' } }))
        .status,
    ).toBe(200);
    expect(
      (await call('bob', 'POST', `/api/tables/${pid}/rows`, { id: 'new', values: { note: 'x' } })).status,
    ).toBe(403);
    // absence-safe: the hidden row's delete reads as unknown, not forbidden
    expect((await call('bob', 'DELETE', `/api/tables/${pid}/rows/hidden`)).status).toBe(404);
  });
});

describe('agent door: phase-1 plumbing, no subtraction', () => {
  it('stamps the agent principal, stores patches, returns __sharing, refuses nothing', async () => {
    const mk = await fetch(`${base}/agent/v1/tables`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer rw-test-token',
        'x-keap-agent': 'seeder',
      },
      body: JSON.stringify({
        slug: 'agent-share-t',
        title: 'Agent table',
        columns: COLS.columns,
        visibility: 'private',
        sharedWith: [{ principal: 'agent:librarian', access: 'read' }],
      }),
    });
    expect(mk.status).toBe(200);
    const up = await fetch(`${base}/agent/v1/tables/agent-share-t/rows`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer rw-test-token',
        'x-keap-agent': 'seeder',
      },
      body: JSON.stringify({ note: 'row', __visibility: 'private', __id: 'r1' }),
    });
    const upJson = rec(await up.json());
    expect(up.status, JSON.stringify(upJson)).toBe(200);
    const listing = rec(
      await (
        await fetch(`${base}/agent/v1/tables/agent-share-t/rows`, {
          headers: { authorization: 'Bearer rw-test-token' },
        })
      ).json(),
    );
    const row = rows(listing.data).find((r) => r.__id === 'r1');
    expect(row?.__sharing?.owner).toBe('agent:seeder');
    expect(row?.__sharing?.visibility).toBe('private');
    expect(upJson.success).toBe(true); // phase 1: stored, never refused
  });
});
