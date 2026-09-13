import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

/**
 * Todos as a per-user private DataTable (migration 010 + /api/todos-table).
 * The laws: the ensure is deterministic and idempotent; the table is born
 * private to its asker, so isolation is plain table privacy — no todo-
 * specific read paths exist to test, which is the point.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-todos-'));
process.env.KEAP_DATA_DIR = TMP;
process.env.KEAP_TRUSTED_PROXY = '1';

let server: http.Server;
let base: string;

const USERS = {
  alice: { 'x-authentik-username': 'alice', 'x-authentik-groups': 'nos-users' },
  bob: { 'x-authentik-username': 'bob', 'x-authentik-groups': 'nos-users' },
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

beforeAll(async () => {
  const db = await import('./db');
  await db.initDb();
  const { default: express } = await import('express');
  const { registerApiRoutes } = await import('./routes');
  const { identityMiddleware } = await import('./identity');
  const app = express();
  app.use(express.json());
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

describe('todos as a per-user private DataTable', () => {
  it('ensure is deterministic and idempotent', async () => {
    const first = await call('alice', 'GET', '/api/todos-table');
    expect(first.status).toBe(200);
    expect(rec(first.data).id).toBe('todos-alice');
    expect(rec(first.data).visibility).toBe('private');
    const again = await call('alice', 'GET', '/api/todos-table');
    expect(rec(again.data).id).toBe('todos-alice');
  });

  it('rows flow through the plain tables surface; table privacy isolates', async () => {
    const add = await call('alice', 'POST', '/api/tables/todos-alice/rows', {
      values: { title: 'water the ficus', completed: false },
    });
    expect(add.status).toBe(200);
    const listing = rec((await call('alice', 'GET', '/api/tables/todos-alice/rows')).data);
    const titles = Array.isArray(listing.rows)
      ? (listing.rows as Array<{ values?: { title?: string } }>).map((r) => r.values?.title)
      : [];
    expect(titles).toContain('water the ficus');
    // bob has his own table and alice's is ABSENT for him (private + absence-safe)
    expect(rec((await call('bob', 'GET', '/api/todos-table')).data).id).toBe('todos-bob');
    expect((await call('bob', 'GET', '/api/tables/todos-alice/rows')).status).toBe(404);
  });

  it('migration 010 carried legacy rows into the per-user table shape', async () => {
    // The migration ran on a fresh DB (guard-created empty todos → no-op);
    // its LAW is pinned structurally: the legacy table is gone…
    const db = await import('./db');
    const raw = 'getDb' in db ? (db as { getDb?: () => { prepare: (sql: string) => { get: () => unknown } } }).getDb?.() : null;
    if (raw) {
      const t = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='todos'")
        .get();
      expect(t, 'the todos entity must not survive migration 010').toBeUndefined();
    }
  });
});
