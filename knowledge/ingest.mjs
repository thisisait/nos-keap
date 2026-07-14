/**
 * Canonical knowledge importer (the inverse of dump.mjs) — the single, idempotent
 * ingest path that makes knowledge/canonical/ the source of truth.
 *
 * Reads knowledge/canonical/<L0>/<L1>.json (each = one L1 domain: ext nodes +
 * K1 description overrides + briefs + typed relations), and materialises the
 * curated delta over the static seed spine into the live DB. Replaces the
 * per-domain import-domain.mjs / import-toe.mjs (one format, one code path).
 *
 * Idempotent + version-driven: each domain file's sha256 is recorded in
 * knowledge_imports; an unchanged file is SKIPPED, a changed file re-applies
 * (reset its L1 subtree/overrides/relations, then re-insert). A blank DB has no
 * markers → everything applies. Raw-SQL rows; a CONTAINER RESTART then lets boot
 * materialise (registerExtNode → applyDescriptionOverride → rebuildFts →
 * ensureLayout APPEND — U1 layout of existing stars never re-bakes).
 *
 * Runs IN the container (libSQL driver — NEVER host sqlite3). Read-only on the
 * DB under --dry-run.
 *
 *   node knowledge/ingest.mjs [--dry-run] [--force] [--canonical <dir>]
 *   env: KEAP_DATA_DIR (default /app/data), CANONICAL_DIR
 *
 * Emits a machine-readable trailer line `INGEST_RESULT {json}` the role reads to
 * decide whether to restart (changed:true).
 */
import Database from 'libsql';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KEAP_DATA_DIR ?? '/app/data';
const CANON = process.argv.includes('--canonical')
  ? process.argv[process.argv.indexOf('--canonical') + 1]
  : (process.env.CANONICAL_DIR ?? path.join(__dir, 'canonical'));
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DB_PATH = path.join(DATA_DIR, 'keap.db');

// ── discover domain files (recursively; skip manifest.json) ─────────────────
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith('.json') && e !== 'manifest.json') out.push(p);
  }
  return out;
}
const files = walk(CANON).sort();

const db = new Database(DB_PATH, DRY ? { readonly: true } : {});
if (!DRY) db.exec('PRAGMA journal_mode=WAL');
// Marker + relation tables (ship in server/db.ts SCHEMA; guard for a pre-boot DB).
if (!DRY) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_imports (import_key TEXT PRIMARY KEY, source_sha TEXT NOT NULL, n_nodes INTEGER NOT NULL DEFAULT 0, n_relations INTEGER NOT NULL DEFAULT 0, applied_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS concept_relations (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, explored TEXT, source TEXT DEFAULT 'toe', PRIMARY KEY (from_id, to_id, type))`);
}
const markerOf = (key) => {
  try { return (db.prepare('SELECT source_sha FROM knowledge_imports WHERE import_key = ?').get(key) || {}).source_sha ?? null; }
  catch { return null; } // table may not exist yet under --dry-run on a fresh DB
};

const ACTOR = 'agent:knowledge-ingest';
const insNode = DRY ? null : db.prepare(`INSERT INTO taxonomy_nodes_ext (id, parent_id, name, description, zone, ordinal, proposed_by, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, '${ACTOR}', '${ACTOR}', ?)`);
const insDesc = DRY ? null : db.prepare(`INSERT INTO node_descriptions (node_id, description_en, description_cs, proposed_by, approved_by) VALUES (?, ?, ?, '${ACTOR}', '${ACTOR}') ON CONFLICT(node_id) DO UPDATE SET description_en = excluded.description_en, description_cs = excluded.description_cs`);
const insMeta = DRY ? null : db.prepare(`INSERT INTO taxonomy_metadata (id, data, updated_by) VALUES (?, ?, '${ACTOR}') ON CONFLICT(id) DO UPDATE SET data = excluded.data`);
const insRel = DRY ? null : db.prepare(`INSERT INTO concept_relations (from_id, to_id, type, explored, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(from_id, to_id, type) DO UPDATE SET explored = excluded.explored`);
const insMarker = DRY ? null : db.prepare(`INSERT INTO knowledge_imports (import_key, source_sha, n_nodes, n_relations, applied_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(import_key) DO UPDATE SET source_sha = excluded.source_sha, n_nodes = excluded.n_nodes, n_relations = excluded.n_relations, applied_at = excluded.applied_at`);

let clock = Math.floor(Date.now() / 1000);
const tick = () => clock++;

function applyDomain(key, doc) {
  // reset this L1's ext subtree + overrides + metadata + from-keyed relations
  const self = `'${key}'`, sub = `'${key}.%'`;
  db.exec(`DELETE FROM taxonomy_nodes_ext WHERE id = ${self} OR id LIKE ${sub}`);
  db.exec(`DELETE FROM node_descriptions  WHERE node_id = ${self} OR node_id LIKE ${sub}`);
  db.exec(`DELETE FROM taxonomy_metadata  WHERE id = ${self} OR id LIKE ${sub}`);
  db.exec(`DELETE FROM concept_relations  WHERE from_id = ${self} OR from_id LIKE ${sub}`);
  // insert nodes parent-first (id-sorted → a parent id is a prefix of its children)
  const nodes = [...doc.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of nodes) {
    // descriptions are the SoT — store VERBATIM (TEXT columns, no length cap);
    // clipping/normalising here would break the dump↔ingest round-trip identity.
    const en = n.en ?? '';
    const cs = n.cs ?? null;
    if (n.kind === 'ext') {
      insNode.run(n.id, n.parentId, n.name, en, n.zone || 'votable', n.ordinal ?? 0, tick());
    }
    insDesc.run(n.id, en, cs);
    if (n.brief) insMeta.run(n.id, JSON.stringify({ brief: n.brief, briefMeta: { source: 'knowledge', domain: key } }));
  }
  let nRel = 0;
  const txn = db.transaction(() => {
    for (const r of doc.relations || []) { insRel.run(r.from, r.to, r.type, r.explored ?? null, r.source || 'knowledge'); nRel++; }
  });
  txn();
  return { nNodes: nodes.length, nRel };
}

const applied = [], skipped = [];
for (const f of files) {
  const bytes = readFileSync(f);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const doc = JSON.parse(bytes.toString('utf8'));
  const key = doc.domain || path.basename(f, '.json');
  const unchanged = !FORCE && markerOf(key) === sha;
  if (unchanged) { skipped.push(key); continue; }
  if (DRY) { applied.push(key); console.log(`would apply ${key} (${doc.nodes.length} nodes, ${(doc.relations || []).length} rel)`); continue; }
  const { nNodes, nRel } = applyDomain(key, doc);
  insMarker.run(key, sha, nNodes, nRel, new Date(clock * 1000).toISOString());
  applied.push(key);
  console.log(`applied ${key}: ${nNodes} nodes, ${nRel} relations`);
}

const changed = applied.length > 0;
console.log(`${DRY ? '[dry-run] ' : ''}${applied.length} applied, ${skipped.length} skipped${DRY && changed ? ' — RESTART would follow' : changed ? ' — RESTART to materialize' : ''}`);
console.log(`INGEST_RESULT ${JSON.stringify({ applied, skipped, changed, dryRun: DRY })}`);
db.close();
