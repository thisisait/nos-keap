/**
 * KEAP standalone backend — the piece the old repo was missing.
 *
 * In the IIAB-era repo the "server" was Vite dev-middleware (vite.config.ts
 * `configureServer`). That meant `vite build` produced a static bundle with
 * NO API and NO persistence. On nOS, KEAP runs as a long-lived container, so
 * the backend has to be a real process. This Express app:
 *   1. serves the built SPA (dist/) as static files,
 *   2. exposes the /api surface (ported 1:1 from the old apiServer.ts),
 *   3. derives the current user from Authentik forward-auth / header-OIDC
 *      headers so progress, leaderboards and todos become per-user,
 *   4. exposes /api/health for the nOS stack-health probe.
 */
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApiRoutes } from './routes.js';
import { identityMiddleware } from './identity.js';
import { initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const STATIC_DIR = process.env.KEAP_STATIC_DIR ?? path.resolve(__dirname, '../dist');

async function main() {
  await initDb();

  const app = express();
  // Relaxed CSP because the SPA is self-hosted behind Traefik+Authentik.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '2mb' }));

  // Resolve X-Authentik-Username / X-Authentik-Email into req.user.
  app.use(identityMiddleware);

  // Liveness/readiness — the nOS health probe hits this.
  app.get('/api/health', (_req, res) =>
    res.json({ success: true, data: { status: 'OK', ts: new Date().toISOString() } }),
  );

  registerApiRoutes(app);

  // SPA static + history-fallback (replaces the Apache RewriteRule from the
  // old README's IIAB deployment).
  app.use(express.static(STATIC_DIR));
  app.get('*', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[keap] listening on :${PORT} — static from ${STATIC_DIR}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[keap] fatal', err);
  process.exit(1);
});
