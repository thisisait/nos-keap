/**
 * Round-trip identity test (CI gate): ingest(canonical) → dump → diff == 0.
 * Proves knowledge/ingest.mjs and knowledge/dump.mjs are exact inverses, so the
 * canonical files are a faithful, losslessly re-importable SoT. No live system —
 * runs against a scratch libSQL DB in a temp dir.
 *
 *   node knowledge/roundtrip.mjs
 *   exit 0 = identity holds, 1 = mismatch (diffs printed).
 */
import Database from 'libsql';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANON = path.join(HERE, 'canonical');
const stamp = `${process.pid}-${Date.now()}`;
const DATA = path.join('/tmp', `kt-${stamp}`);
const OUT = path.join('/tmp', `ktd-${stamp}`);

function loadDir(root) {
  const nodes = new Map(); const rels = new Set();
  const walk = (d) => { for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.json') && e !== 'manifest.json') {
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      for (const n of doc.nodes) nodes.set(n.id, n);
      for (const r of doc.relations || []) rels.add(`${r.from}|${r.to}|${r.type}|${r.explored ?? ''}`);
    }
  } };
  walk(root);
  return { nodes, rels };
}

try {
  mkdirSync(DATA, { recursive: true });
  // scratch schema (the subset ingest/dump touch)
  const db = new Database(path.join(DATA, 'keap.db'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS taxonomy_nodes_ext (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, zone TEXT NOT NULL, ordinal INTEGER NOT NULL, proposed_by TEXT NOT NULL, approved_by TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS node_descriptions (node_id TEXT PRIMARY KEY, description_en TEXT NOT NULL, description_cs TEXT, proposed_by TEXT NOT NULL, approved_by TEXT NOT NULL, updated_at INTEGER DEFAULT (strftime('%s','now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS taxonomy_metadata (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_by TEXT, updated_at INTEGER DEFAULT (strftime('%s','now')))`);
  db.close();

  const env = { ...process.env, KEAP_DATA_DIR: DATA };
  execFileSync('node', [path.join(HERE, 'ingest.mjs'), '--canonical', CANON], { env, stdio: 'inherit' });
  execFileSync('node', [path.join(HERE, 'dump.mjs')], { env: { ...env, OUT_DIR: OUT }, stdio: 'inherit' });

  const a = loadDir(CANON); const b = loadDir(OUT);
  const FIELDS = ['parentId', 'name', 'level', 'zone', 'ordinal', 'kind', 'en', 'cs', 'brief'];
  const missing = [...a.nodes.keys()].filter((k) => !b.nodes.has(k));
  const extra = [...b.nodes.keys()].filter((k) => !a.nodes.has(k));
  let diffs = 0;
  for (const id of a.nodes.keys()) {
    if (!b.nodes.has(id)) continue;
    for (const f of FIELDS) if (JSON.stringify(a.nodes.get(id)[f]) !== JSON.stringify(b.nodes.get(id)[f])) {
      if (diffs < 10) console.error(`  DIFF ${id}.${f}`);
      diffs++;
    }
  }
  const relSym = [...a.rels].filter((r) => !b.rels.has(r)).length + [...b.rels].filter((r) => !a.rels.has(r)).length;
  console.log(`nodes A=${a.nodes.size} B=${b.nodes.size} | missing=${missing.length} extra=${extra.length} field-diffs=${diffs} | rel sym-diff=${relSym}`);
  const ok = !missing.length && !extra.length && !diffs && !relSym;
  console.log(ok ? '✓ ROUND-TRIP IDENTITY OK' : '✗ ROUND-TRIP MISMATCH');
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(DATA, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
}
