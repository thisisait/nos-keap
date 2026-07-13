/**
 * One-time import of the Theory-of-Everything concept graph into the KEAP
 * taxonomy (ROADMAP — ToE integration).
 *
 * Adds a `01.01.11 Quantum Gravity & Unification` subtree under Physics:
 *   01.01.11            Quantum Gravity & Unification   (L2)
 *   01.01.11.NN         19 pillars                      (L3)
 *   01.01.11.NN.MM      ~156 thematic blocks            (L4)
 * plus the block-lifted typed research edges into `concept_relations`.
 *
 * RAW-SQL by design: it writes the ext-node / description / metadata / relation
 * rows, then a CONTAINER RESTART lets the boot sequence do the live
 * materialization (registerExtNode → applyDescriptionOverride → rebuildFts →
 * ensureLayout append). The static-seed layout version is unchanged, so the
 * existing ~790 stars never re-bake — the new nodes are only APPENDED.
 *
 * Idempotent: deletes the whole 01.01.11 subtree (+ its layout/desc/meta) and
 * the source='toe' relations first, then re-inserts. Re-run after refining
 * deploy/toe-blocks.json to update the live graph.
 *
 * Run:  docker exec iiab-keap-1 node deploy/import-toe.mjs  &&  docker restart iiab-keap-1
 */
import Database from 'libsql';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KEAP_DATA_DIR ?? '/app/data';
const DB_PATH = path.join(DATA_DIR, 'keap.db');

const graph = JSON.parse(readFileSync(path.join(__dir, 'toe-concept-graph.json'), 'utf8'));
const blocksDoc = JSON.parse(readFileSync(path.join(__dir, 'toe-blocks.json'), 'utf8'));

const PHYS = '01.01';
const QG_ID = '01.01.11';
const pad = (n) => String(n).padStart(2, '0');

const nodeById = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode=WAL');
// The concept_relations table ships in server/db.ts SCHEMA, but guard in case
// this runs against a DB whose server hasn't booted the new schema yet.
db.exec(
  `CREATE TABLE IF NOT EXISTS concept_relations (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, explored TEXT, source TEXT DEFAULT 'toe', PRIMARY KEY (from_id, to_id, type))`,
);

// ── Idempotent reset of the ToE subtree ─────────────────────────────────────
const like = `${QG_ID}.%`;
db.exec(`DELETE FROM taxonomy_nodes_ext WHERE id = '${QG_ID}' OR id LIKE '${like}'`);
db.exec(`DELETE FROM node_descriptions  WHERE node_id = '${QG_ID}' OR node_id LIKE '${like}'`);
db.exec(`DELETE FROM taxonomy_metadata  WHERE id = '${QG_ID}' OR id LIKE '${like}'`);
db.exec(`DELETE FROM taxonomy_layout    WHERE node_id = '${QG_ID}' OR node_id LIKE '${like}'`);
db.exec(`DELETE FROM concept_relations  WHERE source = 'toe'`);

const insNode = db.prepare(
  `INSERT INTO taxonomy_nodes_ext (id, parent_id, name, description, zone, ordinal, proposed_by, approved_by, created_at)
   VALUES (?, ?, ?, ?, 'votable', ?, 'agent:toe-import', 'agent:toe-import', ?)`,
);
const insDesc = db.prepare(
  `INSERT INTO node_descriptions (node_id, description_en, description_cs, proposed_by, approved_by)
   VALUES (?, ?, ?, 'agent:toe-import', 'agent:toe-import')
   ON CONFLICT(node_id) DO UPDATE SET description_en = excluded.description_en`,
);
const insMeta = db.prepare(
  `INSERT INTO taxonomy_metadata (id, data, updated_by) VALUES (?, ?, 'agent:toe-import')
   ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
);
const insRel = db.prepare(
  `INSERT INTO concept_relations (from_id, to_id, type, explored, source) VALUES (?, ?, ?, ?, 'toe')
   ON CONFLICT(from_id, to_id, type) DO UPDATE SET explored = excluded.explored`,
);

// created_at must strictly increase in insertion order (parent-first) so the
// boot's listExtNodes (ORDER BY created_at, ordinal) registers parents first.
let clock = Math.floor(Date.now() / 1000);
const tick = () => clock++;

// existing ext children under Physics → QG's ordinal
const physOrd = db.prepare(`SELECT COUNT(*) AS c FROM taxonomy_nodes_ext WHERE parent_id = ?`).get(PHYS).c;

// concept/pillar source id → materialized taxonomy node id (for edge lifting)
const toNode = {};

// ── 1. Quantum Gravity root (L2) ────────────────────────────────────────────
insNode.run(
  QG_ID,
  PHYS,
  'Quantum Gravity & Unification',
  'Approaches to a quantum theory of gravity and the unification of general relativity with quantum field theory — the research landscape mapped by the Theory-of-Everything concept graph, organized into 19 pillars.',
  physOrd,
  tick(),
);
insDesc.run(
  QG_ID,
  'Approaches to a quantum theory of gravity and the unification of general relativity with quantum field theory — 19 research pillars from string theory and loop quantum gravity to holography, causal sets and the swampland.',
  null,
);

// ── 2. Pillars (L3) + 3. Blocks (L4) ────────────────────────────────────────
let nPillars = 0;
let nBlocks = 0;
blocksDoc.pillars.forEach((pillar, pi) => {
  const pillarNodeId = `${QG_ID}.${pad(pi + 1)}`;
  const pSrc = nodeById[pillar.id];
  const pDesc = clip(pSrc && pSrc.definition, 480) || `${pillar.name} — an approach to quantum gravity.`;
  insNode.run(pillarNodeId, QG_ID, pillar.name, pDesc, pi, tick());
  insDesc.run(pillarNodeId, pDesc, null);
  toNode[pillar.id] = pillarNodeId;
  nPillars++;

  pillar.blocks.forEach((block, bi) => {
    const blockNodeId = `${pillarNodeId}.${pad(bi + 1)}`;
    const desc = clip(block.description, 480);
    insNode.run(blockNodeId, pillarNodeId, block.name, desc, bi, tick());
    insDesc.run(blockNodeId, desc, null);
    // Brief = the constituent concepts + their definitions (detail preserved).
    const lines = block.conceptIds.map((cid) => {
      const c = nodeById[cid];
      if (!c) return `- ${cid}`;
      const def = clip(c.definition, 400);
      return def ? `- **${c.name}** — ${def}` : `- **${c.name}**`;
    });
    const brief = `${desc}\n\n### Concepts\n${lines.join('\n')}`;
    insMeta.run(
      blockNodeId,
      JSON.stringify({ brief, briefMeta: { source: 'toe', pillar: pillar.id, concepts: block.conceptIds.length } }),
    );
    for (const cid of block.conceptIds) toNode[cid] = blockNodeId;
    nBlocks++;
  });
});

// ── 4. Lift edges to block-level typed relations ────────────────────────────
const RANK = { barely: 0, partially: 1, well: 2 }; // frontier (barely) wins the aggregate
const rel = new Map(); // key "a|b|type" (a<b canonical) → explored
for (const e of graph.edges) {
  const a = toNode[e.from];
  const b = toNode[e.to];
  if (!a || !b || a === b) continue;
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
    insRel.run(x, y, type, explored);
    nRel++;
  }
});
txn();

console.log(
  `[toe-import] ${nPillars} pillars + ${nBlocks} blocks under ${QG_ID}; ${nRel} block-relations. ` +
    `RESTART the container to materialize (registerExtNode + layout append).`,
);
db.close();
