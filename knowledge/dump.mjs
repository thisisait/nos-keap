/**
 * Canonical knowledge exporter (the inverse of ingest.mjs).
 *
 * Dumps the live curated delta over the static seed spine — everything that is
 * NOT hardcoded in src/game/data/taxonomy.ts — into a diffable, git-tracked
 * canonical form under knowledge/. This is the one-time capture that makes
 * knowledge/ the source of truth: grown ext nodes (math/chem/bio/toe/…),
 * K1 description overrides on seed OR ext nodes (EN+CS), block briefs (as
 * structured concepts), and the typed relation overlay.
 *
 * Runs IN the container (libSQL driver — NEVER host sqlite3, which corrupts the
 * live libSQL DB). Read-only on the DB; writes canonical files to OUT_DIR.
 *
 *   docker cp knowledge/dump.mjs iiab-keap-1:/tmp/dump.mjs
 *   docker exec -e OUT_DIR=/tmp/kdump iiab-keap-1 node /tmp/dump.mjs [--inspect]
 *   docker cp iiab-keap-1:/tmp/kdump ./knowledge/_dump
 *
 * --inspect: print counts + samples only, write nothing (format-design probe).
 */
import Database from 'libsql';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.KEAP_DATA_DIR ?? '/app/data';
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/kdump';
const INSPECT = process.argv.includes('--inspect');
const DB_PATH = path.join(DATA_DIR, 'keap.db');

const db = new Database(DB_PATH, { readonly: true });
const level = (id) => (id.match(/\./g) || []).length;
// group by L1 domain (first two segments) — one canonical file per L1 (Physics,
// Chemistry, …): coherent unit for review + community contribution.
const l1 = (id) => id.split('.').slice(0, 2).join('.');
const l0 = (id) => id.split('.')[0];
// Stable L0 spine → folder slug (the 12 top-level sciences never churn).
const L0_DIR = {
  '01': '01-natural-sciences', '02': '02-formal-sciences',
  '03': '03-applied-sciences-technology', '04': '04-social-sciences',
  '05': '05-humanities', '06': '06-arts-creative-expression',
  '07': '07-practical-skills-trades', '08': '08-survival-emergency-preparedness',
  '09': '09-reference-documentation', '10': '10-cultural-preservation',
  '11': '11-digital-preservation', '12': '12-post-disaster-rebuilding',
};

const extNodes = db.prepare('SELECT * FROM taxonomy_nodes_ext').all();
const descs = db.prepare('SELECT * FROM node_descriptions').all();
const metaRows = db.prepare('SELECT * FROM taxonomy_metadata').all();
const rels = db.prepare('SELECT * FROM concept_relations').all();

const extById = new Map(extNodes.map((n) => [n.id, n]));
const descById = new Map(descs.map((d) => [d.node_id, d]));
const metaById = new Map(metaRows.map((m) => [m.id, m]));

// seed-override = a node_descriptions row for an id with NO ext row (a K1
// override on a static-seed node — the curator's approved rewrites live here).
const seedOverrides = descs.filter((d) => !extById.has(d.node_id));

// The brief (block "### Concepts" body) comes in several historical shapes
// (importer-built, librarian-authored, curator). Store it RAW for a lossless,
// round-tripping SoT; structuring into concept records is a future refinement.
function briefOf(dataJson) {
  if (!dataJson) return null;
  try {
    const data = JSON.parse(dataJson);
    return typeof data.brief === 'string' && data.brief.trim() ? data.brief : null;
  } catch { return null; }
}

if (INSPECT) {
  console.log('ext nodes:', extNodes.length);
  console.log('node_descriptions:', descs.length, '(seed-overrides:', seedOverrides.length + ')');
  console.log('taxonomy_metadata (briefs):', metaRows.length);
  console.log('concept_relations:', rels.length);
  // ext roots (grown L2 branches)
  const roots = extNodes.filter((n) => level(n.id) === 2).map((n) => `${n.id} ${n.name}`);
  console.log('grown L2 roots:', roots);
  // L1 domains touched by seed-overrides
  const ovDomains = [...new Set(seedOverrides.map((d) => l1(d.node_id)))].sort();
  console.log('L1 domains with seed-overrides:', ovDomains.length, ovDomains.slice(0, 20));
  // sample brief (raw)
  const sampleMeta = metaRows.find((m) => briefOf(m.data));
  if (sampleMeta) {
    console.log('sample brief node:', sampleMeta.id);
    console.log('raw brief head:', JSON.stringify(briefOf(sampleMeta.data).slice(0, 160)));
  }
  // sample seed-override
  if (seedOverrides.length) {
    const s = seedOverrides[0];
    console.log('sample seed-override:', s.node_id, '| en:', (s.description_en || '').slice(0, 60), '| cs:', (s.description_cs || '').slice(0, 60));
  }
  db.close();
} else {
  // full canonical export — one file per L1 domain, nodes sorted by id
  mkdirSync(OUT_DIR, { recursive: true });
  const domains = new Map(); // l1 → {nodes:[], relations:[]}
  const touch = (id) => { const k = l1(id); if (!domains.has(k)) domains.set(k, { nodes: [], relations: [] }); return domains.get(k); };
  const emitted = new Set();
  const record = (id) => {
    if (emitted.has(id)) return; emitted.add(id);
    const ext = extById.get(id); const d = descById.get(id); const meta = metaById.get(id);
    const rec = { id, level: level(id) };
    if (ext) { rec.parentId = ext.parent_id; rec.name = ext.name; rec.zone = ext.zone; rec.ordinal = ext.ordinal; rec.kind = 'ext'; }
    else { rec.kind = 'seed-override'; }
    rec.en = d ? d.description_en : (ext ? ext.description : '');
    if (d && d.description_cs) rec.cs = d.description_cs;
    const brief = briefOf(meta && meta.data);
    if (brief) rec.brief = brief;
    touch(id).nodes.push(rec);
  };
  for (const n of extNodes) record(n.id);
  for (const d of seedOverrides) record(d.node_id);
  for (const r of rels) touch(r.from_id).relations.push({ from: r.from_id, to: r.to_id, type: r.type, explored: r.explored, source: r.source });

  const manifest = [];
  for (const [k, v] of [...domains.entries()].sort()) {
    v.nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    v.relations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const dir = L0_DIR[l0(k)] || l0(k);           // canonical/<L0-slug>/<L1>.json
    const rel = path.join(dir, `${k}.json`);
    mkdirSync(path.join(OUT_DIR, dir), { recursive: true });
    writeFileSync(path.join(OUT_DIR, rel), JSON.stringify({ domain: k, nodes: v.nodes, relations: v.relations }, null, 1) + '\n');
    manifest.push({ domain: k, file: rel, nodes: v.nodes.length, relations: v.relations.length });
  }
  manifest.sort((a, b) => (a.domain < b.domain ? -1 : 1));
  writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ domains: manifest }, null, 1) + '\n');
  console.log(`wrote ${domains.size} domain files + manifest to ${OUT_DIR}`);
  console.log(`totals: ${emitted.size} nodes, ${rels.length} relations`);
  db.close();
}
