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
 * The SECOND half of this module is the admin-managed "mapped folders" mirror
 * (fs_mappings rows over read-only KEAP_FS_ROOTS mounts — see syncMapping and
 * server/fs-roots.ts). It shares the walker and the object pipeline but is
 * isolated by construction: owner 'fsmap:<id>', ids 'fsm:…', frontmatter
 * source='fs-mapping' — the users-pass prune filter never sees its rows.
 *
 * Triggers: boot + interval (KEAP_FS_SYNC_INTERVAL_S, 0 disables) and the
 * agent surface (POST /agent/v1/fs/sync) so a host job can kick it after
 * writing files. Everything degrades: without KEAP_USER_FILES_DIR and
 * KEAP_FS_ROOTS this module is inert.
 */
import crypto from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as db from './db';
import { listRoots, resolveInRoot } from './fs-roots';
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
  // Additive blocks (agent back-compat — existing keys untouched): mounted
  // roots + per-mapping status for the admin panel and /agent/v1/fs/status.
  roots: listRoots(),
  mappings: mappingStatusBlock(),
});

/** Per-mapping status summary. Hard caps (50 items, 60-char labels) keep the
 *  agent payload under its 16KiB budget — normative, not decorative. */
function mappingStatusBlock() {
  const rows = db.listFsMappings();
  return {
    total: rows.length,
    items: rows.slice(0, 50).map((m) => ({
      id: m.id,
      label: m.label.slice(0, 60),
      enabled: m.enabled,
      // Live probe, not the last pass's snapshot — a mount that appeared
      // after boot reads available before anything re-syncs.
      rootAvailable: resolveInRoot(m.rootKey, m.relPath).ok,
      objectCount: db.countObjectsByOwner(`fsmap:${m.id}`),
      lastSync: m.lastSync
        ? {
            at: m.lastSyncAt ? new Date(m.lastSyncAt * 1000).toISOString() : null,
            scanned: m.lastSync.scanned ?? 0,
            upserted: m.lastSync.upserted ?? 0,
            removed: m.lastSync.removed ?? 0,
            unchanged: m.lastSync.unchanged ?? 0,
            capped: Boolean(m.lastSync.capped),
            pruneRefused: Boolean(m.lastSync.pruneRefused),
          }
        : null,
    })),
  };
}

interface FoundFile {
  relPath: string; // scope-relative, '/'-separated
  size: number;
  mtime: number;
  absPath: string;
}

interface UserFoundFile extends FoundFile {
  uid: string;
}

/** Walk one subtree. Hidden entries and symlinks are skipped. Shared by the
 *  users pass and the mapping pass — identical rules for both. */
function walkDir(dir: string, rel: string, out: FoundFile[], cap: number): void {
  if (out.length >= cap) return;
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
    if (st.isDirectory()) walkDir(abs, childRel, out, cap);
    else if (st.isFile()) {
      out.push({ relPath: childRel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), absPath: abs });
      if (out.length >= cap) return;
    }
  }
}

/** Walk one user's subtree — walkDir + uid stamping. The MAX_FILES cap is
 *  shared across ALL users via the shared out array (unchanged behavior). */
function walkUser(uid: string, dir: string, rel: string, out: UserFoundFile[]): void {
  const before = out.length;
  walkDir(dir, rel, out, MAX_FILES);
  for (let i = before; i < out.length; i++) out[i].uid = uid;
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

  const found: UserFoundFile[] = [];
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

// ── Mapped folders (fs_mappings) — the admin-managed shared mirror ──────────
// Same walk/upsert/prune shape as the users pass, but scoped to ONE mapping:
// owner 'fsmap:<id>', object ids 'fsm:<id>:<sha1(relPath)[:16]>' with relPath
// MAPPING-relative (repointing a moved host folder with identical structure
// keeps every id and embedding). frontmatter.source='fs-mapping' is disjoint
// from the users pass's 'fs' — the two prune filters can never see each
// other's rows. See server/fs-roots.ts for the mount registry and db.ts for
// the fs_mappings CRUD.

export interface FsMappingSyncResult {
  scanned: number;
  upserted: number;
  removed: number;
  unchanged: number;
  capped: boolean;
  pruneRefused: boolean;
  rootAvailable: boolean;
  tookMs: number;
  error?: string;
}

/**
 * Config fingerprint stamped into every mirrored object's frontmatter.cfg —
 * the third leg of the unchanged-skip (size+mtime+cfg), so a schema/tags/
 * visibility edit defeats the skip exactly once (one full rewrite + embed
 * bump, then cheap again) while a label/description typo fix rewrites nothing.
 */
export function mappingCfgHash(m: db.FsMappingRow): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ t: m.schema.type ?? null, f: m.schema.frontmatter ?? {}, g: m.tags, v: m.visibility }))
    .digest('hex')
    .slice(0, 8);
}

/** One mirror pass for one mapping. Never throws — a crashed walk lands in
 *  result.error and the status row, so Admin never shows a stale healthy
 *  status after a crash (persistence runs in the finally). */
export function syncMapping(m: db.FsMappingRow): FsMappingSyncResult {
  const t0 = Date.now();
  const result: FsMappingSyncResult = {
    scanned: 0, upserted: 0, removed: 0, unchanged: 0,
    capped: false, pruneRefused: false, rootAvailable: true, tookMs: 0,
  };
  try {
    // Containment re-verified EVERY pass — a hand-edited DB row can't escape
    // the root. Missing/unmounted root: NO walk, NO prune, objects + vectors
    // survive until the mount returns.
    const resolved = resolveInRoot(m.rootKey, m.relPath);
    if (!resolved.ok) {
      result.rootAvailable = false;
      return result;
    }
    const found: FoundFile[] = [];
    walkDir(resolved.abs, '', found, MAX_FILES);
    result.scanned = found.length;
    // Capped walk = truncated found-set. Pruning against it would delete
    // objects for files the walk never reached, so prune is skipped entirely.
    result.capped = found.length >= MAX_FILES;

    const owner = `fsmap:${m.id}`;
    // Skip/prune index — ids seen on disk drop out; the remainder is pruned.
    const index = db.getObjectSyncIndex(owner);
    const cfg = mappingCfgHash(m);
    const template = m.schema.frontmatter ?? {};

    const toWrite: Array<{ f: FoundFile; id: string; prev?: db.ObjectSyncIndexEntry }> = [];
    for (const f of found) {
      const id = `fsm:${m.id}:${crypto.createHash('sha1').update(f.relPath).digest('hex').slice(0, 16)}`;
      const prev = index.get(id);
      index.delete(id); // seen → not pruned
      if (prev && prev.frontmatter?.size === f.size && prev.frontmatter?.mtime === f.mtime && prev.frontmatter?.cfg === cfg) {
        result.unchanged++;
        continue;
      }
      toWrite.push({ f, id, prev });
    }

    let changed = false;
    // Upserts batched 500/transaction — WAL burst control on big mappings.
    const writeBatch = db.getDb().transaction((batch: typeof toWrite) => {
      for (const { f, id, prev } of batch) {
        const dir = path.dirname(f.relPath);
        const body = bodyOf(f);
        // Same union rule as the users pass: curated links survive resyncs.
        // The mapping's taxonomy anchors are NOT injected here — they live on
        // the mapping row and render as hub-level rays, never N×5000 orbits.
        const links = new Map<string, ObjectRef>();
        for (const r of [...((prev?.links ?? []) as ObjectRef[]), ...extractRefs(body, undefined)]) {
          links.set(`${r.kind}:${r.ref}`, r);
        }
        db.saveObject(owner, {
          id,
          type: m.schema.type ?? typeOf(f.relPath),
          title: path.basename(f.relPath),
          description: dir === '.' ? undefined : dir,
          tags: m.tags, // exactly the mapping's tags — no top-segment tag
          // Reserved keys win via spread order (validation also strips them
          // from the stored template — belt and suspenders).
          frontmatter: {
            ...template,
            source: 'fs-mapping', mapping: m.id, root: m.rootKey,
            path: f.relPath, size: f.size, mtime: f.mtime, cfg,
          },
          body,
          links: [...links.values()],
          visibility: m.visibility,
        });
        result.upserted++;
      }
    });
    for (let i = 0; i < toWrite.length; i += 500) writeBatch(toWrite.slice(i, i + 500));
    if (toWrite.length > 0) changed = true;

    if (result.capped) {
      // no prune — see above
    } else if (result.scanned === 0 && index.size > 0) {
      // Per-mapping twin of the users-pass guard: zero files while mirrors
      // exist reads as an emptied dir vs mount race, not a mass delete.
      result.pruneRefused = true;
      console.warn(
        `[fs-sync] mapping ${m.id}: 0 files under ${m.rootKey}/${m.relPath} but ${index.size} mirrored objects exist — refusing to prune`,
      );
    } else {
      for (const [id] of index) {
        db.deleteObject(id);
        result.removed++;
        changed = true;
      }
    }
    if (changed) markCorpusDirty();
  } catch (e) {
    result.error = String(e).slice(0, 200);
  } finally {
    result.tookMs = Date.now() - t0;
    try {
      db.setFsMappingSyncStatus(m.id, Math.floor(Date.now() / 1000), JSON.stringify(result));
    } catch (e) {
      console.warn(`[fs-sync] mapping ${m.id}: failed to persist sync status:`, e);
    }
  }
  return result;
}

// One in-flight guard for every trigger (boot, interval, agent, admin HTTP).
// The walk is synchronous today, so this documents the invariant more than it
// races — interval callers skip silently, HTTP callers turn it into a 409.
let inFlight = false;
export const fsSyncInFlight = (): boolean => inFlight;

export interface FsAllSyncResult {
  users: FsSyncResult | null;
  mappings: Array<{ id: string } & FsMappingSyncResult>;
}

/** Full pass: users tree (if configured) + every ENABLED mapping, in order.
 *  Returns null when a pass is already in flight (caller decides how loud). */
export function syncAllFs(): FsAllSyncResult | null {
  if (inFlight) return null;
  inFlight = true;
  try {
    const users = USER_FILES_DIR ? syncUserFiles() : null;
    const mappings: FsAllSyncResult['mappings'] = [];
    for (const m of db.listFsMappings()) {
      if (!m.enabled) continue; // paused: no sync, objects retained
      mappings.push({ id: m.id, ...syncMapping(m) });
    }
    return { users, mappings };
  } finally {
    inFlight = false;
  }
}

/** Boot hook: initial pass + optional interval. Inert only when NEITHER the
 *  users tree nor any KEAP_FS_ROOTS mount is configured — mappings must sync
 *  even without the per-user tree. */
export function startFsSync(): void {
  if (!USER_FILES_DIR && listRoots().length === 0) return;
  const r = syncAllFs();
  if (r?.users) {
    console.log(
      `[fs-sync] ${r.users.scanned} files under ${USER_FILES_DIR} — ${r.users.upserted} upserted, ${r.users.removed} removed, ${r.users.unchanged} unchanged`,
    );
  }
  if (r && r.mappings.length > 0) {
    const scanned = r.mappings.reduce((n, x) => n + x.scanned, 0);
    const upserted = r.mappings.reduce((n, x) => n + x.upserted, 0);
    console.log(`[fs-sync] ${r.mappings.length} mapping(s) — ${scanned} files scanned, ${upserted} upserted`);
  }
  if (INTERVAL_S > 0) {
    const t = setInterval(() => syncAllFs(), INTERVAL_S * 1000);
    t.unref?.(); // never keep the process alive just to poll
  }
}
