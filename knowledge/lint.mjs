/**
 * Canonical knowledge linter — validates knowledge/canonical/**.json against the
 * SoT contract. Runs standalone (no DB), so CI gates every PR before ingest ever
 * touches a live system.
 *
 *   node knowledge/lint.mjs [--canonical <dir>]
 *   exit 0 = clean, 1 = violations (printed), 2 = usage/read error.
 *
 * Gates: id well-formed + level-consistent; ext nodes carry name/parentId
 * (a strict prefix of id)/zone/ordinal; en present; en/cs within 20–2000; NO
 * Cyrillic in en/cs (the curator's contamination gate); global id uniqueness;
 * relation endpoints present; every ext parent resolves (to another node here or
 * a seed id we can't see — only an ext-id parent that is missing is an error).
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CANON = process.argv.includes('--canonical')
  ? process.argv[process.argv.indexOf('--canonical') + 1]
  : path.join(__dir, 'canonical');

// Seed spine ids are dotted 2-digit runs; user subtrees are dotted lowercase
// slugs (a numeric segment encodes position, a slug encodes identity).
const ID_RE = /^(?:\d{2}(?:\.\d{2})*|[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)$/;
const CYR = /[Ѐ-ӿ]/;
const ZONES = new Set(['votable', 'free', 'anchor']);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith('.json') && e !== 'manifest.json') out.push(p);
  }
  return out;
}

const errors = [];
const seen = new Map();          // id → file
const extIds = new Set();
const allNodes = [];

let files;
try { files = walk(CANON).sort(); }
catch (e) { console.error(`cannot read ${CANON}: ${e.message}`); process.exit(2); }

for (const f of files) {
  const rel = path.relative(CANON, f);
  let doc;
  try { doc = JSON.parse(readFileSync(f, 'utf8')); }
  catch (e) { errors.push(`${rel}: invalid JSON — ${e.message}`); continue; }
  if (!Array.isArray(doc.nodes)) { errors.push(`${rel}: missing nodes[]`); continue; }
  // The domain key is BOTH the wipe scope ingest deletes by and a value that is
  // interpolated into that scope — so it must be shape-valid, and every node in
  // the file must fall inside it. A node outside its file's scope survives the
  // wipe on re-apply and the plain INSERT then dies on the id PRIMARY KEY —
  // bricking ingest for a layout lint had blessed.
  const key = doc.domain || path.basename(f, '.json');
  if (!ID_RE.test(key)) { errors.push(`${rel}: malformed domain key '${key}'`); continue; }
  const owns = (id) => (key.includes('.') ? id === key || id.startsWith(key + '.') : id === key);
  for (const n of doc.nodes) {
    const at = `${rel} ${n.id}`;
    if (!n.id || !ID_RE.test(n.id)) { errors.push(`${at}: malformed id`); continue; }
    if (!owns(n.id)) errors.push(`${at}: outside this file's domain scope '${key}' — the re-apply wipe will not cover it`);
    // seed-override overlays a node of the STATIC spine; slug ids never exist
    // there, so a slug seed-override is a node that lints green, lands only in
    // node_descriptions, and leaves every child orphaned at boot.
    if (n.kind === 'seed-override' && /^[a-z]/.test(n.id)) {
      errors.push(`${at}: seed-override on a slug id — there is no seed node to overlay; use kind 'ext'`);
    }
    if (seen.has(n.id)) errors.push(`${at}: duplicate id (also in ${seen.get(n.id)})`);
    else seen.set(n.id, rel);
    if (n.level !== (n.id.match(/\./g) || []).length) errors.push(`${at}: level ${n.level} ≠ id depth`);
    if (n.kind !== 'ext' && n.kind !== 'seed-override') errors.push(`${at}: bad kind '${n.kind}'`);
    if (n.kind === 'ext') {
      extIds.add(n.id);
      const parent = n.id.split('.').slice(0, -1).join('.');
      const isRoot = !n.id.includes('.') && /^[a-z]/.test(n.id);
      if (isRoot) {
        // A user-defined ROOT: bare slug, and parentId must be ABSENT — a root
        // carrying one would mask a child whose id lost its dots in an edit.
        if (n.parentId !== undefined && n.parentId !== '') {
          errors.push(`${at}: a root must not carry parentId (got '${n.parentId}')`);
        }
      } else if (!n.parentId) errors.push(`${at}: ext node missing parentId`);
      else if (n.parentId !== parent) errors.push(`${at}: parentId '${n.parentId}' ≠ id prefix '${parent}'`);
      if (!n.name || !String(n.name).trim()) errors.push(`${at}: ext node missing name`);
      if (!ZONES.has(n.zone)) errors.push(`${at}: bad zone '${n.zone}'`);
      if (!Number.isInteger(n.ordinal)) errors.push(`${at}: ordinal not an integer`);
    }
    if (!n.en || !String(n.en).trim()) errors.push(`${at}: missing en`);
    else if (n.en.length < 20 || n.en.length > 2000) errors.push(`${at}: en length ${n.en.length} outside 20–2000`);
    if (n.cs !== undefined) {
      if (!String(n.cs).trim()) errors.push(`${at}: cs present but empty`);
      else if (n.cs.length > 2000) errors.push(`${at}: cs length ${n.cs.length} > 2000`);
      if (CYR.test(n.cs)) errors.push(`${at}: CYRILLIC in cs`);
    }
    if (CYR.test(n.en || '')) errors.push(`${at}: CYRILLIC in en`);
    allNodes.push({ ...n, _file: rel });
  }
  for (const r of doc.relations || []) {
    if (!r.from || !r.to || !r.type) errors.push(`${rel}: relation missing from/to/type — ${JSON.stringify(r)}`);
  }
}

// ext parent must resolve to a known ext id OR a seed id (dot-shorter, not ext →
// assumed seed; only a missing ext-scoped parent is an error we can prove)
for (const n of allNodes) {
  if (n.kind !== 'ext') continue;
  const parent = n.parentId;
  if (!parent) continue;
  if (extIds.has(parent)) continue;
  // NUMERIC parents up to L2 are assumed seed (the static spine lints elsewhere).
  // A SLUG parent has no seed to fall back on — every ancestor must be present
  // in the canonical set, or the whole subtree silently fails to register at
  // boot (registerExtNodes drops nodes whose parent never resolves).
  const numericParent = /^\d{2}(\.\d{2})*$/.test(parent);
  if (numericParent && (parent.match(/\./g) || []).length <= 2) continue;
  if (numericParent) {
    // A deep NUMERIC parent may be a real seed node whose canonical presence is
    // a seed-override row — the override overlays a node that exists in the
    // static spine, so file-set presence does imply tree presence here.
    if (!seen.has(parent)) errors.push(`${n._file} ${n.id}: ext parent '${parent}' not found (orphan)`);
  } else if (!extIds.has(parent)) {
    // A SLUG parent has no seed to overlay: only an ext row puts it in the
    // boot tree. A seed-override with a slug id lands in node_descriptions
    // alone — lint green, subtree silently dropped at boot.
    errors.push(`${n._file} ${n.id}: slug parent '${parent}' not found among ext nodes (subtree would drop at boot)`);
  }
}

if (errors.length) {
  console.error(`✗ ${errors.length} violation(s):`);
  for (const e of errors.slice(0, 200)) console.error('  ' + e);
  if (errors.length > 200) console.error(`  … +${errors.length - 200} more`);
  process.exit(1);
}
console.log(`✓ knowledge lint clean — ${seen.size} nodes across ${files.length} files`);
