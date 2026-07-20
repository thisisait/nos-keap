/**
 * Admin HTTP surface for Track R3 typed relations — the moderation control
 * plane. Two queues: proposed RELATIONS (confirm/reject one edge) and proposed
 * relation TYPES (vocab growth: confirm a verb into the live palette with a
 * colour, or retire it). Mirrors the topics/promotions admin route + guard
 * style exactly (server/topics-routes.ts).
 *
 * Mounted in server/index.ts next to registerTopicRoutes (BEFORE the /api 404
 * fallback in routes.ts) and therefore behind identityMiddleware; every route
 * is additionally admin-gated (403). The storage helpers live in db.ts; this
 * module owns only the HTTP shape + the human labels the panel renders.
 */
import type { Express, Request, Response } from 'express';
import * as db from './db';
import { getNode } from './taxonomy';

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

/** A relation endpoint's human label for the moderation card — the node name or
 *  object title, falling back to the bare ref when it no longer resolves. */
function endpointLabel(ref: string, kind: db.RelationKind): string {
  if (kind === 'node') return getNode(ref)?.name ?? ref;
  return db.getObject(ref)?.title ?? ref;
}

// Default palette for a newly-confirmed verb that arrives without a colour —
// distinct hues so a grown vocabulary stays visually separable in the overlay.
const TYPE_COLOR_PALETTE = [
  '#22d3ee', '#34d399', '#a78bfa', '#fbbf24', '#f472b6',
  '#38bdf8', '#c084fc', '#5eead4', '#fb923c', '#e879f9',
];
function pickTypeColor(type: string): string {
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return TYPE_COLOR_PALETTE[h % TYPE_COLOR_PALETTE.length];
}

const isColor = (v: unknown): v is string =>
  typeof v === 'string' && /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s]+\))$/.test(v.trim());

export function registerRelationRoutes(app: Express) {
  // The moderation queue: relations at a status (default 'proposed') decorated
  // with from/to labels, plus the relation_types registry (both queues in one
  // call). status=all lists every row (the panel's "recently decided" tail).
  app.get('/api/admin/relations', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const raw = req.query.status ? String(req.query.status) : 'proposed';
    const status =
      raw === 'confirmed' || raw === 'rejected' || raw === 'proposed'
        ? (raw as db.RelationStatus)
        : undefined; // 'all' (or anything else) → no filter
    const relations = db.listRelations(status ? { status } : undefined).map((r) => ({
      ...r,
      fromLabel: endpointLabel(r.fromRef, r.fromKind),
      toLabel: endpointLabel(r.toRef, r.toKind),
    }));
    ok(res, { relations, types: db.listRelationTypes() });
  });

  // Decide one relation: proposed → confirmed | rejected. A confirmed edge joins
  // the /api/graph Vazby overlay + the brain endpoint; rejected never renders.
  app.post('/api/admin/relations/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = req.body?.status;
    if (status !== 'confirmed' && status !== 'rejected') {
      return fail(res, 400, "status must be 'confirmed' or 'rejected'");
    }
    if (!db.setRelationStatus(req.params.id, status)) return fail(res, 404, 'unknown relation');
    ok(res, { id: req.params.id, status });
  });

  // Confirm a PROPOSED verb into the live palette (vocab growth), assigning a
  // render colour (caller-supplied or a deterministic palette pick). The verb
  // then re-enters the classifier vocabulary offered on the agent surface.
  app.post('/api/admin/relation-types/:type', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (req.body?.status !== 'confirmed') return fail(res, 400, "status must be 'confirmed'");
    const type = req.params.type;
    const existing = db.getRelationType(type);
    if (!existing) return fail(res, 404, 'unknown relation type');
    const color = isColor(req.body?.color)
      ? String(req.body.color).trim()
      : existing.color ?? pickTypeColor(type);
    db.setRelationTypeStatus(type, 'confirmed', color);
    ok(res, { ...db.getRelationType(type) });
  });

  // Reject a proposed verb: retire it (seed/confirmed vocab is protected in db).
  app.delete('/api/admin/relation-types/:type', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!db.deleteRelationType(req.params.type)) {
      return fail(res, 404, 'unknown or non-proposed relation type');
    }
    ok(res, { type: req.params.type, deleted: true });
  });
}
