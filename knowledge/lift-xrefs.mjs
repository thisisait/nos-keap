/**
 * Lift the [[id]] cross-references embedded in node `brief` prose into first-class
 * typed `relations` in the canonical files — a low-risk coherence gain: the links
 * an author wrote into a node-article become queryable, renderable graph edges.
 *
 * Re-runnable + idempotent: it first drops every existing source='brief-xref'
 * relation, then re-derives from the current briefs, so a brief edit + re-run
 * keeps the overlay in sync. Directional (from = the node whose brief cites, to =
 * the cited id); deduped; self-refs skipped. Each relation is placed in the file
 * of l1(from) and the file's relations are re-sorted EXACTLY as dump.mjs sorts,
 * so canonical stays byte-identical to a fresh dump (round-trip clean).
 *
 * Operates only on knowledge/canonical/ files — no DB, no API.
 *
 *   node knowledge/lift-xrefs.mjs [--canonical <dir>] [--dry-run]
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CANON = process.argv.includes('--canonical')
  ? process.argv[process.argv.indexOf('--canonical') + 1]
  : path.join(__dir, 'canonical');
const DRY = process.argv.includes('--dry-run');

const XREF = /\[\[([0-9][0-9.]*)\]\]/g;
const l1 = (id) => id.split('.').slice(0, 2).join('.');

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
const docs = new Map();          // path → parsed doc
const allIds = new Set();
for (const f of files) {
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  docs.set(f, doc);
  for (const n of doc.nodes) allIds.add(n.id);
}
// A brief may cross-reference a SEED ancestor that carries no override (so it is
// not itself a canonical node) but is a real position in the tree — e.g. the L2
// branch 01.01.05 (Relativity) whose children 01.01.05.* ARE in canonical. Every
// dotted prefix of a canonical id is such a valid ancestor; add them so those
// refs are lifted, not dropped. (No graph/API needed — derived offline.)
for (const id of [...allIds]) {
  const seg = id.split('.');
  for (let i = 1; i < seg.length; i++) allIds.add(seg.slice(0, i).join('.'));
}

// derive (from → to) pairs from briefs; validate targets against known ids
const pairs = new Set();         // "from|to"
let broken = 0;
for (const doc of docs.values()) {
  for (const n of doc.nodes) {
    if (!n.brief) continue;
    for (const m of n.brief.matchAll(XREF)) {
      const to = m[1];
      if (to === n.id) continue;                 // no self-reference
      if (!allIds.has(to)) { broken++; continue; } // target must exist in the corpus
      pairs.add(`${n.id}|${to}`);
    }
  }
}

// group new relations by l1(from) → file domain; drop stale brief-xref first
const byDomain = new Map();       // domain-key → relations[]
for (const doc of docs.values()) {
  doc.relations = (doc.relations || []).filter((r) => r.source !== 'brief-xref');
  byDomain.set(doc.domain, doc.relations);
}
let added = 0;
for (const key of pairs) {
  const [from, to] = key.split('|');
  const dom = l1(from);
  const bucket = byDomain.get(dom);
  if (!bucket) continue;          // from's domain file must exist
  bucket.push({ from, to, type: 'references', explored: null, source: 'brief-xref' });
  added++;
}

if (DRY) {
  console.log(`[dry-run] would lift ${added} brief-xref relations (${broken} broken targets skipped) across ${byDomain.size} domains`);
  process.exit(0);
}

// re-sort each file's relations EXACTLY like dump.mjs, then write
let touched = 0;
for (const [f, doc] of docs.entries()) {
  doc.relations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  writeFileSync(f, JSON.stringify(doc, null, 1) + '\n');
  touched++;
}
console.log(`lifted ${added} brief-xref relations (${broken} broken skipped) into ${touched} files`);
