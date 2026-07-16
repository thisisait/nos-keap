/**
 * Filesystem sync — the doctrine-tree half of "documents arrive in KEAP".
 *
 * The nOS filesystem doctrine (nOS docs/doctrine/filesystem.md) gives KEAP a
 * class-3 FS-native per-user tree: {nos_data_root}/tenants/<t>/users/<uid>/
 * {documents,library,inbox,agents}. Once the role bind-mounts that users/ dir
 * into the container (planned nOS-side work) and points KEAP_USER_FILES_DIR at
 * it, this module walks it and mirrors every file as a per-user knowledge
 * object (frontmatter.source='fs'), so the EXISTING pipeline takes over:
 * objectText → pending diff → host keap-embed-sync embeds it → it appears in
 * /explore (files core) and search. This is the OWNER-SCOPED mirror; the nOS
 * keap-consolidate.py sweep (→ /ingest/v1/capture, app:consolidator) should
 * keep to shared roots, not this tree — two pipelines on one tree would
 * double-ingest every file.
 *
 * Contract:
 *   - the filesystem is the boundary (doctrine class 3): the uid comes from
 *     the top-level directory name, and the object is owned by that uid.
 *     Only the content classes sync (KEAP_FS_SYNC_DIRS, default
 *     documents,library,inbox) — agents/<agent>/ scratch is NOT knowledge.
 *   - one file = one object, id `fs:<uid>:<sha1(relpath)[:16]>` (hashed so
 *     ids stay URL-safe for GET /api/objects/:id); the real path lives in
 *     frontmatter.path. A move/rename is a delete+create (the embedding
 *     re-syncs; spatial memory is unaffected — files are never taxonomy stars).
 *   - the FILE is the source of truth for title/body/frontmatter, but curated
 *     LINKS survive: existing links (human/curator-added anchors) are unioned
 *     with refs extracted from the file body, never clobbered.
 *   - idempotent + cheap: unchanged (size, mtime) files are skipped; objects
 *     whose file vanished are pruned (their vectors follow via
 *     pruneEmbeddings) — EXCEPT when a scan finds zero files while mirrors
 *     exist, which reads as an unmounted/mid-migration volume, not a mass
 *     delete: prune is refused and a warning logged.
 *   - symlinks are NOT followed (realpath ∈ scope is the doctrine rule; a link
 *     could point outside the mounted subtree).
 *
 * Triggers: boot + interval (KEAP_FS_SYNC_INTERVAL_S, 0 disables) and the
 * agent surface (POST /agent/v1/fs/sync) so a host job can kick it after
 * writing files. Everything degrades: without KEAP_USER_FILES_DIR this module
 * is inert.
 */
import crypto from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as db from './db';
import { extractRefs, type ObjectRef } from './objects';
import { markCorpusDirty } from './search';

export const USER_FILES_DIR = process.env.KEAP_USER_FILES_DIR ?? '';
const INTERVAL_S = Number(process.env.KEAP_FS_SYNC_INTERVAL_S ?? 300);
/** Which top-level class dirs under <uid>/ are knowledge (agents/ is scratch). */
const SYNC_DIRS = new Set(
  (process.env.KEAP_FS_SYNC_DIRS ?? 'documents,library,inbox')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** object.type by extension — feeds assetDescriptor (asset-types.ts ALIAS). */
const TYPE_BY_EXT: Record<string, string> = {
  md: 'page', markdown: 'page', txt: 'page', rst: 'page', adoc: 'page',
  pdf: 'document', doc: 'document', docx: 'document', odt: 'document', rtf: 'document',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', heic: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video',
  csv: 'table', tsv: 'table', xlsx: 'table', ods: 'table',
  db: 'database', sqlite: 'database', sqlite3: 'database',
  epub: 'books', mobi: 'books',
};
/** Extensions whose content is plain text worth embedding (body excerpt). */
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'csv', 'tsv']);
const TEXT_READ_CAP = 256 * 1024; // bytes read for the excerpt
const BODY_CAP = 4000; // objectText caps at 4000 anyway — don't store more
const MAX_FILES = 20000; // runaway backstop (a mounted photo dump etc.)

export interface FsSyncResult {
  configured: boolean;
  scanned: number;
  upserted: number;
  removed: number;
  unchanged: number;
  skipped: number;
  users: string[];
  tookMs: number;
}

let lastRun: { at: string; result: FsSyncResult } | null = null;
export const fsSyncStatus = () => ({
  dir: USER_FILES_DIR || null,
  configured: Boolean(USER_FILES_DIR),
  intervalS: INTERVAL_S,
  lastRun,
});

interface FoundFile {
  uid: string;
  relPath: string; // uid-relative, '/'-separated
  size: number;
  mtime: number;
  absPath: string;
}

/** Walk one user's subtree. Hidden entries and symlinks are skipped. */
function walkUser(uid: string, dir: string, rel: string, out: FoundFile[]): void {
  if (out.length >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable dir — doctrine perms may hide it; not our file then
  }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const abs = path.join(dir, e);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) continue; // realpath ∈ scope — never follow links
    const childRel = rel ? `${rel}/${e}` : e;
    if (st.isDirectory()) walkUser(uid, abs, childRel, out);
    else if (st.isFile()) {
      out.push({ uid, relPath: childRel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), absPath: abs });
      if (out.length >= MAX_FILES) return;
    }
  }
}

function typeOf(relPath: string): string {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return TYPE_BY_EXT[ext] ?? 'file';
}

function bodyOf(f: FoundFile): string | undefined {
  const ext = path.extname(f.relPath).slice(1).toLowerCase();
  if (!TEXT_EXT.has(ext) || f.size === 0) return undefined;
  try {
    const buf = readFileSync(f.absPath).subarray(0, TEXT_READ_CAP);
    return buf.toString('utf8').slice(0, BODY_CAP);
  } catch {
    return undefined;
  }
}

/**
 * One full mirror pass: walk every <uid>/ under USER_FILES_DIR, upsert
 * changed files, prune fs-sourced objects whose file is gone.
 */
export function syncUserFiles(): FsSyncResult {
  const t0 = Date.now();
  const result: FsSyncResult = {
    configured: Boolean(USER_FILES_DIR),
    scanned: 0, upserted: 0, removed: 0, unchanged: 0, skipped: 0,
    users: [], tookMs: 0,
  };
  if (!USER_FILES_DIR || !existsSync(USER_FILES_DIR)) {
    result.tookMs = Date.now() - t0;
    lastRun = { at: new Date().toISOString(), result };
    return result;
  }

  const found: FoundFile[] = [];
  for (const uid of readdirSync(USER_FILES_DIR)) {
    if (uid.startsWith('.')) continue;
    const userDir = path.join(USER_FILES_DIR, uid);
    const st = lstatSync(userDir, { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue;
    result.users.push(uid);
    // Only the knowledge classes sync — agents/ scratch stays out of the corpus.
    for (const top of readdirSync(userDir)) {
      if (!SYNC_DIRS.has(top)) continue;
      const topDir = path.join(userDir, top);
      const ts = lstatSync(topDir, { throwIfNoEntry: false });
      if (ts?.isDirectory()) walkUser(uid, topDir, top, found);
    }
  }
  result.scanned = found.length;
  if (found.length >= MAX_FILES) result.skipped = -1; // sentinel: tree was capped

  // Existing fs-sourced objects, keyed by id — the prune set starts as all.
  const existing = new Map(
    db.getObjects('', true)
      .filter((o) => o.frontmatter?.source === 'fs')
      .map((o) => [o.id, o]),
  );

  let changed = false;
  for (const f of found) {
    // Hashed id (URL-safe for GET /api/objects/:id); the path itself is data.
    const id = `fs:${f.uid}:${crypto.createHash('sha1').update(f.relPath).digest('hex').slice(0, 16)}`;
    const prev = existing.get(id);
    existing.delete(id); // seen → not pruned
    if (prev && prev.frontmatter?.size === f.size && prev.frontmatter?.mtime === f.mtime) {
      result.unchanged++;
      continue;
    }
    const dir = path.dirname(f.relPath);
    const body = bodyOf(f);
    // The file owns title/body/frontmatter; curated LINKS survive — union the
    // previous links (human/curator anchors) with refs found in the body, so a
    // markdown file's own [[node-id]] refs anchor it, and curation is never
    // clobbered by the next sync pass.
    const links = new Map<string, ObjectRef>();
    for (const r of [...((prev?.links ?? []) as ObjectRef[]), ...extractRefs(body, undefined)]) {
      links.set(`${r.kind}:${r.ref}`, r);
    }
    db.saveObject(f.uid, {
      id,
      type: typeOf(f.relPath),
      title: path.basename(f.relPath),
      // The folder path is embeddable context ("documents/finance/2026").
      description: dir === '.' ? undefined : dir,
      tags: [f.relPath.split('/')[0]],
      frontmatter: { source: 'fs', path: f.relPath, size: f.size, mtime: f.mtime },
      body,
      links: [...links.values()],
      visibility: 'private',
    });
    result.upserted++;
    changed = true;
  }
  // Prune refusal: zero files found while mirrors exist smells like an
  // unmounted volume or a mid-migration empty dir (the P2 cutover), not a
  // genuine mass delete — deleting the corpus (and its vectors) on a mount
  // hiccup would be unrecoverable without a re-scan AND a re-embed.
  if (found.length === 0 && existing.size > 0) {
    console.warn(`[fs-sync] 0 files under ${USER_FILES_DIR} but ${existing.size} mirrored objects exist — refusing to prune`);
  } else {
    for (const [id] of existing) {
      db.deleteObject(id);
      result.removed++;
      changed = true;
    }
  }
  if (changed) markCorpusDirty();

  result.tookMs = Date.now() - t0;
  lastRun = { at: new Date().toISOString(), result };
  return result;
}

/** Boot hook: initial pass + optional interval. Inert without the env var. */
export function startFsSync(): void {
  if (!USER_FILES_DIR) return;
  const r = syncUserFiles();
  console.log(
    `[fs-sync] ${r.scanned} files under ${USER_FILES_DIR} — ${r.upserted} upserted, ${r.removed} removed, ${r.unchanged} unchanged`,
  );
  if (INTERVAL_S > 0) {
    const t = setInterval(() => syncUserFiles(), INTERVAL_S * 1000);
    t.unref?.(); // never keep the process alive just to poll
  }
}
