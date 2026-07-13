/**
 * Data-table contract — the shape every TableStore driver speaks (Track R2′,
 * owner direction 2026-07-12: "DataTable(Store) je klíčový — musí být dost
 * abstraktní").
 *
 * Design pillars:
 *  - COLUMN KINDS cover rich values: files arrive BY REFERENCE (same doctrine
 *    as intake media), vectors are first-class (libSQL F32 heritage),
 *    taxonomyRef/objectRef wire rows into the knowledge graph.
 *  - OLAP IN THE DNA: every column carries a `role` (dimension | measure |
 *    attribute) and the query surface includes `AggregateQuery` (group-by
 *    dimensions × aggregated measures) — a SharePoint-list today, a cube
 *    tomorrow (the DuckDB/parquet driver inherits the same contract).
 *  - CAPABILITIES, not assumptions: drivers declare what they can do
 *    (transactions, rowHistory, aggregate, vectorColumns, objectVersioning,
 *    events); the UI renders only what the chosen storage offers.
 *
 * Shared between server drivers, the web UI grid, and the extension.
 */
import { z } from 'zod';

// ── Columns ───────────────────────────────────────────────────────────────────

export const columnKindSchema = z.enum([
  'text',
  'number',
  'boolean',
  'date', // epoch seconds
  'select', // one of options
  'json', // free structured payload
  'file', // BY REFERENCE: { url, mime?, name?, size? }
  'vector', // number[] of fixed dim
  'taxonomyRef', // node id — anchors the ROW into the universe
  'objectRef', // knowledge_object id
  'user', // KEAP user id (attribution columns)
]);
export type ColumnKind = z.infer<typeof columnKindSchema>;

/** OLAP role: dimensions slice, measures aggregate, attributes just describe. */
export const columnRoleSchema = z.enum(['dimension', 'measure', 'attribute']);
export type ColumnRole = z.infer<typeof columnRoleSchema>;

export const columnDefSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'snake_case keys only'),
  label: z.string().min(1).max(120),
  kind: columnKindSchema,
  role: columnRoleSchema.default('attribute'),
  required: z.boolean().default(false),
  /** select: allowed values */
  options: z.array(z.string()).max(200).optional(),
  /** vector: dimension (validated on write) */
  dim: z.number().int().positive().max(4096).optional(),
  /** measure display/aggregation hint, e.g. "kg", "CZK" */
  unit: z.string().max(24).optional(),
});
export type ColumnDef = z.infer<typeof columnDefSchema>;

export const tableSchemaSchema = z.object({
  columns: z.array(columnDefSchema).min(1).max(120),
});
export type TableSchema = z.infer<typeof tableSchemaSchema>;

// ── Values ────────────────────────────────────────────────────────────────────

export const fileValueSchema = z.object({
  url: z.string().min(1),
  mime: z.string().max(120).optional(),
  name: z.string().max(240).optional(),
  size: z.number().int().nonnegative().optional(),
});
export type FileValue = z.infer<typeof fileValueSchema>;

/** Runtime validation of one row's values against a schema. */
export function validateRowValues(
  schema: TableSchema,
  values: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const byKey = new Map(schema.columns.map((c) => [c.key, c]));
  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) errors.push(`unknown column: ${key}`);
  }
  for (const col of schema.columns) {
    const v = values[col.key];
    if (v === undefined || v === null) {
      if (col.required) errors.push(`missing required column: ${col.key}`);
      continue;
    }
    switch (col.kind) {
      case 'text':
        if (typeof v !== 'string') errors.push(`${col.key}: expected string`);
        break;
      case 'number':
        if (typeof v !== 'number' || Number.isNaN(v)) errors.push(`${col.key}: expected number`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`${col.key}: expected boolean`);
        break;
      case 'date':
        if (typeof v !== 'number') errors.push(`${col.key}: expected epoch seconds`);
        break;
      case 'select':
        if (typeof v !== 'string' || (col.options && !col.options.includes(v)))
          errors.push(`${col.key}: expected one of options`);
        break;
      case 'json':
        if (typeof v !== 'object') errors.push(`${col.key}: expected object/array`);
        break;
      case 'file':
        if (!fileValueSchema.safeParse(v).success)
          errors.push(`${col.key}: expected file ref { url, mime?, name?, size? }`);
        break;
      case 'vector':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'number'))
          errors.push(`${col.key}: expected number[]`);
        else if (col.dim && v.length !== col.dim)
          errors.push(`${col.key}: expected dim ${col.dim}, got ${v.length}`);
        break;
      case 'taxonomyRef':
      case 'objectRef':
      case 'user':
        if (typeof v !== 'string') errors.push(`${col.key}: expected id string`);
        break;
    }
  }
  return errors;
}

// ── Query surface ─────────────────────────────────────────────────────────────

export const filterOpSchema = z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains']);

export const rowFilterSchema = z.object({
  column: z.string(),
  op: filterOpSchema,
  value: z.union([z.string(), z.number(), z.boolean()]),
});
export type RowFilter = z.infer<typeof rowFilterSchema>;

export const listRowsQuerySchema = z.object({
  filter: z.array(rowFilterSchema).max(16).default([]),
  sort: z.object({ column: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(500).default(50),
});
export type ListRowsQuery = z.infer<typeof listRowsQuerySchema>;

export const aggregateFnSchema = z.enum(['count', 'sum', 'avg', 'min', 'max']);

/** The OLAP slice: GROUP BY dimensions, aggregate measures. */
export const aggregateQuerySchema = z.object({
  dimensions: z.array(z.string()).max(6).default([]),
  measures: z
    .array(z.object({ column: z.string(), fn: aggregateFnSchema }))
    .min(1)
    .max(12),
  filter: z.array(rowFilterSchema).max(16).default([]),
  limit: z.number().int().positive().max(1000).default(200),
});
export type AggregateQuery = z.infer<typeof aggregateQuerySchema>;

// ── Driver capabilities & registry shapes ─────────────────────────────────────

export interface TableCapabilities {
  transactions: boolean;
  rowHistory: boolean;
  aggregate: boolean;
  vectorColumns: boolean;
  objectVersioning: boolean;
  events: boolean;
}

export const tableDriverSchema = z.enum(['libsql', 'rustfs', 'postgres', 'grist']);
export type TableDriver = z.infer<typeof tableDriverSchema>;

// Share scope, mapped onto the nOS Authentik tiers (see server/rbac.ts):
// private = owner+admin only; tier-* = that tier and every tier above it;
// shared = every authenticated user in the tenant.
export const tableVisibilitySchema = z.enum([
  'private',
  'tier-managers',
  'tier-users',
  'tier-guests',
  'shared',
]);
export type TableVisibilityContract = z.infer<typeof tableVisibilitySchema>;

export const createTableRequestSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  driver: tableDriverSchema.default('libsql'),
  schema: tableSchemaSchema,
  /** taxonomy anchors — where the table's card hangs in the universe */
  anchors: z.array(z.string()).max(8).default([]),
  visibility: tableVisibilitySchema.default('private'),
});
export type CreateTableRequest = z.infer<typeof createTableRequestSchema>;

/** PATCH /api/tables/:id — move a table between share scopes after creation. */
export const updateTableVisibilitySchema = z.object({
  visibility: tableVisibilitySchema,
});
export type UpdateTableVisibility = z.infer<typeof updateTableVisibilitySchema>;

export interface TableInfo {
  id: string;
  title: string;
  description?: string;
  driver: TableDriver;
  schema: TableSchema;
  capabilities: TableCapabilities;
  ownerId: string;
  visibility: string;
  rowCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TableRow {
  id: string;
  values: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}
