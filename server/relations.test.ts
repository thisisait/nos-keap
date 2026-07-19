import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Track R3 stage 1 — the store contracts the e2e can't reach: the ToE mirror
 * (concept_relations → the generalized `relations` store) and the derived-edge
 * upsert + vocabulary growth, exercised against a real throwaway libSQL DB.
 * KEAP_DATA_DIR is set BEFORE importing ./db (the data dir is resolved at module
 * load), so this file owns its own database.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-rel-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  db.seedRelationTypes(); // boot step (server/index.ts) — call it explicitly here
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('ToE mirror (syncToeRelations)', () => {
  it('mirrors concept_relations in as confirmed node↔node with mapped confidence', () => {
    db.insertConceptRelation({ from: '01.01', to: '02.02', type: 'duality', explored: 'well' });
    db.insertConceptRelation({ from: '01.01', to: '03.03', type: 'shared-math', explored: 'barely' });
    db.insertConceptRelation({ from: '04', to: '05', type: 'related-concept', explored: null });
    db.syncToeRelations();

    const toe = db.listRelations({ source: 'toe' });
    expect(toe).toHaveLength(3);
    for (const r of toe) {
      expect(r.fromKind).toBe('node');
      expect(r.toKind).toBe('node');
      expect(r.status).toBe('confirmed');
      expect(r.source).toBe('toe');
    }
    const duality = toe.find((r) => r.type === 'duality')!;
    expect(duality.confidence).toBe(1.0); // well
    expect(toe.find((r) => r.type === 'shared-math')!.confidence).toBe(0.3); // barely
    expect(toe.find((r) => r.type === 'related-concept')!.confidence).toBeNull(); // no rating
  });

  it('is a live mirror: a re-sync reflects a deleted ToE row, leaves derived edges alone', () => {
    db.insertDerivedRelation({
      fromRef: 'obj:keep',
      fromKind: 'object',
      toRef: '01.01',
      toKind: 'node',
      type: 'supports',
      confidence: 0.9,
      justification: 'keep me',
      model: 'test',
    });
    // Drop one ToE edge at the source, then re-mirror.
    db.getDb().prepare("DELETE FROM concept_relations WHERE type = 'related-concept'").run();
    db.syncToeRelations();

    expect(db.listRelations({ source: 'toe' })).toHaveLength(2); // the dropped one is gone
    // The derived edge survived the source='toe' partition rebuild.
    const derived = db.listRelations({ source: 'derived' });
    expect(derived).toHaveLength(1);
    expect(derived[0].status).toBe('proposed');
  });

  it('claims a colliding derived edge as ToE and NULLs its classifier provenance', () => {
    // A derived+proposed edge that shares (from_ref,to_ref,type) with a ToE
    // concept_relation. On the next mirror the row must be claimed by ToE:
    // confirmed, ToE confidence, and — critically — no leftover classifier
    // justification/model (a ToE-partition row carries NULL provenance).
    db.insertConceptRelation({ from: '07.07', to: '08.08', type: 'duality', explored: 'well' });
    db.insertDerivedRelation({
      fromRef: '07.07',
      fromKind: 'node',
      toRef: '08.08',
      toKind: 'node',
      type: 'duality',
      confidence: 0.42,
      justification: 'DERIVED-justification-from-sonnet',
      model: 'claude-sonnet-derived',
    });
    db.syncToeRelations();

    const row = db
      .listRelations({ source: 'toe' })
      .find((r) => r.fromRef === '07.07' && r.toRef === '08.08' && r.type === 'duality')!;
    expect(row).toBeTruthy();
    expect(row.status).toBe('confirmed');
    expect(row.confidence).toBe(1.0); // ToE 'well' rating, not the classifier's 0.42
    expect(row.justification).toBeNull(); // classifier rationale wiped
    expect(row.model).toBeNull(); // classifier model wiped
    // And it is no longer part of the derived partition.
    expect(db.listRelations({ source: 'derived' }).some((r) => r.fromRef === '07.07')).toBe(false);
  });
});

describe('derived-edge upsert + vocabulary growth', () => {
  it('upserts idempotently on (from_ref,to_ref,type), refreshing provenance', () => {
    const before = db.listRelations({ source: 'derived' }).length;
    db.insertDerivedRelation({
      fromRef: 'obj:keep',
      fromKind: 'object',
      toRef: '01.01',
      toKind: 'node',
      type: 'supports',
      confidence: 0.42,
      justification: 'refreshed',
      model: 'test-2',
    });
    const derived = db.listRelations({ source: 'derived' });
    expect(derived).toHaveLength(before); // no duplicate row
    const row = derived.find((r) => r.fromRef === 'obj:keep' && r.type === 'supports')!;
    expect(row.confidence).toBe(0.42);
    expect(row.model).toBe('test-2');
    expect(row.status).toBe('proposed');
  });

  it('seeds the base vocabulary and grows unknown types as proposed (idempotently)', () => {
    const seeded = db.listRelationTypes();
    expect(seeded.find((t) => t.type === 'supports')!.status).toBe('seed');
    expect(seeded.some((t) => t.type === 'depends-on')).toBe(true);

    expect(db.insertProposedRelationType('wibbles-with', 'agent:test')).toBe(true);
    expect(db.insertProposedRelationType('wibbles-with', 'agent:test')).toBe(false); // no re-growth
    expect(db.getRelationType('wibbles-with')!.status).toBe('proposed');
  });

  it('relationPairExists sees either direction', () => {
    expect(db.relationPairExists('obj:keep', '01.01')).toBe(true);
    expect(db.relationPairExists('01.01', 'obj:keep')).toBe(true); // reversed
    expect(db.relationPairExists('nope', 'nada')).toBe(false);
  });
});
