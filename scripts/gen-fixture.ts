/**
 * Synthetic knowledge-object fixture generator — DEV / STRESS ONLY.
 *
 * The scale roadmap (U2″ Phase A/B) needs a large, semantically-plausible
 * universe to measure the explorer against, and a repeatable local preview
 * scene. This builds one WITHOUT an LLM and WITHOUT touching the live tenant:
 *
 *   • Semantic, not lorem-soup: every object's title/description/body is woven
 *     from the TAXONOMY itself — the anchor node's name, one of its child
 *     sub-topics, and its ancestry path. So the words are genuinely on-topic
 *     (topic-mode clustering / embeddings would find real structure later),
 *     the object orbits a real star, and the files-core view gets real folder
 *     constellations. faker only fills the scaffolding (names, dates, files).
 *   • Deterministic: one faker.seed drives every choice, so a given
 *     (count, seed) always produces byte-identical rows → stable layouts and
 *     reproducible before/after perf numbers.
 *   • Realistic shape: a power-law anchor spread (a few dense "hub" stars +
 *     a long tail) exercises the orbital LOD; a weighted type mix spans all
 *     five celestial forms; ~12% carry an object→object ref for the link
 *     overlay; recency (frontmatter.mtime) spreads for the Recent lens.
 *
 * Writes via the app's own db module (schema-correct, ON CONFLICT idempotent),
 * wrapped in ONE transaction. Rows are id-prefixed `fixture-` so --clear only
 * ever removes generated data, never hand-made or fs-synced cards.
 *
 * Usage:
 *   npm run seed:fixture -- --count 8000 --seed 42 --data-dir ./.fixture --clear
 *   npm run seed:fixture -- --count 200            # quick preview into ./.fixture
 *
 * NEVER point --data-dir at the live container volume (it is inside
 * iiab-keap-1 anyway, unreachable from the host); the guard below refuses the
 * obvious mistakes and prints the resolved path loudly before writing.
 */
import path from 'node:path';
import { faker } from '@faker-js/faker';
// Type-only: erased by esbuild, so this does NOT evaluate the taxonomy module
// before KEAP_DATA_DIR is set (the runtime import stays dynamic, below).
import type { FlatNode } from '../server/taxonomy';

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const COUNT = Number(arg('count', '2000'));
const SEED = Number(arg('seed', '1337'));
const DATA_DIR = arg('data-dir', './.fixture')!;
const OWNER = arg('owner', 'local')!;
const CLEAR = process.argv.includes('--clear');

if (!Number.isFinite(COUNT) || COUNT < 1) throw new Error(`bad --count: ${arg('count')}`);
const resolved = path.resolve(DATA_DIR);
if (/iiab|\/var\/lib|docker\/volumes/.test(resolved)) {
  throw new Error(`refusing suspicious --data-dir (looks live): ${resolved}`);
}
// The db module reads KEAP_DATA_DIR at import time, so set it BEFORE importing.
process.env.KEAP_DATA_DIR = resolved;

const { initDb, getDb, saveObject } = await import('../server/db');
const { allNodes } = await import('../server/taxonomy');

// ── Vocab (types → celestial forms via server/asset-types.ts) ────────────────
// Weights ≈ a real corpus: mostly small docs (moons), some tables/captures
// (asteroids), fewer big datasets/services (planets/stations), rare feeds.
const TYPE_POOL: Array<{ weight: number; value: string }> = [
  { weight: 16, value: 'note' }, { weight: 12, value: 'page' },
  { weight: 10, value: 'file' }, { weight: 7, value: 'image' }, // → moon
  { weight: 9, value: 'dataTable' }, { weight: 6, value: 'capture' },
  { weight: 5, value: 'audio' }, // → asteroid
  { weight: 6, value: 'database' }, { weight: 5, value: 'books' },
  { weight: 4, value: 'video' }, // → planet
  { weight: 5, value: 'ai' }, { weight: 5, value: 'repo' },
  { weight: 3, value: 'query' }, { weight: 2, value: 'maps' }, // → station
  { weight: 5, value: 'rss' }, // → comet
];
const EXT: Record<string, string> = {
  note: 'md', page: 'html', file: 'pdf', image: 'png',
  dataTable: 'csv', capture: 'json', audio: 'mp3',
  database: 'sqlite', books: 'epub', video: 'mp4',
  ai: 'json', repo: 'md', query: 'sql', maps: 'geojson', rss: 'xml',
};
const TITLE_TEMPLATES = [
  '{n}: {sub}', '{sub} in {n}', 'Notes on {sub}', '{n} — {sub} overview',
  'A survey of {sub}', '{sub} ({n})', 'Introduction to {sub}',
  '{n} {kind} №{num}', '{sub}: methods & results', 'On {sub}',
];
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

async function main() {
  const t0 = Date.now();
  faker.seed(SEED);
  await initDb();
  const db = getDb();

  const byId = new Map<string, FlatNode>();
  for (const n of allNodes()) byId.set(n.id, n);
  // Level isn't stored on FlatNode (graph.ts derives it) — recover it from the
  // dotted-id depth: "01"→0, "01.01"→1, "01.01.02"→2.
  const levelOf = (id: string) => id.split('.').length - 1;
  // Anchors = stars and deeper (level ≥ 2). Objects anchored to a galaxy /
  // constellation (level ≤ 1) would orbit an enormous body and read oddly.
  const stars = allNodes().filter((n) => levelOf(n.id) >= 2);
  if (!stars.length) throw new Error('no level≥2 taxonomy nodes to anchor to');
  // Power-law: a handful of hub stars soak up ~35% of objects (dense orbital
  // clusters that stress the LOD), the rest scatter across the long tail.
  const hubCount = Math.min(40, Math.max(3, Math.round(COUNT / 500)));
  const hubs = faker.helpers.arrayElements(stars, hubCount);

  const subtopicOf = (node: FlatNode): string => {
    const kids = node.childIds.map((id) => byId.get(id)?.name).filter(Boolean) as string[];
    if (kids.length) return faker.helpers.arrayElement(kids);
    // Leaf: fall back to a sibling term or the last path segment.
    const seg = node.path.split(' > ');
    return seg.length > 1 ? seg[seg.length - 2] : node.name;
  };

  const ids: string[] = [];
  db.exec('BEGIN');
  try {
    if (CLEAR) db.prepare("DELETE FROM knowledge_objects WHERE id LIKE 'fixture-%'").run();
    for (let i = 0; i < COUNT; i++) {
      const id = `fixture-${SEED}-${i}`;
      const node =
        faker.number.float({ min: 0, max: 1 }) < 0.35
          ? faker.helpers.arrayElement(hubs)
          : faker.helpers.arrayElement(stars);
      const type = faker.helpers.weightedArrayElement(TYPE_POOL);
      const sub = subtopicOf(node);
      const title = faker.helpers
        .arrayElement(TITLE_TEMPLATES)
        .replace('{n}', node.name)
        .replace('{sub}', sub)
        .replace('{kind}', type)
        .replace('{num}', String(faker.number.int({ min: 1, max: 99 })));
      const description = `${sub} — ${faker.lorem.sentence()}`;
      // ~12% cross-link to an earlier object → the [[object:…]] ref overlay.
      const linkTarget =
        ids.length && faker.number.float({ min: 0, max: 1 }) < 0.12
          ? faker.helpers.arrayElement(ids)
          : null;
      const body =
        `[[${node.id}]]\n${linkTarget ? `[[object:${linkTarget}]]\n` : ''}\n` +
        `${node.name}. ${faker.lorem.sentences(2)} Focus: ${sub}.`;
      const folder = node.path.split(' > ').map(slug).join('/');
      const fileName = faker.system.commonFileName(EXT[type] ?? 'txt');
      const mtime = Math.floor(faker.date.past({ years: 2 }).getTime() / 1000);

      saveObject(OWNER, {
        id,
        type,
        title,
        description,
        body,
        // Emergent edges come from the body refs — same extraction the API uses.
        links: [
          { kind: 'node', ref: node.id },
          ...(linkTarget ? [{ kind: 'object' as const, ref: linkTarget }] : []),
        ],
        frontmatter: { path: `${folder}/${fileName}`, mtime },
        visibility: faker.number.float({ min: 0, max: 1 }) < 0.85 ? 'shared' : 'private',
      });
      ids.push(id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // ── Self-verify (offline — mirrors what graph.ts will read) ────────────────
  const total = (db.prepare("SELECT COUNT(*) c FROM knowledge_objects WHERE id LIKE 'fixture-%'").get() as { c: number }).c;
  const shared = (db.prepare("SELECT COUNT(*) c FROM knowledge_objects WHERE id LIKE 'fixture-%' AND visibility='shared'").get() as { c: number }).c;
  const withOlink = (db.prepare("SELECT COUNT(*) c FROM knowledge_objects WHERE id LIKE 'fixture-%' AND links LIKE '%\"object\"%'").get() as { c: number }).c;
  const types = db.prepare("SELECT type, COUNT(*) c FROM knowledge_objects WHERE id LIKE 'fixture-%' GROUP BY type ORDER BY c DESC").all() as Array<{ type: string; c: number }>;
  const anchors = (db.prepare("SELECT COUNT(DISTINCT json_extract(value,'$.ref')) c FROM knowledge_objects, json_each(links) WHERE knowledge_objects.id LIKE 'fixture-%' AND json_extract(value,'$.kind')='node'").get() as { c: number }).c;
  const sample = db.prepare("SELECT title FROM knowledge_objects WHERE id LIKE 'fixture-%' ORDER BY id LIMIT 5").all() as Array<{ title: string }>;

  console.log(`\n✔ generated ${total} objects in ${Date.now() - t0}ms → ${resolved}`);
  console.log(`  seed=${SEED}  hubs=${hubCount}  distinct anchors=${anchors}  shared=${shared}  with object-link=${withOlink}`);
  console.log(`  types: ${types.map((t) => `${t.type}:${t.c}`).join('  ')}`);
  console.log(`  sample titles:`);
  for (const s of sample) console.log(`    · ${s.title}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
