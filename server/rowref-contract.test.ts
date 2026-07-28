/**
 * The structural join — `rowRef`.
 *
 * DataTables was adopted as the entity registry that `ent:` resolves against
 * (nOS docs/plans/cortex-self-core.md §6b), and it shipped with eleven column
 * kinds of which two — `taxonomyRef` and `objectRef` — anchor a row into the
 * knowledge graph. NONE of them pointed at another ROW, so an invoice could not
 * reference its customer: a registry with entities and no edges.
 *
 * These tests pin the decisions, not the code:
 *
 *   - cardinality is expressed by PLACEMENT (1:N = rowRef on the many side;
 *     N:N = a junction table with two rowRefs), so there is deliberately no
 *     array-of-refs kind to test for;
 *   - a rowRef MUST name its target table, because a join whose target varies
 *     per row is not a join;
 *   - `validateRowValues` checks SHAPE ONLY — existence is the store's call,
 *     since answering it here would turn a write into an enumeration oracle for
 *     a table the caller may not be allowed to read;
 *   - the graph edge kind `'row'` ships WITH the column kind, or the joins exist
 *     in the store and are invisible in /explore.
 */
import { describe, it, expect } from 'vitest';
import {
  columnKindSchema,
  tableSchemaSchema,
  listRowsQuerySchema,
  createTableRequestSchema,
  validateRowValues,
  type TableSchema,
} from '../shared/contracts/table';

const col = (over: Record<string, unknown> = {}) => ({
  key: 'customer',
  label: 'Customer',
  kind: 'rowRef',
  refTable: 'party',
  ...over,
});

describe('rowRef — the column kind', () => {
  it('exists', () => {
    expect(columnKindSchema.safeParse('rowRef').success).toBe(true);
  });

  it('requires refTable, naming the offending column', () => {
    const r = tableSchemaSchema.safeParse({ columns: [col({ refTable: undefined })] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain('customer');
      expect(r.error.issues[0].message).toContain('refTable');
    }
  });

  it('rejects refTable on a kind that cannot use it', () => {
    const r = tableSchemaSchema.safeParse({
      columns: [{ key: 'name', label: 'Name', kind: 'text', refTable: 'party' }],
    });
    expect(r.success, 'a stray refTable is a schema mistake, not a harmless extra').toBe(false);
  });

  it('defaults onDelete to restrict — an orphan is a defect, not a tidy-up', () => {
    const r = tableSchemaSchema.parse({ columns: [col()] });
    expect(r.columns[0].onDelete).toBe('restrict');
  });

  it('allows a self-reference (a party may own a party)', () => {
    const r = tableSchemaSchema.safeParse({
      columns: [col({ key: 'parent', refTable: 'party' })],
    });
    expect(r.success).toBe(true);
  });
});

describe('rowRef — row values are checked for SHAPE ONLY', () => {
  const schema = tableSchemaSchema.parse({ columns: [col()] }) as TableSchema;

  it('accepts an id string without asking whether the row exists', () => {
    expect(validateRowValues(schema, { customer: 'party-42' })).toEqual([]);
  });

  it('rejects a non-string and an empty string', () => {
    expect(validateRowValues(schema, { customer: 42 })).toHaveLength(1);
    expect(validateRowValues(schema, { customer: '   ' })).toHaveLength(1);
  });

  it('does not resolve the target — that is the store\'s call, not the contract\'s', () => {
    // A contract that answered existence would leak it: writes would succeed for
    // real ids and fail for invented ones, enumerating a table the writer may
    // not read. Same shape as hidden_fees/13 (Bone's uid-parameter store).
    expect(validateRowValues(schema, { customer: 'definitely-not-a-real-row' })).toEqual([]);
  });
});

describe('graph edges resolve a rowRef', () => {
  const base = {
    title: 'Invoices',
    schema: { columns: [col(), { key: 'label', label: 'Label', kind: 'text' }] },
  };

  it("accepts toKind 'row' against a rowRef column", () => {
    const r = createTableRequestSchema.safeParse({
      ...base,
      graph: { mode: 'card', edges: [{ column: 'customer', toKind: 'row' }] },
    });
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true);
  });

  it("rejects toKind 'row' against a column that is not a rowRef", () => {
    const r = createTableRequestSchema.safeParse({
      ...base,
      graph: { mode: 'card', edges: [{ column: 'label', toKind: 'row' }] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects toKind 'node' against a rowRef column", () => {
    const r = createTableRequestSchema.safeParse({
      ...base,
      graph: { mode: 'card', edges: [{ column: 'customer', toKind: 'node' }] },
    });
    expect(r.success, 'a rowRef is not a taxonomy anchor').toBe(false);
  });
});

describe('expand is bounded', () => {
  it('defaults to nothing — reads stay exactly as cheap as before', () => {
    expect(listRowsQuerySchema.parse({}).expand).toEqual([]);
  });

  it('caps at four, because a self-referencing table has a cycle to walk', () => {
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(listRowsQuerySchema.safeParse({ expand: five }).success).toBe(false);
  });
});
