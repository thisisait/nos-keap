/**
 * Agent-facing API surface — /agent/v1/* (COMPLETION_PROPOSAL.md §3).
 *
 * Consumed by nOS AgentKit agents (via the `mcp-keap` tool) and by the mcpo
 * gateway for Open WebUI. These callers are HOST processes hitting the
 * loopback-published port directly — they bypass Traefik, so Authentik
 * headers are absent here BY DESIGN and identity comes from a bearer
 * service token instead (minted by the nOS role):
 *
 *   KEAP_AGENT_TOKEN_RO — read scope  (taxonomy, search, resolve, health)
 *   KEAP_AGENT_TOKEN_RW — read+write  (additionally POST /captures)
 *
 * If neither env var is set the whole surface answers 503 — the agent API
 * is opt-in and never open by accident.
 *
 * Response-size budget: AgentKit caps tool responses at 16 KiB, so every
 * endpoint paginates (limit ≤ 50) and truncates descriptions — never dump
 * the whole tree.
 */
import crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import * as db from './db';
import { getNode, getAncestors, taxonomyNodeCount, type FlatNode } from './taxonomy';
import { resolveContentRef, listContentServices } from './content-links';

const ok = (res: Response, data?: unknown) => res.json({ success: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ success: false, error });

const TOKEN_RO = process.env.KEAP_AGENT_TOKEN_RO ?? null;
const TOKEN_RW = process.env.KEAP_AGENT_TOKEN_RW ?? null;

type AgentScope = 'ro' | 'rw';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agentScope?: AgentScope;
      agentName?: string;
    }
  }
}

function tokenEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function agentAuth(required: AgentScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!TOKEN_RO && !TOKEN_RW) return fail(res, 503, 'agent surface disabled: no agent token configured');
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return fail(res, 401, 'missing bearer token');

    let scope: AgentScope | null = null;
    if (TOKEN_RW && tokenEquals(token, TOKEN_RW)) scope = 'rw';
    else if (TOKEN_RO && tokenEquals(token, TOKEN_RO)) scope = 'ro';
    if (!scope) return fail(res, 401, 'invalid token');
    if (required === 'rw' && scope !== 'rw') return fail(res, 403, 'write scope required');

    req.agentScope = scope;
    req.agentName = String(req.headers['x-keap-agent'] ?? 'unknown').slice(0, 64);
    next();
  };
}

const MAX_LIMIT = 50;
const DESCRIPTION_CAP = 240;

function trim(s: string | undefined): string | undefined {
  if (!s) return s;
  return s.length > DESCRIPTION_CAP ? `${s.slice(0, DESCRIPTION_CAP - 1)}…` : s;
}

function nodeSummary(n: FlatNode) {
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    path: n.path || undefined,
    description: trim(n.description),
    requiredData: n.requiredData,
  };
}

function searchNodes(q: string, domain: string | undefined, limit: number) {
  const hits = db.searchTaxonomyFts(q, limit * 3); // over-fetch, then domain-filter
  const results: ReturnType<typeof nodeSummary>[] = [];
  for (const hit of hits) {
    if (domain && !hit.id.startsWith(domain)) continue;
    const node = getNode(hit.id);
    if (node) results.push(nodeSummary(node));
    if (results.length >= limit) break;
  }
  return results;
}

export function registerAgentRoutes(app: Express) {
  // Unauthenticated: liveness alias with corpus stats (container liveness for
  // the nOS probe is /api/health; this one is for agents/dashboards).
  app.get('/agent/v1/health', (_req, res) => {
    const stats = db.corpusStats();
    ok(res, {
      status: 'OK',
      surface: TOKEN_RO || TOKEN_RW ? 'enabled' : 'disabled',
      corpus: { taxonomyNodes: taxonomyNodeCount(), ...stats },
    });
  });

  // Unauthenticated: self-description (mcpo/Open WebUI consume this).
  app.get('/agent/v1/openapi.json', (_req, res) => res.json(OPENAPI_SPEC));

  // Search the taxonomy (FTS5 over name/description/path).
  app.get('/agent/v1/taxonomy/search', agentAuth('ro'), (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return fail(res, 400, 'q required');
    const domain = req.query.domain ? String(req.query.domain) : undefined;
    const limit = Math.min(Number(req.query.limit) || 20, MAX_LIMIT);
    ok(res, { query: q, results: searchNodes(q, domain, limit) });
  });

  // Node detail: ancestors, children, curated notes, resolved content link.
  app.get('/agent/v1/taxonomy/node/:id', agentAuth('ro'), (req, res) => {
    const node = getNode(req.params.id);
    if (!node) return fail(res, 404, 'unknown taxonomy node');
    const children = node.childIds
      .map((id) => getNode(id))
      .filter((n): n is FlatNode => Boolean(n))
      .slice(0, MAX_LIMIT)
      .map((n) => ({ id: n.id, name: n.name, kind: n.kind }));
    const curatedRow = db.getTaxonomyMetadata(node.id);
    const curated = curatedRow && !Array.isArray(curatedRow) ? curatedRow.data : null;
    // Admin-curated content ref overrides the static dataset's requiredData.
    const contentRef = curated?.requiredData ?? node.requiredData;
    ok(res, {
      ...nodeSummary(node),
      description: node.description, // full description on the detail view
      ancestors: getAncestors(node.id),
      children,
      childCount: node.childIds.length,
      curated,
      contentLink: resolveContentRef(contentRef),
    });
  });

  // Resolve a content ref ("kiwix:wikipedia_en") to a live nOS service URL.
  app.get('/agent/v1/content/resolve', agentAuth('ro'), (req, res) => {
    const ref = String(req.query.ref ?? '');
    const resolved = resolveContentRef(ref);
    if (!resolved) return fail(res, 404, `unresolvable ref: ${ref}`);
    ok(res, resolved);
  });

  // Available content services (what refs can point at).
  app.get('/agent/v1/content/services', agentAuth('ro'), (_req, res) =>
    ok(res, listContentServices()),
  );

  // Semantic search — Phase 6 lands the Qdrant/Bone index; until then this
  // transparently answers from FTS so agent callers have a stable endpoint.
  app.get('/agent/v1/search/semantic', agentAuth('ro'), (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return fail(res, 400, 'q required');
    const limit = Math.min(Number(req.query.limit) || 20, MAX_LIMIT);
    ok(res, { query: q, semantic: false, note: 'semantic index not yet populated — FTS results', results: searchNodes(q, undefined, limit) });
  });

  // Agents PRESERVE knowledge: submit a capture into the Admin review queue.
  // Same shape as the companion userscript's POST /api/metadata; attributed
  // to the calling agent (user_id = "agent:<name>").
  app.post('/agent/v1/captures', agentAuth('rw'), (req, res) => {
    if (!req.body?.title) return fail(res, 400, 'title required');
    const id = String(req.body.id ?? crypto.randomUUID());
    db.saveMetadataApi(`agent:${req.agentName}`, {
      id,
      title: String(req.body.title),
      description: req.body.description ? String(req.body.description) : undefined,
      url: req.body.url ? String(req.body.url) : undefined,
      domain: req.body.domain ? String(req.body.domain) : undefined,
      metadata: req.body.metadata,
    });
    ok(res, { id, submittedBy: `agent:${req.agentName}` });
  });
}

// Hand-maintained minimal OpenAPI 3.1 description of the surface above.
const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'KEAP agent API',
    version: '1',
    description:
      'Knowledge Explorer and Preserver — agent-facing knowledge surface. Bearer auth (read or read/write service token). Responses use a {success, data|error} envelope and are budgeted to fit AgentKit’s 16 KiB tool-response cap.',
  },
  paths: {
    '/agent/v1/health': { get: { summary: 'Liveness + corpus stats', security: [] } },
    '/agent/v1/taxonomy/search': {
      get: {
        summary: 'Full-text search over the knowledge taxonomy',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'domain', in: 'query', schema: { type: 'string' }, description: 'Restrict to a category id prefix, e.g. "01"' },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
        ],
      },
    },
    '/agent/v1/taxonomy/node/{id}': {
      get: {
        summary: 'Node detail: ancestors, children, curated notes, resolved content link',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/agent/v1/content/resolve': {
      get: {
        summary: 'Resolve a content ref (e.g. kiwix:wikipedia_en) to a live nOS service URL',
        parameters: [{ name: 'ref', in: 'query', required: true, schema: { type: 'string' } }],
      },
    },
    '/agent/v1/content/services': { get: { summary: 'List linkable nOS content services' } },
    '/agent/v1/search/semantic': {
      get: {
        summary: 'Semantic search (FTS fallback until the Qdrant/Bone index is populated)',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
        ],
      },
    },
    '/agent/v1/captures': {
      post: {
        summary: 'Preserve knowledge: submit a capture into the Admin review queue (write scope)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  url: { type: 'string' },
                  domain: { type: 'string' },
                  metadata: { type: 'object' },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
  security: [{ bearerAuth: [] }],
} as const;
