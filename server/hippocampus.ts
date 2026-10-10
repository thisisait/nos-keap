/**
 * Hippocampus — KEAP serving the CortexDB "Direct" wire under /hippocampus/v1/*.
 *
 * OpenHuman's memory engine (vendored tinymemory, engine id `cortexdb`) talks to
 * any http(s) endpoint that speaks CortexDB's `/v1/*` routes with a static API
 * key. Pointed at `http://127.0.0.1:<port>/hippocampus`, it stores every memory
 * here as ONE ROW of the `engram` DataTable, written through the ordinary
 * TableStore so the rows show up in the normal tables API.
 *
 * Shapes follow tinymemory's own loopback double (cortex/testing/{routes,log}.rs)
 * — the thing the client is conformance-tested against — not CortexDB's prose.
 * Only the fields the client reads are produced; what it never sends is 404.
 *
 * Auth: KEAP_HIPPOCAMPUS_KEYS="name:key[,name:key]" — a key is the principal
 * `agent:<name>` and every read and write is confined to that agent's rows.
 * These keys open nothing else, and the /agent/v1 tokens open nothing here.
 * Unset or blank → every route (health included) is 503: never open by accident.
 */
import crypto from 'node:crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import * as db from './db';
import { embedText, EMBED_MODEL } from './embeddings';
import { getTable, storeFor } from './tables';
import { bearerOf, tokenEquals } from './tokens';
import type { Principal } from '../shared/contracts/visibility';
import type { RowFilter, TableInfo, TableRow } from '../shared/contracts/table';

export const ENGRAM_TABLE = 'engram';
const PACK_TTL_MS = 60_000;
const PAGE = 500; // the store's listRows ceiling

const fail = (res: Response, status: number, error_code: string, message: string) =>
  res.status(status).json({ error_code, message });

/** `name:key,...` → [name, key][]; read per request so a rotated env is live. */
export function hippocampusKeys(raw = process.env.KEAP_HIPPOCAMPUS_KEYS): Array<[string, string]> {
  return (raw ?? '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf(':');
      return at > 0 ? ([pair.slice(0, at).trim(), pair.slice(at + 1).trim()] as [string, string]) : null;
    })
    .filter((p): p is [string, string] => p !== null && p[0] !== '' && p[1] !== '');
}

interface Req extends Request {
  agent?: string;
  engram?: TableInfo;
}

function auth(req: Req, res: Response, next: NextFunction) {
  const keys = hippocampusKeys();
  if (!keys.length) return fail(res, 503, 'UNAVAILABLE', 'hippocampus not configured');
  const token = bearerOf(req.headers.authorization);
  let agent: string | null = null;
  // Compare against every key so timing does not say which one matched.
  for (const [name, key] of keys) if (token && tokenEquals(token, key)) agent = name;
  if (!agent) return fail(res, 401, 'UNAUTHORIZED', 'invalid API key');
  req.agent = agent;
  next();
}

function needTable(req: Req, res: Response, next: NextFunction) {
  const t = getTable(ENGRAM_TABLE);
  if (!t) return fail(res, 503, 'UNAVAILABLE', 'engram table missing');
  req.engram = t;
  next();
}

// ── rows ↔ events ─────────────────────────────────────────────────────────────

function eventOf(r: TableRow) {
  const v = r.values;
  return {
    id: r.id,
    scope: v.scope,
    modality: v.modality,
    content: { kind: 'message', role: v.role ?? 'user', text: v.text },
    context: {
      labels: Array.isArray(v.labels) ? v.labels : [],
      ...(typeof v.observed_at === 'string' ? { observed_at: v.observed_at } : {}),
      recorded_at: new Date(r.createdAt * 1000).toISOString(),
    },
  };
}

// Time-ordered ids (ms + a per-process counter + random): the store sorts by a per-second
// updated_at, so within one second only the id can say which turn came first.
let seq = 0;
function eventId(now = Date.now()): string {
  seq = (seq + 1) % 0x10000;
  return `evt_${now.toString(16).padStart(12, '0')}${seq.toString(16).padStart(4, '0')}${crypto.randomBytes(4).toString('hex')}`;
}

/** Every row of `agent` matching `filter`, newest first, paging through the store. */
async function rowsOf(t: TableInfo, agent: string, filter: RowFilter[], max = Infinity): Promise<TableRow[]> {
  const store = storeFor(t.driver);
  const out: TableRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listRows(t.id, {
      filter: [{ column: 'agent', op: 'eq', value: agent }, ...filter],
      limit: Math.min(PAGE, max - out.length) || 1,
      cursor,
      expand: [],
    });
    out.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor && out.length < max);
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

const labelled = (r: TableRow, wanted: string[]) =>
  !wanted.length || (Array.isArray(r.values.labels) && r.values.labels.some((l) => wanted.includes(String(l))));

// ── writes ────────────────────────────────────────────────────────────────────

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** One experience → (status, body), with the body idempotency key honoured per agent. */
async function append(t: TableInfo, agent: string, body: Body): Promise<[number, Body]> {
  const content = (body.content ?? {}) as Body;
  const context = (body.context ?? {}) as Body;
  const scope = str(body.scope);
  const text = str(content.text);
  const key = str(body.idempotency_key);
  if (!scope || !text || !key) return [422, { error_code: 'INVALID_ENVELOPE', message: 'scope, idempotency_key and content.text are required' }];
  if (text.length > 1024 * 1024) return [422, { error_code: 'INVALID_ENVELOPE', message: 'text over 1 MiB' }];

  const [held] = await rowsOf(t, agent, [{ column: 'idempotency_key', op: 'eq', value: key }], 1);
  if (held) {
    if (held.values.text !== text) return [409, { error_code: 'IDEMPOTENCY_CONFLICT', message: 'key reused with another body' }];
    return [202, { event_id: held.id, status: 'captured', replayed_from_idempotency: true }];
  }
  const id = eventId();
  const principal = `agent:${agent}` as Principal;
  const row = await storeFor(t.driver).upsertRow(
    t.id,
    id,
    {
      agent,
      scope,
      modality: str(body.modality) ?? 'observation',
      role: str(content.role) ?? 'user',
      text,
      labels: Array.isArray(context.labels) ? context.labels.map(String) : [],
      ...(str(context.observed_at) ? { observed_at: context.observed_at } : {}),
      idempotency_key: key,
    },
    principal,
    { stamp: principal },
  );
  return [202, { event_id: row.id, status: 'captured', replayed_from_idempotency: false }];
}

// ── recall ────────────────────────────────────────────────────────────────────

const packs = new Map<string, { agent: string; events: ReturnType<typeof eventOf>[]; at: number }>();

const words = (q: string) =>
  q
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase())
    .filter((w) => w.length >= 3);

/**
 * Rank the scope's rows for `query`: the vector leg first (the same ANN read
 * agent-table-search uses, over the row objects a projected engram table has),
 * then lexical word overlap to fill. Lexical alone when no embedder is wired.
 * ponytail: row projection is capped at ROW_OBJECT_CAP rows, so past it the
 * vector leg is blind and this degrades to lexical; a per-row vector column
 * (TableStore.capabilities.vectorColumns) is the upgrade path.
 */
async function rank(t: TableInfo, rows: TableRow[], query: string, limit: number): Promise<TableRow[]> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked: TableRow[] = [];
  const vec = query.trim() ? await embedText(query) : null;
  if (vec) {
    const prefix = `table-${t.id}:row-`;
    for (const n of db.vectorNeighborsOf(JSON.stringify(vec), 'related', ['object'], limit * 4, undefined, EMBED_MODEL)) {
      if (!n.refId.startsWith(prefix)) continue;
      const rowId = db.getObject(n.refId)?.frontmatter?.row;
      const row = typeof rowId === 'string' ? byId.get(rowId) : undefined;
      if (row && !picked.includes(row)) picked.push(row);
    }
  }
  const terms = words(query);
  const scored = rows
    .filter((r) => !picked.includes(r))
    .map((r) => {
      const text = String(r.values.text ?? '').toLowerCase();
      return { r, score: terms.filter((w) => text.includes(w)).length };
    })
    .filter((s) => !terms.length || s.score > 0)
    .sort((a, b) => b.score - a.score);
  return [...picked, ...scored.map((s) => s.r)].slice(0, limit);
}

// ── routes ────────────────────────────────────────────────────────────────────

export function registerHippocampusRoutes(app: Express): void {
  const r = express.Router();
  // Events can be 768 KiB each and a bulk carries several; the app-wide 2 MB cap is too small.
  r.use(express.json({ limit: '32mb' }));
  r.use(auth);

  r.get('/v1/auth/whoami', (req: Req, res) => res.json({ caller: `agent:${req.agent}` }));
  r.get('/v1/admin/version', (_req, res) => res.json({ version: 'keap-hippocampus/1', capabilities: [] }));
  r.get('/v1/admin/health', needTable, (_req, res) => res.json({ status: 'healthy' }));

  r.post('/v1/experience', needTable, async (req: Req, res) => {
    const [status, body] = await append(req.engram!, req.agent!, req.body ?? {});
    res.status(status).json(body);
  });

  r.post('/v1/experience/bulk', needTable, async (req: Req, res) => {
    const items = Array.isArray(req.body?.items) ? (req.body.items as Body[]) : [];
    const results: Body[] = [];
    for (const [index, item] of items.entries()) {
      const [status, body] = await append(req.engram!, req.agent!, item);
      if (status >= 300) return res.status(status).json(body);
      results.push({ index, event_id: body.event_id, replayed_from_idempotency: body.replayed_from_idempotency });
    }
    res.json({ accepted: results.length, results });
  });

  r.get('/v1/events', needTable, async (req: Req, res) => {
    const scope = String(req.query.scope ?? '');
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), PAGE);
    const offset = Math.max(Number(req.query.cursor) || 0, 0);
    const wanted = String(req.query.labels ?? '').split(',').map((l) => l.trim()).filter(Boolean);
    const all = (await rowsOf(req.engram!, req.agent!, [{ column: 'scope', op: 'eq', value: scope }])).filter((row) => labelled(row, wanted));
    const page = all.slice(offset, offset + limit);
    const next = offset + page.length;
    res.json({ items: page.map(eventOf), has_more: next < all.length, next_cursor: String(next) });
  });

  r.post('/v1/recall', needTable, async (req: Req, res) => {
    const body = (req.body ?? {}) as Body;
    const scope = str(body.scope) ?? '';
    const wanted = ((body as { filters?: { metadata?: { labels?: unknown[] } } }).filters?.metadata?.labels ?? []).map(String);
    const budget = Number((body as { budgets?: { per_layer_limits?: { events?: number } } }).budgets?.per_layer_limits?.events ?? 30);
    const rows = (await rowsOf(req.engram!, req.agent!, [{ column: 'scope', op: 'eq', value: scope }])).filter((row) => labelled(row, wanted));
    const events = (await rank(req.engram!, rows, str(body.query) ?? '', Math.max(budget, 0))).map(eventOf);
    const pack_id = `pack_${crypto.randomBytes(8).toString('hex')}`;
    for (const [id, p] of packs) if (Date.now() - p.at > PACK_TTL_MS) packs.delete(id);
    packs.set(pack_id, { agent: req.agent!, events, at: Date.now() });
    res.json({ pack_id, layers: { events, beliefs: [] } });
  });

  // No model runs here: the answer QUOTES the pack's best events (as tinymemory's
  // own ReferenceEngine does), so the agent's `recall` tool and compaction get
  // grounded text instead of a hard error.
  r.post('/v1/answer', needTable, (req: Req, res) => {
    const pack = packs.get(String(req.body?.use_pack_id ?? ''));
    if (!pack || pack.agent !== req.agent || Date.now() - pack.at > PACK_TTL_MS) return fail(res, 404, 'NOT_FOUND', 'pack expired');
    const answer = pack.events.slice(0, 3).map((e) => e.content.text).join('\n\n');
    res.json({ answer, citations: [], diagnostics: { answer_model: 'hippocampus-quote' } });
  });

  r.post('/v1/forget', needTable, async (req: Req, res) => {
    const body = (req.body ?? {}) as Body;
    const scope = str(body.scope) ?? '';
    const ids = ((body.selector as Body | undefined)?.memory_ids as unknown[] | undefined)?.map(String) ?? [];
    const confirmAll = body.confirm_all === true;
    const cascade = body.cascade === undefined ? 'derived_only' : body.cascade;
    if (cascade !== 'derived_only' && cascade !== 'redact_events') return fail(res, 400, 'INVALID_CASCADE', 'cascade must be derived_only or redact_events');
    if (ids.length && confirmAll) return fail(res, 400, 'AMBIGUOUS_SELECTOR_CONFIRM_ALL', 'selector beside confirm_all');
    if (!ids.length && !confirmAll) return fail(res, 422, 'EMPTY_SELECTOR_WITHOUT_CONFIRMATION', 'an empty selector needs confirm_all');
    if (cascade === 'derived_only') return res.json({ deleted: { events: 0 }, requested: ids.length }); // nothing derived lives here
    const mine = await rowsOf(req.engram!, req.agent!, [{ column: 'scope', op: 'eq', value: scope }]);
    const gone = ids.length ? mine.filter((row) => ids.includes(row.id)) : mine;
    const store = storeFor(req.engram!.driver);
    for (const row of gone) await store.deleteRow(req.engram!.id, row.id, `agent:${req.agent}`);
    res.json({ deleted: { events: gone.length }, requested: ids.length });
  });

  r.get('/v1/scopes/list', needTable, async (req: Req, res) => {
    const prefix = String(req.query.prefix ?? '');
    const limit = Math.min(Number(req.query.limit) || 50, 1000);
    const groups = await storeFor(req.engram!.driver).aggregate(req.engram!.id, {
      dimensions: ['scope'],
      measures: [{ fn: 'count', column: 'scope' }],
      filter: [{ column: 'agent', op: 'eq', value: req.agent! }],
      limit: 1000,
    });
    const items = groups
      .map((g) => String(g.scope))
      .filter((s) => !prefix || s === prefix || s.startsWith(`${prefix}/`))
      .sort()
      .slice(0, limit)
      .map((path) => ({ path }));
    res.json({ items });
  });

  // Beliefs are a derived layer this store does not build: an honest zero lets the
  // client's background job complete instead of failing three times.
  r.post('/v1/beliefs/build', needTable, (_req, res) => res.json({ built: 0, items: [], facts_scanned: 0, events_scanned: 0 }));

  // Everything else the engine might send (GET v1/beliefs, v1/erasures, scope
  // registration) is a capability gap on the client: 404 reads as "none"/Unsupported.
  r.use((_req, res) => fail(res, 404, 'NOT_FOUND', 'no such route'));

  app.use('/hippocampus', r);
}
