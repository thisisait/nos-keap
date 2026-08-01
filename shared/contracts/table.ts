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
import { checkConceptBinding, fieldConceptSchema } from './field-concepts';

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
  /**
   * L1 field concept — WHAT this column means, from the closed vocabulary in
   * field-concepts.ts. Optional so every table that exists today stays valid
   * byte-for-byte; when present it is gated on membership here and on
   * concept↔kind compatibility in `validateColumnConcepts` below.
   */
  concept: fieldConceptSchema.optional(),
});
export type ColumnDef = z.infer<typeof columnDefSchema>;

/**
 * Concept↔kind compatibility, plus the one-concept-per-table rule.
 *
 * A concept names a meaning, and a meaning is singular within a collection: two
 * columns both claiming `lifecycle.status` makes "the status of this row"
 * ambiguous for every consumer that queries by concept, which is the entire
 * reason concepts exist. Different tables reusing the same concept is the point
 * and stays legal.
 *
 * Returns error strings; empty array = valid.
 */
export function validateColumnConcepts(
  // Optional key/kind because zod hands superRefine the pre-default INPUT
  // shape, where every field with a `.default()` reads as optional.
  columns: Array<{ key?: string; kind?: string; concept?: string }>,
): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const c of columns) {
    if (!c.concept) continue;
    const bindErr = checkConceptBinding(c.concept, c.kind ?? '');
    if (bindErr) errors.push(`${c.key}: ${bindErr}`);
    const prior = seen.get(c.concept);
    if (prior) errors.push(`${c.key}: concept ${c.concept} is already declared by column ${prior}`);
    else seen.set(c.concept, c.key ?? '(unnamed)');
  }
  return errors;
}

export const tableSchemaSchema = z
  .object({
    columns: z.array(columnDefSchema).min(1).max(120),
  })
  .superRefine((val, ctx) => {
    for (const message of validateColumnConcepts(val.columns)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['columns'] });
    }
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

// ── Graph-render metadata (S2⁶) ──────────────────────────────────────────────
// A table declares how it projects into the /explore universe. ABSENT → today's
// card-only behaviour, byte-identical (§3). Stored verbatim in the card
// `frontmatter.graph` by syncCard; read by server/graph.ts at render.

// Celestial form vocabulary — a zod mirror of asset-types.ts CelestialForm /
// orbital.ts (KEEP IN SYNC: the values byte-match server/asset-types.ts:21).
export const celestialFormSchema = z.enum(['planet', 'moon', 'asteroid', 'comet', 'station']);
export type CelestialFormContract = z.infer<typeof celestialFormSchema>;

// lowercase-kebab slug — mirrors the R3 verb convention (node-kind + edge type).
const kebabSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'must be a lowercase-kebab slug');

export const graphMetaSchema = z.object({
  // Projection mode. 'card' (default) = one table-<slug> card, as today.
  // 'rows' = ALSO project each row as its own node (materialised in Stage 2;
  // Stage 1 ACCEPTS the value but renders CARD-ONLY — see server/graph.ts).
  mode: z.enum(['card', 'rows']).default('card'),

  // CARD visual override (independent of mode; lets a table pick its own look
  // instead of the generic asteroid/hue-180). Implemented in Stage 1.
  card: z
    .object({
      form: celestialFormSchema.optional(),
      hue: z.number().min(0).max(360).optional(),
      glyph: z.string().max(64).optional(),
    })
    .optional(),

  // Per-row node projection. Required when mode==='rows'. DEFINED here so the
  // contract is visible/stable, but Stage 1 does NOT materialise rows.
  node: z
    .object({
      idColumn: z.string().optional(), // column → stable node id; default: row uuid
      labelColumn: z.string(), // column → node label (required)
      kind: kebabSlugSchema.default('record'), // node-kind → legend + default visual
      form: celestialFormSchema.optional(),
      hue: z.number().min(0).max(360).optional(),
      glyph: z.string().max(64).optional(),
      anchorColumn: z.string().optional(), // a taxonomyRef column → the star this row orbits
    })
    .optional(),

  // Edge definitions: a column whose cell value points at another graph node.
  edges: z
    .array(
      z.object({
        column: z.string(), // an objectRef | taxonomyRef column
        toKind: z.enum(['node', 'object']), // how to resolve the target ref
        type: kebabSlugSchema.optional(), // edge label / relation verb
        label: z.string().max(120).optional(), // display label override
      }),
    )
    .max(8)
    .default([]),
});
export type GraphMeta = z.infer<typeof graphMetaSchema>;

// ── Render metadata (face DataTable surfaces) ────────────────────────────────
// A table declares HOW it wants to be rendered. ABSENT → the grid, byte-identical
// to today. Stored verbatim in the card `frontmatter.view` by syncCard, read by
// the nOS face BFF.
//
// WHY IT LIVES ON THE TABLE and not in the face: the answer to "is this a
// spreadsheet or an article list" is a property of the DATA, not of one client.
// A grid with `white-space: nowrap` is unusable for a table whose `research`
// column holds three paragraphs — and that is knowable from the table, once,
// rather than re-decided by every surface that renders it.

export const tableViewStyleSchema = z.enum(['grid', 'blog', 'timeline', 'tiles']);
export type TableViewStyle = z.infer<typeof tableViewStyleSchema>;

export const viewMetaSchema = z.object({
  style: tableViewStyleSchema.default('grid'),
  /** Row heading. Defaults to the first text column at render time. */
  titleColumn: z.string().optional(),
  /** The long-form cell: rendered as a paragraph block, never a table cell. */
  bodyColumn: z.string().optional(),
  /** Chronological ordering + the timeline gutter label. */
  dateColumn: z.string().optional(),
  /** Tile artwork — a `file` column, or text holding a URL/icon name. */
  mediaColumn: z.string().optional(),
  /** Small facts shown beside the heading (status, tags, owner …). */
  metaColumns: z.array(z.string()).max(4).default([]),
});
export type ViewMeta = z.infer<typeof viewMetaSchema>;

/**
 * Validate a view block against the schema it will render. Returns error
 * strings; empty = valid.
 *
 * Each style has ONE column it cannot work without, and a missing one is an
 * authoring error rather than something to paper over at render time: a
 * timeline with no date column is a list in arbitrary order wearing a
 * timeline's clothes, which is worse than the grid it replaced.
 */
export function validateViewMeta(
  view: { style?: string; titleColumn?: string; bodyColumn?: string; dateColumn?: string; mediaColumn?: string; metaColumns?: string[] },
  columns: Array<{ key?: string; kind?: string }>,
): string[] {
  const errors: string[] = [];
  const byKey = new Map(columns.filter((c) => c.key).map((c) => [c.key as string, c]));
  const need = (col: string | undefined, field: string) => {
    if (col === undefined) return;
    if (!byKey.has(col)) errors.push(`view.${field} references unknown column: ${col}`);
  };
  need(view.titleColumn, 'titleColumn');
  need(view.bodyColumn, 'bodyColumn');
  need(view.dateColumn, 'dateColumn');
  need(view.mediaColumn, 'mediaColumn');
  (view.metaColumns ?? []).forEach((c, i) => need(c, `metaColumns[${i}]`));

  if (view.style === 'blog' && !view.bodyColumn) {
    errors.push("view.style 'blog' requires bodyColumn — the long-form cell is the whole point of the style");
  }
  if (view.style === 'timeline' && !view.dateColumn) {
    errors.push("view.style 'timeline' requires dateColumn — without it the order is arbitrary");
  }
  if (view.dateColumn) {
    const k = byKey.get(view.dateColumn)?.kind;
    if (k && k !== 'date' && k !== 'number' && k !== 'text') {
      errors.push(`view.dateColumn must be a date/number/text column, got ${k}`);
    }
  }
  return errors;
}

export const createTableRequestSchema = z
  .object({
    id: z.string().uuid().optional(),
    title: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    driver: tableDriverSchema.default('libsql'),
    schema: tableSchemaSchema,
    /** taxonomy anchors — where the table's card hangs in the universe */
    anchors: z.array(z.string()).max(8).default([]),
    visibility: tableVisibilitySchema.default('private'),
    /** graph-render metadata (S2⁶) — absent = card-only, byte-identical */
    graph: graphMetaSchema.optional(),
    /** render metadata (face surfaces) — absent = the grid, byte-identical */
    view: viewMetaSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.view) {
      for (const message of validateViewMeta(val.view, val.schema.columns)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['view'] });
      }
    }
    const g = val.graph;
    if (!g) return;
    const byKey = new Map(val.schema.columns.map((c) => [c.key, c]));
    const requireColumn = (col: string | undefined, path: (string | number)[]) => {
      if (col === undefined) return;
      if (!byKey.has(col)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `graph references unknown column: ${col}`,
          path,
        });
      }
    };

    // mode:'rows' ⇒ node present, node.labelColumn names a real column.
    if (g.mode === 'rows' && !g.node) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "graph.mode 'rows' requires graph.node",
        path: ['graph', 'node'],
      });
    }

    // Node column refs must name real columns.
    if (g.node) {
      requireColumn(g.node.labelColumn, ['graph', 'node', 'labelColumn']);
      requireColumn(g.node.idColumn, ['graph', 'node', 'idColumn']);
      if (g.node.anchorColumn !== undefined) {
        requireColumn(g.node.anchorColumn, ['graph', 'node', 'anchorColumn']);
        const col = byKey.get(g.node.anchorColumn);
        if (col && col.kind !== 'taxonomyRef') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `graph.node.anchorColumn must be a taxonomyRef column, got ${col.kind}`,
            path: ['graph', 'node', 'anchorColumn'],
          });
        }
      }
    }

    // Edge column refs must name real columns, kind-compatible with toKind.
    g.edges.forEach((e, i) => {
      requireColumn(e.column, ['graph', 'edges', i, 'column']);
      const col = byKey.get(e.column);
      if (!col) return;
      const wantKind = e.toKind === 'object' ? 'objectRef' : 'taxonomyRef';
      if (col.kind !== wantKind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `graph.edges[${i}].column kind ${col.kind} is not compatible with toKind '${e.toKind}' (needs ${wantKind}; a user→node mapping does not exist in Stage 1)`,
          path: ['graph', 'edges', i, 'column'],
        });
      }
    });
  });
export type CreateTableRequest = z.infer<typeof createTableRequestSchema>;

/** PATCH /api/tables/:id — move a table between share scopes after creation. */
export const updateTableVisibilitySchema = z.object({
  visibility: tableVisibilitySchema,
});
export type UpdateTableVisibility = z.infer<typeof updateTableVisibilitySchema>;

/**
 * PATCH /api/tables/:id with a `schema` — reconcile the column schema of a
 * table that already exists. Both fields optional and independent, so the
 * endpoint stays the single "change this table's declaration" surface rather
 * than growing a second one; a body with neither is rejected at the route.
 */
export const updateTableSchemaSchema = z.object({
  visibility: tableVisibilitySchema.optional(),
  schema: tableSchemaSchema.optional(),
  /** Change how the table renders without touching its columns. Validated
   *  against the LIVE schema at the route, since the columns may not be in
   *  this request at all. */
  view: viewMetaSchema.optional(),
});
export type UpdateTableSchema = z.infer<typeof updateTableSchemaSchema>;

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
