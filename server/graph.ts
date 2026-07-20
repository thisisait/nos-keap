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
import { getFsDirStats } from './fs-sync';
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
    // Graph-scope visibility (getVisibleObjects): own + shared, so shared
    // mapped-folder mirrors appear in every user's Explore — /api/objects
    // lists stay owner-scoped. DELIBERATE (spec decision #8): the predicate is
    // visibility='shared', not owner-prefix — a manually shared card was
    // already readable by anyone via direct GET; the graph now lists what was
    // always readable. 'shared' means graph-listed tenant-wide.
    const visibleRows = db.getVisibleObjects(req.user.id, req.user.isAdmin);
    // Persisted topic-mode assignment (object_id → topic_id). Scoping stays
    // free — the join is keyed per visible-object id, so a topic surfaces only
    // through members the viewer can already see (decision #13).
    const topicByObject = db.getTopicAssignments();
    const objects = visibleRows.map((o) => {
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
          // Mapped-folder provenance (fs_mappings id) — the files core groups
          // these under their mapping's hub instead of the owner's tree.
          mapping: typeof o.frontmatter?.mapping === 'string' ? o.frontmatter.mapping : undefined,
          // Topics-mode cluster (id present in `topics[]` below) — undefined for
          // unembedded / minority-model objects, which fall into ~untopiced.
          topic: topicByObject.get(o.id),
          // Recency (unix seconds) for the client's "Recent" lens: fs mirrors
          // carry the file's real mtime (fs-sync frontmatter), hand-made cards
          // fall back to their row's updatedAt. Additive — recolor only.
          mtime: typeof o.frontmatter?.mtime === 'number' ? o.frontmatter.mtime : o.updatedAt,
        };
      });
    // Object→object refs ([[object:<id>]] wiki links) as drawn edges. Bare ids
    // in the payload — the client adds its obj: prefix. Both-endpoints-visible
    // is automatic: sources and the visible set derive from the same
    // getVisibleObjects call, so a private card referenced by a shared one is
    // silently dropped (graph-scope doctrine above).
    const visibleIds = new Set(objects.map((o) => o.id));
    const OBJ_LINK_CAP = 5000;
    const seenObjLinks = new Set<string>();
    const objectLinks: Array<{ source: string; target: string }> = [];
    outer: for (const row of visibleRows) {
      for (const r of (row.links ?? []) as ObjectRef[]) {
        if (r.kind !== 'object' || r.ref === row.id || !visibleIds.has(r.ref)) continue;
        const key = `${row.id}→${r.ref}`;
        if (seenObjLinks.has(key)) continue;
        if (objectLinks.length >= OBJ_LINK_CAP) {
          console.warn(`[graph] objectLinks capped at ${OBJ_LINK_CAP}`);
          break outer;
        }
        seenObjLinks.add(key);
        objectLinks.push({ source: row.id, target: r.ref });
      }
    }
    // Mapped-folder hubs (fs_mappings) — label + placement metadata for the
    // files-core view. Admins get every row; non-admins only shared ones.
    // DISABLED mappings ship too (enabled:false): their retained objects
    // still need placement + labels. Dangling taxonomy anchors (deleted ext
    // nodes) are filtered here; the Admin panel shows them as a warning.
    const fsMappings = db
      .listFsMappings()
      .filter((m) => req.user.isAdmin || m.visibility === 'shared')
      .map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description || undefined,
        nested: m.nestUnderFiles,
        taxonomyRoot: m.taxonomyRoot && getNode(m.taxonomyRoot) ? m.taxonomyRoot : undefined,
        taxonomyLinks: m.taxonomyLinks.filter((l) => getNode(l)),
        tags: m.tags,
        enabled: m.enabled,
        count: db.countObjectsByOwner(`fsmap:${m.id}`),
      }));
    // Concept-relation overlay (imported research graphs, e.g. ToE) — a SEPARATE
    // typed-edge layer, NOT folded into the parent-child `links` skeleton. Typed
    // research edges by default; `?relations=all` adds the generic related-concept.
    const typedOnly = req.query.relations !== 'all';
    const relations = db
      .listConceptRelations(typedOnly)
      .filter((r) => getNode(r.from) && getNode(r.to))
      .map((r) => ({ source: r.from, target: r.to, type: r.type, explored: r.explored }));
    // Track R3 stage 2: typed cross-type relations from the generalized `relations`
    // store (confirmed by default; ?relations=all adds high-confidence proposed).
    // ToE node↔node is EXCLUDED — it already ships via `relations` above with its
    // own palette; this layer is the NEW derived/manual cross-type edges (verb +
    // registry colour). Both-endpoints-visible is load-bearing: object endpoints
    // must be in the viewer's visible set, node endpoints a live taxonomy node —
    // the same doctrine objectLinks enforces, so an edge touching a private card
    // is silently dropped for a viewer who can't see it.
    const relTypeMeta = new Map(db.listRelationTypes().map((rt) => [rt.type, rt] as const));
    const crossVisible = (ref: string, kind: string) =>
      kind === 'object' ? visibleIds.has(ref) : Boolean(getNode(ref));
    const crossRows = db.listRelations({ status: 'confirmed' }).filter((r) => r.source !== 'toe');
    if (!typedOnly) {
      crossRows.push(
        ...db
          .listRelations({ status: 'proposed' })
          .filter((r) => r.source !== 'toe' && (r.confidence ?? 0) >= 0.75),
      );
    }
    const crossRelations = crossRows
      .filter((r) => crossVisible(r.fromRef, r.fromKind) && crossVisible(r.toRef, r.toKind))
      .map((r) => {
        const meta = relTypeMeta.get(r.type);
        return {
          from: r.fromRef,
          fromKind: r.fromKind,
          to: r.toRef,
          toKind: r.toKind,
          type: r.type,
          label: meta?.label ?? r.type,
          color: meta?.color ?? null,
          confidence: r.confidence,
          status: r.status,
        };
      });
    // Repo-flagged directory aggregates (fs walks) — the client textures +
    // sizes repo spheres from these. Scoped like objects: own + shared uids
    // for non-admins, everything for admins, mapping namespaces by the
    // VISIBLE mapping set above.
    const fsDirs = getFsDirStats(req.user.id, req.user.isAdmin, new Set(fsMappings.map((m) => m.id)));
    // Topic hubs (decision #13): per-viewer filter + counts. A topic ships only
    // when the viewer can see ≥1 of its members, and `count` is that VISIBLE
    // member count (from the already-scoped objects above) — a topic whose
    // members are all hidden does not exist in this payload (no existence leak).
    const visTopicCount = new Map<string, number>();
    for (const o of objects) if (o.topic) visTopicCount.set(o.topic, (visTopicCount.get(o.topic) ?? 0) + 1);
    const topics = db
      .listTopicClusters()
      .filter((t) => visTopicCount.has(t.id))
      .map((t) => ({
        id: t.id,
        label: t.label,
        theta: t.theta,
        count: visTopicCount.get(t.id)!,
        terms: t.terms.slice(0, 5),
      }));
    ok(res, {
      nodes,
      links,
      objects,
      objectLinks,
      relations,
      crossRelations,
      fsMappings,
      fsDirs,
      topics,
      meta: {
        vectors: db.vectorSearchAvailable(),
        embeddings: db.embeddingStats(),
        liveEmbed: liveEmbedAvailable(),
        layoutVersion: db.getLayoutVersion(),
        topics: db.topicStats(),
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
