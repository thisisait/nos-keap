/**
 * Admin HTTP surface for topic clusters (topic_clusters / topic_assignments) —
 * the Topics-mode control plane: list, rename (lock/unlock), re-anchor, and
 * rebuild/reset the clustering.
 *
 * Mounted in server/index.ts next to registerFsMappingRoutes (BEFORE the /api
 * 404 fallback in routes.ts) and therefore behind identityMiddleware; every
 * route here is additionally admin-gated (403), same pattern as fs-mappings.ts.
 *
 * The clustering pipeline lives in server/topics.ts (clusterTopics,
 * reanchorTopic), the row CRUD in db.ts. This module owns only the HTTP shape:
 * the rebuild endpoint mirrors /agent/v1/fs/sync's default-202 / ?wait=1
 * semantics and 503s when the vector layer is unavailable.
 */
import type { Express, Request, Response } from 'express';
import * as db from './db';
import { clusterTopics, reanchorTopic } from './topics';

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

/** One topic row for the admin card: the full TopicClusterRow minus the
 *  warm-start centroid (768 floats — pipeline-only, never shipped). */
function toApi(t: db.TopicClusterRow) {
  return {
    id: t.id,
    label: t.label,
    labelAuto: t.labelAuto,
    labelLocked: t.labelLocked,
    terms: t.terms,
    churnAccum: t.churnAccum,
    theta: t.theta,
    memberCount: t.memberCount,
    emptyRuns: t.emptyRuns,
    model: t.model,
    updatedAt: t.updatedAt,
  };
}

export function registerTopicRoutes(app: Express) {
  // Full topic list (sans centroid) + the mode summary — the Admin card reads
  // both in one call. Renders even when vectorsOk=false (frozen topics).
  app.get('/api/admin/topics', (req, res) => {
    if (!requireAdmin(req, res)) return;
    ok(res, { topics: db.listTopicClusters().map(toApi), stats: db.topicStats() });
  });

  // Rename (decision #8): {label:'…'} locks a custom label (auto never
  // overwrites); {label:null} unlocks and restores label_auto.
  app.patch('/api/admin/topics/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body ?? {};
    if (!('label' in b)) return fail(res, 400, 'label required (string or null)');
    let label: string | null;
    if (b.label === null) {
      label = null;
    } else if (typeof b.label === 'string' && b.label.trim() !== '') {
      label = b.label.trim();
    } else {
      return fail(res, 400, 'label must be a non-empty string or null');
    }
    if (!db.renameTopic(req.params.id, label)) return fail(res, 404, 'unknown topic');
    const row = db.listTopicClusters().find((t) => t.id === req.params.id);
    ok(res, row ? toApi(row) : null);
  });

  // Re-anchor (decision #9): recompute θ from the current majority root galaxy
  // — an admin action is a "measured cause" for a geometry change.
  app.post('/api/admin/topics/:id/reanchor', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!reanchorTopic(req.params.id)) return fail(res, 404, 'unknown topic');
    const row = db.listTopicClusters().find((t) => t.id === req.params.id);
    ok(res, row ? toApi(row) : null);
  });

  // Rebuild / reset (decision #1). Default: fire-and-forget through the
  // single-flight chain, 202 {scheduled:true}. ?wait=1 awaits the serialized
  // run and returns the TopicRunResult (e2e/admin hook). 503 without vectors.
  app.post('/api/admin/topics/rebuild', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!db.vectorSearchAvailable()) return fail(res, 503, 'vector layer unavailable');
    const reset = Boolean(req.body?.reset);
    if (req.query.wait === '1') {
      ok(res, await clusterTopics({ reset }));
      return;
    }
    void clusterTopics({ reset }).catch((err) => console.warn('[topics] rebuild failed:', err));
    res.status(202).json({ success: true, data: { scheduled: true } });
  });
}
