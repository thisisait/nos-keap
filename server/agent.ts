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
import { runLint, lastLintReport } from './lint';
import { propose, proposeNode, proposeDescription, moderationPolicy } from './promotions';
import { allNodes } from './taxonomy';
import { normalizeAndSaveCapture, parseEnvelope } from './intake';
import { TOKEN_RO, TOKEN_RW, tokenEquals } from './tokens';

const ok = (res: Response, data?: unknown) => res.json({ success: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ success: false, error });

// Token tiers live in server/tokens.ts (shared with the /ingest surface).

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
      zone: node.zone,
      ext: node.ext ?? false,
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

  // ── Knowledge lint (server/lint.ts) — the cortex's periodic health check ───
  // GET returns the standing findings (cheap, no recompute); POST /run
  // executes all checks and reconciles the findings lifecycle. The nOS
  // keap-lint Pulse job POSTs nightly and notifies only on NEW findings.
  app.get('/agent/v1/lint', agentAuth('ro'), (req, res) => {
    const report = lastLintReport();
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    let findings = report.findings;
    // Intake filters for the librarian judge: ?check=overlap-review&unjudged=1
    const check = req.query.check ? String(req.query.check) : null;
    if (check) findings = findings.filter((f) => f.checkId === check);
    if (req.query.unjudged === '1') findings = findings.filter((f) => !f.data?.verdict);
    ok(res, { ...report, findings: findings.slice(0, limit) });
  });

  // Layer-2 judgment: the librarian (or an admin) rules on a finding.
  // fine -> resolves; duplicate -> medium; contradiction -> high (see db).
  app.post('/agent/v1/lint/verdict', agentAuth('rw'), (req, res) => {
    const { findingId, verdict, note } = req.body ?? {};
    if (typeof findingId !== 'string' || !['fine', 'duplicate', 'contradiction'].includes(verdict)) {
      return fail(res, 400, 'findingId + verdict (fine|duplicate|contradiction) required');
    }
    const row = db.applyLintVerdict(findingId, verdict, note ? String(note).slice(0, 500) : undefined, `agent:${req.agentName}`);
    if (!row) return fail(res, 404, 'unknown finding');
    ok(res, row);
  });

  app.post('/agent/v1/lint/run', agentAuth('rw'), (req, res) => {
    const report = runLint();
    const limit = Math.min(Number(req.body?.limit) || 100, 500);
    ok(res, {
      ...report,
      findings: report.findings.slice(0, limit),
      submittedBy: `agent:${req.agentName}`,
    });
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

  // Read the review queue (the librarian's promotion intake). unpromoted=1
  // filters to datapoints no proposal/approval has touched yet.
  app.get('/agent/v1/captures', agentAuth('ro'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, MAX_LIMIT);
    const source = req.query.source ? String(req.query.source) : undefined;
    let items = db.getAllMetadataApi('', true);
    if (source) items = items.filter((c) => c.source === source);
    if (req.query.unpromoted === '1') {
      const proposedCaptures = new Set(db.listPromotions().map((p) => p.captureId));
      items = items.filter((c) => !c.metadata?.promotedTo && !proposedCaptures.has(c.id));
    }
    ok(res, {
      total: items.length,
      items: items.slice(0, limit).map((c) => ({
        id: c.id,
        title: c.title,
        description: trim(c.description),
        url: c.url,
        source: c.source,
        modality: c.modality,
        attribution: c.userId,
        metadata: c.metadata,
      })),
    });
  });

  // Taxonomy extension proposal (Track T): grow the tree under votable/free
  // parents. Description is MANDATORY (DescGraph doctrine) — a 400 explains
  // why. Free-zone parents auto-approve (light governance); votable-core
  // parents queue for the moderator; anchor-core parents refuse.
  app.post('/agent/v1/taxonomy/propose', agentAuth('rw'), (req, res) => {
    const { parentId, name, description, rationale } = req.body ?? {};
    try {
      const result = proposeNode({ parentId, name, description }, rationale, `agent:${req.agentName}`);
      ok(res, { ...result, submittedBy: `agent:${req.agentName}` });
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });

  // ── K1 taxonomy-describe surface (Track K) ────────────────────────────────
  // Same trust split as embeddings: the container decides WHAT needs a
  // description (server-assembled context per node — the skill stays dumb);
  // the host-side LLM ceremony decides the WORDS and proposes them back.
  app.get('/agent/v1/taxonomy/describe/pending', agentAuth('ro'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const openDesc = new Set(
      db.listPromotions('proposed').filter((p) => p.kind === 'desc').map((p) => p.object?.nodeId),
    );
    const nodes = allNodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Pending = no curated override AND seed description missing/too thin to
    // carry retrieval. Refresh of curated text happens via re-proposal, not here.
    const pending = nodes.filter(
      (n) => !n.descCurated && (n.description ?? '').trim().length < 20 && !openDesc.has(n.id),
    );
    ok(res, {
      total: pending.length,
      items: pending.slice(0, limit).map((n) => ({
        id: n.id,
        name: n.name,
        path: n.path,
        zone: n.zone,
        currentDescription: n.description ?? null,
        childNames: n.childIds.slice(0, 12).map((cid) => byId.get(cid)?.name).filter(Boolean),
        siblingNames: n.parentId
          ? (byId.get(n.parentId)?.childIds ?? [])
              .filter((sid) => sid !== n.id)
              .slice(0, 12)
              .map((sid) => byId.get(sid)?.name)
              .filter(Boolean)
          : [],
      })),
    });
  });

  app.post('/agent/v1/taxonomy/describe', agentAuth('rw'), (req, res) => {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || !items.length || items.length > 50) {
      return fail(res, 400, 'items required (1-50 per batch)');
    }
    const proposed: string[] = [];
    const errors: Array<{ nodeId: string; error: string }> = [];
    for (const it of items) {
      try {
        proposeDescription(
          { nodeId: it?.nodeId, descriptionEn: it?.descriptionEn, descriptionCs: it?.descriptionCs },
          it?.rationale,
          `agent:${req.agentName}`,
        );
        proposed.push(it.nodeId);
      } catch (err) {
        errors.push({ nodeId: String(it?.nodeId), error: (err as Error).message });
      }
    }
    ok(res, { proposed: proposed.length, errors, submittedBy: `agent:${req.agentName}` });
  });

  // Promotion proposals — the librarian PROPOSES, the moderator DECIDES.
  // No agent path can approve; the curated corpus stays human-gated
  // (or quorum-gated in the future democratic/MMO policy).
  app.get('/agent/v1/promotions', agentAuth('ro'), (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    ok(res, { policy: moderationPolicy(), items: db.listPromotions(status, 100) });
  });

  app.post('/agent/v1/promotions', agentAuth('rw'), (req, res) => {
    const { captureId, object, rationale } = req.body ?? {};
    if (typeof captureId !== 'string' || !object) {
      return fail(res, 400, 'captureId + object draft required');
    }
    try {
      const { id } = propose(captureId, object, rationale, `agent:${req.agentName}`);
      ok(res, { id, status: 'proposed', submittedBy: `agent:${req.agentName}` });
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  });

  // Agents PRESERVE knowledge: submit a capture into the Admin review queue.
  // Same shape as the companion userscript's POST /api/metadata; attributed
  // to the calling agent (user_id = "agent:<name>").
  app.post('/agent/v1/captures', agentAuth('rw'), (req, res) => {
    // Unified intake: accept the flat legacy shape OR a full envelope; both
    // normalize through the same path as /ingest/v1 and the web surface.
    let envelope;
    try {
      envelope = parseEnvelope({
        source: { kind: 'agent', name: req.agentName },
        text: req.body?.description,
        ...req.body,
      });
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
    envelope.source = { kind: 'agent', name: req.agentName ?? 'unknown' };
    const { id } = normalizeAndSaveCapture(envelope, `agent:${req.agentName}`);
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
    '/agent/v1/captures': {
      get: {
        summary: 'Read the review queue (promotion intake); ?unpromoted=1 filters untouched datapoints',
        parameters: [
          { name: 'unpromoted', in: 'query', schema: { type: 'string', enum: ['1'] } },
          { name: 'source', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
        ],
      },
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
    '/agent/v1/promotions': {
      get: { summary: 'List promotion proposals + moderation policy' },
      post: {
        summary: 'Propose promoting a capture into a knowledge object (write scope). The MODERATOR decides — agents can never approve.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['captureId', 'object'],
                properties: {
                  captureId: { type: 'string' },
                  object: {
                    type: 'object',
                    required: ['type', 'title'],
                    properties: {
                      type: { type: 'string' },
                      title: { type: 'string' },
                      description: { type: 'string' },
                      body: { type: 'string', description: '[[node-id]] refs anchor the object' },
                      resource: { type: 'string' },
                      tags: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  rationale: { type: 'string', maxLength: 1000 },
                },
              },
            },
          },
        },
      },
    },
    '/agent/v1/taxonomy/propose': {
      post: {
        summary: 'Propose a new taxonomy node (Track T). Description REQUIRED (DescGraph). Anchor-core parents refuse; votable-core queue for the moderator; free-zone auto-approve.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['parentId', 'name', 'description'],
                properties: {
                  parentId: { type: 'string' },
                  name: { type: 'string', maxLength: 120 },
                  description: { type: 'string', minLength: 20, maxLength: 2000 },
                  rationale: { type: 'string', maxLength: 1000 },
                },
              },
            },
          },
        },
      },
    },
    '/agent/v1/taxonomy/describe/pending': {
      get: {
        summary:
          'K1 taxonomy-describe intake: nodes lacking a load-bearing description, with server-assembled context (path, children, siblings). Consumed by the describe ceremony.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 40 } },
        ],
      },
    },
    '/agent/v1/taxonomy/describe': {
      post: {
        summary:
          'K1: batch-propose curated node descriptions (en canonical + cs localization). Every item lands as a kind=desc promotion — the moderator approves; nothing writes the tree directly.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    maxItems: 50,
                    items: {
                      type: 'object',
                      required: ['nodeId', 'descriptionEn'],
                      properties: {
                        nodeId: { type: 'string' },
                        descriptionEn: { type: 'string', minLength: 20, maxLength: 2000 },
                        descriptionCs: { type: 'string', minLength: 20, maxLength: 2000 },
                        rationale: { type: 'string', maxLength: 1000 },
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
    '/agent/v1/lint': {
      get: {
        summary: 'Standing knowledge-lint findings (broken refs, duplicates, deserts, substrate drift)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 100 } },
        ],
      },
    },
    '/agent/v1/lint/run': {
      post: {
        summary: 'Run all lint checks now and reconcile the findings lifecycle (write scope; nightly keap-lint job)',
      },
    },
    '/agent/v1/lint/verdict': {
      post: {
        summary: 'Judge a lint finding (librarian Layer 2): fine resolves it, duplicate/contradiction escalate it',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['findingId', 'verdict'],
                properties: {
                  findingId: { type: 'string' },
                  verdict: { type: 'string', enum: ['fine', 'duplicate', 'contradiction'] },
                  note: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
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
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
  security: [{ bearerAuth: [] }],
} as const;
