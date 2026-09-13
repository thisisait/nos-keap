/**
 * REST API — full port of the old apiServer.ts giant if/else, expressed as
 * real Express routes and user-scoped via req.user.id (see identity.ts).
 * The { success, data, error } envelope is preserved so the existing frontend
 * API clients in src/services/api/*.ts keep working unchanged.
 *
 * Scoping rules:
 *   - per-user: todos, completed-items, courses, homepage-tiles, activity,
 *     settings, captured metadata (admins see all captures — the Admin CMS
 *     "API Data" tab is a review queue).
 *   - global:   taxonomy options (static dataset), curated taxonomy-metadata
 *     (writes admin-gated), app-metadata.
 */
import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import * as db from './db';
import { generateTaxonomyOptions, getNode } from './taxonomy';
import { listContentServices } from './content-links';
import { extractRefs } from './objects';
import { markCorpusDirty } from './search';
import { runLint, lastLintReport } from './lint';
import { propose, proposeNode, proposeDescription, proposeBrief, vote, decide, decideBriefBulk, moderationPolicy } from './promotions';
import { exportBundle, importBundle } from './okf';
import { normalizeAndSaveCapture } from './intake';
import {
  approvePairing,
  deleteDraft,
  getDraftForUser,
  getPairingForApproval,
  listCredentials,
  revokeCredential,
} from './extension/store';
import {
  listTables,
  getTable,
  canWriteTable,
  updateTableVisibility,
  updateTableSharing,
  hasRowGrantFor,
  updateTableSchema,
  syncCard,
  storeFor,
  listDrivers,
  assertRowId,
} from './tables';
import {
  tierRank,
  canCreateTables,
  canReadTableAs,
  canWriteTableAs,
  canReadRowAs,
  canWriteRowAs,
  canShareRowAs,
  type ShareCaller,
} from './rbac';
import { extractRowSharing, type Principal } from '../shared/contracts/visibility';
import {
  createTableRequestSchema,
  updateTableSchemaSchema,
  validateViewMeta,
  listRowsQuerySchema,
  aggregateQuerySchema,
} from '../shared/contracts/table';
import { FIELD_CONCEPTS } from '../shared/contracts/field-concepts';

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

/**
 * CSRF guard for state-changing extension endpoints reached with the ambient
 * Authentik forward-auth cookie. The old check only ran when KEAP_PUBLIC_URL
 * was set — unset, a cross-site page could drive pairing-approval/revoke/draft
 * deletion as the victim. This fails CLOSED behind the outpost:
 *   - Sec-Fetch-Site (sent by every modern browser) must be same-origin,
 *     same-site, or none (address-bar) — 'cross-site' is refused.
 *   - if an Origin header is present and KEAP_PUBLIC_URL is known, it must match.
 * A request lacking BOTH signals is allowed only when we are NOT behind the
 * trusted proxy (local dev), never in production.
 */
function csrfOk(req: Request, res: Response): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') {
    if (site === 'same-origin' || site === 'same-site' || site === 'none') return true;
    fail(res, 403, 'cross-site request refused');
    return false;
  }
  const expectedOrigin = process.env.KEAP_PUBLIC_URL?.replace(/\/$/, '');
  const origin = req.headers.origin;
  if (expectedOrigin && typeof origin === 'string') {
    if (origin === expectedOrigin) return true;
    fail(res, 403, 'invalid request origin');
    return false;
  }
  // No Sec-Fetch-Site and no verifiable Origin: safe only outside the outpost.
  if (process.env.KEAP_TRUSTED_PROXY === '1') {
    fail(res, 403, 'request origin could not be verified');
    return false;
  }
  return true;
}

export function registerApiRoutes(app: Express) {
  // Whoami — lets the SPA show the signed-in Authentik user.
  app.get('/api/me', (req, res) =>
    ok(res, {
      id: req.user.id,
      username: req.user.username,
      name: req.user.name,
      email: req.user.email,
      groups: req.user.groups,
      isAdmin: req.user.isAdmin,
    }),
  );

  app.get('/api/extension/pairings/:code', (req, res) => {
    const pairing = getPairingForApproval(req.params.code);
    if (!pairing || pairing.expiresAt <= Math.floor(Date.now() / 1000)) {
      return fail(res, 404, 'unknown or expired pairing');
    }
    ok(res, pairing);
  });
  app.post('/api/extension/pairings/:code/approve', (req, res) => {
    if (!csrfOk(req, res)) return;
    if (!approvePairing(req.params.code, req.user)) return fail(res, 409, 'pairing is not pending or has expired');
    ok(res);
  });
  app.get('/api/extension/credentials', (req, res) => ok(res, listCredentials(req.user.id)));
  app.post('/api/extension/credentials/:id/revoke', (req, res) => {
    if (!csrfOk(req, res)) return;
    if (!revokeCredential(req.user.id, req.params.id)) return fail(res, 404, 'unknown active credential');
    ok(res);
  });
  app.get('/api/extension/drafts/:id', (req, res) => {
    const draft = getDraftForUser(req.params.id, req.user.id);
    if (!draft) return fail(res, 404, 'unknown or expired draft');
    ok(res, draft);
  });
  app.delete('/api/extension/drafts/:id', (req, res) => {
    if (!csrfOk(req, res)) return;
    if (!deleteDraft(req.params.id, req.user.id)) return fail(res, 404, 'unknown draft');
    ok(res);
  });

  // Taxonomy options (static dataset, global)
  app.get('/api/taxonomy', (_req, res) => ok(res, generateTaxonomyOptions()));

  // Tenant config for the SPA: which nOS content services exist and where.
  // Served from env (KEAP_TENANT_DOMAIN) so one image serves any tenant.
  app.get('/api/config', (_req, res) =>
    ok(res, {
      tenantDomain: process.env.KEAP_TENANT_DOMAIN ?? 'dev.local',
      services: listContentServices(),
    }),
  );

  // Captured page metadata (companion userscript → review in Admin)
  app.get('/api/metadata', (req, res) => ok(res, db.getAllMetadataApi(req.user.id, req.user.isAdmin)));
  app.post('/api/metadata', (req, res) => {
    // Accept both the canonical shape ({id,title,url,domain,metadata}) and
    // the companion userscript's shape ({name, links:{url,domain,...},
    // taxonomyId, icon}) — normalize the latter instead of breaking capture.
    const b = req.body ?? {};
    const title = b.title ?? b.name;
    if (!title) return fail(res, 400, 'title required');
    const capture = {
      id: String(b.id ?? crypto.randomUUID()),
      // Unified intake envelope — same normalizer the /ingest/v1 device
      // surface and the agent surface use (source/modality attribution).
      source: { kind: 'userscript' as const, name: req.user.username || 'web' },
      title: String(title),
      text: b.description ? String(b.description) : undefined,
      url: b.url ?? b.links?.url,
      domain: b.domain ?? b.links?.domain,
      metadata:
        b.metadata ??
        (b.links || b.taxonomyId || b.icon
          ? { taxonomyId: b.taxonomyId, icon: b.icon, links: b.links, translations: b.translations }
          : undefined),
    };
    try {
      normalizeAndSaveCapture(capture, req.user.id);
    } catch (e) {
      return fail(res, 403, e instanceof Error ? e.message : 'capture rejected');
    }
    markCorpusDirty();
    ok(res, capture);
  });
  app.get('/api/metadata/search', (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase();
    const all = db.getAllMetadataApi(req.user.id, req.user.isAdmin);
    ok(
      res,
      all.filter(
        (item) =>
          item.title?.toLowerCase().includes(q) || item.description?.toLowerCase().includes(q),
      ),
    );
  });
  app.get('/api/metadata/domain/:domain', (req, res) =>
    ok(res, db.getMetadataByDomainApi(req.user.id, req.user.isAdmin, req.params.domain)),
  );

  // Stats over the user's visible captures
  app.get('/api/stats', (req, res) => {
    const all = db.getAllMetadataApi(req.user.id, req.user.isAdmin);
    const domains = [
      ...new Set(
        all
          .map((item) => {
            if (item.domain) return item.domain;
            try {
              return item.url ? new URL(item.url).hostname : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      ),
    ];
    ok(res, { totalMetadata: all.length, domains, lastUpdate: new Date().toISOString() });
  });

  // Courses (per-user)
  app.get('/api/courses', (req, res) => ok(res, db.getAllCourses(req.user.id)));
  app.post('/api/courses/:id/progress', (req, res) => {
    const courseId = Number(req.params.id);
    if (!Number.isInteger(courseId) || !req.body) return fail(res, 400, 'Invalid course data');
    db.updateCourseProgress(req.user.id, courseId, req.body.progress ?? 0, req.body.completedChapters ?? 0);
    ok(res);
  });

  // Completed items (per-user; POST toggles, matching the old behavior)
  app.get('/api/completed-items', (req, res) => ok(res, db.getCompletedItems(req.user.id)));
  app.post('/api/completed-items/:id', (req, res) => {
    db.toggleCompletedItem(req.user.id, req.params.id);
    ok(res);
  });

  // Curated taxonomy metadata (global knowledge layer; writes admin-gated)
  app.get('/api/taxonomy-metadata', (_req, res) => ok(res, db.getTaxonomyMetadata()));
  // Per-node fetch also carries the node's K1 description (en+cs) — the bulk
  // /api/graph payload no longer ships prose (explore-decomplexity Phase A).
  app.get('/api/taxonomy-metadata/:id', (req, res) => {
    const row = db.getTaxonomyMetadata(req.params.id);
    const base = row && !Array.isArray(row) ? row : null;
    const n = getNode(req.params.id);
    if (!base && !n) return ok(res, null);
    ok(res, {
      id: req.params.id,
      data: base?.data ?? null,
      updatedAt: base?.updatedAt ?? 0,
      description: n?.description,
      descriptionCs: n?.descriptionCs,
    });
  });
  app.post('/api/taxonomy-metadata', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!req.body?.id) return fail(res, 400, 'No data provided');
    db.saveTaxonomyMetadata(req.body, req.user.id);
    markCorpusDirty();
    ok(res);
  });
  app.delete('/api/taxonomy-metadata/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    db.deleteTaxonomyMetadata(req.params.id);
    markCorpusDirty();
    ok(res);
  });

  // Homepage tiles (per-user UI config)
  app.get('/api/homepage-tiles', (req, res) => ok(res, db.getHomepageTiles(req.user.id)));
  app.post('/api/homepage-tiles', (req, res) => {
    if (!Array.isArray(req.body)) return fail(res, 400, 'No data provided');
    db.saveHomepageTiles(req.user.id, req.body);
    ok(res);
  });

  // Activity (per-user)
  app.get('/api/activity', (req, res) => {
    const type = req.query.type ? String(req.query.type) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    ok(res, db.getRecentActivity(req.user.id, type, limit));
  });
  app.post('/api/activity', (req, res) => {
    if (!req.body?.itemId || !req.body?.itemType) return fail(res, 400, 'Invalid activity data');
    db.trackActivity(req.user.id, req.body.itemId, req.body.itemType);
    ok(res);
  });

  // App metadata (global)
  app.get('/api/app-metadata', (_req, res) => ok(res, db.getAppMetadata()));

  // OKF bundle export/import (S3). Export = the caller's visible objects as
  // an Open Knowledge Format zip (openknowledge-CLI readable). Import goes
  // through the intake review queue + auto-proposals — never straight into
  // the curated corpus; dedupe on keap.id + content hash.
  app.get('/api/objects/export.okf', (req, res) => {
    const zip = exportBundle(req.user.id, req.user.isAdmin);
    res
      .status(200)
      .setHeader('content-type', 'application/zip')
      .setHeader('content-disposition', 'attachment; filename="keap-knowledge.okf.zip"')
      .end(Buffer.from(zip));
  });
  app.post('/api/objects/import.okf', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return fail(res, 400, 'send the .okf.zip as the raw request body (content-type: application/zip)');
    }
    try {
      ok(res, importBundle(new Uint8Array(req.body), req.user.username));
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });

  // Promotion moderation — the operator's FINAL WORD on what enters the
  // curated corpus. Votes are the MMO seed (advisory under policy=local).
  app.get('/api/promotions', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = req.query.status ? String(req.query.status) : undefined;
    // Moderation must see the WHOLE queue — a bulk sweep past the default
    // 200-row cap would silently hide the tail from the operator.
    ok(res, { policy: moderationPolicy(), items: db.listPromotions(status, 5000) });
  });
  app.post('/api/promotions', (req, res) => {
    // Humans may propose too (non-admin users included — moderation gates).
    const { captureId, object, rationale } = req.body ?? {};
    if (typeof captureId !== 'string' || !object) return fail(res, 400, 'captureId + object draft required');
    try {
      ok(res, propose(captureId, object, rationale, req.user.id));
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });
  app.post('/api/taxonomy/propose', (req, res) => {
    const { parentId, name, description, rationale } = req.body ?? {};
    try {
      ok(res, proposeNode({ parentId, name, description }, rationale, req.user.id));
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });
  // K1 human surface: any signed-in user may propose a curated description
  // from the explorer's DetailPanel — moderated like every desc proposal.
  app.post('/api/taxonomy/describe', (req, res) => {
    const { nodeId, descriptionEn, descriptionCs, rationale } = req.body ?? {};
    try {
      ok(res, proposeDescription({ nodeId, descriptionEn, descriptionCs }, rationale, req.user.id));
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });
  // Human brief proposal — same moderated path as agents (DetailPanel later).
  app.post('/api/taxonomy/brief', (req, res) => {
    const { nodeId, briefEn, briefCs, rationale } = req.body ?? {};
    try {
      ok(res, proposeBrief({ nodeId, briefEn, briefCs }, rationale, req.user.id));
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });
  // Batch relief: decide EVERY open kind='desc' (default) or kind='brief'
  // proposal in one click. The describe/brief skills land dozens-hundreds at
  // once — the honest review granularity is the rendered batch, not
  // one-by-one rubber-stamping. Object/node proposals change corpus/
  // structure and stay individual.
  app.post('/api/promotions/decide-desc-bulk', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') return fail(res, 400, 'decision approve|reject required');
    const kind = req.body?.kind === 'brief' ? 'brief' : 'desc';
    const open = db.listPromotions('proposed', 1000).filter((p) => p.kind === kind);
    let decided = 0;
    const errors: Array<{ id: string; error: string }> = [];
    for (const p of open) {
      try {
        decide(p.id, decision, req.user.username);
        decided++;
      } catch (err) {
        errors.push({ id: p.id, error: (err as Error).message });
      }
    }
    ok(res, { decision, kind, decided, errors });
  });
  // Selected-set twin of decide-desc-bulk for the weekly drain loop: decides
  // EXPLICIT ids (the operator-approved verdict batch), not everything open.
  // Brief-kind only; per-id errors so a re-run is idempotent-safe.
  app.post('/api/promotions/decide-brief-bulk', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') return fail(res, 400, 'decision approve|reject required');
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some((i) => typeof i !== 'string')) {
      return fail(res, 400, 'ids required (1-1000 promotion id strings)');
    }
    ok(res, { decision, ...decideBriefBulk(ids, decision, req.user.username) });
  });
  app.post('/api/promotions/:id/vote', (req, res) => {
    const value = req.body?.value === -1 ? -1 : 1;
    try {
      ok(res, vote(req.params.id, req.user.id, value));
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });
  app.post('/api/promotions/:id/decide', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') return fail(res, 400, 'decision approve|reject required');
    try {
      ok(res, decide(req.params.id, decision, req.user.username));
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });

  // Knowledge lint (admin) — standing findings for the future Admin tab;
  // POST re-runs the checks on demand (same engine the nightly job uses).
  app.get('/api/lint', (req, res) => {
    if (!requireAdmin(req, res)) return;
    ok(res, lastLintReport());
  });
  app.post('/api/lint/run', (req, res) => {
    if (!requireAdmin(req, res)) return;
    ok(res, runLint());
  });
  app.post('/api/lint/verdict', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { findingId, verdict, note } = req.body ?? {};
    if (typeof findingId !== 'string' || !['fine', 'duplicate', 'contradiction'].includes(verdict)) {
      return fail(res, 400, 'findingId + verdict (fine|duplicate|contradiction) required');
    }
    const row = db.applyLintVerdict(findingId, verdict, note ? String(note).slice(0, 500) : undefined, req.user.username);
    if (!row) return fail(res, 404, 'unknown finding');
    ok(res, row);
  });

  // Settings (per-user)
  app.post('/api/settings', (req, res) => {
    if (!req.body?.key || req.body.value === undefined) return fail(res, 400, 'Invalid settings data');
    db.saveSetting(req.user.id, req.body.key, String(req.body.value));
    ok(res);
  });
  app.get('/api/settings/:key', (req, res) => ok(res, db.getSetting(req.user.id, req.params.key)));

  // Knowledge objects (per-user OKF index cards; admins see all — ROADMAP S1)
  app.get('/api/objects', (req, res) => {
    const type = req.query.type ? String(req.query.type) : undefined;
    ok(res, db.getObjects(req.user.id, req.user.isAdmin, type));
  });
  app.get('/api/objects/types', (_req, res) => ok(res, db.objectTypes()));
  app.get('/api/objects/:id', (req, res) => {
    // Row-level read gate via the ONE source of truth (server/rbac.ts tier
    // ladder), identical to /api/graph's getVisibleObjects and search's
    // canReadObject. A flat `visibility !== 'private'` check here would treat
    // every tier-scoped card (tier-managers/users/guests) as world-readable and
    // leak it below its entitled tier. Not-found and not-readable both 404 —
    // never leak an object's existence to a caller who cannot read it.
    if (!db.canReadObject(req.params.id, req.user.id, req.user.isAdmin, req.user.groups)) {
      return fail(res, 404, 'unknown object');
    }
    ok(res, db.getObject(req.params.id));
  });
  app.post('/api/objects', (req, res) => {
    const b = req.body ?? {};
    if (!b.type || !b.title) return fail(res, 400, 'type and title required');
    const id = String(b.id ?? crypto.randomUUID());
    const existing = db.getObject(id);
    if (existing && existing.userId !== req.user.id && !req.user.isAdmin) {
      return fail(res, 403, 'not your object');
    }
    // UPDATE = merge, CREATE = the request (same law as the agent twin in
    // agent.ts). saveObject replaces every column, so an absent field here was
    // a deletion: Admin → Objects saving a typo fix used to flip a shared card
    // private and null its frontmatter, because the editor's Draft never
    // carried either. Absent field → keep; empty string → clear.
    const body = b.body !== undefined ? (b.body ? String(b.body) : undefined) : existing?.body;
    const resource =
      b.resource !== undefined ? (b.resource ? String(b.resource) : undefined) : existing?.resource;
    const object = {
      id,
      type: String(b.type),
      title: String(b.title),
      description:
        b.description !== undefined
          ? b.description
            ? String(b.description)
            : undefined
          : existing?.description,
      resource,
      tags: Array.isArray(b.tags) ? b.tags.map(String) : existing?.tags,
      frontmatter:
        b.frontmatter && typeof b.frontmatter === 'object' ? b.frontmatter : existing?.frontmatter,
      body,
      links:
        b.body !== undefined || b.resource !== undefined
          ? extractRefs(body, resource)
          : (existing?.links ?? extractRefs(body, resource)),
      visibility:
        b.visibility === 'shared'
          ? ('shared' as const)
          : b.visibility === 'private'
            ? ('private' as const)
            : (existing?.visibility ?? 'private'),
    };
    // Edits keep the original owner (admin fixing a card must not steal it).
    db.saveObject(existing?.userId ?? req.user.id, object);
    markCorpusDirty();
    ok(res, db.getObject(id));
  });
  app.delete('/api/objects/:id', (req, res) => {
    const o = db.getObject(req.params.id);
    if (!o) return fail(res, 404, 'unknown object');
    if (o.userId !== req.user.id && !req.user.isAdmin) return fail(res, 403, 'not your object');
    db.deleteObject(req.params.id);
    markCorpusDirty();
    ok(res);
  });

  // Data tables (Track R2′ + dtt-share-model) — TableStore behind
  // shared/contracts/table.ts. Reads: owner, admin, tier grade, explicit
  // grant, or a row grant (which implies table EXISTENCE and only the granted
  // rows). Row writes: owner, admin, or a WRITE grant (table ∪ row). Table
  // DECLARATION changes (schema/visibility/sharing/drop) stay owner/admin —
  // a write grantee edits rows, never the shares.
  const callerOf = (req: Request): ShareCaller => ({
    principal: `user:${req.user.id}` as Principal,
    id: req.user.id,
    isAdmin: req.user.isAdmin,
    groups: req.user.groups,
  });
  // Absence-safe read guard: unreadable = 404, never a 403 that leaks existence.
  const tableForRead = (req: Request, res: Response) => {
    const t = getTable(req.params.id);
    if (!t || !(canReadTableAs(t, callerOf(req)) || hasRowGrantFor(t.id, callerOf(req).principal))) {
      fail(res, 404, 'unknown table');
      return null;
    }
    return t;
  };
  // Declaration changes (PATCH/drop): read leg is grant-aware (a grantee gets
  // an honest 403, not a leaking 404-vs-403 oracle), write leg stays
  // owner/admin — a write grantee edits rows, never the declaration.
  const tableForWrite = (req: Request, res: Response) => {
    const t = tableForRead(req, res);
    if (!t) return null;
    if (!canWriteTable(t, req.user)) {
      fail(res, 403, 'not your table');
      return null;
    }
    return t;
  };
  /** Fetch one row's stored sharing (driver-agnostic scan, <= 500 rows —
   *  the same law the agent get-row route uses). */
  const rowByld = async (t: NonNullable<ReturnType<typeof tableForRead>>, rowId: string) => {
    const { rows } = await storeFor(t.driver).listRows(t.id, { filter: [], limit: 500, expand: [] });
    return rows.find((r) => r.id === rowId);
  };

  app.get('/api/tables', (req, res) => ok(res, listTables(req.user)));

  // Storage picker: which drivers this deployment offers (register BEFORE :id).
  app.get('/api/tables/drivers', (_req, res) => ok(res, listDrivers()));

  // The L1 vocabulary — what a column may declare it MEANS. Read-only and
  // git-owned; a picker or an agent enumerates it here instead of guessing.
  // Same BEFORE-:id rule as /drivers, or the literal is read as a table id.
  app.get('/api/tables/field-concepts', (_req, res) => ok(res, FIELD_CONCEPTS));

  app.post('/api/tables', async (req, res) => {
    // Guests (tier 4) are read-only — they may not create/own data tables.
    if (!canCreateTables(tierRank(req.user.groups))) {
      return fail(res, 403, 'your access tier is read-only for data tables');
    }
    const parsed = createTableRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'invalid table');
    try {
      const t = await storeFor(parsed.data.driver).createTable(req.user.id, parsed.data);
      ok(res, t);
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'create failed');
    }
  });

  app.get('/api/tables/:id', (req, res) => {
    const t = tableForRead(req, res);
    if (!t) return;
    // The view block lives in the card frontmatter, not in data_tables — so it
    // has to be lifted here, exactly as /agent/v1/tables/:slug does.
    //
    // WITHOUT THIS, `view` WAS WRITE-ONLY THROUGH THIS DOOR: the PATCH below
    // accepts and validates a view block, and this GET — the only way a caller
    // reads the table back — omitted it. So the only available confirmation
    // that a style had been applied was the PATCH's own 200, which is a success
    // marker written by the code that attempted the work: the shape this estate
    // keeps paying for. A reader must be able to see what a writer claims.
    // Absent → key omitted, and every existing consumer is byte-identical.
    const view = db.getObject(`table-${t.id}`)?.frontmatter?.view;
    ok(res, view ? { ...t, view } : t);
  });

  // Change a table's DECLARATION (owner/admin): its share scope, its column
  // schema, or both. Schema reconcile is additive-and-relabel only — see
  // updateTableSchema for why dropping a column or changing a kind is refused.
  app.patch('/api/tables/:id', (req, res) => {
    const t = tableForWrite(req, res);
    if (!t) return;
    const parsed = updateTableSchemaSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'invalid table update');
    const { visibility, schema, view, sharedWith } = parsed.data;
    if (!visibility && !schema && !view && !sharedWith)
      return fail(res, 400, 'nothing to update: send visibility, sharedWith, schema, view, or any combination');
    try {
      // Visibility FIRST: the schema reconcile re-syncs the card and the
      // projected row objects, and those inherit the table's visibility. Doing
      // it the other way round would leave the corpus on the old scope.
      let next: typeof t = t;
      if (visibility) {
        updateTableVisibility(t.id, visibility);
        next = { ...next, visibility };
      }
      if (sharedWith) {
        updateTableSharing(t.id, sharedWith);
        next = { ...next, sharedWith };
      }
      if (schema) next = { ...next, ...updateTableSchema(next, schema) };
      if (view) {
        // Validated against the LIVE columns, not the request's — a caller may
        // change the style without resending the schema, and a view block whose
        // titleColumn no longer exists renders an untitled list forever.
        const errs = validateViewMeta(view, next.schema.columns);
        if (errs.length) return fail(res, 400, errs[0]);
        syncCard(next, [], undefined, view);
      }
      ok(res, { ...next, view });
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'update failed');
    }
  });

  app.delete('/api/tables/:id', async (req, res) => {
    const t = tableForWrite(req, res);
    if (!t) return;
    try {
      await storeFor(t.driver).dropTable(t.id);
      ok(res);
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'drop failed');
    }
  });

  app.get('/api/tables/:id/rows', async (req, res) => {
    const t = tableForRead(req, res);
    if (!t) return;
    let parsedFilter: unknown = [];
    try {
      parsedFilter = req.query.filter ? JSON.parse(String(req.query.filter)) : [];
    } catch {
      return fail(res, 400, 'filter must be JSON');
    }
    const parsed = listRowsQuerySchema.safeParse({
      filter: parsedFilter,
      sort: req.query.sort_column
        ? { column: String(req.query.sort_column), dir: req.query.sort_dir === 'desc' ? 'desc' : 'asc' }
        : undefined,
      cursor: req.query.cursor ? String(req.query.cursor) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'invalid query');
    try {
      // Per-row visibility: absence-safe — a row the caller cannot read is
      // simply not in the page (a row-only grantee sees exactly their rows).
      const c = callerOf(req);
      const page = await storeFor(t.driver).listRows(t.id, parsed.data);
      ok(res, { ...page, rows: page.rows.filter((r) => canReadRowAs(t, r.sharing, c)) });
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'query failed');
    }
  });

  app.post('/api/tables/:id/rows', async (req, res) => {
    const t = getTable(req.params.id);
    const c = req.user && callerOf(req);
    if (!t || !c || !(canReadTableAs(t, c) || hasRowGrantFor(t.id, c.principal))) {
      return fail(res, 404, 'unknown table');
    }
    const rawValues = req.body?.values;
    if (!rawValues || typeof rawValues !== 'object') return fail(res, 400, 'values object required');
    // Reserved __ meta keys peel off here (the __id law applied to sharing).
    const { values, patch, error } = extractRowSharing(rawValues as Record<string, unknown>);
    if (error) return fail(res, 400, error);
    try {
      const rid = req.body.id ? assertRowId(String(req.body.id)) : undefined;
      const existing = rid ? await rowByld(t, rid) : undefined;
      if (existing) {
        if (!canWriteRowAs(t, existing.sharing, c)) return fail(res, 403, 'no write access to this row');
        if (patch && !canShareRowAs(t, existing.sharing, c)) {
          return fail(res, 403, 'only the row or table owner may change row sharing');
        }
      } else if (!canWriteTableAs(t, c)) {
        // Creating rows needs table-level write; a per-row grant grants that row.
        return fail(res, 403, 'no write access to this table');
      }
      ok(
        res,
        await storeFor(t.driver).upsertRow(t.id, rid, values, req.user.id, {
          stamp: c.principal,
          patch,
        }),
      );
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'write failed');
    }
  });

  app.delete('/api/tables/:id/rows/:rowId', async (req, res) => {
    const t = tableForRead(req, res);
    if (!t) return;
    try {
      const c = callerOf(req);
      const existing = await rowByld(t, assertRowId(req.params.rowId));
      if (!existing || !canReadRowAs(t, existing.sharing, c)) return fail(res, 404, 'unknown row');
      if (!canWriteRowAs(t, existing.sharing, c)) return fail(res, 403, 'no write access to this row');
      await storeFor(t.driver).deleteRow(t.id, existing.id, req.user.id);
      ok(res);
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'delete failed');
    }
  });

  app.get('/api/tables/:id/rows/:rowId/history', async (req, res) => {
    const t = tableForRead(req, res);
    if (!t) return;
    if (!t.capabilities.rowHistory) return fail(res, 400, 'driver has no row history');
    // try/catch like every sibling: an async rejection here (assertRowId on a
    // dotted id, a driver error) is otherwise an unhandledRejection and the
    // request hangs — Express 4 never sees it.
    try {
      const rid = assertRowId(req.params.rowId);
      const row = await rowByld(t, rid);
      if (row && !canReadRowAs(t, row.sharing, callerOf(req))) return fail(res, 404, 'unknown row');
      ok(res, await storeFor(t.driver).rowHistory(t.id, rid, Math.min(Number(req.query.limit) || 50, 200)));
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'history failed');
    }
  });

  // The OLAP slice: GROUP BY dimensions × aggregated measures.
  app.post('/api/tables/:id/aggregate', async (req, res) => {
    const t = tableForRead(req, res);
    if (!t) return;
    if (!t.capabilities.aggregate) return fail(res, 400, 'driver cannot aggregate');
    const parsed = aggregateQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'invalid aggregate query');
    try {
      ok(res, await storeFor(t.driver).aggregate(t.id, parsed.data));
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'aggregate failed');
    }
  });

  // Todos live as each user's own PRIVATE DataTable (migration 010) — this
  // is the one piece of todo-specific machinery left: a deterministic,
  // idempotent ensure. Everything else (rows CRUD, isolation, listing) is
  // the plain tables surface. Per-user table because the write law only
  // lets owner/admin/write-grant INSERT rows — a communal table would need
  // a grant per user.
  app.get('/api/todos-table', async (req, res) => {
    const id = `todos-${req.user.id}`;
    const existing = getTable(id);
    if (existing) return ok(res, existing);
    const parsed = createTableRequestSchema.parse({
      title: 'Todos',
      schema: {
        columns: [
          { key: 'title', label: 'Title', kind: 'text', role: 'dimension', required: true },
          { key: 'completed', label: 'Done', kind: 'boolean', role: 'attribute' },
        ],
      },
      visibility: 'private',
    });
    try {
      ok(res, await storeFor('libsql').createTable(req.user.id, { ...parsed, id }));
    } catch {
      // lost a create race — the winner's table is the answer
      const t = getTable(id);
      if (t) return ok(res, t);
      fail(res, 500, 'todos table create failed');
    }
  });

  // Unknown /api path → 404 in the same envelope (the SPA fallback must not
  // serve index.html for API misses).
  app.use('/api', (_req, res) => fail(res, 404, 'Not Found'));
}
