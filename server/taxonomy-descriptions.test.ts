import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

/**
 * GET /api/taxonomy-descriptions — the bulk id→description projection the
 * Admin tree reads. The prose left the bulk /api/graph payload
 * (explore-decomplexity Phase A) and the admin list was left reading only the
 * curated taxonomy_metadata overlay, so canonical K1 descriptions went blank
 * and unsearchable. This test pins the light re-entry: the map serves the
 * canonical description for seed nodes without any curated overlay row.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-taxdesc-'));
process.env.KEAP_DATA_DIR = TMP;
process.env.KEAP_TRUSTED_PROXY = '1';
delete process.env.KEAP_PROXY_SHARED_SECRET;

let server: http.Server;
let base: string;

beforeAll(async () => {
  const db = await import('./db');
  await db.initDb();
  const { default: express } = await import('express');
  const { registerApiRoutes } = await import('./routes');
  const { identityMiddleware } = await import('./identity');
  const app = express();
  app.use(express.json());
  app.use(identityMiddleware);
  registerApiRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
});

describe('the bulk description map serves canonical prose', () => {
  it('returns a non-trivial id→description map matching the taxonomy oracle', async () => {
    const res = await fetch(`${base}/api/taxonomy-descriptions`, {
      headers: { 'x-authentik-username': 'alice', 'x-authentik-groups': 'nos-users' },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, string> };
    const ids = Object.keys(data);
    // Seed prose alone covers multiple nodes — an empty/near-empty map means
    // the endpoint regressed to the curated overlay again (the exact bug).
    expect(ids.length).toBeGreaterThan(5);
    const { getNode } = await import('./taxonomy');
    for (const id of ids.slice(0, 5)) {
      expect(data[id]).toBe(getNode(id)?.description);
      expect(data[id].length).toBeGreaterThan(0);
    }
  });

  it('serves K1 description overrides — the canonical layer Admin lost', async () => {
    const { allNodes, applyDescriptionOverride } = await import('./taxonomy');
    // Pick a seed node with no prose and give it a K1 override, exactly as
    // index.ts does at startup from node_descriptions.
    const bare = allNodes().find((n) => !n.description && !n.ext)!;
    expect(bare).toBeDefined();
    applyDescriptionOverride({ nodeId: bare.id, descriptionEn: 'K1 canonical prose for the admin tree' });
    const res = await fetch(`${base}/api/taxonomy-descriptions`, {
      headers: { 'x-authentik-username': 'alice', 'x-authentik-groups': 'nos-users' },
    });
    const { data } = (await res.json()) as { data: Record<string, string> };
    expect(data[bare.id]).toBe('K1 canonical prose for the admin tree');
  });
});
