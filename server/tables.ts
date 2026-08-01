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
  type GraphMeta,
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

/** Raw data_tables row — snake_case DB columns before mapping. */
export interface DataTableDbRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  driver: TableDriver;
  schema_json: string;
  visibility: TableInfo['visibility'];
  row_count: number;
  created_at: number;
  updated_at: number;
}

/** Param stays `unknown` (not the row interface) because callers hand over
 *  driver `.get()` results directly — the cast to the row shape lives here. */
export function mapTable(row: unknown): Omit<TableInfo, 'capabilities'> {
  const r = row as DataTableDbRow;
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    driver: r.driver,
    schema: JSON.parse(r.schema_json),
    ownerId: r.user_id,
    visibility: r.visibility,
    rowCount: r.row_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
    return (rows as DataTableDbRow[]).map((r) => withCapabilities(mapTable(r)));
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
  return (rows as DataTableDbRow[]).map((r) => withCapabilities(mapTable(r)));
}

export function getTable(id: string): TableInfo | null {
  const row = db.getDb().prepare('SELECT * FROM data_tables WHERE id = ?').get(id) as
    | DataTableDbRow
    | undefined;
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

/**
 * Reconcile a table's COLUMN SCHEMA — the write path `data_tables.schema_json`
 * did not have.
 *
 * Until this existed there was exactly one writer of `schema_json` (the INSERT
 * in `createTable`) and no UPDATE of it anywhere, so a table's columns were
 * immutable for its whole lifetime: the only way to change them was DELETE +
 * recreate, which `dropTable` implements by deleting `table_rows` AND
 * `table_row_history`. That is why declaring a new per-column fact (an L1
 * concept, and later an L2 vector slot) could not reach a converged install at
 * all — the declaration would land in git, the offline gate would go green, and
 * the database would keep the old schema with nothing red anywhere.
 *
 * RECONCILE, NOT REPLACE. The rules exist because rows already hold values:
 *   - a column may be ADDED (rows simply have no value for it yet);
 *   - `label`, `role`, `unit`, `required`, `options` and `concept` may CHANGE —
 *     none of them invalidates a stored value, and declaring meaning onto an
 *     existing column is the whole point of the exercise;
 *   - `kind` may NOT change, and a column may NOT be DROPPED: both would strand
 *     or silently reinterpret data already in `table_rows`. A caller that means
 *     it drops the table.
 *
 * Re-syncs the card and the projected row objects, because both render column
 * metadata — a reconcile that left the corpus describing the old columns would
 * be the same silent half-application this function exists to remove.
 */
export function updateTableSchema(
  t: Omit<TableInfo, 'capabilities'>,
  next: TableSchema,
): Omit<TableInfo, 'capabilities'> {
  const prior = new Map(t.schema.columns.map((c) => [c.key, c]));
  const nextKeys = new Set(next.columns.map((c) => c.key));
  const errors: string[] = [];

  for (const [key, col] of prior) {
    if (!nextKeys.has(key)) {
      errors.push(`column ${key} would be dropped; rows still hold its values — drop the table instead`);
      continue;
    }
    const n = next.columns.find((c) => c.key === key)!;
    if (n.kind !== col.kind) {
      errors.push(`column ${key} would change kind ${col.kind} → ${n.kind}; stored values would be reinterpreted`);
    }
  }
  if (errors.length) throw new Error(`schema reconcile refused: ${errors.join('; ')}`);

  db.getDb()
    .prepare("UPDATE data_tables SET schema_json = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(JSON.stringify(next), t.id);

  const updated = { ...t, schema: next };
  syncCard(updated);
  syncRows(updated);
  return updated;
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

export function syncCard(
  t: Omit<TableInfo, 'capabilities'>,
  anchors: string[] = [],
  graph?: GraphMeta,
): void {
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
  // S2⁶ graph block (frontmatter.graph). Preserve it across re-syncs the same
  // way anchors are merged above: a row-count bump (upsertRow/deleteRow) calls
  // syncCard with NO graph arg, so fall back to the existing card's block —
  // otherwise every row write would wipe the table's declared render metadata.
  const priorGraph = existing?.frontmatter?.graph as GraphMeta | undefined;
  const graphBlock = graph ?? priorGraph;
  db.saveObject(t.ownerId, {
    id: `table-${t.id}`,
    type: 'table',
    title: t.title,
    description: t.description,
    resource: `keaptable:${t.id}`,
    frontmatter: {
      storage: { driver: t.driver },
      // `concept` rides along so the card — which IS the corpus's description
      // of the table — carries what each column means, not just how it is
      // stored. An agent reading the card can then map columns across tables.
      columns: t.schema.columns.map(({ key, label, kind, role, unit, concept }) => ({ key, label, kind, role, unit, concept })),
      rowCount: t.rowCount,
      // Absent (card-only, no override) → key omitted entirely, so an existing
      // table with no graph block stays byte-identical to today's frontmatter.
      ...(graphBlock ? { graph: graphBlock } : {}),
    },
    body,
    links: extractRefs(body, `keaptable:${t.id}`),
    visibility: t.visibility,
  });
  markCorpusDirty();
}

// ── Row sync: each row as its own knowledge_object (S2⁶ Stage 2, D3) ─────────
//
// D3 in docs/specs/table-graph-metadata-spec.md ratified MATERIALISED over
// computed-on-read: a row projected into the graph is a real knowledge_object,
// so everything downstream is free. `allSources()` already enumerates
// db.getObjects under kind 'object' (no new EmbeddingKind), hybridSearch
// rebuilds FTS from the same list, and /explore renders getVisibleObjects,
// which already applies the tier ladder. graph.ts needs no table-specific code.
//
// WHY THIS MATTERS, concretely: before this, the cortex held ONE object per
// table and nothing about its rows. An operator capturing ideas into a
// DataTable — the intended face → cortex → agent loop — could not have those
// rows found by search, embedding or an agent; the only way in was opening
// SQLite directly. That is the workflow this function exists to make real.

/** Ratified cap. A table above it is REJECTED at enable time rather than
 *  silently truncated — a partially-projected table is worse than an
 *  unprojected one, because it looks complete. */
export const ROW_OBJECT_CAP = 500;

export function rowObjectId(tableId: string, rowId: string, idValue?: unknown): string {
  const suffix =
    typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : rowId;
  return `table-${tableId}:row-${suffix}`;
}

/**
 * Compact one row into a body the embedder and FTS can use. Column LABELS, not
 * keys — the body is read by humans and by a router answering questions, and
 * `title_or_link` is worse than `Title or link` for both.
 *
 * A declared L1 concept is emitted as `Label [concept]: value`. Be honest about
 * what that buys: the body is embedded as ONE vector and truncated before it is,
 * so a shared bracket token among thousands of characters does not make the
 * embedding concept-aware — that needs L2's per-concept slots. What it does buy
 * is the LEXICAL leg: `lifecycle.status` is a literal FTS/BM25 term, so "which
 * rows anywhere carry a lifecycle status" becomes answerable across tables that
 * spell the label five different ways.
 */
function rowBody(t: Omit<TableInfo, 'capabilities'>, values: Record<string, unknown>, anchor?: string): string {
  const lines = t.schema.columns
    .map((c) => {
      const v = values[c.key];
      if (v === undefined || v === null || v === '') return null;
      const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return c.concept ? `${c.label} [${c.concept}]: ${text}` : `${c.label}: ${text}`;
    })
    .filter(Boolean) as string[];
  const anchorBody = anchor ? `[[${anchor}]]` : '';
  return [anchorBody, lines.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * Project a table's rows as individual knowledge_objects when its graph block
 * declares `mode: 'rows'`. Idempotent: re-syncing rewrites the current rows and
 * deletes objects for rows that no longer exist, so a delete or a flip back to
 * `mode: 'card'` cleans up after itself instead of leaving orphans in the
 * corpus (which the nightly diff would then report forever).
 */
export function syncRows(
  t: Omit<TableInfo, 'capabilities'>,
  graph?: GraphMeta,
  rows?: TableRow[],
): void {
  const existingCard = db.getObject(`table-${t.id}`);
  const graphBlock = graph ?? (existingCard?.frontmatter?.graph as GraphMeta | undefined);
  const prefix = `table-${t.id}:row-`;

  // Everything we previously materialised for this table.
  const priorIds = new Set(
    db
      .getObjects(t.ownerId, true)
      .filter((o) => o.id.startsWith(prefix))
      .map((o) => o.id),
  );

  const node = graphBlock?.mode === 'rows' ? graphBlock.node : undefined;
  if (!node) {
    // Not projecting (or no longer projecting) — retract whatever is there.
    for (const id of priorIds) db.deleteObject(id);
    if (priorIds.size) markCorpusDirty();
    return;
  }

  const all = rows ?? readAllRows(t.id);
  const kept = new Set<string>();
  for (const r of all.slice(0, ROW_OBJECT_CAP)) {
    const id = rowObjectId(t.id, r.id, node.idColumn ? r.values[node.idColumn] : undefined);
    const label = node.labelColumn ? r.values[node.labelColumn] : undefined;
    const anchorRaw = node.anchorColumn ? r.values[node.anchorColumn] : undefined;
    const anchor = typeof anchorRaw === 'string' && anchorRaw ? anchorRaw : undefined;
    const body = rowBody(t, r.values, anchor);
    const resource = `keaptable:${t.id}#${r.id}`;
    kept.add(id);
    db.saveObject(t.ownerId, {
      id,
      type: node.kind || 'record',
      // A row with an empty label column still gets an object — silently
      // dropping it would make the corpus disagree with the table, and the
      // nightly diff would be right to complain.
      title: label ? String(label) : `${t.title} row ${r.id.slice(0, 8)}`,
      resource,
      frontmatter: { table: t.id, row: r.id },
      body,
      links: extractRefs(body, resource),
      // Inherited, never widened: a row can never be more visible than the
      // table it belongs to.
      visibility: t.visibility,
    });
  }

  for (const id of priorIds) if (!kept.has(id)) db.deleteObject(id);
  markCorpusDirty();
}

/** Every row of a table, unpaged — only ever called for projection, which is
 *  bounded by ROW_OBJECT_CAP at enable time. */
function readAllRows(tableId: string): TableRow[] {
  return (
    db
      .getDb()
      .prepare('SELECT * FROM table_rows WHERE table_id = ? ORDER BY created_at')
      .all(tableId) as TableRowDbRow[]
  ).map(mapRow);
}

/** Enable-time guard for `mode: 'rows'`. Throws rather than truncating. */
export function assertRowProjectionAllowed(rowCount: number, graph?: GraphMeta): void {
  if (graph?.mode !== 'rows') return;
  if (rowCount > ROW_OBJECT_CAP) {
    throw new Error(
      `table has ${rowCount} rows; row projection is capped at ${ROW_OBJECT_CAP}. ` +
        `Raise ROW_OBJECT_CAP deliberately or keep mode: 'card' — a partially ` +
        `projected table looks complete and is not.`,
    );
  }
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

/** Raw table_rows row — snake_case DB columns before mapping. */
interface TableRowDbRow {
  row_id: string;
  data: string;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

function mapRow(r: TableRowDbRow): TableRow {
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
  const c = (d.prepare('SELECT COUNT(*) AS c FROM table_rows WHERE table_id = ?').get(tableId) as { c: number }).c;
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
    assertRowProjectionAllowed(t.rowCount, req.graph);
    syncCard(t, req.anchors, req.graph);
    syncRows(t, req.graph);
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
      .all(id, ...params, q.limit + 1, offset) as TableRowDbRow[];
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
        .get(id, rid) as { data: string } | undefined;
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
    syncRows({ ...t, rowCount });
    const saved = d
      .prepare('SELECT * FROM table_rows WHERE table_id = ? AND row_id = ?')
      .get(id, rid) as TableRowDbRow;
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
    syncRows({ ...t, rowCount });
  },

  async rowHistory(id, rowId, limit) {
    return (
      db
        .getDb()
        .prepare(
          'SELECT op, data, actor, at FROM table_row_history WHERE table_id = ? AND row_id = ? ORDER BY at DESC, id DESC LIMIT ?',
        )
        .all(id, rowId, limit) as Array<{ op: string; data: string | null; actor: string; at: number }>
    ).map((r) => ({ op: r.op, values: r.data ? JSON.parse(r.data) : null, actor: r.actor, at: r.at }));
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
      .all(id, ...params, q.limit) as Array<Record<string, unknown>>;
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
