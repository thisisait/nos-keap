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
import { extractRefs, anchorNodeIds, type ObjectRef } from './objects';
import { getNode } from './taxonomy';
import { markCorpusDirty } from './search';
import { canonicalUid } from './uid';

export const USER_FILES_DIR = process.env.KEAP_USER_FILES_DIR ?? '';
const INTERVAL_S = Number(process.env.KEAP_FS_SYNC_INTERVAL_S ?? 300);
/** Which top-level class dirs under <uid>/ are knowledge (agents/ is scratch). */
const SYNC_DIRS = new Set(
  (process.env.KEAP_FS_SYNC_DIRS ?? 'documents,library,inbox')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
/** Reserved uids whose mirrors are TENANT-SHARED (Option C for the nOS
 *  self-model: a class-2 shared tree bind-mounted as uid 'nos-docs' should
 *  render in every user's ring, not just its synthetic owner's). Objects of
 *  these uids get visibility 'shared' — /api/graph's getVisibleObjects then
 *  lists them for everyone. Default unset: every users-pass mirror stays
 *  private and the pass is byte-identical to v1.7.0. */
// Canonicalised so a reserved shared uid matches the same key the users pass
// stamps on its mirror objects (both run through canonicalUid). 'nos-docs' is
// already canonical → no-op; a non-canonical config value still lines up.
const SHARED_UIDS = new Set(
  (process.env.KEAP_FS_SHARED_UIDS ?? '')
    .split(',')
    .map((s) => canonicalUid(s.trim()))
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
  /** True when a prune was REFUSED because the found-set could not be trusted
   *  (cap hit, or a walk truncated by an unreadable subtree). Surfaced so a
   *  silent refusal is observable rather than looking like "nothing to remove". */
  pruneRefused?: boolean;
  /** Cards written this pass whose [[node]] anchor does not resolve. Such a card
   *  is INVISIBLE in the constellation view — graph.ts drops the dangling anchor
   *  at read time — so a sync that produces them must say so. Benign and
   *  self-healing when the taxonomy simply has not been ingested yet; a standing
   *  non-zero count means cards are pointing at nodes that will never arrive. */
  danglingAnchors?: number;
}

// ── fs-watch status registration ────────────────────────────────────────────
// server/fs-watch.ts imports THIS module's sync entrypoints, so fsSyncStatus
// cannot import back without a cycle: the watcher registers a status provider
// at boot instead. Purely additive — every existing status key is untouched,
// and without registration the block reads as a disabled watcher.

export interface FsWatchStatusBlock {
  enabled: boolean;
  degraded: boolean;
  watchedRoots: Array<{ key: string; path: string }>;
  lastEvent: { at: string; root: string } | null;
}
let fsWatchStatusFn: (() => FsWatchStatusBlock) | null = null;
export function registerFsWatchStatus(fn: () => FsWatchStatusBlock): void {
  fsWatchStatusFn = fn;
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
  sharedUids: [...SHARED_UIDS],
  watch: fsWatchStatusFn?.() ?? { enabled: false, degraded: false, watchedRoots: [], lastEvent: null },
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

// ── Per-directory aggregates for the explore renderers ──────────────────────
// Collected DURING the walks — purely observational, the mirror behavior
// (ids, skips, prune) is untouched: direct file bytes + extension byte
// buckets per directory, and a repo flag when the dir holds a `.git` entry
// (dir or worktree gitfile — both mean "this folder is a repository").
// Rolled up to subtree totals after each pass; /api/graph ships only the
// repo-flagged dirs so the client can texture + size repo spheres.

interface DirAgg {
  bytes: number;
  repo?: boolean;
  ext: Map<string, number>;
}

/** uid → (dir relPath → subtree agg); rebuilt by every users pass. */
let userDirStats = new Map<string, Map<string, DirAgg>>();
/** mapping id → (dir relPath → subtree agg); rebuilt per mapping sync. */
const mappingDirStats = new Map<string, Map<string, DirAgg>>();

function dirAggAt(stats: Map<string, DirAgg>, rel: string): DirAgg {
  let s = stats.get(rel);
  if (!s) {
    s = { bytes: 0, ext: new Map() };
    stats.set(rel, s);
  }
  return s;
}

/** Roll direct per-dir aggregates up to subtree totals ('' = the walk root). */
function rollupDirStats(direct: Map<string, DirAgg>): Map<string, DirAgg> {
  const total = new Map<string, DirAgg>();
  for (const [rel, s] of direct) {
    let key = rel;
    for (;;) {
      const t = dirAggAt(total, key);
      t.bytes += s.bytes;
      for (const [e, b] of s.ext) t.ext.set(e, (t.ext.get(e) ?? 0) + b);
      if (key === '') break;
      const i = key.lastIndexOf('/');
      key = i === -1 ? '' : key.slice(0, i);
    }
    if (s.repo) dirAggAt(total, rel).repo = true;
  }
  return total;
}

export interface FsDirStat {
  path: string;
  bytes: number;
  repo: true;
  /** Extension byte buckets, largest first (client maps ext → language). */
  exts: Array<[string, number]>;
}

/**
 * Repo-flagged directories visible to this user: own users-tree dirs, shared
 * uids' dirs (Option C), everything for admins — mirroring exactly which
 * OBJECTS the graph ships, so no private tree structure leaks through stats.
 * Mapping namespaces use the client's `@<mapId>/…` folder-path convention.
 */
export function getFsDirStats(userId: string, isAdmin: boolean, mappingIds: Set<string>): FsDirStat[] {
  const merged = new Map<string, DirAgg>();
  for (const [uid, stats] of userDirStats) {
    if (!isAdmin && uid !== userId && !SHARED_UIDS.has(uid)) continue;
    for (const [rel, s] of stats) {
      const t = dirAggAt(merged, rel);
      t.bytes += s.bytes;
      if (s.repo) t.repo = true;
      for (const [e, b] of s.ext) t.ext.set(e, (t.ext.get(e) ?? 0) + b);
    }
  }
  const out: FsDirStat[] = [];
  const push = (p: string, s: DirAgg) => {
    if (!s.repo) return;
    out.push({
      path: p,
      bytes: s.bytes,
      repo: true,
      exts: [...s.ext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    });
  };
  for (const [rel, s] of merged) push(rel, s);
  for (const [id, stats] of mappingDirStats) {
    if (!mappingIds.has(id)) continue;
    for (const [rel, s] of stats) push(rel ? `@${id}/${rel}` : `@${id}`, s);
  }
  return out;
}

/** Walk one subtree. Hidden entries and symlinks are skipped. Shared by the
 *  users pass and the mapping pass — identical rules for both. Returns false
 *  when ANY readdir failed (EACCES, a dropped sub-mount): the found-set is
 *  then TRUNCATED exactly like a capped one — every file under the unreadable
 *  subtree is missing — so callers must not prune against it. Cap-hits are
 *  not flagged here; callers detect those via out.length >= cap. */
function walkDir(dir: string, rel: string, out: FoundFile[], cap: number, stats?: Map<string, DirAgg>): boolean {
  if (out.length >= cap) return true;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false; // unreadable dir — this subtree was NOT enumerated
  }
  // `.git` itself is a hidden entry (skipped below) — but its PRESENCE marks
  // this dir as a repository for the renderer stats.
  if (stats && entries.includes('.git')) dirAggAt(stats, rel).repo = true;
  let complete = true;
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const abs = path.join(dir, e);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) continue; // realpath ∈ scope — never follow links
    const childRel = rel ? `${rel}/${e}` : e;
    if (st.isDirectory()) {
      if (!walkDir(abs, childRel, out, cap, stats)) complete = false;
    } else if (st.isFile()) {
      if (stats) {
        const s = dirAggAt(stats, rel);
        s.bytes += st.size;
        const ext = path.extname(e).slice(1).toLowerCase();
        if (ext) s.ext.set(ext, (s.ext.get(ext) ?? 0) + st.size);
      }
      out.push({ relPath: childRel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), absPath: abs });
      if (out.length >= cap) return complete;
    }
  }
  return complete;
}

/** Walk one user's subtree — walkDir + uid stamping. The MAX_FILES cap is
 *  shared across ALL users via the shared out array. Returns false when the walk
 *  was truncated by an unreadable subdir, which the caller MUST honour: this flag
 *  used to be dropped here, and the users pass pruned against a truncated
 *  found-set exactly like the mapping pass did before it grew the same guard. */
function walkUser(
  uid: string,
  dir: string,
  rel: string,
  out: UserFoundFile[],
  stats?: Map<string, DirAgg>,
): boolean {
  const before = out.length;
  const complete = walkDir(dir, rel, out, MAX_FILES, stats);
  for (let i = before; i < out.length; i++) out[i].uid = uid;
  return complete;
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

/** Honored frontmatter keys and their validators. Everything else is preserved
 *  verbatim under `frontmatter.fm` but never interpreted. */
const FM_TYPE_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Minimal leading-YAML-block reader for fs-synced cards: `--- key: value … ---`
 * with FLAT SCALAR values only — no nesting, no lists, no quoting rules. That is
 * deliberate: this is a card contract, not a YAML implementation, and the two
 * keys it honors decide things that were previously impossible to express
 * through fs-sync at all — `type` (a skill card typed by its extension landed as
 * 'page', which made the skill facet and the type's visual form unreachable for
 * the entire router corpus) and `title` (basename-only titling is what produced
 * nine cards named `_stack.md`).
 *
 * Unknown keys ride along untouched in `fm`; a malformed block is treated as
 * body text, never an error — a producer typo must not eat the card.
 */
/** Bump when parsing SEMANTICS change: it participates in the unchanged-skip,
 *  so a bump forces one full re-parse pass. Without this leg, a card mirrored
 *  under an older parser keeps its stale identity until the file itself is
 *  touched — size and mtime cannot see a parser upgrade. */
export const FM_VERSION = 1;

export function parseCardFrontmatter(raw: string | undefined): {
  type?: string;
  title?: string;
  fm?: Record<string, string>;
  body: string | undefined;
} {
  if (!raw) return { body: raw };
  // CRLF-normalise BEFORE detection: a producer on another OS (or a checkout
  // with core.autocrlf) writes '---\r\n', and a byte-exact gate would silently
  // disable frontmatter for that whole tree — type/title lost, no error.
  const norm = raw.includes('\r\n') ? raw.replace(/\r\n/g, '\n') : raw;
  if (!norm.startsWith('---\n')) return { body: raw };
  // The closing delimiter must be a LONE '---' line, not any later substring —
  // a markdown note that opens with a horizontal rule and has another one pages
  // later must not have its prefix eaten as junk keys.
  const close = /\n---[ \t]*(?:\n|$)/.exec(norm.slice(4));
  if (!close) return { body: raw };
  const block = norm.slice(4, 4 + close.index);
  const rest = norm.slice(4 + close.index + close[0].length);
  const fm: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(t);
    // STRICT: one non-key line means this is not frontmatter, it is a document
    // that happens to start with a rule — treat the whole thing as body.
    if (!m) return { body: raw };
    fm[m[1]] = m[2].trim();
  }
  if (!Object.keys(fm).length) return { body: raw };
  const type = fm.type && FM_TYPE_RE.test(fm.type) ? fm.type : undefined;
  const title = fm.title?.trim() ? fm.title.trim().slice(0, 200) : undefined;
  return { type, title, fm, body: rest };
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
  // False once any user subtree hits an unreadable dir — see the prune rule below.
  let walkComplete = true;
  const dirSink = new Map<string, Map<string, DirAgg>>();
  for (const rawDir of readdirSync(USER_FILES_DIR)) {
    if (rawDir.startsWith('.')) continue;
    const userDir = path.join(USER_FILES_DIR, rawDir); // FS path uses the RAW name
    const st = lstatSync(userDir, { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue;
    // OWNER key is the canonical slug of the folder name — the SAME transform
    // the identity middleware applies to X-Authentik-Username, so a user's
    // mirrored files and their DB rows share one owner. Bone already writes
    // canonical slug folders, so this is a no-op for live trees; it just makes
    // the match KEAP-enforced rather than Bone-dependent. Skip folders that
    // canonicalise to empty (e.g. '...').
    const uid = canonicalUid(rawDir);
    if (!uid) continue;
    result.users.push(uid);
    const uidSink = new Map<string, DirAgg>();
    dirSink.set(uid, uidSink);
    // Only the knowledge classes sync — agents/ scratch stays out of the corpus.
    for (const top of readdirSync(userDir)) {
      if (!SYNC_DIRS.has(top)) continue;
      const topDir = path.join(userDir, top);
      const ts = lstatSync(topDir, { throwIfNoEntry: false });
      if (ts?.isDirectory() && !walkUser(uid, topDir, top, found, uidSink)) walkComplete = false;
    }
  }
  userDirStats = new Map([...dirSink].map(([uid, m]) => [uid, rollupDirStats(m)]));
  result.scanned = found.length;
  if (found.length >= MAX_FILES) result.skipped = -1; // sentinel: tree was capped

  // Existing fs-sourced objects, keyed by id — the prune set starts as all.
  const existing = new Map(
    db.getObjects('', true)
      .filter((o) => o.frontmatter?.source === 'fs')
      .map((o) => [o.id, o]),
  );

  let changed = false;
  let danglingAnchors = 0;
  for (const f of found) {
    // Hashed id (URL-safe for GET /api/objects/:id); the path itself is data.
    const id = `fs:${f.uid}:${crypto.createHash('sha1').update(f.relPath).digest('hex').slice(0, 16)}`;
    const prev = existing.get(id);
    existing.delete(id); // seen → not pruned
    // Visibility is part of the skip key: flipping KEAP_FS_SHARED_UIDS must
    // propagate to already-mirrored files exactly once (mtime/size alone
    // would skip them forever).
    const visibility = SHARED_UIDS.has(f.uid) ? 'shared' : 'private';
    if (
      prev &&
      prev.frontmatter?.size === f.size &&
      prev.frontmatter?.mtime === f.mtime &&
      prev.frontmatter?.fmv === FM_VERSION &&
      (prev.visibility ?? 'private') === visibility
    ) {
      result.unchanged++;
      continue;
    }
    const dir = path.dirname(f.relPath);
    const card = parseCardFrontmatter(bodyOf(f));
    const body = card.body;
    // The file owns title/body/frontmatter; curated LINKS survive — union the
    // previous links (human/curator anchors) with refs found in the body, so a
    // markdown file's own [[node-id]] refs anchor it, and curation is never
    // clobbered by the next sync pass.
    const links = new Map<string, ObjectRef>();
    for (const r of [...((prev?.links ?? []) as ObjectRef[]), ...extractRefs(body, undefined)]) {
      links.set(`${r.kind}:${r.ref}`, r);
    }
    // Count anchors that do not resolve RIGHT NOW. fs-sync runs on boot and on a
    // timer, independent of whichever job ingests the taxonomy, so a card can
    // legitimately land before its node exists — it becomes visible by itself on
    // the next graph read, because anchors are re-filtered per request. What is
    // NOT acceptable is that happening quietly.
    const unresolved = anchorNodeIds([...links.values()]).filter((a) => !getNode(a)).length;
    if (unresolved) danglingAnchors += unresolved;
    db.saveObject(f.uid, {
      id,
      type: card.type ?? typeOf(f.relPath),
      title: card.title ?? path.basename(f.relPath),
      // The folder path is embeddable context ("documents/finance/2026").
      description: dir === '.' ? undefined : dir,
      tags: [f.relPath.split('/')[0]],
      frontmatter: {
        source: 'fs', path: f.relPath, size: f.size, mtime: f.mtime, fmv: FM_VERSION,
        ...(card.fm ? { fm: card.fm } : {}),
      },
      body,
      links: [...links.values()],
      visibility,
    });
    result.upserted++;
    changed = true;
  }
  // Prune rules, mirroring the mapping pass (which grew these first).
  if (result.skipped === -1) {
    // Cap hit: the found-set is truncated by construction, so every unseen
    // mirror is unproven, not absent.
    result.pruneRefused = true;
    console.warn(
      `[fs-sync] users pass: walk capped at ${MAX_FILES} files with ${existing.size} unseen mirrored object(s) — refusing to prune`,
    );
  } else if (!walkComplete && existing.size > 0) {
    // A readdir failed mid-walk (EACCES, a dropped sub-mount). The found-set is
    // truncated PARTIALLY — sibling dirs still listed, so scanned > 0 and the
    // zero-scan guard below never fires. Pruning here would mass-delete every
    // mirror under the unreadable subtree AND reap its vectors, recoverable only
    // by a full re-scan plus a re-embed. Refuse; the mirrors survive until the
    // subtree reads again.
    result.pruneRefused = true;
    console.warn(
      `[fs-sync] users pass: walk truncated by an unreadable subtree with ${existing.size} unseen mirrored object(s) — refusing to prune`,
    );
  } else if (found.length === 0 && existing.size > 0) {
    // Zero files found while mirrors exist smells like an unmounted volume or a
    // mid-migration empty dir (the P2 cutover), not a genuine mass delete.
    result.pruneRefused = true;
    console.warn(`[fs-sync] 0 files under ${USER_FILES_DIR} but ${existing.size} mirrored objects exist — refusing to prune`);
  } else {
    // PER-UID zero-scan guard. The prune set spans every uid, but the guard
    // above asks only whether the WHOLE pass found nothing — so a uid whose
    // tree is empty this pass has its mirrors deleted as long as some other uid
    // contributed a file. That is not hypothetical: a bind-mounted shared tree
    // (the nOS self-model under KEAP_FS_SHARED_UIDS) exists before its content
    // does, and a sync landing in that gap would reap the entire corpus and its
    // embeddings while the global guard stayed silent. Today the live estate is
    // protected only by the accident that nearly every file belongs to that one
    // uid; one file in any other tree removes that protection.
    const foundByUid = new Set(found.map((f) => f.uid));
    const heldBack = new Map<string, number>();
    for (const [id, o] of existing) {
      const uid = o.userId;
      if (uid && !foundByUid.has(uid)) {
        heldBack.set(uid, (heldBack.get(uid) ?? 0) + 1);
        continue;
      }
      db.deleteObject(id);
      result.removed++;
      changed = true;
    }
    if (heldBack.size) {
      result.pruneRefused = true;
      for (const [uid, n] of heldBack) {
        console.warn(
          `[fs-sync] uid '${uid}' contributed 0 files this pass but has ${n} mirrored object(s) — ` +
            `refusing to prune them (empty or not-yet-populated tree, not a mass delete)`,
        );
      }
    }
  }
  if (changed) markCorpusDirty();
  if (danglingAnchors) {
    result.danglingAnchors = danglingAnchors;
    console.warn(
      `[fs-sync] ${danglingAnchors} anchor(s) point at taxonomy nodes that do not exist — ` +
        `those cards render nowhere in the constellation until the nodes are ingested`,
    );
  }

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
    const mapSink = new Map<string, DirAgg>();
    const walkComplete = walkDir(resolved.abs, '', found, MAX_FILES, mapSink);
    mappingDirStats.set(m.id, rollupDirStats(mapSink));
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
      if (
        prev &&
        prev.frontmatter?.size === f.size &&
        prev.frontmatter?.mtime === f.mtime &&
        prev.frontmatter?.cfg === cfg &&
        prev.frontmatter?.fmv === FM_VERSION
      ) {
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
        const card = parseCardFrontmatter(bodyOf(f));
        const body = card.body;
        // Same union rule as the users pass: curated links survive resyncs.
        // The mapping's taxonomy anchors are NOT injected here — they live on
        // the mapping row and render as hub-level rays, never N×5000 orbits.
        const links = new Map<string, ObjectRef>();
        for (const r of [...((prev?.links ?? []) as ObjectRef[]), ...extractRefs(body, undefined)]) {
          links.set(`${r.kind}:${r.ref}`, r);
        }
        db.saveObject(owner, {
          id,
          // Precedence: the mapping's declared type wins (an admin scoping a
          // folder to one type is a policy), then the file's own claim, then
          // the extension fallback. Title: the file's claim, then basename.
          type: m.schema.type ?? card.type ?? typeOf(f.relPath),
          title: card.title ?? path.basename(f.relPath),
          description: dir === '.' ? undefined : dir,
          tags: m.tags, // exactly the mapping's tags — no top-segment tag
          // Reserved keys win via spread order (validation also strips them
          // from the stored template — belt and suspenders).
          frontmatter: {
            ...template,
            source: 'fs-mapping', mapping: m.id, root: m.rootKey,
            path: f.relPath, size: f.size, mtime: f.mtime, cfg, fmv: FM_VERSION,
            ...(card.fm ? { fm: card.fm } : {}),
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
    } else if (!walkComplete && index.size > 0) {
      // A readdir failed mid-walk (EACCES, a dropped sub-mount under the
      // root): the found-set is truncated the same way the cap truncates it,
      // except PARTIALLY — sibling dirs still listed, so scanned > 0 and the
      // zero-scan guard below never fires. Pruning here would mass-delete
      // every mirror under the unreadable subtree (and reap its vectors);
      // refuse instead — the mirrors survive until the subtree reads again.
      result.pruneRefused = true;
      console.warn(
        `[fs-sync] mapping ${m.id}: walk under ${m.rootKey}/${m.relPath} truncated by an unreadable subtree with ${index.size} unseen mirrored object(s) — refusing to prune`,
      );
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
