import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

/**
 * The hippocampus: KEAP serving the CortexDB "Direct" wire (`/hippocampus/v1/*`)
 * so OpenHuman's memory engine (`cortexdb`) stores its memories as rows of the
 * `engram` DataTable. Shapes follow vendor/tinymemory's own loopback double
 * (cortex/testing/{routes,log}.rs), which is what the client is conformance-
 * tested against — that double IS the oracle, not CortexDB's prose.
 *
 * Driven over real HTTP against an ephemeral Express listener and a throwaway
 * libSQL DB, because the laws here are about the seam: auth tiers that must
 * not cross, rows that must not cross agents, replays that must not duplicate.
 *
 * KEAP_DATA_DIR and the token env are set BEFORE the dynamic imports — tokens.ts
 * and db.ts bind their env at module load (the lesson relations.test.ts:13 records).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-hippocampus-'));
process.env.KEAP_DATA_DIR = TMP;
process.env.KEAP_AGENT_TOKEN_RW = 'agent-rw-token';
process.env.KEAP_HIPPOCAMPUS_KEYS = 'alice:key-alice,bob:key-bob';
delete process.env.KEAP_OLLAMA_URL; // no live embedder in the unit env → lexical recall

let tables: typeof import('./tables');
let server: Server;
let base = '';

const ENGRAM = {
  id: 'engram',
  title: 'Engram',
  driver: 'libsql' as const,
  schema: {
    columns: [
      { key: 'agent', label: 'Agent', kind: 'text' as const, role: 'dimension' as const, required: true, onDelete: 'restrict' as const },
      { key: 'scope', label: 'Scope', kind: 'text' as const, role: 'dimension' as const, required: true, onDelete: 'restrict' as const },
      { key: 'modality', label: 'Modality', kind: 'text' as const, role: 'dimension' as const, required: true, onDelete: 'restrict' as const },
      { key: 'role', label: 'Role', kind: 'text' as const, role: 'attribute' as const, required: false, onDelete: 'restrict' as const },
      { key: 'text', label: 'Text', kind: 'text' as const, role: 'attribute' as const, required: true, onDelete: 'restrict' as const },
      { key: 'labels', label: 'Labels', kind: 'json' as const, role: 'attribute' as const, required: false, onDelete: 'restrict' as const },
      { key: 'observed_at', label: 'Observed at', kind: 'text' as const, role: 'attribute' as const, required: false, onDelete: 'restrict' as const },
      { key: 'idempotency_key', label: 'Idempotency key', kind: 'text' as const, role: 'attribute' as const, required: true, onDelete: 'restrict' as const },
    ],
  },
  anchors: [],
  visibility: 'private' as const,
  sharedWith: [],
};

const SCOPE = 'app:tinymemory/agent:researcher/app:learnings';

async function call(route: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.key !== null) headers.authorization = `Bearer ${init.key ?? 'key-alice'}`;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${route}`, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function experience(text: string, extra: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    modality: 'observation',
    idempotency_key: `tm3:${Buffer.from(text).toString('hex').slice(0, 56)}`,
    content: { kind: 'message', role: 'user', text },
    context: { labels: ['tm:i:' + text.length.toString(16).padStart(16, '0'), 'kind:learning'], observed_at: '2026-01-02T03:04:05+00:00' },
    ...extra,
  };
}

beforeAll(async () => {
  const db = await import('./db');
  await db.initDb();
  tables = await import('./tables');
  const { registerAgentRoutes } = await import('./agent');
  const { registerHippocampusRoutes } = await import('./hippocampus');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerAgentRoutes(app);
  registerHippocampusRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});

afterAll(() => {
  server?.close();
});

describe('the gate: keys, tiers and the missing table', () => {
  it('without the engram table, store and recall answer 503 "engram table missing"', async () => {
    const stored = await call('/hippocampus/v1/experience', { json: experience('early') });
    expect(stored.status).toBe(503);
    expect(stored.body.message ?? stored.body.error).toMatch(/engram table missing/);
    const recalled = await call('/hippocampus/v1/recall', { json: { scope: SCOPE, query: 'early' } });
    expect(recalled.status).toBe(503);
    const health = await call('/hippocampus/v1/admin/health');
    expect(health.status, 'health must not read green while the store is absent').toBe(503);
  });

  it('with KEAP_HIPPOCAMPUS_KEYS unset, every route is 503 — health included, never open', async () => {
    const saved = process.env.KEAP_HIPPOCAMPUS_KEYS;
    delete process.env.KEAP_HIPPOCAMPUS_KEYS;
    try {
      for (const route of ['/hippocampus/v1/admin/health', '/hippocampus/v1/auth/whoami']) {
        const r = await call(route);
        expect(r.status, route).toBe(503);
        expect(r.body.message ?? r.body.error).toMatch(/hippocampus not configured/);
      }
      process.env.KEAP_HIPPOCAMPUS_KEYS = '  ';
      expect((await call('/hippocampus/v1/admin/health')).status).toBe(503);
    } finally {
      process.env.KEAP_HIPPOCAMPUS_KEYS = saved;
    }
  });

  it('a wrong or missing bearer is 401 with the Direct error shape', async () => {
    const wrong = await call('/hippocampus/v1/auth/whoami', { key: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error_code).toBe('UNAUTHORIZED');
    expect((await call('/hippocampus/v1/auth/whoami', { key: null })).status).toBe(401);
  });

  it('a hippocampus key authenticates principal agent:<name> (whoami, the actor header source)', async () => {
    const who = await call('/hippocampus/v1/auth/whoami');
    expect(who.status).toBe(200);
    expect(who.body).toEqual({ caller: 'agent:alice' });
    expect((await call('/hippocampus/v1/auth/whoami', { key: 'key-bob' })).body.caller).toBe('agent:bob');
  });

  it('a hippocampus key does NOT open /agent/v1', async () => {
    const r = await call('/agent/v1/tables', { key: 'key-alice' });
    expect(r.status).toBe(401);
  });

  it('KEAP agent tokens do NOT open /hippocampus', async () => {
    const r = await call('/hippocampus/v1/auth/whoami', { key: 'agent-rw-token' });
    expect(r.status).toBe(401);
  });
});

describe('the store: experience, bulk, idempotency', () => {
  let firstId = '';

  beforeAll(async () => {
    await tables.storeFor('libsql').createTable('nos', ENGRAM);
  });

  it('health and version answer once the table exists; version lists no refers_to_v1', async () => {
    const health = await call('/hippocampus/v1/admin/health');
    expect(health.status).toBe(200);
    const version = await call('/hippocampus/v1/admin/version');
    expect(version.status).toBe(200);
    expect(version.body.capabilities).not.toContain('refers_to_v1');
  });

  it('POST experience is 202 with an event_id, and the row lands in the engram table under the agent', async () => {
    const r = await call('/hippocampus/v1/experience?wait=indexed', { json: experience('the user prefers short answers') });
    expect(r.status).toBe(202);
    expect(typeof r.body.event_id).toBe('string');
    expect(r.body.replayed_from_idempotency).toBe(false);
    firstId = r.body.event_id;

    // The same row through the normal tables API — one memory, one row, attributed.
    const rows = await call('/agent/v1/tables/engram/rows', { key: 'agent-rw-token' });
    expect(rows.status).toBe(200);
    const row = rows.body.data.rows.find((x: { __id: string }) => x.__id === firstId);
    expect(row).toBeDefined();
    expect(row.agent).toBe('alice');
    expect(row.scope).toBe(SCOPE);
    expect(row.text).toBe('the user prefers short answers');
    expect(row.__sharing?.owner).toBe('agent:alice');
  });

  it('the same body again is a replay: same event_id, no second row', async () => {
    const r = await call('/hippocampus/v1/experience', { json: experience('the user prefers short answers') });
    expect(r.status).toBe(202);
    expect(r.body.event_id).toBe(firstId);
    expect(r.body.replayed_from_idempotency).toBe(true);
    const rows = await call('/agent/v1/tables/engram/rows', { key: 'agent-rw-token' });
    expect(rows.body.data.rows.filter((x: { text: string }) => x.text === 'the user prefers short answers')).toHaveLength(1);
  });

  it('the same key with a different body is 409 IDEMPOTENCY_CONFLICT', async () => {
    const body = experience('the user prefers short answers');
    body.content.text = 'something else entirely';
    const r = await call('/hippocampus/v1/experience', { json: body });
    expect(r.status).toBe(409);
    expect(r.body.error_code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('a body without text or scope is 422 (the closed experience schema)', async () => {
    const r = await call('/hippocampus/v1/experience', { json: { scope: SCOPE, modality: 'observation', idempotency_key: 'k', content: { kind: 'message', role: 'user' } } });
    expect(r.status).toBe(422);
  });

  it('bulk appends in order and answers one result per item, the last naming its event_id', async () => {
    const items = [experience('turn zero of the chat', { modality: 'conversation' }), experience('turn one of the chat', { modality: 'conversation' })];
    const r = await call('/hippocampus/v1/experience/bulk?wait=indexed', { json: { items, ordering: 'strict_temporal' } });
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(2);
    expect(r.body.results[1].index).toBe(1);
    expect(typeof r.body.results[1].event_id).toBe('string');
    expect(r.body.accepted).toBe(2);
  });

  it('an idempotency key is scoped to the agent: bob storing alice\'s body gets his own row', async () => {
    const r = await call('/hippocampus/v1/experience', { key: 'key-bob', json: experience('the user prefers short answers') });
    expect(r.status).toBe(202);
    expect(r.body.event_id).not.toBe(firstId);
    expect(r.body.replayed_from_idempotency).toBe(false);
  });
});

describe('the reads: events, recall, scopes — and one agent never sees another', () => {
  it('events lists the scope newest first with the wire shape, and pages by cursor', async () => {
    const r = await call(`/hippocampus/v1/events?scope=${encodeURIComponent(SCOPE)}&limit=2`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.has_more).toBe(true);
    expect(typeof r.body.next_cursor).toBe('string');
    const ev = r.body.items[0];
    expect(ev.scope).toBe(SCOPE);
    expect(ev.content.text).toBe('turn one of the chat');
    expect(ev.content.role).toBe('user');
    expect(ev.context.labels[1]).toBe('kind:learning');
    expect(ev.context.observed_at).toBe('2026-01-02T03:04:05+00:00');
    const next = await call(`/hippocampus/v1/events?scope=${encodeURIComponent(SCOPE)}&limit=2&cursor=${r.body.next_cursor}`);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.has_more).toBe(false);
    expect(next.body.next_cursor, 'a cursor that does not advance is Error::Engine on the client').not.toBe(r.body.next_cursor);
  });

  it('events narrows by one comma-separated labels parameter (any-of)', async () => {
    const label = 'tm:i:' + 'the user prefers short answers'.length.toString(16).padStart(16, '0');
    const r = await call(`/hippocampus/v1/events?scope=${encodeURIComponent(SCOPE)}&limit=200&labels=${encodeURIComponent(`${label},tm:i:nothing`)}`);
    expect(r.body.items.map((e: { content: { text: string } }) => e.content.text)).toEqual(['the user prefers short answers']);
  });

  it('events in another agent\'s key sees only that agent\'s rows', async () => {
    const r = await call(`/hippocampus/v1/events?scope=${encodeURIComponent(SCOPE)}&limit=200`, { key: 'key-bob' });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].content.text).toBe('the user prefers short answers');
  });

  it('recall ranks lexically when no embedder is wired, honours the events budget, and returns a pack', async () => {
    const r = await call('/hippocampus/v1/recall', {
      json: { scope: SCOPE, query: 'chat turn', view: 'granular', include: ['events'], budgets: { max_tokens: 8000000, per_layer_limits: { events: 1 } } },
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.pack_id).toBe('string');
    expect(r.body.layers.events).toHaveLength(1);
    expect(r.body.layers.events[0].content.text).toMatch(/of the chat$/);
    expect(r.body.layers.beliefs).toEqual([]);
    const wide = await call('/hippocampus/v1/recall', { json: { scope: SCOPE, query: 'chat', budgets: { per_layer_limits: { events: 30 } } } });
    expect(wide.body.layers.events).toHaveLength(2);
    const none = await call('/hippocampus/v1/recall', { json: { scope: SCOPE, query: 'quantum chromodynamics', budgets: { per_layer_limits: { events: 30 } } } });
    expect(none.body.layers.events, 'a recall must be able to answer NONE').toEqual([]);
  });

  it('recall narrows by filters.metadata.labels', async () => {
    const label = 'tm:i:' + 'turn one of the chat'.length.toString(16).padStart(16, '0');
    const r = await call('/hippocampus/v1/recall', { json: { scope: SCOPE, query: 'chat', filters: { metadata: { labels: [label] } } } });
    expect(r.body.layers.events.map((e: { content: { text: string } }) => e.content.text)).toEqual(['turn one of the chat']);
  });

  it('recall for another agent never reaches a sibling\'s engrams', async () => {
    const r = await call('/hippocampus/v1/recall', { key: 'key-bob', json: { scope: SCOPE, query: 'chat' } });
    expect(r.body.layers.events).toEqual([]);
  });

  it('answer quotes the pack it is asked about and 404s a pack it does not hold', async () => {
    const pack = await call('/hippocampus/v1/recall', { json: { scope: SCOPE, query: 'short answers' } });
    const r = await call('/hippocampus/v1/answer', { json: { scope: SCOPE, question: 'what does the user prefer?', use_pack_id: pack.body.pack_id, cite_sources: true, include_context: true, answer_instructions: null } });
    expect(r.status).toBe(200);
    expect(r.body.answer).toContain('the user prefers short answers');
    const gone = await call('/hippocampus/v1/answer', { json: { scope: SCOPE, question: 'q', use_pack_id: 'pack_nope' } });
    expect(gone.status).toBe(404);
  });

  it('scopes/list names the caller\'s scopes under a prefix in the Direct shape', async () => {
    const r = await call('/hippocampus/v1/scopes/list?prefix=app%3Atinymemory&limit=1000');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([{ path: SCOPE }]);
    const other = await call('/hippocampus/v1/scopes/list?prefix=app%3Aelsewhere&limit=1000');
    expect(other.body.items).toEqual([]);
  });
});

describe('forget, and the routes the engine never needs', () => {
  it('forget by memory_ids removes only the caller\'s named events and releases their keys', async () => {
    const listed = await call(`/hippocampus/v1/events?scope=${encodeURIComponent(SCOPE)}&limit=200`);
    const target = listed.body.items.find((e: { content: { text: string } }) => e.content.text === 'the user prefers short answers');
    const bobs = (await call(`/hippocampus/v1/events?scope=${encodeURIComponent(SCOPE)}&limit=200`, { key: 'key-bob' })).body.items[0];

    // alice names bob's id too — it must not be hers to delete
    const r = await call('/hippocampus/v1/forget', {
      json: { scope: SCOPE, layers: ['events'], selector: { memory_ids: [target.id, bobs.id] }, cascade: 'redact_events', audit_note: 'tinymemory: forget' },
    });
    expect(r.status).toBe(200);
    expect(r.body.deleted.events).toBe(1);
    expect((await call(`/hippocampus/v1/events?scope=${encodeURIComponent(SCOPE)}&limit=200`)).body.items).toHaveLength(2);
    expect((await call(`/hippocampus/v1/events?scope=${encodeURIComponent(SCOPE)}&limit=200`, { key: 'key-bob' })).body.items).toHaveLength(1);

    // the key is released: the same body stores again as a new event
    const again = await call('/hippocampus/v1/experience', { json: experience('the user prefers short answers') });
    expect(again.status).toBe(202);
    expect(again.body.replayed_from_idempotency).toBe(false);
    expect(again.body.event_id).not.toBe(target.id);
  });

  it('an empty selector without confirm_all is refused, and confirm_all beside a selector is ambiguous', async () => {
    expect((await call('/hippocampus/v1/forget', { json: { scope: SCOPE, selector: {}, cascade: 'redact_events' } })).status).toBe(422);
    expect((await call('/hippocampus/v1/forget', { json: { scope: SCOPE, selector: { memory_ids: ['x'] }, confirm_all: true, cascade: 'redact_events' } })).status).toBe(400);
  });

  it('erasures and scope admin are 404 (the client reads Unsupported / "no registration"), beliefs 404 (read as none)', async () => {
    expect((await call('/hippocampus/v1/erasures', { json: { scope: SCOPE, confirm_all: true } })).status).toBe(404);
    expect((await call('/hippocampus/v1/erasures/e1')).status).toBe(404);
    expect((await call('/hippocampus/v1/scopes', { json: { path: 'org:1' } })).status).toBe(404);
    expect((await call(`/hippocampus/v1/beliefs?scope=${encodeURIComponent(SCOPE)}`)).status).toBe(404);
  });

  it('beliefs/build answers an honest built: 0 so the background job completes instead of failing thrice', async () => {
    const r = await call('/hippocampus/v1/beliefs/build', { json: { scope: SCOPE } });
    expect(r.status).toBe(200);
    expect(r.body.built).toBe(0);
  });

  it('an unknown route under the prefix still needs the key, then 404s', async () => {
    expect((await call('/hippocampus/v1/nothing', { key: 'nope' })).status).toBe(401);
    expect((await call('/hippocampus/v1/nothing')).status).toBe(404);
  });
});

describe('order', () => {
  it('events written in one second come back newest first, in exactly the order they were written', async () => {
    // updated_at has second resolution and row ids were random: a chat's turns came back shuffled.
    const scope = 'agent:alice/order';
    const texts = Array.from({ length: 20 }, (_, i) => `ordered turn ${i}`);
    for (const t of texts) {
      const r = await call('/hippocampus/v1/experience', { json: experience(t, { scope }) });
      expect(r.status).toBe(202);
    }
    const r = await call(`/hippocampus/v1/events?scope=${encodeURIComponent(scope)}&limit=200`);
    expect(r.body.items.map((e: { content: { text: string } }) => e.content.text)).toEqual([...texts].reverse());
  });
});
