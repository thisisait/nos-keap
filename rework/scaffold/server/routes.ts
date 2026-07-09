/**
 * REST API — ported from the old apiServer.ts giant if/else, but:
 *   - expressed as real Express routes (not manual URL string matching),
 *   - user-scoped via req.user.id (from identity.ts),
 *   - taxonomy served from the static taxonomy dataset (unchanged).
 *
 * This file is a representative STUB showing the shape and the two illustrative
 * user-scoped endpoints. Port the remaining endpoints (metadata, courses,
 * homepage-tiles, activity, settings, app-metadata, stats) mechanically from
 * the old apiServer.ts — the response envelope { success, data, error } is
 * preserved so the existing frontend API clients in src/services/api/*.ts keep
 * working unchanged.
 */
import type { Express, Request, Response } from 'express';
import { getTodos, saveTodo, getCompletedItems, toggleCompletedItem } from './db.js';

const ok = (res: Response, data?: unknown) => res.json({ success: true, data });
const fail = (res: Response, status: number, error: string) => res.status(status).json({ success: false, error });

export function registerApiRoutes(app: Express) {
  // Whoami — lets the SPA show the signed-in Authentik user in the header.
  app.get('/api/me', (req: Request, res: Response) =>
    ok(res, { username: req.user.username, name: req.user.name, email: req.user.email, isAdmin: req.user.isAdmin }),
  );

  // Todos (user-scoped)
  app.get('/api/todos', (req, res) => ok(res, getTodos(req.user.id)));
  app.post('/api/todos', (req, res) => {
    if (!req.body?.id || !req.body?.title) return fail(res, 400, 'id and title required');
    saveTodo(req.user.id, req.body);
    ok(res);
  });

  // Completed items (user-scoped)
  app.get('/api/completed-items', (req, res) => ok(res, getCompletedItems(req.user.id)));
  app.post('/api/completed-items/:id', (req, res) => {
    toggleCompletedItem(req.user.id, req.params.id);
    ok(res);
  });

  // TODO: port these from old apiServer.ts, all user-scoped by req.user.id:
  //   GET  /api/taxonomy               (static, from game/data/taxonomy)
  //   GET/POST /api/metadata           (+ /domain/:d, /search)
  //   GET  /api/stats
  //   GET/POST /api/courses            (+ /:id/progress)
  //   GET/POST /api/taxonomy-metadata  (+ DELETE /:id)
  //   GET/POST /api/homepage-tiles
  //   GET/POST /api/activity
  //   GET/POST /api/settings           (+ GET /:key)
  //   GET  /api/app-metadata
}
