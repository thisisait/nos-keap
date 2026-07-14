/**
 * Generalized one-time domain import into the KEAP taxonomy.
 *
 * Grafts an ontology-derived subtree (root L2 -> pillars L3 -> agent-consolidated
 * blocks L4) plus a typed cross-block relation overlay, from a single bundle:
 *
 *   deploy/<domain>-import.json = {
 *     importKey, actor, root:{id,parent,name,description},
 *     pillars:[{id,name,description,blocks:[
 *       {slug,name,description,explored,brief:[{code,name,definition}]}]}],
 *     relations:[{from:<slug>,to:<slug>,type,explored}]
 *   }
 *
 * Generalizes deploy/import-toe.mjs: the ToE importer lifted relations from a
 * source edge-graph and read concept definitions from that graph; here the
 * agent-authored `brief` carries the definitions and `relations` is a first-
 * class list keyed by block slug (the hybrid ontology-skeleton + agent-relations
 * model). Same materialization contract: RAW-SQL rows, then a CONTAINER RESTART
 * lets boot do registerExtNode -> applyDescriptionOverride -> rebuildFts ->
 * ensureLayout APPEND. Static-seed layout version unchanged -> existing stars
 * never re-bake.
 *
 * Idempotent: deletes the root subtree (+ layout/desc/meta) and this domain's
 * relations (source=importKey) first, then re-inserts.
 *
 * Run:  docker exec iiab-keap-1 node deploy/import-domain.mjs <domain>
 *       docker restart iiab-keap-1
 */
import Database from 'libsql';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KEAP_DATA_DIR ?? '/app/data';
const DB_PATH = path.join(DATA_DIR, 'keap.db');

const domain = process.argv[2];
if (!domain) {
  console.error('usage: node import-domain.mjs <domain>   (reads deploy/<domain>-import.json)');
  process.exit(2);
}
const bundle = JSON.parse(readFileSync(path.join(__dir, `${domain}-import.json`), 'utf8'));
const { importKey, root, pillars, relations = [] } = bundle;
const actor = bundle.actor ?? `agent:${importKey}-import`;

const pad = (n) => String(n).padStart(2, '0');
const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode=WAL');
db.exec(
  `CREATE TABLE IF NOT EXISTS concept_relations (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, explored TEXT, source TEXT DEFAULT 'toe', PRIMARY KEY (from_id, to_id, type))`,
);

// rootIsSeed: the L2 branch already exists in the static seed tree (e.g. the
// named physics fields 01.01.03-.10). Pillars then attach as ext children
// DIRECTLY under the seed L2 — the ToE precedent (ext L2 under seed L1 01.01)
// proves ext-under-seed registers + gets an appended layout position without a
// re-bake. In that mode we must NEVER touch the root's own row / description /
// baked layout point — only its ext descendants.
const rootIsSeed = bundle.rootIsSeed === true;

// ── Idempotent reset of this domain's subtree + relations ───────────────────
const like = `${root.id}.%`;
const clause = (col) => (rootIsSeed ? `${col} LIKE '${like}'` : `${col} = '${root.id}' OR ${col} LIKE '${like}'`);
db.exec(`DELETE FROM taxonomy_nodes_ext WHERE ${clause('id')}`);
db.exec(`DELETE FROM node_descriptions  WHERE ${clause('node_id')}`);
db.exec(`DELETE FROM taxonomy_metadata  WHERE ${clause('id')}`);
db.exec(`DELETE FROM taxonomy_layout    WHERE ${clause('node_id')}`);
db.exec(`DELETE FROM concept_relations  WHERE source = '${importKey}'`);

const insNode = db.prepare(
  `INSERT INTO taxonomy_nodes_ext (id, parent_id, name, description, zone, ordinal, proposed_by, approved_by, created_at)
   VALUES (?, ?, ?, ?, 'votable', ?, ?, ?, ?)`,
);
const insDesc = db.prepare(
  `INSERT INTO node_descriptions (node_id, description_en, description_cs, proposed_by, approved_by)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(node_id) DO UPDATE SET description_en = excluded.description_en`,
);
const insMeta = db.prepare(
  `INSERT INTO taxonomy_metadata (id, data, updated_by) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
);
const insRel = db.prepare(
  `INSERT INTO concept_relations (from_id, to_id, type, explored, source) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(from_id, to_id, type) DO UPDATE SET explored = excluded.explored`,
);

// created_at must strictly increase in insertion order (parent-first) so boot's
// listExtNodes (ORDER BY created_at, ordinal) registers parents before children.
let clock = Math.floor(Date.now() / 1000);
const tick = () => clock++;

const rootOrd = db.prepare(`SELECT COUNT(*) AS c FROM taxonomy_nodes_ext WHERE parent_id = ?`).get(root.parent).c;

// ── 1. Root (L2) ────────────────────────────────────────────────────────────
// A seed root already exists in the static tree (row + baked star + seed desc);
// skip re-inserting it, else the ext table duplicates the seed node. A grown
// root (the ToE/chem/bio "Disciplines" catch-all pattern) is inserted as before.
if (!rootIsSeed) {
  insNode.run(root.id, root.parent, root.name, clip(root.description, 480), rootOrd, actor, actor, tick());
  insDesc.run(root.id, clip(root.description, 480), root.descriptionCs ? clip(root.descriptionCs, 480) : null, actor, actor);
}

// ── 2. Pillars (L3) + 3. Blocks (L4) ────────────────────────────────────────
const slugToNode = {};
let nPillars = 0;
let nBlocks = 0;
pillars.forEach((pillar, pi) => {
  const pillarNodeId = `${root.id}.${pad(pi + 1)}`;
  const pDesc = clip(pillar.description, 480) || pillar.name;
  insNode.run(pillarNodeId, root.id, pillar.name, pDesc, pi, actor, actor, tick());
  insDesc.run(pillarNodeId, pDesc, pillar.descriptionCs ? clip(pillar.descriptionCs, 480) : null, actor, actor);
  nPillars++;

  pillar.blocks.forEach((block, bi) => {
    const blockNodeId = `${pillarNodeId}.${pad(bi + 1)}`;
    const desc = clip(block.description, 480);
    insNode.run(blockNodeId, pillarNodeId, block.name, desc, bi, actor, actor, tick());
    insDesc.run(blockNodeId, desc, block.descriptionCs ? clip(block.descriptionCs, 480) : null, actor, actor);
    // Brief = the constituent ontology concepts + agent-authored definitions.
    const lines = (block.brief || []).map((c) => {
      const code = c.code ? ` (${c.code})` : '';
      return c.definition ? `- **${c.name}**${code} — ${clip(c.definition, 400)}` : `- **${c.name}**${code}`;
    });
    const brief = `${desc}\n\n### Concepts\n${lines.join('\n')}`;
    insMeta.run(
      blockNodeId,
      JSON.stringify({ brief, briefMeta: { source: importKey, pillar: pillar.id, concepts: (block.brief || []).length } }),
      actor,
    );
    if (block.slug) slugToNode[block.slug] = blockNodeId;
    nBlocks++;
  });
});

// ── 4. Typed cross-block relations ──────────────────────────────────────────
const RANK = { barely: 0, partially: 1, well: 2 }; // frontier (barely) wins the aggregate
const rel = new Map(); // key "a|b|type" (a<b canonical) → explored
let unresolved = 0;
for (const e of relations) {
  const a = slugToNode[e.from];
  const b = slugToNode[e.to];
  if (!a || !b || a === b) { unresolved++; continue; }
  const [x, y] = a < b ? [a, b] : [b, a];
  const key = `${x}|${y}|${e.type}`;
  const prev = rel.get(key);
  const cur = e.explored ?? null;
  if (prev === undefined) rel.set(key, cur);
  else if (cur != null && (prev == null || RANK[cur] < RANK[prev])) rel.set(key, cur);
}
let nRel = 0;
const txn = db.transaction(() => {
  for (const [key, explored] of rel) {
    const [x, y, type] = key.split('|');
    insRel.run(x, y, type, explored, importKey);
    nRel++;
  }
});
txn();

console.log(
  `[${importKey}-import] ${nPillars} pillars + ${nBlocks} blocks under ${root.id}; ` +
    `${nRel} relations (${unresolved} unresolved slug refs). RESTART the container to materialize.`,
);
db.close();
