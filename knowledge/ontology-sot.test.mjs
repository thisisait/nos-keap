import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'libsql';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

/**
 * The ontology layer (R3 verb registry + moderated typed edges) as a versioned
 * source of truth — the gap that let the 2026-07-22 data-dir reset take the
 * whole moderated relation set with it, silently, for two days.
 *
 * knowledge/roundtrip.mjs already gates ingest∘dump identity, but only over the
 * files the repo actually carries — and the ontology layer shipped with ZERO
 * relations, so that gate proves nothing about relations. This suite supplies
 * the data the repo lacks: every status, both sources, present and absent
 * optional fields, and the rejection paths.
 *
 * PLAIN ESM ON PURPOSE. Everything it tests is .mjs, and it runs in the
 * `knowledge` CI workflow, which installs with --ignore-scripts to stay
 * independent of the app build. That skips the `wxt prepare` postinstall, so
 * .wxt/tsconfig.json — which tsconfig.extension.json extends, and which the root
 * tsconfig references — never exists, and the TS transform then fails to resolve
 * a tsconfig for ANY .ts file in the repo. A TypeScript test here would drag the
 * whole browser-extension toolchain into a data-only gate.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUMP = path.join(HERE, 'dump.mjs');
const INGEST = path.join(HERE, 'ingest.mjs');

let TMP;

/** Schema subset ingest/dump touch. Mirrors migration 006 + the canonical tables. */
function scratchDb(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'keap.db'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS taxonomy_nodes_ext (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, zone TEXT NOT NULL, ordinal INTEGER NOT NULL, proposed_by TEXT NOT NULL, approved_by TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS node_descriptions (node_id TEXT PRIMARY KEY, description_en TEXT NOT NULL, description_cs TEXT, proposed_by TEXT NOT NULL, approved_by TEXT NOT NULL, updated_at INTEGER DEFAULT (strftime('%s','now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS taxonomy_metadata (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_by TEXT, updated_at INTEGER DEFAULT (strftime('%s','now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS concept_relations (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, explored TEXT, source TEXT DEFAULT 'toe', PRIMARY KEY (from_id, to_id, type))`);
  db.exec(`CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, from_ref TEXT NOT NULL, to_ref TEXT NOT NULL, from_kind TEXT NOT NULL DEFAULT 'node', to_kind TEXT NOT NULL DEFAULT 'node', type TEXT NOT NULL, confidence REAL, justification TEXT, source TEXT NOT NULL DEFAULT 'derived', status TEXT NOT NULL DEFAULT 'proposed', model TEXT, created_at INTEGER, UNIQUE (from_ref, to_ref, type))`);
  db.exec(`CREATE TABLE IF NOT EXISTS relation_types (type TEXT PRIMARY KEY, label TEXT NOT NULL, color TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'seed', created_at INTEGER)`);
  return db;
}

const VERBS = [
  { type: 'exemplifies', label: 'exemplifies', color: '#fbbf24', description: 'An instance of.', status: 'seed' },
  { type: 'requires', label: 'requires', color: '#f59e0b', description: 'Cannot run without.', status: 'seed' },
  // a GROWN verb: confirmed into the palette by an admin, not part of the code
  // seed — precisely the moderated growth a code-only registry cannot preserve.
  { type: 'interprets', label: 'interprets', color: '#818cf8', description: 'Case law reading a section.', status: 'confirmed' },
];

/** One row per shape that must survive: each status, both sources, node/object
 *  endpoint orders, and optional fields both present and absent. */
const ROWS = [
  { id: 'r-1', from_ref: 'obj:a', to_ref: '03.01.02', from_kind: 'object', to_kind: 'node', type: 'exemplifies',
    confidence: 0.82, justification: 'body names it', source: 'derived', status: 'confirmed', model: 'claude-sonnet-5', created_at: 1784916266 },
  { id: 'r-2', from_ref: 'obj:b', to_ref: '03.04.01', from_kind: 'object', to_kind: 'node', type: 'requires',
    confidence: null, justification: null, source: 'manual', status: 'proposed', model: null, created_at: 1784916300 },
  { id: 'r-3', from_ref: '01.02.03', to_ref: 'obj:c', from_kind: 'node', to_kind: 'object', type: 'exemplifies',
    confidence: 0.4, justification: null, source: 'derived', status: 'rejected', model: 'claude-sonnet-5', created_at: 1784916400 },
  { id: 'r-4', from_ref: 'nos.services.x', to_ref: 'obj:d', from_kind: 'node', to_kind: 'object', type: 'interprets',
    confidence: 1, justification: 'slug-root partition', source: 'manual', status: 'confirmed', model: null, created_at: 1784916500 },
];

function seed(db) {
  for (const v of VERBS) {
    db.prepare('INSERT INTO relation_types (type, label, color, description, status, created_at) VALUES (?,?,?,?,?,1)')
      .run(v.type, v.label, v.color, v.description, v.status);
  }
  for (const r of ROWS) {
    db.prepare(`INSERT INTO relations (id, from_ref, to_ref, from_kind, to_kind, type, confidence, justification, source, status, model, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.id, r.from_ref, r.to_ref, r.from_kind, r.to_kind, r.type, r.confidence, r.justification, r.source, r.status, r.model, r.created_at);
  }
}

function runDump(dataDir, outDir) {
  execFileSync('node', [DUMP], { env: { ...process.env, KEAP_DATA_DIR: dataDir, OUT_DIR: outDir }, stdio: 'pipe' });
}

function runIngest(dataDir, canonDir, ontologyDir) {
  const out = execFileSync('node', [INGEST, '--canonical', canonDir], {
    env: { ...process.env, KEAP_DATA_DIR: dataDir, ONTOLOGY_DIR: ontologyDir },
    encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('INGEST_RESULT '));
  return { out, result: JSON.parse(line.slice('INGEST_RESULT '.length)) };
}

/** All ontology files as path → raw text (byte comparison, no parsed projection). */
function ontologyFiles(root) {
  const out = new Map();
  const dir = path.join(root, 'ontology');
  if (!existsSync(dir)) return out;
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, path.join(prefix, e.name));
      else if (e.name.endsWith('.json') && e.name !== 'manifest.json') out.set(path.join(prefix, e.name), readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

beforeAll(() => {
  TMP = path.join(os.tmpdir(), `keap-ont-${process.pid}-${Date.now()}`);
  mkdirSync(TMP, { recursive: true });
  // An empty canonical dir keeps the taxonomy layer out of the way; --canonical
  // points here so ingest has domain files to find (none) and the ontology dir
  // is supplied explicitly.
  mkdirSync(path.join(TMP, 'canonical'), { recursive: true });
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('ontology SoT — dump ∘ ingest identity', () => {
  it('round-trips every relation shape byte-identically through a blank DB', () => {
    // 1. a live-like DB with a moderated ontology → dump to files (the git SoT)
    const liveDir = path.join(TMP, 'live');
    const db = scratchDb(liveDir);
    seed(db);
    // A ToE mirror row must NOT reach the files: concept_relations is already
    // versioned by canonical/, and dumping it here would put one edge under two
    // sources of truth that can silently drift apart.
    db.prepare(`INSERT INTO relations (id, from_ref, to_ref, from_kind, to_kind, type, source, status, created_at)
                VALUES ('r-toe','01.01','02.02','node','node','exemplifies','toe','confirmed',1)`).run();
    db.close();

    const sot = path.join(TMP, 'sot');
    runDump(liveDir, sot);
    const a = ontologyFiles(sot);

    const rels = JSON.parse(readFileSync(path.join(sot, 'ontology', 'relations', '03-applied-sciences-technology.json'), 'utf8'));
    expect(rels.relations.map((r) => r.type).sort()).toEqual(['exemplifies', 'requires']);
    // toe row excluded
    const allRefs = [...a.values()].join('');
    expect(allRefs).not.toContain('r-toe');
    expect(allRefs).not.toContain('"source": "toe"');

    // 2. replay the files into a BLANK DB — the 2026-07-22 recovery path
    const blankDir = path.join(TMP, 'blank');
    scratchDb(blankDir).close();
    const { result } = runIngest(blankDir, path.join(TMP, 'canonical'), path.join(sot, 'ontology'));
    expect(result.ontology.relations).toBe(ROWS.length);
    expect(result.ontology.unknownVerbs).toEqual([]);
    expect(result.ontology.malformed).toEqual([]);

    // 3. dump the restored DB — byte identity against the SoT
    const back = path.join(TMP, 'back');
    runDump(blankDir, back);
    const b = ontologyFiles(back);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [f, text] of a) expect(b.get(f), `file ${f}`).toBe(text);
  });

  it('restores the moderation verdicts, not just the edges', () => {
    // The whole point: a rebuilt DB must not silently re-arm rejected edges as
    // fresh proposals for a human to moderate a second time.
    const dir = path.join(TMP, 'verdicts');
    scratchDb(dir).close();
    runIngest(dir, path.join(TMP, 'canonical'), path.join(TMP, 'sot', 'ontology'));
    const db = new Database(path.join(dir, 'keap.db'), { readonly: true });
    const rows = db.prepare('SELECT from_ref, to_ref, type, status, confidence, model, created_at FROM relations ORDER BY from_ref').all();
    db.close();
    expect(rows.map((r) => r.status).sort()).toEqual(['confirmed', 'confirmed', 'proposed', 'rejected']);
    const rejected = rows.find((r) => r.status === 'rejected');
    expect(rejected.from_ref).toBe('01.02.03');
    // provenance survives verbatim — a rebuild that reset these would quietly
    // relabel when and by what each edge was typed
    expect(rejected.model).toBe('claude-sonnet-5');
    expect(rejected.created_at).toBe(1784916400);
    expect(rejected.confidence).toBe(0.4);
  });

  it('restores a grown verb the code seed does not carry', () => {
    const db = new Database(path.join(TMP, 'verdicts', 'keap.db'), { readonly: true });
    const grown = db.prepare("SELECT * FROM relation_types WHERE type = 'interprets'").get();
    db.close();
    expect(grown?.status).toBe('confirmed');
    expect(grown?.color).toBe('#818cf8');
  });

  it('partitions by the taxonomy endpoint, whichever side it is on', () => {
    const files = [...ontologyFiles(path.join(TMP, 'sot')).keys()].map((f) => path.basename(f));
    expect(files).toContain('03-applied-sciences-technology.json');
    expect(files).toContain('01-natural-sciences.json'); // node endpoint is `from`
    expect(files).toContain('nos.json');                 // slug root keeps its own name
  });
});

describe('ontology SoT — what it refuses, loudly', () => {
  const write = (name, doc) => {
    const dir = path.join(TMP, name, 'ontology');
    mkdirSync(path.join(dir, 'relations'), { recursive: true });
    writeFileSync(path.join(dir, 'relation-types.json'), JSON.stringify({ version: 1, types: VERBS }, null, 1) + '\n');
    writeFileSync(path.join(dir, 'relations', 'x.json'), JSON.stringify(doc, null, 1) + '\n');
    return dir;
  };

  it('drops a relation on an unregistered verb and names it', () => {
    // Bypassing the vocabulary gate through git would be a hole straight around
    // the moderation the live API enforces.
    const ont = write('badverb', { version: 1, partition: 'x', relations: [
      { from: 'obj:z', fromKind: 'object', to: '03.01', toKind: 'node', type: 'invented-verb', source: 'derived', status: 'confirmed' },
    ] });
    const dir = path.join(TMP, 'badverb-db');
    scratchDb(dir).close();
    const { result } = runIngest(dir, path.join(TMP, 'canonical'), ont);
    expect(result.ontology.relations).toBe(0);
    expect(result.ontology.unknownVerbs).toHaveLength(1);
    expect(result.ontology.unknownVerbs[0].type).toBe('invented-verb');
  });

  it('drops malformed rows and names them instead of importing junk', () => {
    const ont = write('malformed', { version: 1, partition: 'x', relations: [
      { from: 'obj:z', to: '03.01', type: 'exemplifies', source: 'toe', status: 'confirmed' },       // toe belongs to canonical/
      { from: 'obj:z', to: '03.02', type: 'exemplifies', source: 'derived', status: 'whatever' },     // bad status
      { from: 'obj:z', to: '03.03', type: 'exemplifies', source: 'derived', confidence: 7 },          // out of range
      { from: '', to: '03.04', type: 'exemplifies', source: 'derived' },                              // no endpoint
      { from: 'obj:z', to: '03.05', type: 'exemplifies', source: 'derived', status: 'proposed' },      // the one good row
    ] });
    const dir = path.join(TMP, 'malformed-db');
    scratchDb(dir).close();
    const { result } = runIngest(dir, path.join(TMP, 'canonical'), ont);
    expect(result.ontology.relations).toBe(1);
    expect(result.ontology.malformed).toHaveLength(4);
    expect(result.ontology.malformed.map((m) => m.why).some((w) => w.includes('toe'))).toBe(true);
  });

  it('reports overwriting a live moderation verdict rather than doing it quietly', () => {
    // Git is the moderation record and wins — but an admin's live `confirmed`
    // being reverted by a stale file is exactly the change nobody may discover
    // by accident.
    const dir = path.join(TMP, 'conflict-db');
    const db = scratchDb(dir);
    seed(db);
    db.prepare("UPDATE relations SET status = 'confirmed' WHERE id = 'r-3'").run(); // live says confirmed
    db.close();
    const { result } = runIngest(dir, path.join(TMP, 'canonical'), path.join(TMP, 'sot', 'ontology')); // file says rejected
    expect(result.ontology.statusConflicts).toHaveLength(1);
    expect(result.ontology.statusConflicts[0]).toMatchObject({ live: 'confirmed', file: 'rejected' });
  });

  it('never deletes a live edge the files do not carry', () => {
    // `relations` has two writers — this importer and the live classifier. A
    // wipe-then-insert (what the canonical layer does) would delete every edge
    // proposed since the last dump.
    const dir = path.join(TMP, 'additive-db');
    const db = scratchDb(dir);
    seed(db);
    db.prepare(`INSERT INTO relations (id, from_ref, to_ref, from_kind, to_kind, type, source, status, created_at)
                VALUES ('r-new','obj:fresh','03.09.01','object','node','exemplifies','derived','proposed',9)`).run();
    db.close();
    runIngest(dir, path.join(TMP, 'canonical'), path.join(TMP, 'sot', 'ontology'));
    const check = new Database(path.join(dir, 'keap.db'), { readonly: true });
    const still = check.prepare("SELECT status FROM relations WHERE id = 'r-new'").get();
    check.close();
    expect(still?.status).toBe('proposed');
  });
});
