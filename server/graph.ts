/**
 * Graph surface for the /explore vector explorer (human API, /api/graph*).
 *
 * Two shapes:
 *   GET /api/graph                — the whole taxonomy tree as nodes+links,
 *                                   one payload the force-graph renders from.
 *   GET /api/graph/neighbors      — the "stars behind the constellation":
 *                                   nearest/farthest stored vectors around an
 *                                   anchor node, joined back to their source
 *                                   rows for labels + data links.
 *
 * Everything degrades: without vectors /api/graph still serves the tree
 * (meta.vectors=false) and neighbors answers semantic:false — the explorer
 * then offers only the tree + same-zone mode (pure taxonomy, no vectors).
 */
import type { Express, Request, Response } from 'express';
import * as db from './db';
import { allNodes, getNode, getAncestors } from './taxonomy';
import { resolveContentRef, inferCaptureType } from './content-links';
import { embedText, liveEmbedAvailable } from './embeddings';

const ok = (res: Response, data?: unknown) => res.json({ success: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ success: false, error });

const MAX_NEIGHBORS = 50;

/** Depth from root (category=0) — the explorer maps this to radial shells. */
function nodeLevel(id: string): number {
  return getAncestors(id).length;
}

/** dataType facet of a taxonomy node = the content TYPE behind its ref. */
function nodeDataType(ref?: string): string | undefined {
  return resolveContentRef(ref)?.type;
}

// ── Neighbor hit enrichment: join vector hits back to their source rows ──────

interface EnrichedHit {
  kind: db.EmbeddingKind;
  refId: string;
  distance: number;
  name: string;
  description?: string;
  dataType?: string;
  url?: string;
  nodeId?: string;
}

function enrich(hits: db.NeighborHit[]): EnrichedHit[] {
  const out: EnrichedHit[] = [];
  for (const h of hits) {
    if (h.kind === 'taxonomy') {
      const n = getNode(h.refId);
      if (!n) continue;
      const curatedRow = db.getTaxonomyMetadata(h.refId);
      const curated = curatedRow && !Array.isArray(curatedRow) ? curatedRow.data : null;
      const ref = curated?.requiredData ?? n.requiredData;
      const resolved = resolveContentRef(ref);
      out.push({
        ...h,
        name: n.name,
        description: n.description,
        dataType: resolved?.type,
        url: resolved?.url,
        nodeId: n.id,
      });
    } else if (h.kind === 'capture') {
      const rows = db.getAllMetadataApi('', true).filter((c) => c.id === h.refId);
      const c = rows[0];
      if (!c) continue;
      out.push({
        ...h,
        name: c.title,
        description: c.description,
        dataType: inferCaptureType(c.domain, c.url),
        url: c.url ?? undefined,
      });
    } else {
      const row = db.getTaxonomyMetadata(h.refId);
      const note = row && !Array.isArray(row) ? row : null;
      if (!note) continue;
      const n = getNode(h.refId);
      out.push({
        ...h,
        name: n ? `${n.name} (note)` : `note ${h.refId}`,
        dataType: 'note',
        url: resolveContentRef(note.data?.requiredData)?.url,
        nodeId: n?.id,
      });
    }
  }
  return out;
}

function parseKinds(raw: unknown): db.EmbeddingKind[] {
  const all: db.EmbeddingKind[] = ['taxonomy', 'capture', 'note'];
  if (!raw) return all;
  const asked = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const picked = all.filter((k) => asked.includes(k));
  return picked.length ? picked : all;
}

export function registerGraphRoutes(app: Express) {
  // The full taxonomy as a render-ready graph. The dataset is static, curated
  // overlay is tiny — one uncached pass per request is fine at ~790 nodes.
  app.get('/api/graph', (_req: Request, res: Response) => {
    const curated = db.getTaxonomyMetadata();
    const curatedById = new Map(
      (Array.isArray(curated) ? curated : []).map((c) => [c.id, c.data]),
    );
    const nodes = allNodes().map((n) => {
      const cur = curatedById.get(n.id);
      const ref = cur?.requiredData ?? n.requiredData;
      return {
        id: n.id,
        name: n.name,
        kind: n.kind,
        parentId: n.parentId,
        level: nodeLevel(n.id),
        childCount: n.childIds.length,
        hasNote: curatedById.has(n.id),
        dataType: nodeDataType(ref),
      };
    });
    const links = nodes
      .filter((n) => n.parentId)
      .map((n) => ({ source: n.parentId as string, target: n.id }));
    ok(res, {
      nodes,
      links,
      meta: {
        vectors: db.vectorSearchAvailable(),
        embeddings: db.embeddingStats(),
        liveEmbed: liveEmbedAvailable(),
      },
    });
  });

  // Stars behind the constellation: nearest/farthest vectors around a node.
  app.get('/api/graph/neighbors', (req: Request, res: Response) => {
    const id = String(req.query.id ?? '').trim();
    if (!id) return fail(res, 400, 'id required');
    if (!getNode(id)) return fail(res, 404, 'unknown taxonomy node');
    const mode = req.query.mode === 'unrelated' ? 'unrelated' : 'related';
    const kinds = parseKinds(req.query.kinds);
    const limit = Math.min(Number(req.query.limit) || 25, MAX_NEIGHBORS);

    const hits = db.vectorNeighbors('taxonomy', id, mode, kinds, limit);
    if (hits === null) {
      // No vector layer or the anchor isn't embedded yet.
      return ok(res, { id, mode, semantic: false, items: [] });
    }
    ok(res, { id, mode, semantic: true, items: enrich(hits) });
  });

  // Free-text semantic search (human twin of /agent/v1/search/semantic).
  // True vector search only when the operator wired KEAP_OLLAMA_URL.
  app.get('/api/search/semantic', async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return fail(res, 400, 'q required');
    const limit = Math.min(Number(req.query.limit) || 20, MAX_NEIGHBORS);
    const kinds = parseKinds(req.query.kinds);
    const vec = await embedText(q);
    if (vec) {
      const hits = db.vectorNeighborsOf(JSON.stringify(vec), 'related', kinds, limit);
      return ok(res, { query: q, semantic: true, items: enrich(hits) });
    }
    const fts = db.searchTaxonomyFts(q, limit);
    const items = fts
      .map((hit) => getNode(hit.id))
      .filter((n): n is NonNullable<ReturnType<typeof getNode>> => Boolean(n))
      .map((n) => ({ kind: 'taxonomy', refId: n.id, name: n.name, nodeId: n.id }));
    ok(res, { query: q, semantic: false, items });
  });
}
