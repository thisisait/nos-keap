import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * R4 stage 1 (docs/specs/conditional-relations.md): the vocabulary splits —
 * entity verbs relate knowledge items, meta verbs relate STATEMENTS. The
 * classifier must only ever be OFFERED entity verbs; a meta verb on an entity
 * pair can never be applied correctly, and this split is the named
 * prerequisite for the whole conditional-relations track.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-relscope-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  db.seedRelationTypes();
});

describe('relation_types carries a scope', () => {
  it('every seeded verb is an entity verb (migration default)', () => {
    const types = db.listRelationTypes();
    expect(types.length).toBeGreaterThan(10);
    for (const t of types) expect(t.scope).toBe('entity');
  });

  it('a meta verb can exist without reaching the classifier vocabulary', () => {
    db.getDb()
      .prepare(
        `INSERT INTO relation_types (type, label, status, scope, created_at)
         VALUES ('conditioned-on', 'conditioned on', 'seed', 'meta', strftime('%s','now'))`,
      )
      .run();
    expect(db.getRelationType('conditioned-on')?.scope).toBe('meta');
    // The offering filter lives in the candidates route — source-law half:
    const agentSrc = readFileSync(fileURLToPath(new URL('./agent.ts', import.meta.url)), 'utf8');
    const at = agentSrc.indexOf("app.get('/agent/v1/relations/candidates'");
    const block = agentSrc.slice(at, agentSrc.indexOf('\n  app.', at + 1));
    expect(
      block.includes("t.scope === 'entity'"),
      'the candidates vocab no longer filters to entity verbs — the classifier ' +
        'can be offered a meta verb it can never apply to an entity pair',
    ).toBe(true);
  });
});
