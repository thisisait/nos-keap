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
import { registerApiRoutes } from './routes';
import { registerAgentRoutes } from './agent';
import { registerGraphRoutes } from './graph';
import { registerIngestRoutes } from './intake';
import { identityMiddleware } from './identity';
import { initDb, rebuildTaxonomyFts } from './db';
import { allNodes } from './taxonomy';
import { ensureLayout } from './layout';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const STATIC_DIR = process.env.KEAP_STATIC_DIR ?? path.resolve(__dirname, '../dist');

async function main() {
  await initDb();
  rebuildTaxonomyFts(allNodes());
  ensureLayout(); // U1: bake star positions iff the root index changed

  const app = express();
  // Relaxed CSP because the SPA is self-hosted behind Traefik+Authentik.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '2mb' }));

  // Liveness/readiness — the nOS health probe hits this from the host
  // loopback (no Authentik headers), so it MUST be registered before the
  // identity middleware, which 401s header-less requests in production.
  app.get('/api/health', (_req, res) =>
    res.json({ success: true, data: { status: 'OK', ts: new Date().toISOString() } }),
  );

  // Agent surface (/agent/v1) — bearer-token auth, NOT Authentik headers:
  // host processes (AgentKit, mcpo) hit the loopback port directly, so this
  // must be mounted before the identity middleware. See server/agent.ts.
  registerAgentRoutes(app);

  // Ingest surface (/ingest/v1) — the DEVICE entry point (AR glasses, mobile
  // companions). Own bearer tier (capture-only token), never reads identity
  // headers, mounted before the identity middleware so the public bearer-only
  // Traefik route works without SSO. See server/intake.ts.
  registerIngestRoutes(app);

  // Resolve X-Authentik-Uid / -Username / -Email into req.user
  // (401 without headers when KEAP_TRUSTED_PROXY=1 — see identity.ts).
  app.use(identityMiddleware);

  // Graph/explorer surface first — registerApiRoutes ends with the /api/*
  // 404 fallback, so anything mounted after it is unreachable.
  registerGraphRoutes(app); // /api/graph* + /api/search/semantic
  registerApiRoutes(app);

  // SPA static + history-fallback (replaces the Apache RewriteRule from the
  // old README's IIAB deployment). Plain middleware instead of app.get('*'):
  // the '*' path pattern breaks on Express 5 (path-to-regexp v8).
  app.use(express.static(STATIC_DIR));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });

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
