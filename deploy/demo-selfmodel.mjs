/**
 * Local self-model demo — `npm run demo:selfmodel`.
 *
 * Boots a throwaway KEAP with the e2e selfmodel fixture through the REAL
 * channels, in the REAL order:
 *
 *   1. scratch DB + canonical ingest (slug root `nos` → stacks → systems →
 *      credential), BEFORE the server boots — the playbook's ingest→restart
 *      order, so boot-time registration is what you are looking at
 *   2. server boot (registers the subtree, places the root on its own ring)
 *   3. skill cards land as FILES under the shared uid and fs-sync mirrors them
 *      (frontmatter decides type/title; anchors resolve, danglingAnchors 0)
 *   4. the mechanical Requires: producer posts `requires` relations
 *   5. they are auto-CONFIRMED here — demo only; live moderation stays manual
 *
 * Then it prints the URL and stays attached until Ctrl+C. Nothing here touches
 * the live container, the live DB, or the repo's canonical/ tree.
 *
 * Look at:  /explore?core=fs   — nos constellation on the outer ring, skill
 *                                stations orbiting their systems
 *           toggle «Ontologie» — requires edges, verb-labelled
 *           side panel on nos.iiab.nextcloud.credential — grouped by verb
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

const REPO = path.resolve('.');
const DIR = path.join(REPO, 'e2e', '.demo');

/** First port free on IPv4 loopback. A Docker-published port holds 127.0.0.1
 *  while Node can still bind the same number on IPv6 — the server then boots
 *  "fine" and every localhost probe lands on the container's 404 instead. */
const freePort = (from) =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(freePort(from + 1)));
    srv.listen(from, '127.0.0.1', () => srv.close(() => resolve(from)));
  });
const PORT = process.env.PORT ? Number(process.env.PORT) : await freePort(8123);
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(path.join(REPO, 'dist-server', 'index.js'))) {
  console.error('✗ dist-server missing — run `npm run build` first');
  process.exit(1);
}

console.log('· scratch data dir:', DIR);
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const env = { ...process.env, KEAP_DATA_DIR: DIR };
execFileSync('node', ['knowledge/roundtrip-setup.mjs'], { env, stdio: 'ignore' });
execFileSync('node', ['knowledge/ingest.mjs', '--canonical', 'e2e/fixtures/selfmodel'], { env, stdio: 'inherit' });

const USERFILES = path.join(DIR, 'userfiles');
cpSync(path.join(REPO, 'e2e', 'fixtures', 'selfmodel-skills'), path.join(USERFILES, 'nos-docs', 'nOS', 'skills'), {
  recursive: true,
});

console.log('· booting on', BASE);
const server = spawn('node', ['dist-server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    KEAP_DATA_DIR: DIR,
    KEAP_USER_FILES_DIR: USERFILES,
    KEAP_FS_SHARED_UIDS: 'nos-docs',
    KEAP_FS_SYNC_DIRS: 'documents,library,inbox,nOS',
    KEAP_FS_SYNC_INTERVAL_S: '0',
    KEAP_TENANT_DOMAIN: 'demo.local',
    KEAP_AGENT_TOKEN_RO: 'demo-ro',
    KEAP_AGENT_TOKEN_RW: 'demo-rw',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
server.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => server.kill('SIGINT'));

const until = async (fn, label, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`✗ gave up waiting for ${label}`);
  server.kill();
  process.exit(1);
};

await until(async () => (await fetch(`${BASE}/api/health`)).ok, 'health');

// fs-sync the skill cards, then run the producer and confirm for the demo.
const rw = { authorization: 'Bearer demo-rw', 'content-type': 'application/json' };
const sync = await (await fetch(`${BASE}/agent/v1/fs/sync?wait=1`, { method: 'POST', headers: rw, body: '{}' })).json();
console.log(`· fs-sync: ${sync.data?.upserted ?? '?'} card(s), danglingAnchors=${sync.data?.danglingAnchors ?? 0}`);

execFileSync('node', ['scripts/skills-requires.mjs', 'post'], {
  env: { ...process.env, KEAP_BASE_URL: BASE, KEAP_AGENT_TOKEN_RO: 'demo-ro', KEAP_AGENT_TOKEN_RW: 'demo-rw' },
  stdio: 'inherit',
});

// Demo-only auto-confirm (headerless requests get the local dev admin identity).
const admin = await (await fetch(`${BASE}/api/admin/relations?status=proposed`)).json();
for (const rel of admin.data?.relations ?? []) {
  if (rel.type !== 'requires') continue;
  await fetch(`${BASE}/api/admin/relations/${rel.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'confirmed' }),
  });
}
console.log('· requires relations confirmed (demo-only auto-confirm)');
console.log('');
console.log(`▶ open ${BASE}/explore?core=fs   (Ctrl+C stops the demo)`);
console.log('   — «nos» constellation on the outer ring, skills as stations');
console.log('   — Ontologie toggle: verb-labelled requires edges');
console.log('   — Sources panel: filter by the «skill» facet');
