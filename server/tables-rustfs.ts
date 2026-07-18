/**
 * RustFS TableStore driver — rows as S3 objects (Track R2′, driver #2).
 *
 * Layout in the bucket (KEAP_RUSTFS_BUCKET, default "keap-tables"):
 *   tables/<tableId>/schema.json          — portable copy of the schema card
 *   tables/<tableId>/rows/<rowId>.json    — one object per row
 *
 * What this storage buys (the picker's honest pitch):
 *   - OBJECT VERSIONING: bucket versioning is enabled on first use; row
 *     history = ListObjectVersions, no history table needed.
 *   - lifecycle routines / replication belong to the object store, not KEAP.
 *   - the parquet/DuckDB OLAP-cube path starts here (same bucket, S6).
 * What it costs: no transactions; filter/sort/aggregate run in-memory over a
 * bounded scan (SCAN_CAP) — honest for personal-scale lists, and the future
 * DuckDB leg takes over when tables outgrow it.
 *
 * Auth: SigV4 via aws4fetch (6 kB), path-style addressing (RustFS/MinIO).
 * The registry row + knowledge-object card stay in libSQL — the bucket holds
 * only the DATA, so `/api/tables` listing works even when RustFS is down.
 */
import crypto from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import * as db from './db';
import {
  type TableStore,
  getTable,
  mapTable,
  syncCard,
} from './tables';
import {
  type TableInfo,
  type TableRow,
  type RowFilter,
  validateRowValues,
} from '../shared/contracts/table';

const ENDPOINT = (process.env.KEAP_RUSTFS_ENDPOINT ?? '').replace(/\/$/, '');
const ACCESS_KEY = process.env.KEAP_RUSTFS_ACCESS_KEY ?? '';
const SECRET_KEY = process.env.KEAP_RUSTFS_SECRET_KEY ?? '';
const BUCKET = process.env.KEAP_RUSTFS_BUCKET ?? 'keap-tables';

const SCAN_CAP = 2000; // filtered/sorted list scans at most this many rows
const AGG_CAP = 10000; // aggregate scans at most this many rows
const TIMEOUT = 10_000;

let aws: AwsClient | null = null;
function client(): AwsClient {
  if (!aws) {
    aws = new AwsClient({
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: 'us-east-1',
      service: 's3',
    });
  }
  return aws;
}

function url(key: string, query = ''): string {
  return `${ENDPOINT}/${BUCKET}/${key}${query}`;
}

async function s3(method: string, key: string, query = '', body?: string): Promise<Response> {
  return client().fetch(url(key, query), {
    method,
    body,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

let bucketReady = false;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  // Create-if-missing, then best-effort enable versioning (row history).
  const put = await client().fetch(`${ENDPOINT}/${BUCKET}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!put.ok && put.status !== 409) {
    const text = await put.text();
    if (!text.includes('BucketAlreadyOwnedByYou') && !text.includes('BucketAlreadyExists')) {
      throw new Error(`rustfs bucket create failed (${put.status})`);
    }
  }
  await client()
    .fetch(`${ENDPOINT}/${BUCKET}?versioning`, {
      method: 'PUT',
      body: '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
      signal: AbortSignal.timeout(TIMEOUT),
    })
    .catch(() => undefined); // versioning unsupported → history just returns []
  bucketReady = true;
}

// ── Minimal XML picking (keys are uuid paths — regex is safe here) ───────────

function pick(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);
}

async function listKeys(
  prefix: string,
  maxKeys: number,
  token?: string,
): Promise<{ keys: string[]; nextToken?: string }> {
  const q =
    `?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}` +
    (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
  const res = await client().fetch(`${ENDPOINT}/${BUCKET}${q}`, {
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`rustfs list failed (${res.status})`);
  const xml = await res.text();
  return {
    keys: pick(xml, 'Key'),
    nextToken: pick(xml, 'IsTruncated')[0] === 'true' ? pick(xml, 'NextContinuationToken')[0] : undefined,
  };
}

interface StoredRow {
  values: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

async function getRow(tableId: string, rowId: string): Promise<StoredRow | null> {
  const res = await s3('GET', `tables/${tableId}/rows/${rowId}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`rustfs get failed (${res.status})`);
  return (await res.json()) as StoredRow;
}

function rowIdOfKey(key: string): string {
  return key.split('/').pop()!.replace(/\.json$/, '');
}

async function fetchRows(tableId: string, keys: string[]): Promise<TableRow[]> {
  const out: TableRow[] = [];
  const BATCH = 25;
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = await Promise.all(
      keys.slice(i, i + BATCH).map(async (k) => {
        const r = await getRow(tableId, rowIdOfKey(k));
        return r ? { id: rowIdOfKey(k), ...r } : null;
      }),
    );
    for (const r of chunk) if (r) out.push({ id: r.id, values: r.values, createdAt: r.createdAt, updatedAt: r.updatedAt, updatedBy: r.updatedBy });
  }
  return out;
}

/** Bounded full scan — the in-memory leg behind filter/sort/aggregate. */
async function scanRows(tableId: string, cap: number): Promise<TableRow[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await listKeys(`tables/${tableId}/rows/`, Math.min(1000, cap - keys.length), token);
    keys.push(...page.keys);
    token = page.nextToken;
  } while (token && keys.length < cap);
  return fetchRows(tableId, keys.slice(0, cap));
}

function matches(values: Record<string, unknown>, f: RowFilter): boolean {
  const v = values[f.column];
  switch (f.op) {
    case 'eq':
      return v === f.value;
    case 'neq':
      return v !== f.value;
    case 'lt':
      return Number(v) < Number(f.value);
    case 'lte':
      return Number(v) <= Number(f.value);
    case 'gt':
      return Number(v) > Number(f.value);
    case 'gte':
      return Number(v) >= Number(f.value);
    case 'contains':
      return String(v ?? '').toLowerCase().includes(String(f.value).toLowerCase());
  }
}

function bumpRowCount(tableId: string, delta: number): Omit<TableInfo, 'capabilities'> {
  const d = db.getDb();
  d.prepare(
    "UPDATE data_tables SET row_count = MAX(row_count + ?, 0), updated_at = strftime('%s','now') WHERE id = ?",
  ).run(delta, tableId);
  return mapTable(d.prepare('SELECT * FROM data_tables WHERE id = ?').get(tableId));
}

export const rustfsStore: TableStore = {
  driver: 'rustfs',
  capabilities: {
    transactions: false,
    rowHistory: true, // via S3 object versions (empty when versioning unsupported)
    aggregate: true, // in-memory over a bounded scan
    vectorColumns: true,
    objectVersioning: true,
    events: false, // bucket notifications are a future nOS-side hookup
  },

  available: () => Boolean(ENDPOINT && ACCESS_KEY && SECRET_KEY),

  async createTable(ownerId, req) {
    if (!this.available()) throw new Error('rustfs driver not configured (KEAP_RUSTFS_*)');
    await ensureBucket();
    const id = req.id ?? crypto.randomUUID();
    db.getDb()
      .prepare(
        `INSERT INTO data_tables (id, user_id, title, description, driver, schema_json, visibility)
         VALUES (?, ?, ?, ?, 'rustfs', ?, ?)`,
      )
      .run(id, ownerId, req.title, req.description ?? null, JSON.stringify(req.schema), req.visibility);
    const put = await s3('PUT', `tables/${id}/schema.json`, '', JSON.stringify(req.schema));
    if (!put.ok) {
      db.getDb().prepare('DELETE FROM data_tables WHERE id = ?').run(id);
      throw new Error(`rustfs schema write failed (${put.status})`);
    }
    const t = getTable(id)!;
    syncCard(t, req.anchors);
    return t;
  },

  async dropTable(id) {
    let token: string | undefined;
    do {
      const page = await listKeys(`tables/${id}/`, 1000, token);
      for (const k of page.keys) await s3('DELETE', k);
      token = page.nextToken;
    } while (token);
    db.getDb().prepare('DELETE FROM data_tables WHERE id = ?').run(id);
    db.deleteObject(`table-${id}`);
  },

  async listRows(id, q) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    if (!q.filter.length && !q.sort) {
      // Fast path: page straight off the object listing.
      const page = await listKeys(`tables/${id}/rows/`, q.limit, q.cursor || undefined);
      return { rows: await fetchRows(id, page.keys), nextCursor: page.nextToken };
    }
    // Filter/sort need the scan leg (bounded, documented).
    const all = await scanRows(id, SCAN_CAP);
    let rows = all.filter((r) => q.filter.every((f) => matches(r.values, f)));
    if (q.sort) {
      const { column, dir } = q.sort;
      rows = rows.sort((a, b) => {
        // Cells are JSON scalars for sortable columns; keep JS `<` semantics.
        const av = a.values[column] as string | number | null | undefined;
        const bv = b.values[column] as string | number | null | undefined;
        const cmp =
          av === bv ? 0 : av === undefined || av === null || av < (bv as string | number) ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    const offset = q.cursor ? Number(q.cursor) || 0 : 0;
    return {
      rows: rows.slice(offset, offset + q.limit),
      nextCursor: rows.length > offset + q.limit ? String(offset + q.limit) : undefined,
    };
  },

  async upsertRow(id, rowId, values, actor) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    await ensureBucket();
    const rid = rowId ?? crypto.randomUUID();
    const existing = await getRow(id, rid);
    const merged = existing ? { ...existing.values, ...values } : values;
    const errors = validateRowValues(t.schema, merged);
    if (errors.length) throw new Error(`invalid row: ${errors.join('; ')}`);
    const now = Math.floor(Date.now() / 1000);
    const stored: StoredRow = {
      values: merged,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: actor,
    };
    const put = await s3('PUT', `tables/${id}/rows/${rid}.json`, '', JSON.stringify(stored));
    if (!put.ok) throw new Error(`rustfs write failed (${put.status})`);
    const reg = existing ? mapTable(db.getDb().prepare('SELECT * FROM data_tables WHERE id = ?').get(id)) : bumpRowCount(id, 1);
    syncCard(reg);
    return { id: rid, ...stored };
  },

  async deleteRow(id, rowId, _actor) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    const res = await s3('DELETE', `tables/${id}/rows/${rowId}.json`);
    if (!res.ok && res.status !== 404) throw new Error(`rustfs delete failed (${res.status})`);
    syncCard(bumpRowCount(id, -1));
  },

  async rowHistory(id, rowId, limit) {
    const key = `tables/${id}/rows/${rowId}.json`;
    const res = await client().fetch(
      `${ENDPOINT}/${BUCKET}?versions&prefix=${encodeURIComponent(key)}&max-keys=${limit}`,
      { signal: AbortSignal.timeout(TIMEOUT) },
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const versionIds = pick(xml, 'VersionId');
    const stamps = pick(xml, 'LastModified');
    const out: unknown[] = [];
    for (let i = 0; i < Math.min(versionIds.length, limit); i++) {
      const v = await client().fetch(url(key, `?versionId=${encodeURIComponent(versionIds[i])}`), {
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!v.ok) continue;
      const body = (await v.json().catch(() => null)) as StoredRow | null;
      out.push({
        op: i === 0 ? 'current' : 'version',
        values: body?.values ?? null,
        actor: body?.updatedBy ?? 'unknown',
        at: body?.updatedAt ?? Math.floor(new Date(stamps[i] ?? 0).getTime() / 1000),
      });
    }
    return out;
  },

  async aggregate(id, q) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    const byKey = new Map(t.schema.columns.map((c) => [c.key, c]));
    for (const dcol of q.dimensions) if (!byKey.has(dcol)) throw new Error(`unknown dimension: ${dcol}`);
    for (const m of q.measures) {
      const col = byKey.get(m.column);
      if (!col) throw new Error(`unknown measure: ${m.column}`);
      if (m.fn !== 'count' && col.kind !== 'number' && col.kind !== 'date')
        throw new Error(`${m.fn}(${m.column}) needs a numeric column`);
    }
    const all = (await scanRows(id, AGG_CAP)).filter((r) => q.filter.every((f) => matches(r.values, f)));
    const groups = new Map<string, TableRow[]>();
    for (const r of all) {
      const k = q.dimensions.map((dcol) => String(r.values[dcol] ?? '')).join(' ');
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    const out: Array<Record<string, unknown>> = [];
    for (const rows of groups.values()) {
      const row: Record<string, unknown> = {};
      q.dimensions.forEach((dcol) => {
        row[dcol] = rows[0].values[dcol] ?? null;
      });
      for (const m of q.measures) {
        const nums = rows.map((r) => Number(r.values[m.column])).filter((n) => !Number.isNaN(n));
        row[`${m.fn}_${m.column}`] =
          m.fn === 'count'
            ? rows.length
            : m.fn === 'sum'
              ? nums.reduce((a, b) => a + b, 0)
              : m.fn === 'avg'
                ? nums.length
                  ? nums.reduce((a, b) => a + b, 0) / nums.length
                  : null
                : m.fn === 'min'
                  ? nums.length
                    ? Math.min(...nums)
                    : null
                  : nums.length
                    ? Math.max(...nums)
                    : null;
      }
      out.push(row);
      if (out.length >= q.limit) break;
    }
    return out;
  },
};
