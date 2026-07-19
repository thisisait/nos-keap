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
import { getNode, getAncestors, taxonomyNodeCount, nodeLevel, type FlatNode } from './taxonomy';
import { resolveContentRef, listContentServices } from './content-links';
import { pendingEmbeddings, EMBED_MODEL, EMBED_DIM } from './embeddings';
import { extractRefs } from './objects';
import { hybridSearch, markCorpusDirty } from './search';
import { runLint, lastLintReport } from './lint';
import { propose, proposeNode, proposeDescription, proposeBrief, moderationPolicy } from './promotions';
import { allNodes } from './taxonomy';
import { normalizeAndSaveCapture, parseEnvelope } from './intake';
import { syncAllFs, syncMapping, fsSyncStatus, USER_FILES_DIR } from './fs-sync';
import { scheduleTopicRecluster, clusterTopics } from './topics';
import { getTable, listTables, storeFor } from './tables';
import { createTableRequestSchema } from '../shared/contracts/table';
import { listRoots } from './fs-roots';
import { TOKEN_RO, TOKEN_RW, tokenEquals } from './tokens';
import { candidatePairs, anchoredCandidates, DEFAULT_MAX_DISTANCE, type CandidatePair } from './relations';

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

  // ── Semantic lens: derived-features pipeline ───────────────────────────────
  // Bulk export of taxonomy embeddings for the host-side keap-features-sync job
  // (it has Ollama + numpy; it projects these onto the exemplar-difference axes,
  // computes centrality + clusters, and POSTs the scalars back). This is the
  // features pipeline's own channel, NOT the 16 KiB-capped agent surface.
  app.get('/agent/v1/features/vectors', agentAuth('ro'), (_req, res) => {
    const vectors = db.readTaxonomyVectors();
    ok(res, { model: db.embeddingStats().model, count: vectors.length, vectors });
  });

  // Upsert the per-node derived features (abstractness/scale/formalness/dynamism/
  // centrality/cluster) computed by keap-features-sync. GraphCanvas renders them.
  app.post('/agent/v1/features', agentAuth('rw'), (req, res) => {
    const body = (req.body ?? {}) as { features?: unknown; model?: unknown };
    const feats = Array.isArray(body.features) ? (body.features as db.NodeFeatureRow[]) : null;
    if (!feats) return fail(res, 400, 'features[] required');
    const model = String(body.model ?? db.embeddingStats().model ?? 'unknown');
    ok(res, { upserted: db.upsertNodeFeatures(feats, model) });
  });

  // Upsert linked-data metadata (Wikidata QID + typing) resolved by the host-side
  // tools/keap-linked-data/resolve-typing.py job. Only high+med confidence lands;
  // GraphCanvas reads node.meta.keapType for the entity-type facet. Derived layer,
  // sibling of /agent/v1/features.
  app.post('/agent/v1/metadata', agentAuth('rw'), (req, res) => {
    const body = (req.body ?? {}) as { metadata?: unknown; model?: unknown; replace?: unknown };
    const rows = Array.isArray(body.metadata) ? (body.metadata as db.NodeMetadataRow[]) : null;
    if (!rows) return fail(res, 400, 'metadata[] required');
    const model = String(body.model ?? 'wikidata');
    ok(res, db.upsertNodeMetadata(rows, model, body.replace === true));
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
    // Topics-mode trigger (§1.3): an object-vector write reshapes the semantic
    // corpus, so debounce a recluster. Trailing 15 s / max-wait 60 s coalesces
    // a bulk embed burst into ~one run per minute (server/topics.ts).
    if (rows.some((r) => r.kind === 'object')) scheduleTopicRecluster();
    ok(res, { upserted, submittedBy: `agent:${req.agentName}` });
  });

  // ── Topics mode (server/topics.ts) — the semantic-cluster control plane ────
  // Status carries the mode summary + last run; rebuild mirrors the admin twin
  // and /agent/v1/fs/sync's default-202 / ?wait=1 semantics (the e2e hook).
  app.get('/agent/v1/topics', agentAuth('ro'), (_req, res) => {
    ok(res, { stats: db.topicStats(), lastRun: db.lastTopicRun() });
  });

  app.post('/agent/v1/topics/rebuild', agentAuth('rw'), async (req, res) => {
    if (!db.vectorSearchAvailable()) return fail(res, 503, 'vector layer unavailable');
    const reset = Boolean(req.body?.reset);
    if (req.query.wait === '1') return ok(res, await clusterTopics({ reset }));
    void clusterTopics({ reset }).catch((err) => console.warn('[topics] rebuild failed:', err));
    res.status(202).json({ success: true, data: { scheduled: true } });
  });

  // ── Typed cross-type relations (Track R3 stage 1) ──────────────────────────
  // The host-side Sonnet classifier drives these: GET pre-recalled candidate
  // pairs + the controlled vocabulary → type them → POST the typed batch, which
  // lands as PROPOSED relations with provenance (moderation is stage 2). KEAP
  // never calls an LLM; it only surfaces geometry + accepts typed results.
  const isRelKind = (k: unknown): k is db.RelationKind => k === 'node' || k === 'object';

  /** Resolve a relation endpoint to its label + text, or null if it doesn't
   *  exist (a node was retired / an object deleted since the vector was written). */
  function relationEndpoint(kind: db.RelationKind, id: string): { label: string; text: string } | null {
    if (kind === 'node') {
      const n = getNode(id);
      if (!n) return null;
      return { label: n.name, text: `${n.name}. ${n.description ?? ''}`.trim() };
    }
    const o = db.getObject(id);
    if (!o) return null;
    return { label: o.title, text: `${o.title}. ${o.description ?? o.body ?? ''}`.trim() };
  }

  // Candidate pairs for the classifier. Anchored mode (anchorKind+anchorId) or a
  // corpus sweep (neither). Both endpoints must resolve, else the pair is
  // dropped — the storage layer is visibility-agnostic; the graph (stage 2)
  // enforces per-viewer both-endpoint visibility at ship time.
  app.get('/agent/v1/relations/candidates', agentAuth('ro'), (req, res) => {
    if (!db.vectorSearchAvailable()) return fail(res, 503, 'vector layer unavailable');
    const limit = Math.min(Number(req.query.limit) || 20, MAX_LIMIT);
    const maxDistance = Number(req.query.maxDistance) || DEFAULT_MAX_DISTANCE;
    const anchorId = req.query.anchorId ? String(req.query.anchorId) : null;
    const anchorKind = req.query.anchorKind ? String(req.query.anchorKind) : null;
    // Incremental watermark (corpus sweep only): only pairs whose endpoints
    // changed after `sinceTs` are re-considered. A caller that passes the prior
    // sweep's timestamp gets bounded compute AND stops re-emitting pairs the
    // classifier already saw-and-declined (their vectors are unchanged) — the
    // whole point of nearCrossKindPairs' sinceTs, which was previously unreachable
    // from this surface. Ignored in anchored mode (already ANN-bounded).
    const sinceRaw = req.query.sinceTs;
    const sinceTs =
      sinceRaw != null && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : undefined;

    let raw: CandidatePair[];
    if (anchorId || anchorKind) {
      if (!isRelKind(anchorKind)) return fail(res, 400, "anchorKind must be 'node' or 'object'");
      if (!anchorId) return fail(res, 400, 'anchorId required with anchorKind');
      if (!relationEndpoint(anchorKind, anchorId)) return fail(res, 404, 'unknown anchor');
      raw = anchoredCandidates(anchorKind, anchorId, { maxDistance, limit });
    } else {
      raw = candidatePairs({ maxDistance, limit, sinceTs });
    }

    const pairs: Array<Record<string, unknown>> = [];
    for (const p of raw) {
      const from = relationEndpoint(p.fromKind, p.fromRef);
      const to = relationEndpoint(p.toKind, p.toRef);
      if (!from || !to) continue; // both endpoints must resolve
      pairs.push({
        from_ref: p.fromRef,
        from_kind: p.fromKind,
        to_ref: p.toRef,
        to_kind: p.toKind,
        fromLabel: from.label,
        toLabel: to.label,
        fromText: trim(from.text),
        toText: trim(to.text),
        similarity: p.similarity,
      });
    }
    // Controlled vocabulary offered to the classifier: the active registry
    // (seed + admin-confirmed). Proposed/rejected verbs are not suggested.
    const vocab = db
      .listRelationTypes()
      .filter((t) => t.status === 'seed' || t.status === 'confirmed')
      .map((t) => ({ type: t.type, label: t.label, description: t.description ?? undefined }));
    ok(res, { model: db.embeddingStats().model, pairs, vocab });
  });

  // Read stored relations (the moderation + agent reader). Filter by status
  // and/or source; newest first. Bounded — this is a host-side moderation feed,
  // not an AgentKit tool response, but still capped to stay sane.
  app.get('/agent/v1/relations', agentAuth('ro'), (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const source = req.query.source ? String(req.query.source) : undefined;
    const limit = Math.min(Number(req.query.limit) || 200, 200);
    const rows = db
      .listRelations({
        status: status as db.RelationStatus | undefined,
        source: source as db.RelationSource | undefined,
      })
      .slice(0, limit);
    ok(res, { relations: rows, types: db.listRelationTypes() });
  });

  // Write a Sonnet-typed batch. Each edge lands source='derived',
  // status='proposed' with provenance (model, confidence, justification,
  // created_at). An unknown type grows the vocabulary as a PROPOSED
  // relation_type (moderated growth) and the edge stores against it, still
  // proposed. Idempotent on (from_ref,to_ref,type). Validate-all-then-write, so
  // a single bad item writes nothing.
  app.post('/agent/v1/relations', agentAuth('rw'), (req, res) => {
    const body = (req.body ?? {}) as { model?: unknown; relations?: unknown };
    const items = Array.isArray(body.relations) ? body.relations : null;
    if (!items || !items.length) return fail(res, 400, 'non-empty relations[] required');
    const model =
      String(body.model ?? req.headers['x-keap-model'] ?? process.env.KEAP_RELATION_MODEL ?? 'unknown').slice(0, 120);
    const agentLabel = `agent:${req.agentName}`;

    interface Valid {
      fromRef: string;
      fromKind: db.RelationKind;
      toRef: string;
      toKind: db.RelationKind;
      type: string;
      confidence: number;
      justification: string;
      unknownType: boolean;
    }
    const valid: Valid[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = (items[i] ?? {}) as Record<string, unknown>;
      const fromKind = it.from_kind;
      const toKind = it.to_kind;
      if (!isRelKind(fromKind) || !isRelKind(toKind)) return fail(res, 400, `invalid from_kind/to_kind at index ${i}`);
      // Cross-type store only: this pipeline derives node↔object edges. Same-kind
      // edges (node↔node / object↔object) belong to ToE (mirrored server-side) or
      // to object-ref links — never to the derived cross-type store. Reject them
      // so candidate recall's cross-kind guard can't be bypassed by a raw POST.
      if (fromKind === toKind) return fail(res, 400, `from_kind and to_kind must differ (cross-type only) at index ${i}`);
      const fromRef = typeof it.from_ref === 'string' ? it.from_ref : '';
      const toRef = typeof it.to_ref === 'string' ? it.to_ref : '';
      if (!relationEndpoint(fromKind, fromRef)) return fail(res, 400, `from endpoint does not resolve at index ${i}`);
      if (!relationEndpoint(toKind, toRef)) return fail(res, 400, `to endpoint does not resolve at index ${i}`);
      const type = typeof it.type === 'string' ? it.type.trim() : '';
      if (!type) return fail(res, 400, `type required at index ${i}`);
      const confidence = Number(it.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return fail(res, 400, `confidence must be a number in [0,1] at index ${i}`);
      }
      const justification = typeof it.justification === 'string' ? it.justification.trim() : '';
      if (!justification) return fail(res, 400, `justification required at index ${i}`);
      valid.push({
        fromRef,
        fromKind,
        toRef,
        toKind,
        type,
        confidence,
        justification,
        unknownType: !db.getRelationType(type),
      });
    }

    const proposedTypes = new Set<string>();
    for (const v of valid) {
      if (v.unknownType && db.insertProposedRelationType(v.type, agentLabel)) proposedTypes.add(v.type);
      db.insertDerivedRelation({
        fromRef: v.fromRef,
        fromKind: v.fromKind,
        toRef: v.toRef,
        toKind: v.toKind,
        type: v.type,
        confidence: v.confidence,
        justification: v.justification,
        model,
      });
    }
    ok(res, { upserted: valid.length, proposedTypes: [...proposedTypes], submittedBy: agentLabel });
  });

  // ── DataTables (server/tables.ts) — the agent-bearer config-table surface ──
  // The nOS face seeder + BFF drive these: host callers hold a bearer token,
  // not an Authentik identity, so the SSO-gated /api/tables 401s them. Two
  // shape rules the seeder relies on and this surface (not /api/tables) honors:
  //   1. the caller-chosen SLUG doubles as the table id (deterministic →
  //      probe-then-create is idempotent; a re-seed finds the existing table);
  //   2. rows are FLAT value objects both ways (POST body IS the values; GET
  //      returns bare values), because the seeder keys idempotency off a
  //      top-level `slug` column. /api/tables wraps rows as {id, values} — this
  //      surface unwraps. Owner is a fixed system id; visibility governs reads.
  // Slug charset per the nOS face contract (dots/underscores, up to 128 chars).
  // The leading [a-z0-9] forbids a '.'/'-' start, so the slug can never BE '..'
  // or '/', and the explicit '..' guard below blocks a dot-run anywhere — so a
  // slug used as a table id can never traverse the RustFS key path.
  const TABLE_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;
  const AGENT_TABLE_OWNER = 'nos-agent';
  const validSlug = (s: string) => TABLE_SLUG.test(s) && !s.includes('..');

  // List every table for the agent surface (nOS face Tables sidebar enumeration).
  // Agent-bearer, RO scope: KEAP trusts the agent token; per-user RBAC is the
  // face's job. Admin actor = all tables regardless of owner/visibility.
  app.get('/agent/v1/tables', agentAuth('ro'), (_req, res) => {
    ok(res, listTables({ id: AGENT_TABLE_OWNER, isAdmin: true, groups: [] }));
  });

  app.get('/agent/v1/tables/:slug', agentAuth('ro'), (req, res) => {
    const t = getTable(req.params.slug);
    if (!t) return fail(res, 404, 'unknown table');
    ok(res, t);
  });

  app.post('/agent/v1/tables', agentAuth('rw'), async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const slug = String(b.slug ?? '');
    if (!validSlug(slug)) return fail(res, 400, 'slug must match ^[a-z0-9][a-z0-9._-]{0,127}$ (no "..")');
    // Idempotent create: the slug IS the id, so a re-seed returns the existing
    // table (200) instead of colliding on the primary key.
    const existing = getTable(slug);
    if (existing) return ok(res, existing);
    // Map the seeder's shape (slug + columns) onto CreateTableRequest (schema
    // wraps columns); id is injected AFTER validation since the schema brands
    // it uuid-only and the slug is deliberately human-readable.
    const parsed = createTableRequestSchema.safeParse({
      title: b.title,
      description: b.description,
      driver: b.driver,
      schema: { columns: b.columns },
      anchors: b.anchors,
      visibility: b.visibility,
    });
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'invalid table');
    try {
      const t = await storeFor(parsed.data.driver).createTable(AGENT_TABLE_OWNER, { ...parsed.data, id: slug });
      ok(res, t);
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'create failed');
    }
  });

  app.get('/agent/v1/tables/:slug/rows', agentAuth('ro'), async (req, res) => {
    const t = getTable(req.params.slug);
    if (!t) return fail(res, 404, 'unknown table');
    try {
      const { rows } = await storeFor(t.driver).listRows(t.id, { filter: [], limit: 500 });
      // FLAT values — the seeder reads a top-level `slug` off each row.
      ok(res, { rows: rows.map((r) => r.values) });
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'query failed');
    }
  });

  app.post('/agent/v1/tables/:slug/rows', agentAuth('rw'), async (req, res) => {
    const t = getTable(req.params.slug);
    if (!t) return fail(res, 404, 'unknown table');
    const values = (req.body ?? {}) as Record<string, unknown>;
    // A row's own `slug` (when present + safe) doubles as the row id, so a
    // re-seed PATCHes the same row instead of inserting a duplicate.
    const rowSlug = typeof values.slug === 'string' && validSlug(values.slug) ? values.slug : undefined;
    try {
      const row = await storeFor(t.driver).upsertRow(t.id, rowSlug, values, `agent:${req.agentName}`);
      ok(res, row.values);
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : 'row upsert failed');
    }
  });

  // ── Filesystem sync (server/fs-sync.ts) — the doctrine-tree mirror ─────────
  // A host job that just wrote into tenants/<t>/users/<uid>/ kicks this so the
  // files appear as objects immediately (boot + interval cover the rest).
  // Status carries the additive roots + mappings blocks (mapped folders).
  app.get('/agent/v1/fs/status', agentAuth('ro'), (_req, res) => ok(res, fsSyncStatus()));

  app.post('/agent/v1/fs/sync', agentAuth('rw'), (req, res) => {
    // Targeted pass: {"mapping":"m-…"} syncs ONE mapped folder (the host-job
    // twin of the admin panel's Sync now).
    const mappingId = req.body?.mapping;
    if (typeof mappingId === 'string' && mappingId) {
      const m = db.getFsMapping(mappingId);
      if (!m) return fail(res, 404, 'unknown mapping');
      if (!m.enabled) return fail(res, 409, 'mapping disabled');
      return ok(res, syncMapping(m));
    }
    // Full pass: users tree (if configured) + every enabled mapping. 503 only
    // when NOTHING at all is configured — mappings sync without the users tree.
    if (!USER_FILES_DIR && listRoots().length === 0) {
      return fail(res, 503, 'fs sync disabled: neither KEAP_USER_FILES_DIR nor KEAP_FS_ROOTS configured');
    }
    const r = syncAllFs();
    if (!r) return fail(res, 409, 'sync in progress');
    // Users-result fields spread at the TOP level so any host job reading
    // scanned/upserted keeps working; mappings is the additive block.
    ok(res, {
      ...(r.users ?? {}),
      mappings: r.mappings.map((x) => ({
        id: x.id,
        scanned: x.scanned,
        upserted: x.upserted,
        removed: x.removed,
        unchanged: x.unchanged,
        capped: x.capped,
        pruneRefused: x.pruneRefused,
      })),
    });
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
      db.openPromotions().filter((p) => p.kind === 'desc').map((p) => p.object?.nodeId),
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

  // ── Curator surface (docs/plans/keap-curator-agent.md) ────────────────────
  // The reconciler sweeps the votable zone (level >= minLevel) staleness-first,
  // lints each node, and — in P0 — proposes desc rewrites through the describe
  // seam above. These endpoints are the traversal cursor + work-log: frontier
  // hands out the next batch (never-visited, then oldest, cooldown-skipped);
  // run/start + run/finish bracket a sweep; visit checkpoints each node so a
  // kill/OOM resumes from the max cursor. No taxonomy writes here — propose-only.
  const contentHashOf = (name: string, description: string | null | undefined) =>
    crypto.createHash('sha1').update(`${name} ${description ?? ''}`).digest('hex').slice(0, 16);

  // The anchor core (level 0-2) is the curator's FIXED reference frame — the
  // top ontology every votable-zone judgment must stay consistent with (plan
  // §7). The profile is a static file so it can't bake the live tree; the agent
  // fetches this once at run start. Read-only; the curator never edits the
  // anchor core in P0 (anchor-edit proposals are P3, off by default).
  app.get('/agent/v1/curator/anchor', agentAuth('ro'), (_req, res) => {
    const anchor = allNodes()
      .filter((n) => nodeLevel(n.id) <= 2)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((n) => ({ id: n.id, name: n.name, level: nodeLevel(n.id), description: trim(n.description) }));
    ok(res, { total: anchor.length, items: anchor });
  });

  app.get('/agent/v1/curator/frontier', agentAuth('ro'), (req, res) => {
    const minLevel = req.query.minLevel !== undefined ? Number(req.query.minLevel) : 3;
    const maxLevel = req.query.maxLevel !== undefined ? Number(req.query.maxLevel) : 9;
    const limit = Math.min(Number(req.query.limit) || 15, MAX_LIMIT);
    const cooldownDays = req.query.cooldownDays !== undefined ? Number(req.query.cooldownDays) : 14;
    const cooldownS = Math.max(0, cooldownDays) * 86400;
    const now = Math.floor(Date.now() / 1000);

    const nodes = allNodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const visits = db.curatorVisitMap();

    // Relation degree per node (typed vs all) — the relation-desert signal.
    const typedDeg = new Map<string, number>();
    const allDeg = new Map<string, number>();
    for (const r of db.listConceptRelations(false)) {
      const typed = r.type !== 'related-concept';
      for (const id of [r.from, r.to]) {
        allDeg.set(id, (allDeg.get(id) ?? 0) + 1);
        if (typed) typedDeg.set(id, (typedDeg.get(id) ?? 0) + 1);
      }
    }

    const eligible = nodes.filter((n) => {
      const lvl = nodeLevel(n.id);
      if (lvl < minLevel || lvl > maxLevel) return false;
      const v = visits.get(n.id);
      if (!v) return true; // never visited — always eligible
      // Skip only if seen recently AND unchanged since (convergence).
      const fresh = now - v.visitedAt < cooldownS;
      const unchanged = v.contentHash === contentHashOf(n.name, n.description);
      return !(fresh && unchanged);
    });

    // Staleness order: never-visited first, then oldest visited_at ascending.
    eligible.sort((a, b) => (visits.get(a.id)?.visitedAt ?? 0) - (visits.get(b.id)?.visitedAt ?? 0));

    const items = eligible.slice(0, limit).map((n) => ({
      id: n.id,
      name: n.name,
      path: n.path,
      level: nodeLevel(n.id),
      zone: n.zone,
      description: n.description ?? null,
      descriptionCs: n.descriptionCs ?? null,
      descLen: (n.description ?? '').trim().length,
      contentHash: contentHashOf(n.name, n.description),
      lastVisitedAt: visits.get(n.id)?.visitedAt ?? null,
      typedRelations: typedDeg.get(n.id) ?? 0,
      allRelations: allDeg.get(n.id) ?? 0,
      childNames: n.childIds.slice(0, 12).map((cid) => byId.get(cid)?.name).filter(Boolean),
      siblingNames: n.parentId
        ? (byId.get(n.parentId)?.childIds ?? [])
            .filter((sid) => sid !== n.id)
            .slice(0, 12)
            .map((sid) => byId.get(sid)?.name)
            .filter(Boolean)
        : [],
    }));
    // Deterministic cursor advance: when the sweeping agent passes its runId
    // (RW token), the hand-out itself checkpoints the served nodes as
    // action='served' — so the cursor advances even if the LLM later forgets
    // the per-node /visit call. /visit then UPSERTs findings/action onto these
    // rows; run/finish owns the authoritative proposal tally. The RO pre-flight
    // peek (no runId) stays a pure read.
    const fRunId = String(req.query.runId ?? '').trim();
    if (fRunId && req.agentScope === 'rw') {
      db.startCuratorRun(fRunId, null, null);
      for (const it of items) {
        db.recordCuratorVisit({ nodeId: it.id, runId: fRunId, contentHash: it.contentHash, action: 'served' });
      }
    }
    ok(res, { total: eligible.length, minLevel, maxLevel, cooldownDays, served: fRunId ? items.length : 0, items });
  });

  app.post('/agent/v1/curator/run/start', agentAuth('rw'), (req, res) => {
    const runId = String(req.body?.runId ?? '').trim();
    if (!runId) return fail(res, 400, 'runId required');
    db.startCuratorRun(
      runId,
      req.body?.params ? JSON.stringify(req.body.params) : null,
      req.body?.budgetTokens != null ? Number(req.body.budgetTokens) : null,
    );
    ok(res, { runId, status: 'running' });
  });

  app.post('/agent/v1/curator/run/finish', agentAuth('rw'), (req, res) => {
    const runId = String(req.body?.runId ?? '').trim();
    if (!runId) return fail(res, 400, 'runId required');
    db.finishCuratorRun(runId, {
      tokensSpent: req.body?.tokensSpent != null ? Number(req.body.tokensSpent) : undefined,
      nodesVisited: req.body?.nodesVisited != null ? Number(req.body.nodesVisited) : undefined,
      proposalsMade: req.body?.proposalsMade != null ? Number(req.body.proposalsMade) : undefined,
      proposalsApproved: req.body?.proposalsApproved != null ? Number(req.body.proposalsApproved) : undefined,
      status: req.body?.status ? String(req.body.status) : undefined,
    });
    ok(res, { runId, status: req.body?.status ?? 'done' });
  });

  app.post('/agent/v1/curator/visit', agentAuth('rw'), (req, res) => {
    const runId = String(req.body?.runId ?? '').trim();
    const nodeId = String(req.body?.nodeId ?? '').trim();
    if (!runId || !nodeId) return fail(res, 400, 'runId and nodeId required');
    if (!getNode(nodeId)) return fail(res, 404, 'unknown taxonomy node');
    db.recordCuratorVisit({
      nodeId,
      runId,
      pass: req.body?.pass != null ? Number(req.body.pass) : 0,
      contentHash: req.body?.contentHash ? String(req.body.contentHash) : null,
      findingsCount: req.body?.findingsCount != null ? Number(req.body.findingsCount) : 0,
      proposalsCount: req.body?.proposalsCount != null ? Number(req.body.proposalsCount) : 0,
      action: req.body?.action ? String(req.body.action).slice(0, 64) : null,
    });
    ok(res, { nodeId, runId, recorded: true });
  });

  // ── taxonomy-brief surface (Track K) — the node's ARTICLE where the K1
  // description is its abstract. Root-first: intake orders by level so the
  // anchor core gets its briefs before the depths. Briefs land in the
  // curated note layer on approval (embeddings kind 'note' pick them up).
  app.get('/agent/v1/taxonomy/brief/pending', agentAuth('ro'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 20);
    const maxLevel = req.query.maxLevel !== undefined ? Number(req.query.maxLevel) : Infinity;
    const openBrief = new Set(
      db.openPromotions().filter((p) => p.kind === 'brief').map((p) => p.object?.nodeId),
    );
    const curated = db.getTaxonomyMetadata();
    const briefed = new Set(
      (Array.isArray(curated) ? curated : []).filter((c) => c.data?.brief).map((c) => c.id),
    );
    const nodes = allNodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const level = (id: string) => getAncestors(id).length;
    const pending = nodes
      .filter((n) => !briefed.has(n.id) && !openBrief.has(n.id) && level(n.id) <= maxLevel)
      .sort((a, b) => level(a.id) - level(b.id) || a.id.localeCompare(b.id));
    ok(res, {
      total: pending.length,
      items: pending.slice(0, limit).map((n) => ({
        id: n.id,
        name: n.name,
        path: n.path,
        zone: n.zone,
        level: level(n.id),
        description: n.description ?? null,
        childNames: n.childIds.slice(0, 15).map((cid) => byId.get(cid)?.name).filter(Boolean),
        siblingNames: n.parentId
          ? (byId.get(n.parentId)?.childIds ?? [])
              .filter((sid) => sid !== n.id)
              .slice(0, 15)
              .map((sid) => byId.get(sid)?.name)
              .filter(Boolean)
          : [],
      })),
    });
  });

  app.post('/agent/v1/taxonomy/brief', agentAuth('rw'), (req, res) => {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || !items.length || items.length > 20) {
      return fail(res, 400, 'items required (1-20 per batch)');
    }
    const proposed: string[] = [];
    const errors: Array<{ nodeId: string; error: string }> = [];
    for (const it of items) {
      try {
        proposeBrief(
          { nodeId: it?.nodeId, briefEn: it?.briefEn, briefCs: it?.briefCs },
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
    '/agent/v1/relations/candidates': {
      get: {
        summary:
          'Track R3: cross-kind candidate pairs from the vector index for the host-side classifier, plus the controlled relation vocabulary. Anchored mode (anchorKind+anchorId) or a corpus sweep (neither). Already-stored pairs are skipped; both endpoints must resolve.',
        parameters: [
          { name: 'anchorKind', in: 'query', schema: { type: 'string', enum: ['node', 'object'] } },
          { name: 'anchorId', in: 'query', schema: { type: 'string' } },
          { name: 'maxDistance', in: 'query', schema: { type: 'number', default: 0.35 }, description: 'Cosine-distance ceiling; similarity = 1 − distance' },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
        ],
      },
    },
    '/agent/v1/relations': {
      get: {
        summary:
          'Track R3: read stored relations for moderation. Filter by status (proposed|confirmed|rejected) and/or source (toe|derived|manual); newest first. Also returns the relation_types registry.',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['proposed', 'confirmed', 'rejected'] } },
          { name: 'source', in: 'query', schema: { type: 'string', enum: ['toe', 'derived', 'manual'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200, default: 200 } },
        ],
      },
      post: {
        summary:
          'Track R3: write a classifier-typed relation batch (write scope). Each edge lands source="derived", status="proposed" with provenance (model, confidence, justification). An unknown type grows the vocabulary as a proposed relation_type. Idempotent on (from_ref,to_ref,type).',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['relations'],
                properties: {
                  model: { type: 'string' },
                  relations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['from_ref', 'from_kind', 'to_ref', 'to_kind', 'type', 'confidence', 'justification'],
                      properties: {
                        from_ref: { type: 'string' },
                        from_kind: { type: 'string', enum: ['node', 'object'] },
                        to_ref: { type: 'string' },
                        to_kind: { type: 'string', enum: ['node', 'object'] },
                        type: { type: 'string' },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                        justification: { type: 'string' },
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
    '/agent/v1/taxonomy/brief/pending': {
      get: {
        summary:
          'taxonomy-brief intake: nodes lacking an explanatory brief, root-first (ordered by level), with server-assembled context incl. the K1 description.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 20, default: 10 } },
          { name: 'maxLevel', in: 'query', schema: { type: 'integer' } },
        ],
      },
    },
    '/agent/v1/taxonomy/brief': {
      post: {
        summary:
          'Batch-propose node briefs (markdown paragraphs; [[node-id]] vazby validated, >=1 required; external links allowed). kind=brief promotions — the moderator disposes; approval merges into the curated note layer.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    maxItems: 20,
                    items: {
                      type: 'object',
                      required: ['nodeId', 'briefEn'],
                      properties: {
                        nodeId: { type: 'string' },
                        briefEn: { type: 'string', minLength: 300, maxLength: 12000 },
                        briefCs: { type: 'string', minLength: 200, maxLength: 12000 },
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
    '/agent/v1/topics': {
      get: {
        summary: 'Topics-mode status: cluster count, assigned objects, last-run summary (semantic clustering)',
      },
    },
    '/agent/v1/topics/rebuild': {
      post: {
        summary:
          'Recluster topics now (write scope): default 202 scheduled; ?wait=1 awaits the run and returns its result; {"reset":true} breaks identities and re-seeds. 503 without the vector layer.',
        parameters: [
          { name: 'wait', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Await the serialized run and return the TopicRunResult' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  reset: {
                    type: 'boolean',
                    description: 'Discard existing topic identities and re-seed from scratch (the one sanctioned identity break)',
                  },
                },
              },
            },
          },
        },
      },
    },
    '/agent/v1/fs/status': {
      get: {
        summary:
          'Filesystem-sync status: doctrine users/ tree mirror (dir, interval, last run) + mounted knowledge roots + per-mapping sync status (mapped folders)',
      },
    },
    '/agent/v1/fs/sync': {
      post: {
        summary:
          'Run one fs→objects mirror pass now (write scope): users tree + every enabled mapped folder, or one mapping via {"mapping":"m-…"}',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  mapping: {
                    type: 'string',
                    description: 'Sync only this fs_mappings id (404 unknown, 409 disabled); omit for the full pass',
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
