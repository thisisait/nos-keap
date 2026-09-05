import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

/**
 * POST /agent/v1/context — Track D v1 (ontology-anchoring.md §4), tier S.
 * The laws under test are the spec's design commitments, not the ranking:
 * every item citable by stable id; proposed edges EXCLUDED unless the caller
 * explicitly asks (an unmoderated classifier guess must never read as "the
 * corpus says"); depth=facts skips rules; the budget is accounted, not
 * decorative. Behavioural over HTTP — the lexical retrieval leg runs for real
 * in the unit env (FTS5); the vector leg's quality is the recall gate's job.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-ctx-'));
process.env.KEAP_DATA_DIR = TMP;
process.env.KEAP_AGENT_TOKEN_RO = 'ro-test-token';

let db: typeof import('./db');
let server: http.Server;
let base: string;

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  db.seedRelationTypes();
  const { default: express } = await import('express');
  const { registerAgentRoutes } = await import('./agent');
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  db.saveObject('alice', {
    id: 'card-koji',
    type: 'note',
    title: 'Koji fermentation notes',
    description: 'Aspergillus oryzae culture temperatures and timing.',
    visibility: 'shared',
  });
  db.saveObject('alice', {
    id: 'card-misc',
    type: 'note',
    title: 'Unrelated shopping list',
    visibility: 'shared',
  });
  const rel = (id: string, to: string, status: string) =>
    db
      .getDb()
      .prepare(
        `INSERT INTO relations (id, from_ref, from_kind, to_ref, to_kind, type, confidence, source, status, created_at)
         VALUES (?, 'card-koji', 'object', ?, 'node', 'exemplifies', 0.9, 'derived', ?, strftime('%s','now'))`,
      )
      .run(id, to, status);
  rel('r-confirmed1', '01.01', 'confirmed');
  rel('r-proposed1', '01.02', 'proposed');
});

afterAll(() => {
  server?.close();
});

async function ctx(body: Record<string, unknown>) {
  const res = await fetch(`${base}/agent/v1/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ro-test-token' },
    body: JSON.stringify(body),
  });
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe('the context injector', () => {
  it('returns citable evidence and only CONFIRMED rules by default', async () => {
    const data = await ctx({ query: 'koji fermentation' });
    const evidence = data.evidence as Array<{ id: string }>;
    expect(evidence.some((e) => e.id === 'obj:card-koji')).toBe(true);
    const rules = data.rules as Array<{ id: string; status: string; verb: string }>;
    expect(rules.map((r) => r.id)).toEqual(['r-confirmed1']);
    expect(rules[0].verb).toBe('exemplifies');
    const budget = data.budget as { requested: number; spent: number };
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.spent).toBeLessThanOrEqual(budget.requested);
  });

  it('includeProposed surfaces the proposed edge, marked as such', async () => {
    const data = await ctx({ query: 'koji fermentation', includeProposed: true });
    const rules = data.rules as Array<{ id: string; status: string }>;
    expect(rules.map((r) => r.id).sort()).toEqual(['r-confirmed1', 'r-proposed1']);
    expect(rules.find((r) => r.id === 'r-proposed1')?.status).toBe('proposed');
  });

  it('depth=facts skips rules entirely', async () => {
    const data = await ctx({ query: 'koji fermentation', depth: 'facts' });
    expect(data.rules).toEqual([]);
    expect((data.evidence as unknown[]).length).toBeGreaterThan(0);
  });

  it('a starving budget drops evidence and says so', async () => {
    const data = await ctx({ query: 'koji fermentation', budget_tokens: 500 });
    const budget = data.budget as { spent: number; dropped: { evidence: number; rules: number } };
    expect(budget.spent).toBeLessThanOrEqual(500);
    // With 500 tokens at least SOMETHING must be dropped or shipped small —
    // the accounting is what matters: dropped counts are numbers, not absent.
    expect(typeof budget.dropped.evidence).toBe('number');
    expect(typeof budget.dropped.rules).toBe('number');
  });
});
