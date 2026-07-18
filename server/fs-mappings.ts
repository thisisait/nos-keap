/**
 * Admin HTTP surface for the mapped folders (fs_mappings) — CRUD over the
 * admin-managed read-only mirrors of KEAP_FS_ROOTS directories, plus the
 * roots listing and the folder picker's browse endpoint.
 *
 * Mounted in server/index.ts BETWEEN registerGraphRoutes and registerApiRoutes
 * (routes.ts ends with the /api 404 fallback — anything after it is
 * unreachable) and therefore behind identityMiddleware; every route here is
 * additionally admin-gated (403), same pattern as routes.ts requireAdmin.
 *
 * The sync engine lives in server/fs-sync.ts (syncMapping), the mount
 * registry in server/fs-roots.ts, the row CRUD in db.ts. This module owns
 * VALIDATION: the object-materialization schema, tags, taxonomy anchors and
 * the overlap check (two mappings over one tree would double-ingest).
 */
import crypto from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import * as db from './db';
import { listRoots, resolveInRoot, type ResolveInRootResult } from './fs-roots';
import { fsSyncStatus, fsSyncInFlight, syncMapping, mappingCfgHash } from './fs-sync';
import { getNode } from './taxonomy';
import { markCorpusDirty } from './search';

const ok = (res: Response, data?: unknown) => res.json({ success: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ success: false, error });

function requireAdmin(req: Request, res: Response): boolean {
  if (!req.user.isAdmin) {
    fail(res, 403, 'admin privileges required');
    return false;
  }
  return true;
}

/** Validation failure carrying its HTTP status — the create/patch ladder
 *  shares one set of throwing parsers instead of two copies of the checks. */
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** resolveInRoot's typed errors → HTTP: everything is a caller mistake (400)
 *  except a path that simply isn't a directory / isn't mounted (404). */
function failResolve(res: Response, r: Extract<ResolveInRootResult, { ok: false }>) {
  return fail(res, r.error === 'not-a-dir' ? 404 : 400, r.message);
}

// Reserved frontmatter keys — the sync engine owns these (spread order wins
// there too; stripping here is belt and suspenders + honest admin feedback).
const RESERVED_FM_KEYS = new Set(['source', 'mapping', 'root', 'path', 'size', 'mtime', 'cfg']);
const FRONTMATTER_MAX_BYTES = 2048;
const TYPE_MAX_CHARS = 40;
const MAX_TAXONOMY_LINKS = 12;

/** {type?, frontmatter?} template — type ≤40 chars, frontmatter a plain
 *  object ≤2KB with reserved keys stripped. */
function parseSchema(raw: unknown): db.FsMappingRow['schema'] {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'schema must be an object');
  const b = raw as Record<string, unknown>;
  const schema: db.FsMappingRow['schema'] = {};
  if (b.type !== undefined && b.type !== null && String(b.type).trim() !== '') {
    if (typeof b.type !== 'string' || b.type.trim().length > TYPE_MAX_CHARS) {
      throw new ApiError(400, `schema.type must be a string of at most ${TYPE_MAX_CHARS} chars`);
    }
    schema.type = b.type.trim();
  }
  if (b.frontmatter !== undefined && b.frontmatter !== null) {
    if (typeof b.frontmatter !== 'object' || Array.isArray(b.frontmatter)) {
      throw new ApiError(400, 'schema.frontmatter must be an object');
    }
    const fm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b.frontmatter as Record<string, unknown>)) {
      if (!RESERVED_FM_KEYS.has(k)) fm[k] = v;
    }
    if (JSON.stringify(fm).length > FRONTMATTER_MAX_BYTES) {
      throw new ApiError(400, `schema.frontmatter too large (max ${FRONTMATTER_MAX_BYTES} bytes)`);
    }
    if (Object.keys(fm).length > 0) schema.frontmatter = fm;
  }
  return schema;
}

function parseTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, 'tags must be an array of strings');
  return [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))];
}

function parseTaxonomyRoot(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = String(raw);
  if (!getNode(id)) throw new ApiError(400, `unknown taxonomy node ${id}`);
  return id;
}

/** ≤12 valid node ids, deduped, with the primary root excluded. */
function parseTaxonomyLinks(raw: unknown, root: string | null): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, 'taxonomyLinks must be an array of node ids');
  const links = [...new Set(raw.map(String).filter((id) => id && id !== root))];
  if (links.length > MAX_TAXONOMY_LINKS) {
    throw new ApiError(400, `at most ${MAX_TAXONOMY_LINKS} taxonomy links`);
  }
  for (const id of links) {
    if (!getNode(id)) throw new ApiError(400, `unknown taxonomy node ${id}`);
  }
  return links;
}

function parseVisibility(raw: unknown): string {
  if (raw === undefined || raw === null) return 'shared';
  if (raw !== 'shared' && raw !== 'private') {
    throw new ApiError(400, "visibility must be 'shared' or 'private'");
  }
  return raw;
}

/**
 * Overlap guard (decision #10): equal / ancestor / descendant RESOLVED
 * realpaths against ALL mappings including disabled ones (a paused overlap
 * double-ingests the moment it is re-enabled). When the other mapping's dir
 * cannot be resolved (unmounted root, vanished dir), fall back to the lexical
 * relPath relation within the same root — an unmounted overlap is still an
 * overlap once the mount returns.
 */
function findOverlap(
  rootKey: string,
  relPath: string,
  abs: string,
  excludeId?: string,
): db.FsMappingRow | null {
  for (const m of db.listFsMappings()) {
    if (m.id === excludeId) continue;
    const r = resolveInRoot(m.rootKey, m.relPath);
    if (r.ok) {
      // Realpath containment catches symlinked aliases too.
      if (r.abs === abs || r.abs.startsWith(abs + path.sep) || abs.startsWith(r.abs + path.sep)) {
        return m;
      }
    } else if (m.rootKey === rootKey) {
      if (
        m.relPath === relPath ||
        m.relPath === '' ||
        relPath === '' ||
        m.relPath.startsWith(relPath + '/') ||
        relPath.startsWith(m.relPath + '/')
      ) {
        return m;
      }
    }
  }
  return null;
}

/** The mapping whose (root, relPath) equals or is an ANCESTOR of the browsed
 *  path — the picker disables Save pre-emptively instead of eating a 409. */
function mappingCovering(rootKey: string, relPath: string): db.FsMappingRow | null {
  for (const m of db.listFsMappings()) {
    if (m.rootKey !== rootKey) continue;
    if (m.relPath === relPath || m.relPath === '' || relPath.startsWith(m.relPath + '/')) return m;
  }
  return null;
}

/** API shape of one mapping row: camelCase fields + a live status block
 *  (object count, live root probe, last persisted sync result). */
function toApi(m: db.FsMappingRow) {
  return {
    id: m.id,
    rootKey: m.rootKey,
    relPath: m.relPath,
    label: m.label,
    description: m.description,
    nestUnderFiles: m.nestUnderFiles,
    schema: m.schema,
    tags: m.tags,
    taxonomyRoot: m.taxonomyRoot,
    taxonomyLinks: m.taxonomyLinks,
    visibility: m.visibility,
    enabled: m.enabled,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    status: {
      objectCount: db.countObjectsByOwner(`fsmap:${m.id}`),
      // Live probe (not the last pass's snapshot) — a mount that appeared
      // after boot reads available immediately.
      rootAvailable: resolveInRoot(m.rootKey, m.relPath).ok,
      lastSync: m.lastSync
        ? {
            at: m.lastSyncAt ? new Date(m.lastSyncAt * 1000).toISOString() : null,
            scanned: m.lastSync.scanned ?? 0,
            upserted: m.lastSync.upserted ?? 0,
            removed: m.lastSync.removed ?? 0,
            unchanged: m.lastSync.unchanged ?? 0,
            capped: Boolean(m.lastSync.capped),
            pruneRefused: Boolean(m.lastSync.pruneRefused),
            tookMs: m.lastSync.tookMs ?? 0,
            error: m.lastSync.error ?? null,
          }
        : null,
    },
  };
}

export function registerFsMappingRoutes(app: Express) {
  // Mounted roots + the users-tree line — the Admin panel's status strip.
  app.get('/api/fs/roots', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const s = fsSyncStatus();
    ok(res, {
      roots: listRoots(),
      userFiles: { dir: s.dir, configured: s.configured, intervalS: s.intervalS, lastRun: s.lastRun },
    });
  });

  // Folder picker: one directory level with per-subdir counts, a sample of
  // the files here, and the pre-emptive already-mapped warning. Same
  // hidden/symlink rules as the sync walker — what you see is what syncs.
  app.get('/api/fs/browse', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const root = String(req.query.root ?? '');
    const relPath = String(req.query.path ?? '');
    const r = resolveInRoot(root, relPath);
    if (!r.ok) return failResolve(res, r);

    const dirNames: string[] = [];
    const fileNames: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(r.abs).sort();
    } catch {
      return fail(res, 404, `'${relPath}' is not a readable directory`);
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const st = lstatSync(path.join(r.abs, e), { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) dirNames.push(e);
      else if (st.isFile()) fileNames.push(e);
    }
    // ≤500 dirs, alphabetical — >500 sibling dirs is not a realistic admin
    // tree; truncated:true tells the picker the list is partial.
    const truncated = dirNames.length > 500;
    const dirs = dirNames.slice(0, 500).map((name) => {
      let dirCount = 0;
      let fileCount = 0;
      try {
        for (const c of readdirSync(path.join(r.abs, name))) {
          if (c.startsWith('.')) continue;
          const st = lstatSync(path.join(r.abs, name, c), { throwIfNoEntry: false });
          if (!st || st.isSymbolicLink()) continue;
          if (st.isDirectory()) dirCount++;
          else if (st.isFile()) fileCount++;
        }
      } catch {
        /* unreadable subdir — show it with zero counts */
      }
      return { name, dirCount, fileCount };
    });
    ok(res, {
      root,
      path: relPath,
      parent: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '',
      dirs,
      fileCount: fileNames.length,
      sampleFiles: fileNames.slice(0, 10),
      truncated,
      mappedBy: mappingCovering(root, relPath)?.id ?? null,
    });
  });

  app.get('/api/fs/mappings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    ok(res, db.listFsMappings().map(toApi));
  });

  // Create: full validation ladder, then a SYNCHRONOUS first sync so the
  // admin's success toast can carry real counts (202+poll is the upgrade
  // path if huge trees make this bite — firstSync is nullable for that).
  app.post('/api/fs/mappings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body ?? {};
    try {
      const label = typeof b.label === 'string' ? b.label.trim() : '';
      if (!label) return fail(res, 400, 'label required');
      const rootKey = String(b.rootKey ?? '');
      const relPath = b.relPath === undefined || b.relPath === null ? '' : String(b.relPath);
      const r = resolveInRoot(rootKey, relPath);
      if (!r.ok) return failResolve(res, r);

      const schema = parseSchema(b.schema);
      const tags = parseTags(b.tags);
      const taxonomyRoot = parseTaxonomyRoot(b.taxonomyRoot);
      const taxonomyLinks = parseTaxonomyLinks(b.taxonomyLinks, taxonomyRoot);
      const visibility = parseVisibility(b.visibility);

      const overlap = findOverlap(rootKey, relPath, r.abs);
      if (overlap) return fail(res, 409, `overlaps mapping ${overlap.id} (${overlap.label})`);

      // Server-minted immutable id — URL- and LIKE-safe by construction.
      const id = `m-${crypto.randomBytes(4).toString('hex')}`;
      let row: db.FsMappingRow;
      try {
        row = db.insertFsMapping({
          id,
          rootKey,
          relPath,
          label,
          description: b.description ? String(b.description) : undefined,
          nestUnderFiles: b.nestUnderFiles === undefined ? true : Boolean(b.nestUnderFiles),
          schema,
          tags,
          taxonomyRoot: taxonomyRoot ?? undefined,
          taxonomyLinks,
          visibility,
          enabled: b.enabled === undefined ? true : Boolean(b.enabled),
          createdBy: req.user.id,
        });
      } catch (e) {
        // UNIQUE(root_key, rel_path) — the overlap check should catch this
        // first; the index is the belt-and-suspenders layer.
        if (String(e).includes('UNIQUE')) return fail(res, 409, 'a mapping for this root and path already exists');
        throw e;
      }
      const firstSync = row.enabled ? syncMapping(row) : null;
      ok(res, { mapping: toApi(db.getFsMapping(id)!), firstSync });
    } catch (e) {
      if (e instanceof ApiError) return fail(res, e.status, e.message);
      throw e;
    }
  });

  // Partial update of any field except id. rootKey/relPath changes re-run
  // containment + overlap; anything affecting the cfg hash (schema/tags/
  // visibility) or the path triggers an immediate resync — the cfg mismatch
  // defeats the unchanged-skip exactly once, idempotent after.
  app.patch('/api/fs/mappings/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const m = db.getFsMapping(req.params.id);
    if (!m) return fail(res, 404, 'unknown mapping');
    const b = req.body ?? {};
    try {
      const patch: db.FsMappingPatch = {};
      if (b.label !== undefined) {
        const label = typeof b.label === 'string' ? b.label.trim() : '';
        if (!label) return fail(res, 400, 'label required');
        patch.label = label;
      }
      if (b.description !== undefined) {
        patch.description = b.description === null ? null : String(b.description);
      }
      if (b.nestUnderFiles !== undefined) patch.nestUnderFiles = Boolean(b.nestUnderFiles);
      if (b.schema !== undefined) patch.schema = parseSchema(b.schema);
      if (b.tags !== undefined) patch.tags = parseTags(b.tags);
      if (b.taxonomyRoot !== undefined) patch.taxonomyRoot = parseTaxonomyRoot(b.taxonomyRoot);
      if (b.taxonomyLinks !== undefined) {
        const effectiveRoot =
          patch.taxonomyRoot !== undefined ? patch.taxonomyRoot : m.taxonomyRoot ?? null;
        patch.taxonomyLinks = parseTaxonomyLinks(b.taxonomyLinks, effectiveRoot);
      }
      if (b.visibility !== undefined) patch.visibility = parseVisibility(b.visibility);
      if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
      if (b.rootKey !== undefined || b.relPath !== undefined) {
        patch.rootKey = b.rootKey !== undefined ? String(b.rootKey) : m.rootKey;
        patch.relPath =
          b.relPath !== undefined && b.relPath !== null ? String(b.relPath) : m.relPath;
        const r = resolveInRoot(patch.rootKey, patch.relPath);
        if (!r.ok) return failResolve(res, r);
        const overlap = findOverlap(patch.rootKey, patch.relPath, r.abs, m.id);
        if (overlap) return fail(res, 409, `overlaps mapping ${overlap.id} (${overlap.label})`);
      }

      let updated: db.FsMappingRow;
      try {
        updated = db.updateFsMapping(m.id, patch)!;
      } catch (e) {
        if (String(e).includes('UNIQUE')) return fail(res, 409, 'a mapping for this root and path already exists');
        throw e;
      }
      // A visibility change is an ACL edit and CANNOT wait for a resync — a
      // disabled mapping or an unmounted root can't run one, and previously-
      // shared mirrors would stay in every user's graph until it could. Flip
      // the rows directly; the next successful sync's cfg-hash rewrite
      // reconciles the (deliberately stale) frontmatter.cfg.
      if (patch.visibility !== undefined && updated.visibility !== m.visibility) {
        db.setObjectVisibilityByOwner(`fsmap:${m.id}`, updated.visibility);
      }
      const pathChanged = updated.rootKey !== m.rootKey || updated.relPath !== m.relPath;
      const cfgChanged = mappingCfgHash(updated) !== mappingCfgHash(m);
      const resync = updated.enabled && (cfgChanged || pathChanged) ? syncMapping(updated) : null;
      ok(res, { mapping: toApi(db.getFsMapping(m.id)!), resync });
    } catch (e) {
      if (e instanceof ApiError) return fail(res, e.status, e.message);
      throw e;
    }
  });

  // Delete always purges the mirrored objects (one transaction) — keepObjects
  // would orphan un-owned rows an admin could only hand-delete. The vectors
  // are reaped by the existing pruneEmbeddings pass on the next embed-sync.
  app.delete('/api/fs/mappings/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const m = db.getFsMapping(req.params.id);
    if (!m) return fail(res, 404, 'unknown mapping');
    let removedObjects = 0;
    db.getDb().transaction(() => {
      removedObjects = db.deleteObjectsByOwner(`fsmap:${m.id}`);
      db.deleteFsMapping(m.id);
    })();
    markCorpusDirty();
    ok(res, { removedObjects });
  });

  // One sync pass now — the row card's "Sync now" action.
  app.post('/api/fs/mappings/:id/sync', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const m = db.getFsMapping(req.params.id);
    if (!m) return fail(res, 404, 'unknown mapping');
    if (!m.enabled) return fail(res, 409, 'mapping disabled');
    if (fsSyncInFlight()) return fail(res, 409, 'sync in progress');
    ok(res, syncMapping(m));
  });
}
