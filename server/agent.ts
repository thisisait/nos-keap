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
import { pendingEmbeddings, EMBED_MODEL, EMBED_DIM } from './embeddings';
import { extractRefs } from './objects';
import { hybridSearch, markCorpusDirty } from './search';

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

function parseAgentKinds(raw: unknown): db.EmbeddingKind[] {
  const all: db.EmbeddingKind[] = ['taxonomy', 'capture', 'note', 'object'];
  if (!raw) return all;
  const asked = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const picked = all.filter((k) => asked.includes(k));
  return picked.length ? picked : all;
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
      embeddings: db.embeddingStats(),
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

  // Hybrid corpus search (S4): RRF fusion of BM25 over the whole corpus
  // ⊕ vectors (when KEAP_OLLAMA_URL is wired) ⊕ one-hop graph expansion.
  // Result items are typed by kind — taxonomy nodes, knowledge objects,
  // captures, curated notes in one ranked list.
  app.get('/agent/v1/search/semantic', agentAuth('ro'), async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return fail(res, 400, 'q required');
    const limit = Math.min(Number(req.query.limit) || 20, MAX_LIMIT);
    const kinds = parseAgentKinds(req.query.kinds);
    const { hits, legs } = await hybridSearch(q, kinds, limit);
    const results = hits
      .map((h) => {
        const base = { kind: h.kind, score: Number(h.score.toFixed(5)), legs: h.legs };
        if (h.kind === 'taxonomy') {
          const n = getNode(h.refId);
          // base last: `kind` must stay the corpus kind ('taxonomy'), the
          // node's own category/subcategory/item level moves to nodeKind.
          return n ? { ...nodeSummary(n), nodeKind: n.kind, ...base } : null;
        }
        if (h.kind === 'object') {
          const o = db.getObject(h.refId);
          return o
            ? { ...base, id: o.id, type: o.type, title: o.title, description: trim(o.description), resource: o.resource }
            : null;
        }
        if (h.kind === 'capture') {
          const c = db.getAllMetadataApi('', true).find((x) => x.id === h.refId);
          return c ? { ...base, id: c.id, title: c.title, description: trim(c.description), url: c.url } : null;
        }
        const row = db.getTaxonomyMetadata(h.refId);
        const note = row && !Array.isArray(row) ? row : null;
        return note ? { ...base, id: note.id, curated: note.data } : null;
      })
      .filter(Boolean);
    ok(res, { query: q, semantic: legs.vector, legs, results });
  });

  // ── Embedding sync surface (consumed by the nOS keap-embed-sync Pulse job) ──
  // The container decides WHAT to embed (canonical text + content_hash diff);
  // the host job decides HOW (loopback Ollama) and pushes vectors back.
  app.get('/agent/v1/embeddings/pending', agentAuth('ro'), (req, res) => {
    if (!db.vectorSearchAvailable()) return fail(res, 503, 'vector layer unavailable');
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { pending, total, pruned } = pendingEmbeddings(limit);
    ok(res, { model: EMBED_MODEL, dim: EMBED_DIM, total, pruned, items: pending });
  });

  app.post('/agent/v1/embeddings', agentAuth('rw'), (req, res) => {
    if (!db.vectorSearchAvailable()) return fail(res, 503, 'vector layer unavailable');
    const { model, dim, items } = req.body ?? {};
    if (!model || !Array.isArray(items) || !items.length) {
      return fail(res, 400, 'model + non-empty items required');
    }
    if (Number(dim) !== EMBED_DIM) return fail(res, 400, `dim must be ${EMBED_DIM}`);
    const rows: Array<{ kind: db.EmbeddingKind; refId: string; contentHash: string; vector: number[] }> = [];
    for (const it of items) {
      if (
        !['taxonomy', 'capture', 'note', 'object'].includes(it?.kind) ||
        typeof it?.refId !== 'string' ||
        typeof it?.contentHash !== 'string' ||
        !Array.isArray(it?.vector) ||
        it.vector.length !== EMBED_DIM
      ) {
        return fail(res, 400, `invalid item at index ${rows.length}`);
      }
      rows.push({ kind: it.kind, refId: it.refId, contentHash: it.contentHash, vector: it.vector });
    }
    const upserted = db.upsertEmbeddings(String(model), EMBED_DIM, rows);
    ok(res, { upserted, submittedBy: `agent:${req.agentName}` });
  });

  // ── Knowledge objects — OKF index cards (ROADMAP S1) ───────────────────────
  // Agents read the shared card corpus and PRESERVE durable findings as new
  // cards (Karpathy's "query writes valuable answers back as new pages").
  app.get('/agent/v1/objects', agentAuth('ro'), (req, res) => {
    const type = req.query.type ? String(req.query.type) : undefined;
    const q = req.query.q ? String(req.query.q).toLowerCase() : undefined;
    const limit = Math.min(Number(req.query.limit) || 20, MAX_LIMIT);
    let items = db.getObjects('', true, type);
    if (q) {
      items = items.filter(
        (o) =>
          o.title.toLowerCase().includes(q) ||
          o.description?.toLowerCase().includes(q) ||
          o.body?.toLowerCase().includes(q),
      );
    }
    ok(res, {
      total: items.length,
      results: items.slice(0, limit).map((o) => ({
        id: o.id,
        type: o.type,
        title: o.title,
        description: trim(o.description),
        resource: o.resource,
        tags: o.tags,
        userId: o.userId,
      })),
    });
  });

  app.get('/agent/v1/objects/:id', agentAuth('ro'), (req, res) => {
    const o = db.getObject(req.params.id);
    if (!o) return fail(res, 404, 'unknown object');
    ok(res, {
      ...o,
      // Body dominates the 16 KiB tool budget; cap it and say so.
      body: o.body && o.body.length > 8000 ? `${o.body.slice(0, 8000)}\n…[truncated]` : o.body,
      contentLink: o.resource ? resolveContentRef(o.resource) : null,
    });
  });

  app.post('/agent/v1/objects', agentAuth('rw'), (req, res) => {
    const b = req.body ?? {};
    if (!b.type || !b.title) return fail(res, 400, 'type and title required');
    const id = String(b.id ?? crypto.randomUUID());
    const existing = db.getObject(id);
    const body = b.body ? String(b.body) : undefined;
    const resource = b.resource ? String(b.resource) : undefined;
    db.saveObject(existing?.userId ?? `agent:${req.agentName}`, {
      id,
      type: String(b.type),
      title: String(b.title),
      description: b.description ? String(b.description) : undefined,
      resource,
      tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
      frontmatter: b.frontmatter && typeof b.frontmatter === 'object' ? b.frontmatter : undefined,
      body,
      links: extractRefs(body, resource),
      visibility: 'private',
    });
    markCorpusDirty();
    ok(res, { id, submittedBy: `agent:${req.agentName}` });
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
    markCorpusDirty();
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
        summary:
          'Hybrid corpus search: RRF fusion of BM25 (whole corpus) + vectors (when live embed is wired) + one-hop graph expansion. Items are typed by kind (taxonomy/object/capture/note) with score and contributing legs.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'kinds', in: 'query', schema: { type: 'string' }, description: 'Comma list of kinds to include (default all): taxonomy,capture,note,object' },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
        ],
      },
    },
    '/agent/v1/embeddings/pending': {
      get: {
        summary: 'Embedding sync diff: canonical texts missing or stale in the vector corpus',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 100 } },
        ],
      },
    },
    '/agent/v1/embeddings': {
      post: {
        summary: 'Upsert computed vectors into the libSQL corpus (write scope; nOS keap-embed-sync job)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'dim', 'items'],
                properties: {
                  model: { type: 'string' },
                  dim: { type: 'integer', const: 768 },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['kind', 'refId', 'contentHash', 'vector'],
                      properties: {
                        kind: { type: 'string', enum: ['taxonomy', 'capture', 'note', 'object'] },
                        refId: { type: 'string' },
                        contentHash: { type: 'string' },
                        vector: { type: 'array', items: { type: 'number' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/agent/v1/objects': {
      get: {
        summary: 'List/filter knowledge objects (OKF index cards) — id, type, title, resource',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Filter by object type, e.g. "query", "recipe"' },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter over title/description/body' },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
        ],
      },
      post: {
        summary:
          'Preserve durable knowledge as an OKF index card (write scope). type + title required; resource is a content ref/URN; frontmatter carries per-type structured data; markdown body links ([[node-id]]) become graph edges.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['type', 'title'],
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  resource: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  frontmatter: { type: 'object' },
                  body: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/agent/v1/objects/{id}': {
      get: {
        summary: 'Object detail: full card + resolved content link',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
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
