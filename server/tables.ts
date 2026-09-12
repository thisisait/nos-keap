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
import type Database from 'libsql';
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
  type ViewMeta,
  validateRowValues,
} from '../shared/contracts/table';
import type { Principal, RowSharing, RowSharingPatch } from '../shared/contracts/visibility';

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
    /** dtt-share-model: stamp = owner principal for a NEW row (immutable
     *  thereafter); patch = authorized visibility/grant changes. The ROUTE
     *  authorizes; the driver only stores. */
    sharing?: { stamp?: Principal; patch?: RowSharingPatch },
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
  const r = row as DataTableDbRow & { shared_with?: string | null };
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    driver: r.driver,
    schema: JSON.parse(r.schema_json),
    ownerId: r.user_id,
    visibility: r.visibility,
    sharedWith: r.shared_with ? JSON.parse(r.shared_with) : [],
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
  // Own tables, any tier-readable scope ('shared' is always in the list, so
  // the IN() is never empty), an explicit table grant, or a ROW grant (a row
  // grant implies the grantee sees the table's existence — settlement #3).
  const vis = readableVisibilities(tierRank(actor.groups));
  const placeholders = vis.map(() => '?').join(',');
  const principal = `user:${actor.id}`;
  const rows = d
    .prepare(
      `SELECT * FROM data_tables
       WHERE user_id = ? OR visibility IN (${placeholders}) OR shared_with LIKE ?
          OR EXISTS (SELECT 1 FROM table_rows tr WHERE tr.table_id = data_tables.id AND tr.sharing LIKE ?)
       ORDER BY updated_at DESC`,
    )
    .all(actor.id, ...vis, `%"${principal}"%`, `%"${principal}"%`);
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
  /**
   * The re-declared view block, if the caller sent one.
   *
   * WITHOUT THIS ARGUMENT THE RECONCILE PATH WAS WRITE-ONCE FOR `view`, and
   * that is the path every real table takes: `syncCard` falls back to the
   * card's prior block when called with none (so a row write does not wipe the
   * style), which is right for a row write and wrong for a re-seed — the
   * definition file is the source of truth, and a `view:` edited in it landed
   * in git, passed validation, and reached nothing on any table that already
   * existed. Exactly the defect the reconcile path was built to end for
   * columns, one field over. Absent → prior block preserved, as before.
   */
  view?: ViewMeta,
  /** Definition anchors — same ride-the-reconcile law as `view`: absent →
   *  the card keeps its prior anchors, provided → REPLACES them (the def
   *  file is the source of truth; see syncCard). */
  anchors?: string[],
  /** The re-declared graph block — same law again: absent → the card keeps its
   *  prior block, provided → REPLACES it (and syncRows materialises or retracts
   *  row projection accordingly; un-project by sending mode:'card'). */
  graph?: GraphMeta,
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
    // select→text is the ONE safe kind widening: every stored enum value is
    // already a valid text value (the options simply stop constraining new
    // writes). The reverse — and every other pair — reinterprets or strands
    // stored values and stays refused. Named reconcile class, requested by
    // nOS 2026-09-09 (roadmap `track` grows unbounded track slugs).
    const safeWidening = col.kind === 'select' && n.kind === 'text';
    if (n.kind !== col.kind && !safeWidening) {
      errors.push(`column ${key} would change kind ${col.kind} → ${n.kind}; stored values would be reinterpreted`);
    }
  }
  if (errors.length) throw new Error(`schema reconcile refused: ${errors.join('; ')}`);

  db.getDb()
    .prepare("UPDATE data_tables SET schema_json = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(JSON.stringify(next), t.id);

  const updated = { ...t, schema: next };
  syncCard(updated, anchors, graph, view);
  syncRows(updated, graph);
  return updated;
}

/** Persist a visibility change (owner/admin only — enforced at the route). */
export function updateTableVisibility(id: string, visibility: TableVisibility): void {
  db.getDb()
    .prepare("UPDATE data_tables SET visibility = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(visibility, id);
}

/** Replace the table's explicit ACL (owner/admin only — routes enforce). */
export function updateTableSharing(id: string, sharedWith: TableInfo['sharedWith']): void {
  db.getDb()
    .prepare("UPDATE data_tables SET shared_with = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(JSON.stringify(sharedWith), id);
}

/** Does ANY row of this table grant the principal? A row grant implies the
 *  grantee sees the table's EXISTENCE (settlement #3) — this is that check.
 *  ponytail: LIKE over the sharing JSON — principals are exact quoted strings
 *  in a column only this module writes, so the match is precise; a real index
 *  arrives if row-sharing ever outgrows personal scale. */
export function hasRowGrantFor(tableId: string, principal: Principal): boolean {
  return Boolean(
    db
      .getDb()
      .prepare("SELECT 1 FROM table_rows WHERE table_id = ? AND sharing LIKE ? LIMIT 1")
      .get(tableId, `%"${principal}"%`),
  );
}

/** Tables whose ROWS grant the principal, for the listing (same LIKE law). */
export function tablesWithRowGrantsFor(principal: Principal): Set<string> {
  const rows = db
    .getDb()
    .prepare("SELECT DISTINCT table_id FROM table_rows WHERE sharing LIKE ?")
    .all(`%"${principal}"%`) as Array<{ table_id: string }>;
  return new Set(rows.map((r) => r.table_id));
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
  anchors?: string[],
  graph?: GraphMeta,
  view?: ViewMeta,
): void {
  // Anchors follow the same law as the graph/view blocks below: an absent
  // arg (row-count bumps) preserves the card's own anchors; a PROVIDED list
  // REPLACES them — the definition is the source of truth, and the old
  // union-merge could never drop a removed anchor on a def re-POST, leaving
  // stale [[refs]] on the card forever (nOS lint broken-anchor class,
  // 2026-09-09).
  const existing = db.getObject(`table-${t.id}`);
  const prior = ((existing?.links ?? []) as ObjectRefLike[])
    .filter((l) => l.kind === 'node')
    .map((l) => l.ref);
  const nextAnchors = anchors ?? prior;
  const anchorBody = [...new Set(nextAnchors)].map((a) => `[[${a}]]`).join(' ');
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
  // Same preserve-across-re-sync rule as the graph block: a row write calls
  // syncCard with NO view arg, so falling back to the card's own copy is what
  // stops every upsert from wiping the table's declared render style.
  const priorView = existing?.frontmatter?.view as ViewMeta | undefined;
  const viewBlock = view ?? priorView;
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
      // Absent (no declared style) → key omitted entirely, so a table that
      // never asked for one stays byte-identical to today's frontmatter.
      ...(viewBlock ? { view: viewBlock } : {}),
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
    // Most-restrictive-wins applied to projection: a row that NARROWED its
    // visibility below the table's is not materialised into the corpus — the
    // knowledge graph is broad-visibility, and a narrowed row leaking through
    // search/embeddings would undo the narrowing. An owner stamp or a grant
    // is not a narrowing and projects normally.
    if (r.sharing?.visibility) continue;
    // Nothing enforces idColumn uniqueness across rows, and two rows mapping
    // to one object id would silently drop the later row from the corpus (the
    // exact partially-projected-but-looks-complete state ROW_OBJECT_CAP's
    // enable-time refusal exists to prevent). On collision the later row falls
    // back to its r.id-keyed identity — present, just not idColumn-addressed.
    let id = rowObjectId(t.id, r.id, node.idColumn ? r.values[node.idColumn] : undefined);
    if (kept.has(id)) id = rowObjectId(t.id, r.id, undefined);
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

function mapRow(r: TableRowDbRow & { sharing?: string | null }): TableRow {
  return {
    id: r.row_id,
    values: JSON.parse(r.data),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    ...(r.sharing ? { sharing: JSON.parse(r.sharing) as RowSharing } : {}),
  };
}

/** Apply a row-sharing patch over the stored triple (dtt-share-model).
 *  Owner is immutable — stamped at insert, never patched; null clears a
 *  field, undefined leaves it (the values-merge law applied to meta). */
export function mergeRowSharing(
  existing: RowSharing | undefined,
  stamp: { owner?: Principal } | undefined,
  patch: RowSharingPatch | undefined,
): RowSharing | undefined {
  const owner = existing?.owner ?? stamp?.owner;
  const visibility =
    patch && 'visibility' in patch ? (patch.visibility ?? undefined) : existing?.visibility;
  const sharedWith =
    patch && 'sharedWith' in patch ? (patch.sharedWith ?? undefined) : existing?.sharedWith;
  if (!owner && !visibility && !(sharedWith && sharedWith.length)) return undefined;
  return {
    ...(owner ? { owner } : {}),
    ...(visibility ? { visibility } : {}),
    ...(sharedWith && sharedWith.length ? { sharedWith } : {}),
  };
}

// ── rowRef back-reference mirror (migration 007-row-refs) ────────────────────
//
// ONE write path. Every mutation of a row's rowRef cells goes through
// syncRowRefs, called INSIDE the row's own transaction, so the mirror can never
// be half-applied against `data`. rebuildRowRefs() is the repair, not the
// routine — if it ever has to fix something, a write path bypassed this.

/** rowRef columns of a schema, as [columnKey, targetTable] pairs. */
function rowRefColumns(schema: TableSchema): Array<[string, string]> {
  return schema.columns
    .filter((c) => c.kind === 'rowRef' && c.refTable)
    .map((c) => [c.key, c.refTable as string]);
}

/** Rewrite one row's mirror entries. Call inside the row's transaction. */
function syncRowRefs(
  d: Database.Database,
  tableId: string,
  rowId: string,
  schema: TableSchema,
  values: Record<string, unknown>,
): void {
  d.prepare('DELETE FROM table_row_refs WHERE from_table = ? AND from_row = ?').run(tableId, rowId);
  const ins = d.prepare(
    `INSERT INTO table_row_refs (from_table, from_row, column_key, to_table, to_row)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [key, target] of rowRefColumns(schema)) {
    const v = values[key];
    // A cleared reference is an ABSENT edge, not an edge to "". Storing empties
    // would make "who points at me" answer with rows that point at nothing.
    if (typeof v === 'string' && v.trim()) ins.run(tableId, rowId, key, target, v);
  }
}

/**
 * Refuse a rowRef that points at a row which does not exist.
 *
 * MEASURED LIVE 2026-08-11, on the estate, minutes after rowRef first shipped:
 * a row carrying `customer: "ghost"` was accepted and stored. The integrity was
 * ASYMMETRIC — `onDelete: restrict` refuses to delete a row somebody points at,
 * while nothing stopped anyone pointing at nothing. 24 unit tests missed it
 * because they test what was written, and nobody had written this.
 *
 * Called INSIDE the row transaction, before the mirror is rewritten, so a
 * refusal leaves neither `data` nor `table_row_refs` touched.
 *
 * THE COST, stated rather than discovered later: this makes load ORDER matter.
 * Importing invoices before parties now fails per row instead of silently
 * building a graph of dangling edges. That is the same trade `restrict` already
 * made on the delete side, and the alternative is a join table whose edges may
 * point nowhere — which is not a join.
 */
function assertRowRefTargetsExist(
  d: Database.Database,
  schema: TableSchema,
  values: Record<string, unknown>,
): void {
  for (const [key, target] of rowRefColumns(schema)) {
    const v = values[key];
    // Absent or cleared is legal — the column simply has no edge. Only a
    // NON-EMPTY value is a claim that something is there.
    if (typeof v !== 'string' || !v.trim()) continue;

    const table = d
      .prepare('SELECT 1 FROM data_tables WHERE id = ?')
      .get(target) as unknown;
    if (!table) {
      throw new Error(
        `column '${key}' points at table '${target}', which does not exist`,
      );
    }
    const row = d
      .prepare('SELECT 1 FROM table_rows WHERE table_id = ? AND row_id = ?')
      .get(target, v.trim()) as unknown;
    if (!row) {
      throw new Error(
        `column '${key}' references ${target}.${v.trim()}, which does not exist`,
      );
    }
  }
}

/**
 * Resolve `expand`ed rowRef columns to their target's display value.
 *
 * ADDITIVE, never destructive: the raw id stays in `<key>` and the label lands
 * in `<key>__display`. A caller that expands gets something to render; every
 * caller that does not is byte-identical, which matters because the agent row
 * API is documented as FLAT and the seeder reads a top-level `slug` off it.
 *
 * `expand` existed in the contract (listRowsQuerySchema, max 4) and did nothing
 * for two weeks — measured live 2026-08-11: `?expand=customer` returned the raw
 * slug. The store never resolved it AND the agent route passed a hard-coded
 * `expand: []`, so the parameter was inert twice over. `capabilities.joins`
 * being declared `false` is what kept that honest rather than broken.
 *
 * One query per (targetTable, ids) rather than per row: a 500-row page with one
 * rowRef column is 1 extra query, not 500.
 */
function expandRowRefs(schema: TableSchema, rows: TableRow[], expand: string[]): void {
  if (!expand.length || !rows.length) return;
  const byKey = new Map(schema.columns.map((c) => [c.key, c]));

  for (const key of expand) {
    const col = byKey.get(key);
    // Silently skipping an unknown or non-rowRef key would make a typo look
    // like "the target had no label". Refuse instead — the caller asked for
    // something this table cannot give.
    if (!col) throw new Error(`unknown expand column: ${key}`);
    if (col.kind !== 'rowRef' || !col.refTable) {
      throw new Error(`column '${key}' is not a rowRef and cannot be expanded`);
    }

    const ids = [
      ...new Set(
        rows
          .map((r) => r.values[key])
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0),
      ),
    ];
    if (!ids.length) continue;

    const placeholders = ids.map(() => '?').join(',');
    const found = db
      .getDb()
      .prepare(
        `SELECT row_id, data FROM table_rows
         WHERE table_id = ? AND row_id IN (${placeholders})`,
      )
      .all(col.refTable, ...ids) as Array<{ row_id: string; data: string }>;

    const display = new Map<string, string>();
    for (const f of found) {
      let label = f.row_id;
      if (col.refDisplay) {
        try {
          const v = (JSON.parse(f.data) as Record<string, unknown>)[col.refDisplay];
          if (typeof v === 'string' && v.trim()) label = v;
        } catch {
          /* a row whose data will not parse keeps its id as the label */
        }
      }
      display.set(f.row_id, label);
    }

    for (const r of rows) {
      const v = r.values[key];
      if (typeof v !== 'string' || !v.trim()) continue;
      // A reference whose target vanished keeps the id and says so, rather than
      // rendering as an empty cell that looks like "no customer".
      r.values[`${key}__display`] = display.get(v) ?? `${v} (missing)`;
    }
  }
}

/** Rows that reference (tableId, rowId). The query the mirror exists for. */
export function referencesTo(
  tableId: string,
  rowId: string,
): Array<{ fromTable: string; fromRow: string; columnKey: string }> {
  return (
    db
      .getDb()
      .prepare(
        `SELECT from_table AS fromTable, from_row AS fromRow, column_key AS columnKey
         FROM table_row_refs WHERE to_table = ? AND to_row = ?
         ORDER BY from_table, from_row, column_key`,
      )
      .all(tableId, rowId) as Array<{ fromTable: string; fromRow: string; columnKey: string }>
  );
}

/**
 * Rebuild the whole mirror from `table_rows`. A repair tool and the fixture the
 * drift test compares against — NOT something to call at boot: it is O(rows),
 * and running it routinely would hide exactly the bug it detects.
 */
export function rebuildRowRefs(): number {
  const d = db.getDb();
  let n = 0;
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM table_row_refs').run();
    const tables = d.prepare('SELECT id, schema_json FROM data_tables').all() as Array<{
      id: string;
      schema_json: string;
    }>;
    for (const t of tables) {
      const schema = JSON.parse(t.schema_json) as TableSchema;
      if (rowRefColumns(schema).length === 0) continue;
      const rows = d
        .prepare('SELECT row_id, data FROM table_rows WHERE table_id = ?')
        .all(t.id) as Array<{ row_id: string; data: string }>;
      for (const r of rows) {
        syncRowRefs(d, t.id, r.row_id, schema, JSON.parse(r.data));
        n += 1;
      }
    }
  });
  tx();
  return n;
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
    // rowRef resolution (expand on read + the back-reference index) is NOT
    // implemented yet. Declared false so the UI does not render a picker and a
    // "what points here" panel that the store cannot serve — capabilities are a
    // promise, and a premature true is a promise the operator sees broken.
    joins: true, // expand on read + the back-reference index both serve now
  },

  async createTable(ownerId, req) {
    const id = req.id ?? crypto.randomUUID();
    db.getDb()
      .prepare(
        `INSERT INTO data_tables (id, user_id, title, description, driver, schema_json, visibility, shared_with)
         VALUES (?, ?, ?, ?, 'libsql', ?, ?, ?)`,
      )
      .run(id, ownerId, req.title, req.description ?? null, JSON.stringify(req.schema), req.visibility, JSON.stringify(req.sharedWith ?? []));
    const t = getTable(id)!;
    assertRowProjectionAllowed(t.rowCount, req.graph);
    syncCard(t, req.anchors, req.graph, req.view);
    syncRows(t, req.graph);
    return t;
  },

  async dropTable(id) {
    const d = db.getDb();
    const tx = d.transaction(() => {
      d.prepare('DELETE FROM table_rows WHERE table_id = ?').run(id);
      d.prepare('DELETE FROM table_row_history WHERE table_id = ?').run(id);
      // Both directions: the table's outgoing edges AND the edges other tables
      // aimed at it. Leaving the incoming half would keep onDelete refusing
      // deletes on behalf of rows that no longer exist.
      d.prepare('DELETE FROM table_row_refs WHERE from_table = ? OR to_table = ?').run(id, id);
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
    expandRowRefs(t.schema, page, q.expand ?? []);
    return {
      rows: page,
      nextCursor: rows.length > q.limit ? String(offset + q.limit) : undefined,
    };
  },

  async upsertRow(id, rowId, values, actor, rowSharing) {
    const t = getTable(id);
    if (!t) throw new Error('unknown table');
    // The drivers own the SAFE_ROW_ID invariant now — the agent door's __id
    // proved that asking every route to remember assertRowId does not hold.
    const rid = rowId ? assertRowId(rowId) : crypto.randomUUID();
    const d = db.getDb();
    const tx = d.transaction(() => {
      const existing = d
        .prepare('SELECT data, sharing FROM table_rows WHERE table_id = ? AND row_id = ?')
        .get(id, rid) as { data: string; sharing: string | null } | undefined;
      const sharing = mergeRowSharing(
        existing?.sharing ? (JSON.parse(existing.sharing) as RowSharing) : undefined,
        existing ? undefined : { owner: rowSharing?.stamp },
        rowSharing?.patch,
      );
      // Upsert semantics: PATCH an existing row (merge keys), insert otherwise.
      // Validation runs on the MERGED result — a patch of one cell must not
      // trip over required columns it didn't touch. A null value DELETES the
      // cell (the only spread-able "clear" that survives JSON.stringify), so
      // required-column checks see it as truly absent.
      const merged: Record<string, unknown> = existing
        ? { ...JSON.parse(existing.data), ...values }
        : { ...values };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      const errors = validateRowValues(t.schema, merged);
      if (errors.length) throw new Error(`invalid row: ${errors.join('; ')}`);
      // Shape first, then EXISTENCE. validateRowValues lives in the shared
      // contract and has no database, so it can say a rowRef is a string and
      // never that the string names anything.
      assertRowRefTargetsExist(d, t.schema, merged);
      d.prepare(
        `INSERT INTO table_rows (table_id, row_id, data, updated_by, sharing)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(table_id, row_id) DO UPDATE SET
           data = excluded.data,
           updated_at = strftime('%s','now'),
           updated_by = excluded.updated_by,
           sharing = excluded.sharing`,
      ).run(id, rid, JSON.stringify(merged), actor, sharing ? JSON.stringify(sharing) : null);
      d.prepare(
        'INSERT INTO table_row_history (table_id, row_id, op, data, actor) VALUES (?, ?, ?, ?, ?)',
      ).run(id, rid, existing ? 'update' : 'insert', JSON.stringify(merged), actor);
      // Mirror the row's rowRef cells. INSIDE this transaction on purpose: a
      // mirror written after commit can be missed by a crash, and a stale edge
      // is worse than none — it makes onDelete refuse a delete for a reference
      // that is not there.
      syncRowRefs(d, id, rid, t.schema, merged);
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
    // onDelete enforcement. 'restrict' is the contract default, so this refuses
    // by default rather than silently orphaning an invoice line. The message
    // names ONE referrer, not all of them: an actor allowed to delete this row
    // is not thereby allowed to enumerate every table that points at it.
    const blocking = referencesTo(id, rowId).filter((r) => {
      const from = getTable(r.fromTable);
      const col = from?.schema.columns.find((c) => c.key === r.columnKey);
      return (col?.onDelete ?? 'restrict') === 'restrict';
    });
    if (blocking.length) {
      throw new Error(
        `row is referenced by ${blocking.length} row(s), first: ` +
          `${blocking[0].fromTable}.${blocking[0].columnKey}`,
      );
    }
    const tx = d.transaction(() => {
      d.prepare('DELETE FROM table_rows WHERE table_id = ? AND row_id = ?').run(id, rowId);
      d.prepare(
        'INSERT INTO table_row_history (table_id, row_id, op, data, actor) VALUES (?, ?, ?, NULL, ?)',
      ).run(id, rowId, 'delete', actor);
      // The deleted row's OWN outgoing edges go with it. Edges pointing AT it
      // were just proven to be non-restricting, and are left for their owning
      // rows to clear — deleting another table's mirror rows here would silently
      // rewrite data this actor may not even be able to read.
      d.prepare('DELETE FROM table_row_refs WHERE from_table = ? AND from_row = ?').run(id, rowId);
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
        // NARROWED rows never aggregate, FOR ANYONE: an aggregate is a broad
        // lens, and a row that narrowed its visibility below the table's
        // would leak through a SUM. Keyed on the narrowing grade only — an
        // owner stamp or a grant does not restrict, it attributes/widens.
        `SELECT ${[...dims, ...measures].join(', ')}
         FROM table_rows WHERE table_id = ?
           AND (sharing IS NULL OR json_extract(sharing, '$.visibility') IS NULL)
         ${sql} ${groupBy} LIMIT ?`,
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

// ── Row claims — a cooperative lease for parallel agents ───────────────────────
// One row = one claim. A second agent claiming a HELD row is refused so it backs
// off; that refusal IS the parallel-safety invariant. The lease is ADVISORY — it
// gates a second CLAIM, not the write door — so a re-seed or the human editor is
// never blocked by an agent's forgotten lease. A claim past its TTL is stealable,
// so a crashed holder self-heals without a background reaper.
// ponytail: advisory; gate upsertRow on the holder the day enforcement is needed.
// Ephemeral table (CREATE IF NOT EXISTS, like corpus_fts) — a lease is not
// durable knowledge, so it earns no migration.

let rowClaimsReady = false;
function ensureRowClaims(): void {
  if (rowClaimsReady) return;
  db.getDb().exec(
    `CREATE TABLE IF NOT EXISTS row_claims (
       table_id TEXT NOT NULL,
       row_id TEXT NOT NULL,
       holder TEXT NOT NULL,
       expires_at INTEGER NOT NULL,
       PRIMARY KEY (table_id, row_id)
     )`,
  );
  rowClaimsReady = true;
}

export interface ClaimResult {
  ok: boolean;
  holder: string;
  expiresAt: number;
}

/** Take (or renew) a lease on a row. Refused ONLY when a DIFFERENT holder's
 *  lease is still live; an expired lease, or the caller's own, is overwritten. */
export function claimRow(
  tableId: string,
  rowId: string,
  holder: string,
  now: number,
  ttlMs: number,
): ClaimResult {
  ensureRowClaims();
  const d = db.getDb();
  const existing = d
    .prepare('SELECT holder, expires_at AS expiresAt FROM row_claims WHERE table_id = ? AND row_id = ?')
    .get(tableId, rowId) as { holder: string; expiresAt: number } | undefined;
  if (existing && existing.expiresAt > now && existing.holder !== holder) {
    return { ok: false, holder: existing.holder, expiresAt: existing.expiresAt };
  }
  const expiresAt = now + ttlMs;
  d.prepare(
    `INSERT INTO row_claims (table_id, row_id, holder, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(table_id, row_id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`,
  ).run(tableId, rowId, holder, expiresAt);
  return { ok: true, holder, expiresAt };
}

/** Drop the caller's lease. Returns false when the caller did NOT hold it
 *  (expired, stolen, or never taken) — never throws. */
export function releaseRow(tableId: string, rowId: string, holder: string): boolean {
  ensureRowClaims();
  const info = db
    .getDb()
    .prepare('DELETE FROM row_claims WHERE table_id = ? AND row_id = ? AND holder = ?')
    .run(tableId, rowId, holder);
  return Number(info.changes) > 0;
}
