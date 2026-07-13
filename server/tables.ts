/**
 * TableStore — the storage abstraction behind data tables (Track R2′).
 *
 * One contract (shared/contracts/table.ts), many drivers. Each driver
 * declares CAPABILITIES; the UI and API render only what the chosen storage
 * offers. This file ships the first driver:
 *
 *   libsql   — rows as JSON blobs next to the registry. Transactions,
 *              append-only row history (the "events" seed), and GROUP-BY
 *              aggregation via json_extract — a SharePoint-list that can
 *              already answer small OLAP slices.
 *
 * Planned drivers (same interface): rustfs (S3 snapshots + object
 * versioning; parquet → the DuckDB/OLAP path), postgres (triggers/routines),
 * grist (full editor UI).
 *
 * Every table also lives as a knowledge_object card (type 'table', resource
 * `keaptable:<id>`, frontmatter = schema card) — so tables are searchable
 * (S4), embeddable, OKF-exportable and anchorable into the universe like any
 * other datapoint. The card is derived state: this module owns the sync.
 */
import crypto from 'node:crypto';
import * as db from './db';
import { markCorpusDirty } from './search';
import { extractRefs } from './objects';
import { rustfsStore } from './tables-rustfs';
import {
  tierRank,
  visibilityGrantsRead,
  readableVisibilities,
  type TableVisibility,
} from './rbac';

type ObjectRefLike = { kind: string; ref: string };
import {
  type TableSchema,
  type TableCapabilities,
  type TableDriver,
  type TableInfo,
  type TableRow,
  type ListRowsQuery,
  type AggregateQuery,
  type RowFilter,
  type CreateTableRequest,
  validateRowValues,
} from '../shared/contracts/table';

/** All methods are async — network-backed drivers (rustfs/postgres/grist)
 *  need it, the libsql driver just resolves synchronously. */
export interface TableStore {
  driver: TableDriver;
  capabilities: TableCapabilities;
  /** false when the driver's backing service isn't configured/reachable. */
  available(): boolean;
  createTable(ownerId: string, req: CreateTableRequest): Promise<TableInfo>;
  dropTable(id: string): Promise<void>;
  listRows(id: string, q: ListRowsQuery): Promise<{ rows: TableRow[]; nextCursor?: string }>;
  upsertRow(
    id: string,
    rowId: string | undefined,
    values: Record<string, unknown>,
    actor: string,
  ): Promise<TableRow>;
  deleteRow(id: string, rowId: string, actor: string): Promise<void>;
  rowHistory(id: string, rowId: string, limit: number): Promise<unknown[]>;
  aggregate(id: string, q: AggregateQuery): Promise<Array<Record<string, unknown>>>;
}

// ── Registry (driver-independent) ─────────────────────────────────────────────

export function mapTable(row: any): Omit<TableInfo, 'capabilities'> {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    driver: row.driver,
    schema: JSON.parse(row.schema_json),
    ownerId: row.user_id,
    visibility: row.visibility,
    rowCount: row.row_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The identity fields table access decisions need (subset of KeapUser). */
export interface TableActor {
  id: string;
  isAdmin: boolean;
  groups: string[];
}

export function listTables(actor: TableActor): TableInfo[] {
  const d = db.getDb();
  if (actor.isAdmin) {
    const rows = d.prepare('SELECT * FROM data_tables ORDER BY updated_at DESC').all();
    return (rows as any[]).map((r) => withCapabilities(mapTable(r)));
  }
  // Own tables OR any visibility scope the caller's tier is allowed to read
  // ('shared' is always in the list, so the IN() is never empty).
  const vis = readableVisibilities(tierRank(actor.groups));
  const placeholders = vis.map(() => '?').join(',');
  const rows = d
    .prepare(
      `SELECT * FROM data_tables WHERE user_id = ? OR visibility IN (${placeholders}) ORDER BY updated_at DESC`,
    )
    .all(actor.id, ...vis);
  return (rows as any[]).map((r) => withCapabilities(mapTable(r)));
}

export function getTable(id: string): TableInfo | null {
  const row = db.getDb().prepare('SELECT * FROM data_tables WHERE id = ?').get(id) as any;
  return row ? withCapabilities(mapTable(row)) : null;
}

export function canReadTable(t: TableInfo, actor: TableActor): boolean {
  if (actor.isAdmin || t.ownerId === actor.id) return true;
  return visibilityGrantsRead(t.visibility, tierRank(actor.groups));
}

/** Owner-or-admin — the write/delete gate (tiers govern read, not write). */
export function canWriteTable(t: TableInfo, actor: TableActor): boolean {
  return actor.isAdmin || t.ownerId === actor.id;
}

/** Persist a visibility change (owner/admin only — enforced at the route). */
export function updateTableVisibility(id: string, visibility: TableVisibility): void {
  db.getDb()
    .prepare("UPDATE data_tables SET visibility = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(visibility, id);
}

/**
 * Row ids reach a RustFS object key (`tables/<id>/rows/<rowId>.json`) that is
 * parsed as a URL — a `/`, `.` or `%` in a caller-supplied id lets `..`
 * traverse out of the table (cross-table, or out of the bucket entirely).
 * Every route that takes a caller-supplied row id MUST pass it through here
 * before the driver sees it. Generated ids are UUIDs, which pass.
 */
const SAFE_ROW_ID = /^[A-Za-z0-9_-]{1,128}$/;
export function assertRowId(rowId: string): string {
  if (!SAFE_ROW_ID.test(rowId)) throw new Error('invalid row id');
  return rowId;
}

function withCapabilities(t: Omit<TableInfo, 'capabilities'>): TableInfo {
  return { ...t, capabilities: storeFor(t.driver).capabilities };
}

export function storeFor(driver: TableDriver): TableStore {
  if (driver === 'libsql') return libsqlStore;
  if (driver === 'rustfs') return rustfsStore;
  throw new Error(`table driver not available yet: ${driver}`);
}

/** Storage picker data: which drivers this deployment can actually offer. */
export function listDrivers(): Array<{
  driver: TableDriver;
  available: boolean;
  capabilities: TableCapabilities;
}> {
  return (['libsql', 'rustfs'] as TableDriver[]).map((d) => {
    const s = storeFor(d);
    return { driver: d, available: s.available(), capabilities: s.capabilities };
  });
}

// ── Card sync: the table's knowledge_object index card ───────────────────────

export function syncCard(t: Omit<TableInfo, 'capabilities'>, anchors: string[] = []): void {
  // Re-syncs (row-count bumps) must not lose the anchors the card already
  // has — merge them in from the existing card's extracted links.
  const existing = db.getObject(`table-${t.id}`);
  const prior = ((existing?.links ?? []) as ObjectRefLike[])
    .filter((l) => l.kind === 'node')
    .map((l) => l.ref);
  const merged = [...new Set([...prior, ...anchors])];
  const anchorBody = merged.map((a) => `[[${a}]]`).join(' ');
  const columnLine = t.schema.columns
    .map((c) => `${c.label} (${c.kind}${c.role !== 'attribute' ? `, ${c.role}` : ''})`)
    .join(' · ');
  const body = [anchorBody, `Columns: ${columnLine}`].filter(Boolean).join('\n\n');
  db.saveObject(t.ownerId, {
    id: `table-${t.id}`,
    type: 'table',
    title: t.title,
    description: t.description,
    resource: `keaptable:${t.id}`,
    frontmatter: {
      storage: { driver: t.driver },
      columns: t.schema.columns.map(({ key, label, kind, role, unit }) => ({ key, label, kind, role, unit })),
      rowCount: t.rowCount,
    },
    body,
    links: extractRefs(body, `keaptable:${t.id}`),
    visibility: t.visibility,
  });
  markCorpusDirty();
}

// ── libsql driver ─────────────────────────────────────────────────────────────

const FILTER_SQL: Record<RowFilter['op'], string> = {
  eq: '=',
  neq: '!=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  contains: 'LIKE',
};

/** WHERE fragment over json_extract'd columns. Column keys are validated
 *  against the schema BEFORE this runs — never raw user input. */
export function filterClause(schema: TableSchema, filters: RowFilter[]): { sql: string; params: unknown[] } {
  const keys = new Set(schema.columns.map((c) => c.key));
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    if (!keys.has(f.column)) throw new Error(`unknown filter column: ${f.column}`);
    const col = schema.columns.find((c) => c.key === f.column)!;
    const extract = `json_extract(data, '$.${f.column}')`;
    if (f.op === 'contains') {
      parts.push(`${extract} LIKE ?`);
      params.push(`%${String(f.value)}%`);
    } else if (col.kind === 'number' || col.kind === 'date') {
      parts.push(`CAST(${extract} AS REAL) ${FILTER_SQL[f.op]} ?`);
      params.push(Number(f.value));
    } else {
      parts.push(`${extract} ${FILTER_SQL[f.op]} ?`);
      params.push(f.value);
    }
  }
  return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

function mapRow(r: any): TableRow {
  return {
    id: r.row_id,
    values: JSON.parse(r.data),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function refreshRowCount(tableId: string): number {
  const d = db.getDb();
  const c = (d.prepare('SELECT COUNT(*) AS c FROM table_rows WHERE table_id = ?').get(tableId) as any).c;
  d.prepare("UPDATE data_tables SET row_count = ?, updated_at = strftime('%s','now') WHERE id = ?").run(
    c,
    tableId,
  );
  return c;
}

const libsqlStore: TableStore = {
  driver: 'libsql',

  available: () => true,
  capabilities: {
    transactions: true,
    rowHistory: true,
    aggregate: true,
    vectorColumns: true, // stored + validated; ANN over row vectors is future work
    objectVersioning: false,
    events: true, // append-only history IS the event log (consumers poll it)
  },

  async createTable(ownerId, req) {
    const id = req.id ?? crypto.randomUUID();
    db.getDb()
      .prepare(
        `INSERT INTO data_tables (id, user_id, title, description, driver, schema_json, visibility)
         VALUES (?, ?, ?, ?, 'libsql', ?, ?)`,
      )
      .run(id, ownerId, req.title, req.description ?? null, JSON.stringify(req.schema), req.visibility);
    const t = getTable(id)!;
    syncCard(t, req.anchors);
    return t;
  },

  async dropTable(id) {
    const d = db.getDb();
    const tx = d.transaction(() => {
      d.prepare('DELETE FROM table_rows WHERE table_id = ?').run(id);
      d.prepare('DELETE FROM table_row_history WHERE table_id = ?').run(id);
      d.prepare('DELETE FROM data_tables WHERE id = ?').run(id);
    });
    tx();
    db.deleteObject(`table-${id}`);
    markCorpusDirty();
  },

  async listRows(id, q) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    const { sql, params } = filterClause(t.schema, q.filter);
    const keys = new Set(t.schema.columns.map((c) => c.key));
    let order = 'ORDER BY updated_at DESC, row_id';
    if (q.sort) {
      if (!keys.has(q.sort.column)) throw new Error(`unknown sort column: ${q.sort.column}`);
      order = `ORDER BY json_extract(data, '$.${q.sort.column}') ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}, row_id`;
    }
    const offset = q.cursor ? Number(q.cursor) || 0 : 0;
    const rows = db
      .getDb()
      .prepare(`SELECT * FROM table_rows WHERE table_id = ? ${sql} ${order} LIMIT ? OFFSET ?`)
      .all(id, ...params, q.limit + 1, offset) as any[];
    const page = rows.slice(0, q.limit).map(mapRow);
    return {
      rows: page,
      nextCursor: rows.length > q.limit ? String(offset + q.limit) : undefined,
    };
  },

  async upsertRow(id, rowId, values, actor) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    const rid = rowId ?? crypto.randomUUID();
    const d = db.getDb();
    const tx = d.transaction(() => {
      const existing = d
        .prepare('SELECT data FROM table_rows WHERE table_id = ? AND row_id = ?')
        .get(id, rid) as any;
      // Upsert semantics: PATCH an existing row (merge keys), insert otherwise.
      // Validation runs on the MERGED result — a patch of one cell must not
      // trip over required columns it didn't touch.
      const merged = existing ? { ...JSON.parse(existing.data), ...values } : values;
      const errors = validateRowValues(t.schema, merged);
      if (errors.length) throw new Error(`invalid row: ${errors.join('; ')}`);
      d.prepare(
        `INSERT INTO table_rows (table_id, row_id, data, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(table_id, row_id) DO UPDATE SET
           data = excluded.data,
           updated_at = strftime('%s','now'),
           updated_by = excluded.updated_by`,
      ).run(id, rid, JSON.stringify(merged), actor);
      d.prepare(
        'INSERT INTO table_row_history (table_id, row_id, op, data, actor) VALUES (?, ?, ?, ?, ?)',
      ).run(id, rid, existing ? 'update' : 'insert', JSON.stringify(merged), actor);
    });
    tx();
    const rowCount = refreshRowCount(id);
    syncCard({ ...t, rowCount });
    const saved = d.prepare('SELECT * FROM table_rows WHERE table_id = ? AND row_id = ?').get(id, rid);
    return mapRow(saved);
  },

  async deleteRow(id, rowId, actor) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    const d = db.getDb();
    const tx = d.transaction(() => {
      d.prepare('DELETE FROM table_rows WHERE table_id = ? AND row_id = ?').run(id, rowId);
      d.prepare(
        'INSERT INTO table_row_history (table_id, row_id, op, data, actor) VALUES (?, ?, ?, NULL, ?)',
      ).run(id, rowId, 'delete', actor);
    });
    tx();
    const rowCount = refreshRowCount(id);
    syncCard({ ...t, rowCount });
  },

  async rowHistory(id, rowId, limit) {
    return db
      .getDb()
      .prepare(
        'SELECT op, data, actor, at FROM table_row_history WHERE table_id = ? AND row_id = ? ORDER BY at DESC, id DESC LIMIT ?',
      )
      .all(id, rowId, limit)
      .map((r: any) => ({ op: r.op, values: r.data ? JSON.parse(r.data) : null, actor: r.actor, at: r.at }));
  },

  async aggregate(id, q) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    const byKey = new Map(t.schema.columns.map((c) => [c.key, c]));
    for (const dcol of q.dimensions) {
      if (!byKey.has(dcol)) throw new Error(`unknown dimension: ${dcol}`);
    }
    for (const m of q.measures) {
      const col = byKey.get(m.column);
      if (!col) throw new Error(`unknown measure: ${m.column}`);
      if (m.fn !== 'count' && col.kind !== 'number' && col.kind !== 'date')
        throw new Error(`${m.fn}(${m.column}) needs a numeric column`);
    }
    const dims = q.dimensions.map((k) => `json_extract(data, '$.${k}') AS ${k}`);
    const measures = q.measures.map((m, i) =>
      m.fn === 'count'
        ? `COUNT(*) AS m${i}`
        : `${m.fn.toUpperCase()}(CAST(json_extract(data, '$.${m.column}') AS REAL)) AS m${i}`,
    );
    const { sql, params } = filterClause(t.schema, q.filter);
    const groupBy = q.dimensions.length
      ? `GROUP BY ${q.dimensions.map((k) => `json_extract(data, '$.${k}')`).join(', ')}`
      : '';
    const rows = db
      .getDb()
      .prepare(
        `SELECT ${[...dims, ...measures].join(', ')}
         FROM table_rows WHERE table_id = ? ${sql} ${groupBy} LIMIT ?`,
      )
      .all(id, ...params, q.limit) as any[];
    // Rename mN back to "<fn>_<column>" for readable payloads.
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const k of q.dimensions) out[k] = r[k];
      q.measures.forEach((m, i) => {
        out[`${m.fn}_${m.column}`] = r[`m${i}`];
      });
      return out;
    });
  },
};
