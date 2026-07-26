import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';

/**
 * P-5 — the cutover switch, proven against the BUILT server in ORGAN mode.
 *
 * Every other spec in this suite runs against the shared playwright webServer,
 * which is local-mode by construction. Organ mode cannot be tested there without
 * flipping the whole suite onto a backend that does not exist in CI, so this
 * spec owns its own pair of processes:
 *
 *   stub organ  — a bare http server that RECORDS what KEAP sent it
 *   KEAP        — dist-server/index.js, the shipped artifact, CORTEX_BACKEND_URL
 *                 pointed at the stub, on its own port and its own data dir
 *
 * What this proves that server/cortex-backend.test.ts cannot: the routes are
 * actually WIRED to the switch. The unit suite tests the client in isolation and
 * would stay green if `registerAgentRoutes` never called it — which is precisely
 * the mistake that ships a cutover doing nothing.
 */
test.describe.configure({ mode: 'serial' });

const RO = { Authorization: 'Bearer cutover-ro', 'Content-Type': 'application/json' };
const DATA_DIR = 'e2e/.data-cutover';

const ORGAN_BINDING = {
  ontologyVersion: 'onto1:organ-side',
  databaseId: 'organ-database-uuid',
  opcodeRegistryHash: 'cx1:organ-side',
};

/** The report the stub answers with. Deliberately carries an impossible marker:
 *  if this string ever comes back from a run where the stub was never called,
 *  the assertion is lying and the local typechecker answered. */
const ORGAN_REPORT = {
  valid: true,
  phase: 1,
  complete: true,
  scope: { model: 'system-ontology', authorizes: false },
  ast: { source: 'PROXIED', binding: ORGAN_BINDING },
  errors: [],
  warnings: [],
  truncated: false,
};

type Recorded = { path: string; method: string; auth: string | undefined; body: string };

let organ: http.Server;
let organUrl: string;
let organDown = false;
let recorded: Recorded[] = [];
let keap: ChildProcess;
let keapUrl: string;

function startOrgan(): Promise<void> {
  return new Promise((resolve) => {
    organ = http.createServer((req, res) => {
      // The kill switch for the "organ is down" case. Closing the real socket
      // mid-suite races the KEAP process's keep-alive pool; refusing at the
      // application layer is the same observable outcome for the client (a
      // CortexBackendError) and is deterministic.
      if (organDown) return req.socket.destroy();

      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        recorded.push({
          path: req.url ?? '',
          method: req.method ?? '',
          auth: req.headers.authorization,
          body,
        });
        const send = (data: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true, data }));
        };
        if (req.url === '/health') return send({ status: 'OK', binding: ORGAN_BINDING });
        if (req.url === '/agent/v1/validate') return send(ORGAN_REPORT);
        if (req.url === '/agent/v1/validate/opcodes') {
          return send({ contract: 1, registryHash: 'cx1:organ-side', opcodes: [{ name: 'organ-only-opcode' }] });
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'stub: no such route' }));
      });
    });
    organ.listen(0, '127.0.0.1', () => {
      organUrl = `http://127.0.0.1:${(organ.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

async function startKeap(): Promise<void> {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const port = 18400;
  keapUrl = `http://127.0.0.1:${port}`;
  keap = spawn('node', ['dist-server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      KEAP_DATA_DIR: DATA_DIR,
      KEAP_AGENT_TOKEN_RO: 'cutover-ro',
      KEAP_AGENT_TOKEN_RW: 'cutover-rw',
      // The switch under test, and the credential the proxy presents.
      CORTEX_BACKEND_URL: organUrl,
      CORTEX_TOKEN_RO: 'organ-ro-secret',
      // Keep this process off the shared fixtures entirely.
      KEAP_FS_SYNC_INTERVAL_S: '0',
      // The probe cache exists so an external monitor cannot set the request
      // rate against the organ (server/cortex-backend.ts). This suite toggles
      // the organ's reachability BETWEEN health calls, so the production 15 s
      // memo would make the down-case read a stale 'reachable: true'. The
      // memoisation itself is covered by the unit suite, where time is a
      // parameter rather than something to wait for.
      CORTEX_PROBE_CACHE_MS: '0',
    },
    stdio: 'pipe',
  });
  keap.stderr?.on('data', (d) => process.stderr.write(`[keap-cutover] ${d}`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${keapUrl}/agent/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('cutover KEAP server did not become healthy');
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.beforeAll(async () => {
  await startOrgan();
  await startKeap();
});

test.afterAll(async () => {
  keap?.kill('SIGTERM');
  await new Promise<void>((resolve) => organ.close(() => resolve()));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test.beforeEach(() => {
  recorded = [];
  organDown = false;
});

test('validate is answered by the organ, not by the local typechecker', async () => {
  const res = await fetch(`${keapUrl}/agent/v1/validate`, {
    method: 'POST',
    headers: RO,
    body: JSON.stringify({ source: 'get(tax:root)' }),
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();

  // The marker: the local typechecker can never produce this, because it stamps
  // ast.source with the program it was given and ast.binding with THIS database.
  expect(data.ast.source).toBe('PROXIED');
  expect(data.ast.binding.databaseId).toBe('organ-database-uuid');

  const call = recorded.find((r) => r.path === '/agent/v1/validate');
  expect(call, 'KEAP never called the organ — the route is not wired to the switch').toBeTruthy();
  expect(call!.method).toBe('POST');
  // KEAP presents its OWN organ credential; the caller's bearer stops at KEAP.
  expect(call!.auth).toBe('Bearer organ-ro-secret');
  expect(JSON.parse(call!.body).source).toBe('get(tax:root)');
  // The TTL default is applied by KEAP's envelope schema before the proxy hop,
  // so the organ receives a clamped value and never has to re-derive one.
  expect(JSON.parse(call!.body).ttlSeconds).toBe(900);
});

test('the envelope is still KEAP’s 400 to give, and never reaches the organ', async () => {
  const res = await fetch(`${keapUrl}/agent/v1/validate`, {
    method: 'POST',
    headers: RO,
    body: JSON.stringify({ ttlSeconds: 900 }),
  });
  expect(res.status).toBe(400);
  expect(recorded.filter((r) => r.path === '/agent/v1/validate')).toHaveLength(0);
});

test('auth is enforced BEFORE the proxy hop', async () => {
  const res = await fetch(`${keapUrl}/agent/v1/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'get(tax:root)' }),
  });
  expect(res.status).toBe(401);
  // An unauthenticated caller must not be able to make KEAP originate traffic.
  expect(recorded).toHaveLength(0);
});

test('the opcode registry served is the organ’s, not the local copy', async () => {
  const res = await fetch(`${keapUrl}/agent/v1/validate/opcodes`, { headers: RO });
  const { data } = await res.json();
  expect(data.registryHash).toBe('cx1:organ-side');
  expect(data.opcodes[0].name).toBe('organ-only-opcode');
});

test('health names the backend and reports port drift', async () => {
  const res = await fetch(`${keapUrl}/agent/v1/health`);
  const { data } = await res.json();

  expect(data.cortex.backend).toBe('organ');
  expect(data.cortex.url).toBe(organUrl);
  expect(data.cortex.reachable).toBe(true);
  expect(data.cortex.binding).toEqual(ORGAN_BINDING);
  // `ontology.version` stays this store's OWN derived hash in both modes.
  expect(data.ontology.version).toMatch(/^onto1:/);
  expect(data.ontology.version).not.toBe(ORGAN_BINDING.ontologyVersion);
  // ...and because they differ, the drift detector must say so rather than
  // report a reassuring 'match'.
  expect(data.cortex.ontologyDrift).toBe('differs');
});

test('an unreachable organ is a 502 — never a silent fall back to local', async () => {
  organDown = true;
  const res = await fetch(`${keapUrl}/agent/v1/validate`, {
    method: 'POST',
    headers: RO,
    body: JSON.stringify({ source: 'get(tax:root)' }),
  });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.success).toBe(false);
  expect(body.error).toMatch(/unreachable/);
  // The decisive part: no report came back at all. A fallback would have
  // answered 200 with a locally-stamped AST while the operator believed the
  // organ was live.
  expect(body.data).toBeUndefined();
});

test('health still answers while the organ is down, and says why', async () => {
  organDown = true;
  const res = await fetch(`${keapUrl}/agent/v1/health`);
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.status).toBe('OK');
  expect(data.cortex.reachable).toBe(false);
  expect(data.cortex.error).toBeTruthy();
  // Unknown, not guessed: with no organ digest to compare against, a verdict
  // either way would be an invention.
  expect(data.cortex.ontologyDrift).toBeNull();
});
