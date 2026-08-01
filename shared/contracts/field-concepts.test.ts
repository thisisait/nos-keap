import { describe, expect, it } from 'vitest';
import {
  FIELD_CONCEPTS,
  FIELD_CONCEPT_BY_ID,
  FIELD_CONCEPT_ID,
  checkConceptBinding,
  fieldConceptSchema,
} from './field-concepts';
import { columnKindSchema, validateColumnConcepts } from './table';

/**
 * L1 vocabulary gates. Two of these exist because field-concepts.ts
 * deliberately does NOT import table.ts (that would be an import cycle between
 * two modules building zod schemas at load time) — the compile-time link that
 * buys is repaid here.
 */
describe('field concept vocabulary', () => {
  it('every declared kind is a real ColumnKind', () => {
    // The cost of breaking the import cycle. Without this, `kinds: ['strng']`
    // would type-check and silently reject every legal binding at runtime.
    const bad = FIELD_CONCEPTS.flatMap((c) =>
      c.kinds.filter((k) => !columnKindSchema.safeParse(k).success).map((k) => `${c.id}: ${k}`),
    );
    expect(bad).toEqual([]);
  });

  it('ids are unique and well-formed namespace.name', () => {
    const ids = FIELD_CONCEPTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => !FIELD_CONCEPT_ID.test(i))).toEqual([]);
    expect(FIELD_CONCEPT_BY_ID.size).toBe(ids.length);
  });

  it('every concept carries a description an agent can act on', () => {
    // A one-word gloss is not a definition, and the description is what an
    // agent reads when choosing a concept for a column it did not author.
    expect(FIELD_CONCEPTS.filter((c) => c.description.length < 20).map((c) => c.id)).toEqual([]);
  });

  it('is a CLOSED set — an unknown concept is refused, not accepted as free text', () => {
    expect(fieldConceptSchema.safeParse('lifecycle.status').success).toBe(true);
    expect(fieldConceptSchema.safeParse('lifecycle.statsu').success).toBe(false);
    expect(fieldConceptSchema.safeParse('Lifecycle.Status').success).toBe(false);
    expect(fieldConceptSchema.safeParse('status').success).toBe(false);
  });
});

describe('concept ↔ kind binding', () => {
  it('accepts a concept on a kind it declares', () => {
    expect(checkConceptBinding('net.port', 'number')).toBeNull();
    expect(checkConceptBinding('graph.anchor', 'taxonomyRef')).toBeNull();
  });

  it('refuses a meaning whose shape contradicts it', () => {
    // A port that is text is a declaration error, not a style choice.
    expect(checkConceptBinding('net.port', 'text')).toMatch(/may not bind/);
    expect(checkConceptBinding('machine.embedding', 'text')).toMatch(/may not bind/);
  });

  it('refuses an unknown concept before it ever reaches kind checking', () => {
    expect(checkConceptBinding('nope.nope', 'text')).toMatch(/unknown field concept/);
  });
});

describe('validateColumnConcepts', () => {
  it('passes a concept-free schema unchanged — every table that exists today', () => {
    expect(validateColumnConcepts([{ key: 'a', kind: 'text' }, { key: 'b', kind: 'number' }])).toEqual([]);
  });

  it('refuses the same meaning declared twice in one table', () => {
    // "The status of this row" must resolve to exactly one column, or every
    // query-by-concept is ambiguous and concepts buy nothing.
    const errs = validateColumnConcepts([
      { key: 'status', kind: 'select', concept: 'lifecycle.status' },
      { key: 'state', kind: 'text', concept: 'lifecycle.status' },
    ]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/already declared by column status/);
  });

  it('lets DIFFERENT tables reuse one concept — that is the whole point', () => {
    expect(validateColumnConcepts([{ key: 'status', kind: 'select', concept: 'lifecycle.status' }])).toEqual([]);
    expect(validateColumnConcepts([{ key: 'stav', kind: 'select', concept: 'lifecycle.status' }])).toEqual([]);
  });
});
