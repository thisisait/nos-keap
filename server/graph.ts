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
import { assetDescriptor } from './asset-types';
import { liveEmbedAvailable } from './embeddings';
import { anchorNodeIds, type ObjectRef } from './objects';
import { hybridSearch } from './search';

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

function enrich(
  hits: db.NeighborHit[],
  viewer?: { userId: string; seeAll: boolean },
): EnrichedHit[] {
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
      if (viewer && !db.canReadCapture(h.refId, viewer.userId, viewer.seeAll)) continue;
      const c = db.getMetadataApi(h.refId);
      if (!c) continue;
      out.push({
        ...h,
        name: c.title,
        description: c.description,
        dataType: inferCaptureType(c.domain, c.url),
        url: c.url ?? undefined,
      });
    } else if (h.kind === 'object') {
      if (viewer && !db.canReadObject(h.refId, viewer.userId, viewer.seeAll)) continue;
      const o = db.getObject(h.refId);
      if (!o) continue;
      const anchors = anchorNodeIds((o.links ?? []) as ObjectRef[]);
      out.push({
        ...h,
        name: o.title,
        description: o.description,
        dataType: o.type,
        url: o.resource ? resolveContentRef(o.resource)?.url ?? undefined : undefined,
        nodeId: anchors[0],
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
  const all: db.EmbeddingKind[] = ['taxonomy', 'capture', 'note', 'object'];
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
  app.get('/api/graph', (req: Request, res: Response) => {
    const curated = db.getTaxonomyMetadata();
    const curatedById = new Map(
      (Array.isArray(curated) ? curated : []).map((c) => [c.id, c.data]),
    );
    // Baked star positions (U1) — the explorer pins taxonomy nodes to these;
    // only semantic stars and nebula dust stay force-simulated.
    const layout = db.getLayout();
    // Semantic-lens derived features (colour/size/texture channels). Empty until
    // keap-features-sync populates node_features — the client just skips the lens.
    const feats = db.getNodeFeatures();
    // Linked-data enrichment (Wikidata QID + entity typing). Empty until the
    // host-side resolve-typing.py job populates node_metadata — client skips it.
    const meta = db.getNodeMetadata();
    const nodes = allNodes().map((n) => {
      const cur = curatedById.get(n.id);
      const ref = cur?.requiredData ?? n.requiredData;
      const resolved = resolveContentRef(ref);
      const p = layout.get(n.id);
      return {
        id: n.id,
        name: n.name,
        kind: n.kind,
        parentId: n.parentId,
        level: nodeLevel(n.id),
        childCount: n.childIds.length,
        hasNote: curatedById.has(n.id),
        dataType: resolved?.type,
        // Resolved content link — the DetailPanel's "open in service" action.
        url: resolved?.url,
        zone: n.zone,
        ext: n.ext ?? false,
        // K1 curated descriptions — en is canonical, cs is the UI locale.
        description: n.description,
        descriptionCs: n.descriptionCs,
        x: p?.x,
        y: p?.y,
        z: p?.z,
        features: feats.get(n.id),
        meta: meta.get(n.id),
      };
    });
    const links = nodes
      .filter((n) => n.parentId)
      .map((n) => ({ source: n.parentId as string, target: n.id }));
    // Nebula layer: the user's knowledge objects hung on their taxonomy
    // anchors ([[node-id]] refs in the card body). ALL objects ship — the
    // orbital view renders only anchored ones (free-floating dust would break
    // spatial memory), but the files-core view needs the unanchored rest too.
    const objects = db
      .getObjects(req.user.id, req.user.isAdmin)
      .map((o) => {
        // A card typed 'file' whose resource is `kiwix:…` is really an
        // encyclopedia — the resolved content type wins over the raw type.
        const contentType = o.resource ? resolveContentRef(o.resource)?.type : undefined;
        const d = assetDescriptor(contentType ?? o.type);
        return {
          id: o.id,
          title: o.title,
          type: o.type,
          assetType: d.assetType,
          form: d.form, // planet | moon | asteroid | comet | station
          glyph: d.glyph,
          hue: d.hue,
          anchors: anchorNodeIds((o.links ?? []) as ObjectRef[]).filter((a) => getNode(a)),
          // Filesystem identity (doctrine tree / fs-sync) — the files-core
          // view folds objects into folder constellations along this path.
          path: typeof o.frontmatter?.path === 'string' ? o.frontmatter.path : undefined,
          // Owner uid — an admin sees every user's objects; without this,
          // two users' "documents/…" trees would merge in the files core.
          owner: o.userId,
        };
      });
    // Concept-relation overlay (imported research graphs, e.g. ToE) — a SEPARATE
    // typed-edge layer, NOT folded into the parent-child `links` skeleton. Typed
    // research edges by default; `?relations=all` adds the generic related-concept.
    const typedOnly = req.query.relations !== 'all';
    const relations = db
      .listConceptRelations(typedOnly)
      .filter((r) => getNode(r.from) && getNode(r.to))
      .map((r) => ({ source: r.from, target: r.to, type: r.type, explored: r.explored }));
    ok(res, {
      nodes,
      links,
      objects,
      relations,
      meta: {
        vectors: db.vectorSearchAvailable(),
        embeddings: db.embeddingStats(),
        liveEmbed: liveEmbedAvailable(),
        layoutVersion: db.getLayoutVersion(),
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
    ok(res, {
      id,
      mode,
      semantic: true,
      items: enrich(hits, { userId: req.user.id, seeAll: req.user.isAdmin }),
    });
  });

  // Free-text hybrid search (human twin of /agent/v1/search/semantic).
  // S4: RRF fusion of BM25 ⊕ vectors (when live embed is wired) ⊕ one-hop
  // graph expansion — one ranked list over the whole corpus.
  app.get('/api/search/semantic', async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return fail(res, 400, 'q required');
    const limit = Math.min(Number(req.query.limit) || 20, MAX_NEIGHBORS);
    const kinds = parseKinds(req.query.kinds);
    const viewer = { userId: req.user.id, seeAll: req.user.isAdmin };
    const { hits, legs } = await hybridSearch(q, kinds, limit, viewer);
    const enriched = enrich(
      hits.map((h) => ({ kind: h.kind, refId: h.refId, distance: 0 })),
      viewer,
    );
    const byKey = new Map(hits.map((h) => [`${h.kind}:${h.refId}`, h]));
    const items = enriched.map(({ distance: _d, ...e }) => ({
      ...e,
      score: byKey.get(`${e.kind}:${e.refId}`)?.score ?? 0,
      legs: byKey.get(`${e.kind}:${e.refId}`)?.legs ?? [],
    }));
    ok(res, { query: q, semantic: legs.vector, legs, items });
  });
}
