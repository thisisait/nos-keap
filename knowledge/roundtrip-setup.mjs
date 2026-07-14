/**
 * Create an empty scratch DB with the base taxonomy tables ingest.mjs/dump.mjs
 * touch (the subset of server/db.ts SCHEMA), for the CI round-trip identity test:
 *   ingest(canonical) → dump → diff == 0.
 * Usage: KEAP_DATA_DIR=/tmp/scratch node knowledge/roundtrip-setup.mjs
 */
import Database from 'libsql';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.KEAP_DATA_DIR ?? '/tmp/scratch';
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'keap.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS taxonomy_nodes_ext (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, zone TEXT NOT NULL, ordinal INTEGER NOT NULL, proposed_by TEXT NOT NULL, approved_by TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS node_descriptions (node_id TEXT PRIMARY KEY, description_en TEXT NOT NULL, description_cs TEXT, proposed_by TEXT NOT NULL, approved_by TEXT NOT NULL, updated_at INTEGER DEFAULT (strftime('%s','now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS taxonomy_metadata (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_by TEXT, updated_at INTEGER DEFAULT (strftime('%s','now')))`);
console.log('scratch schema ready at', DATA_DIR);
db.close();
