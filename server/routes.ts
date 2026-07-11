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
import { generateTaxonomyOptions } from './taxonomy';
import { listContentServices } from './content-links';
import { extractRefs } from './objects';
import { markCorpusDirty } from './search';
import { runLint, lastLintReport } from './lint';
import { normalizeAndSaveCapture } from './intake';

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
    normalizeAndSaveCapture(capture, req.user.id);
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
  app.get('/api/taxonomy-metadata/:id', (req, res) => ok(res, db.getTaxonomyMetadata(req.params.id)));
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
    const o = db.getObject(req.params.id);
    if (!o) return fail(res, 404, 'unknown object');
    if (o.userId !== req.user.id && !req.user.isAdmin && o.visibility === 'private') {
      return fail(res, 404, 'unknown object');
    }
    ok(res, o);
  });
  app.post('/api/objects', (req, res) => {
    const b = req.body ?? {};
    if (!b.type || !b.title) return fail(res, 400, 'type and title required');
    const id = String(b.id ?? crypto.randomUUID());
    const existing = db.getObject(id);
    if (existing && existing.userId !== req.user.id && !req.user.isAdmin) {
      return fail(res, 403, 'not your object');
    }
    const object = {
      id,
      type: String(b.type),
      title: String(b.title),
      description: b.description ? String(b.description) : undefined,
      resource: b.resource ? String(b.resource) : undefined,
      tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
      frontmatter: b.frontmatter && typeof b.frontmatter === 'object' ? b.frontmatter : undefined,
      body: b.body ? String(b.body) : undefined,
      links: extractRefs(b.body ? String(b.body) : undefined, b.resource ? String(b.resource) : undefined),
      visibility: b.visibility === 'shared' ? 'shared' : 'private',
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

  // Todos (per-user)
  app.get('/api/todos', (req, res) => ok(res, db.getTodos(req.user.id)));
  app.post('/api/todos', (req, res) => {
    if (!req.body?.id || !req.body?.title) return fail(res, 400, 'No data provided');
    db.saveTodo(req.user.id, req.body);
    ok(res);
  });
  app.delete('/api/todos/:id', (req, res) => {
    db.deleteTodo(req.user.id, req.params.id);
    ok(res);
  });

  // Unknown /api path → 404 in the same envelope (the SPA fallback must not
  // serve index.html for API misses).
  app.use('/api', (_req, res) => fail(res, 404, 'Not Found'));
}
