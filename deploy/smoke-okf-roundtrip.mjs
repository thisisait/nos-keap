#!/usr/bin/env node
/**
 * OKF roundtrip smoke (S3): export from SOURCE → import into a CLEAN target
 * → approve every queued proposal as the moderator → the target's cards must
 * be IDENTICAL (same ids, same content hashes) to the source's.
 *
 * Usage:
 *   SOURCE=http://127.0.0.1:8098 TARGET=http://127.0.0.1:8099 \
 *     node deploy/smoke-okf-roundtrip.mjs
 * Both servers need identity headers accepted (dev mode / trusted admin
 * headers); TARGET must start from an empty KEAP_DATA_DIR.
 */
const SOURCE = process.env.SOURCE ?? 'http://127.0.0.1:8098';
const TARGET = process.env.TARGET ?? 'http://127.0.0.1:8099';

const ADMIN = {
  'x-authentik-uid': 'smoke-moderator',
  'x-authentik-username': 'smoke-moderator',
  'x-authentik-groups': 'nos-admins',
};

const die = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function api(base, path, init = {}) {
  const res = await fetch(base + path, { ...init, headers: { ...ADMIN, ...init.headers } });
  return res;
}

async function objectsOf(base) {
  const res = await api(base, '/api/objects');
  const json = await res.json();
  const items = json.data?.items ?? json.data ?? [];
  return Array.isArray(items) ? items : [];
}

// 1) Export from source
const exp = await api(SOURCE, '/api/objects/export.okf');
if (exp.status !== 200) die(`export status ${exp.status}`);
const zip = Buffer.from(await exp.arrayBuffer());
console.log(`export: ${zip.length} B zip`);

const sourceObjects = await objectsOf(SOURCE);
if (!sourceObjects.length) die('source has no objects — seed it first');

// 2) Import into clean target
const imp = await api(TARGET, '/api/objects/import.okf', {
  method: 'POST',
  headers: { 'content-type': 'application/zip' },
  body: zip,
});
const impJson = await imp.json();
if (!impJson.success) die(`import: ${impJson.error}`);
console.log('import:', JSON.stringify(impJson.data));
if (impJson.data.errors.length) die(`import errors: ${JSON.stringify(impJson.data.errors)}`);

// 3) Moderator approves every queued proposal on the target
const promos = await (await api(TARGET, '/api/promotions?status=proposed')).json();
for (const p of promos.data.items) {
  const d = await (
    await api(TARGET, `/api/promotions/${p.id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
  ).json();
  if (!d.success) die(`approve ${p.id}: ${d.error}`);
}
console.log(`approved: ${promos.data.items.length} proposal(s)`);

// 4) Compare id sets + content (re-export both and diff the card bodies)
const [srcZip, tgtZip] = await Promise.all([
  api(SOURCE, '/api/objects/export.okf').then((r) => r.arrayBuffer()),
  api(TARGET, '/api/objects/export.okf').then((r) => r.arrayBuffer()),
]);
const { unzipSync, strFromU8 } = await import('fflate');
const canon = (buf) => {
  const out = {};
  for (const [name, raw] of Object.entries(unzipSync(new Uint8Array(buf)))) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    // Identity = the CONTENT-bearing lines. timestamp and the keap
    // provenance keys (promotedFrom/proposedBy/approvedBy) legitimately
    // differ — an import SHOULD record its journey; content must not.
    out[name] = strFromU8(raw)
      .split('\n')
      .filter((l) => !/^(timestamp:|  (promotedFrom|proposedBy|approvedBy|rationale):)/.test(l))
      .join('\n');
  }
  return out;
};
const a = canon(srcZip);
const b = canon(tgtZip);
const aKeys = Object.keys(a).sort();
const bKeys = Object.keys(b).sort();
if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
  die(`file sets differ:\n  source: ${aKeys.join(', ')}\n  target: ${bKeys.join(', ')}`);
}
for (const k of aKeys) {
  if (a[k] !== b[k]) die(`card differs after roundtrip: ${k}`);
}
console.log(`OK: ${aKeys.length} card(s) identical after export → import → approve`);
