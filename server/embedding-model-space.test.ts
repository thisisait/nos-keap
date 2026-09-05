import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ONE MODEL, ONE SPACE. A mixed-model embeddings table is a sanctioned state
 * (topics.ts:49 — "the norm when a parallel nOS sidekick embeds under a second
 * model"), but a cosine distance across two models is NOISE: related pairs
 * split across models read as unrelated, sweeps report "corpus exhausted",
 * and a KEAP_EMBED_MODEL flip re-embeds nothing because the hash-only diff
 * says everything is current.
 *
 * Source-law, not behavioural: vector_distance_cos/vector32 live in the libSQL
 * vector extension the unit env does not load (vectorsOk=false), so the SQL
 * can only be asserted as text here. The live estate's recall gate is the
 * behavioural half.
 */
const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

describe('every distance is computed inside one model space', () => {
  const dbSrc = read('./db.ts');

  it('nearPairs and nearCrossKindPairs join only same-model rows', () => {
    const selfJoins = dbSrc.match(/JOIN embeddings b ON a\.rowid < b\.rowid/g) ?? [];
    expect(selfJoins.length, 'the two pair-sweep queries are gone?').toBeGreaterThanOrEqual(2);
    const modelPredicates = dbSrc.match(/a\.model = b\.model/g) ?? [];
    expect(
      modelPredicates.length,
      'a pair sweep compares vectors across models — cross-model cosine is noise ' +
        'and the sweep will report "corpus exhausted" over pairs it never truly compared',
    ).toBeGreaterThanOrEqual(selfJoins.length);
  });

  it('vectorNeighborsOf can scope to the query vector’s model, and the anchor variant passes its own', () => {
    expect(dbSrc).toMatch(/modelFilter = model \? 'AND e\.model = \?'/);
    expect(
      /vectorNeighborsOf\(anchor\.v[\s\S]{0,120}anchor\.model\)/.test(dbSrc),
      'vectorNeighbors no longer scopes neighbours to the anchor row’s own model',
    ).toBe(true);
  });

  it('the live-embed callers pass EMBED_MODEL', () => {
    for (const f of ['./search.ts', './agent.ts']) {
      expect(
        /vectorNeighborsOf\([\s\S]{0,200}?EMBED_MODEL\)/.test(read(f)),
        `${f} queries neighbours without scoping to EMBED_MODEL's space`,
      ).toBe(true);
    }
  });

  it('the pending diff is stale on model change, not only content change', () => {
    expect(read('./embeddings.ts')).toMatch(/row\.model !== EMBED_MODEL/);
    expect(
      dbSrc.includes('SELECT ref_id, content_hash, model FROM embeddings'),
      'getEmbeddingHashes dropped the model column — a KEAP_EMBED_MODEL flip would ' +
        're-embed nothing and every distance would run over a frozen old-model space',
    ).toBe(true);
  });

  it('topicsStale compares against assignments that still have an incumbent vector', () => {
    expect(
      read('./topics.ts').includes('db.assignedWithVectors(resolved.model)'),
      'topicsStale is back on the raw assignment count, which the carry-forward ' +
        'rows make permanently unequal — an un-caused recluster every boot, forever',
    ).toBe(true);
  });
});
