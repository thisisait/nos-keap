import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

/**
 * GET /agent/v1/topics?clusters=1(&members=1) — the density view the K5
 * star-formation producer (scripts/ontology-extend.mjs) reads: a dense topic
 * cluster the taxonomy has no star for is a node proposal waiting to be
 * written, and this is the only bearer-reachable source of that density.
 * Behavioural over HTTP: the cluster tables are plain SQL (migration 005), so
 * the unit env serves them for real.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-topcl-'));
process.env.KEAP_DATA_DIR = TMP;
process.env.KEAP_AGENT_TOKEN_RO = 'ro-test-token';

let db: typeof import('./db');
let server: http.Server;
let base: string;

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  const { default: express } = await import('express');
  const { registerAgentRoutes } = await import('./agent');
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const d = db.getDb();
  d.prepare(
    `INSERT INTO topic_clusters (id, label, label_auto, terms_json, centroid_json, theta, model, member_count)
     VALUES ('t-dense001', 'Fermentation', 'fermentation', '["koji","lacto"]', '[]', 0.5, 'test-model', 14)`,
  ).run();
  db.saveObject('alice', { id: 'obj-koji', type: 'note', title: 'Koji experiments', visibility: 'shared' });
  d.prepare("INSERT INTO topic_assignments (object_id, topic_id, distance) VALUES ('obj-koji', 't-dense001', 0.1)").run();
});

afterAll(() => {
  server?.close();
});

async function get(qs: string) {
  const res = await fetch(`${base}/agent/v1/topics${qs}`, {
    headers: { authorization: 'Bearer ro-test-token' },
  });
  return (await res.json()) as { data: Record<string, unknown> };
}

describe('the agent topics endpoint serves the density view', () => {
  it('without ?clusters=1 the response stays the slim status (unchanged contract)', async () => {
    const { data } = await get('');
    expect(data.stats).toBeDefined();
    expect(data.clusters).toBeUndefined();
  });

  it('?clusters=1 lists label, terms and memberCount; &members=1 adds sample titles', async () => {
    const { data } = await get('?clusters=1&members=1');
    const clusters = data.clusters as Array<Record<string, unknown>>;
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      id: 't-dense001',
      label: 'Fermentation',
      terms: ['koji', 'lacto'],
      memberCount: 14,
    });
    expect(clusters[0].members).toEqual([{ id: 'obj-koji', title: 'Koji experiments' }]);
  });
});
