/**
 * /explore — the 2.5D knowledge-space explorer (the cortex made visible).
 *
 * The taxonomy renders as a flat radial constellation map; focusing a node
 * queries the libSQL vector corpus for its semantic neighbourhood and hangs
 * the hits as "stars behind the constellation" — points that are NOT part of
 * the hard-coded tree (captures, curated notes) or distant tree nodes,
 * placed by vector distance. `?root=<nodeId>` slices the whole scene down to
 * one subtree (client-side): nodes outside it, and objects not anchored in
 * it, simply aren't built.
 */
import { useCallback, useMemo, useState, useRef, useLayoutEffect, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Search, Waypoints, PanelRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { apiFetch } from '@/services/api/client';
import GraphCanvas, {
  RECENT_AXIS,
  type CanvasNode,
  type CanvasLink,
} from '@/components/explorer/GraphCanvas';
import DetailPanel, {
  type DrawerTarget,
  type FocusRelation,
} from '@/components/explorer/DetailPanel';
import { useGraph, useNeighbors, type GraphObject } from '@/hooks/useExplorerData';
import { orbitalPosition } from '@/components/explorer/orbital';
import {
  computeCore,
  userRootConstellation,
  type CoreLayout,
  type CoreOrder,
} from '@/components/explorer/core';
import { repoLangs, hash01 } from '@/components/explorer/repoVisuals';

/** The one view control: constellation = core off, the rest are core orders. */
type ViewMode = 'constellation' | 'fs' | 'taxonomy' | 'type';
const VIEWS: ViewMode[] = ['constellation', 'fs', 'taxonomy', 'type'];

/** One hit of /api/search/semantic as the dropdown needs it. */
interface SearchHit {
  kind: string;
  refId: string;
  name: string;
  dataType?: string;
  description?: string;
  url?: string;
  nodeId?: string;
}

export default function Explore() {
  const { t } = useTranslation();
  const { data: graph, isLoading } = useGraph();

  // Addressable view: focus / core order / lens / relations round-trip through
  // the URL query so any explore state is a shareable link. Read ONCE at mount
  // (below, in the state initializers); a single effect writes state → URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialParams = useRef(searchParams).current;

  const [focusId, setFocusId] = useState<string | null>(() => initialParams.get('focus') || null);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const isMobile = useIsMobile();
  const [panelOpen, setPanelOpen] = useState(false);
  // ONE edge layer switch (Vazby): typed cross-relations, the concept overlay
  // AND [[object:…]] wiki refs. `?rel=0` turns them all off; an old `olinks=0`
  // deep link migrates to the same off state.
  const [showLinks, setShowLinks] = useState(
    () => initialParams.get('rel') !== '0' && initialParams.get('olinks') !== '0',
  );
  const [jumpQuery, setJumpQuery] = useState('');
  const [jumpMiss, setJumpMiss] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  // Recency lens — the one lens backed by shipped data (mtime/updatedAt).
  // Old `?lens=<semantic axis>` links fall back to off (node_features is dead).
  const [recent, setRecent] = useState(() => initialParams.get('lens') === RECENT_AXIS);
  // Subtree slice: `?root=04.11` renders only that node's subtree + the
  // objects anchored inside it.
  const [rootId, setRootId] = useState<string | null>(() => initialParams.get('root') || null);
  // View: constellation (core off) or the files core grouped by fs / taxonomy /
  // type. Core-on/fs stays the default (owner decision 2026-07-22: the center
  // IS the home view). Old `?core` links migrate: `0` → constellation,
  // an order → that order (`topic` is gone → fs).
  const [view, setView] = useState<ViewMode>(() => {
    const v = initialParams.get('view');
    if (v && VIEWS.includes(v as ViewMode)) return v as ViewMode;
    const c = initialParams.get('core');
    if (c === '0') return 'constellation';
    if (c === 'taxonomy' || c === 'type') return c;
    return 'fs';
  });
  const coreOn = view !== 'constellation';
  const coreOrder: CoreOrder = coreOn ? view : 'fs';

  // State → URL (replace, so a focus change doesn't spam the back stack). This
  // is the ONLY writer; the initializers above are the only reader, so there's
  // no read/write loop. An empty value drops the param → clean shareable URLs.
  useEffect(() => {
    const p = new URLSearchParams();
    if (focusId) p.set('focus', focusId);
    if (rootId) p.set('root', rootId);
    if (view !== 'fs') p.set('view', view);
    if (recent) p.set('lens', RECENT_AXIS);
    if (!showLinks) p.set('rel', '0');
    setSearchParams(p, { replace: true });
  }, [focusId, rootId, view, recent, showLinks, setSearchParams]);

  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph],
  );

  // Mapped-folder hubs (fs_mappings) — labels, nesting and taxonomy anchors
  // for the files core; disabled mappings ship too (their objects remain).
  const mappingById = useMemo(
    () => new Map((graph?.fsMappings ?? []).map((m) => [m.id, m])),
    [graph],
  );

  // Repo-flagged dir aggregates keyed by core-tree folder path — repo hubs
  // render as language spheres sized by these.
  const dirStatByPath = useMemo(
    () => new Map((graph?.fsDirs ?? []).map((d) => [d.path, d])),
    [graph],
  );

  const objectById = useMemo(
    () => new Map((graph?.objects ?? []).map((o) => [o.id, o])),
    [graph],
  );

  // Focus can land on a synthetic core node (`dir:…`/`obj:…`) — the camera
  // warps there, but the semantic-neighbourhood query is taxonomy-only, so an
  // object focus falls back to its first anchor's star.
  const focusAnchor =
    focusId?.startsWith('obj:') ? objectById.get(focusId.slice(4))?.anchors[0] : undefined;
  const taxonomyFocus =
    focusId && nodeById.has(focusId)
      ? focusId
      : focusAnchor && nodeById.has(focusAnchor)
        ? focusAnchor
        : null;
  const neighbors = useNeighbors(taxonomyFocus);

  // Hue per top-level category — the constellation's colour identity.
  const hueByCategory = useMemo(() => {
    const cats = (graph?.nodes ?? []).filter((n) => n.kind === 'category');
    return new Map(cats.map((c, i) => [c.id, Math.round((i / Math.max(cats.length, 1)) * 360)]));
  }, [graph]);

  const rootOf = useCallback(
    (id: string): string => {
      let cur = nodeById.get(id);
      while (cur?.parentId) cur = nodeById.get(cur.parentId);
      return cur?.id ?? id;
    },
    [nodeById],
  );

  // Facets are derived from the WHOLE corpus, not just the focused node's
  // neighbourhood. Deriving them from the neighbourhood meant the list was empty
  // with no focus — so in the default view there was nothing to filter by at all,
  // while the cards those facets describe were on screen the entire time.
  const availableTypes = useMemo(() => {
    const s = new Set<string>();
    for (const o of graph?.objects ?? []) if (o.type) s.add(o.type);
    for (const i of neighbors.data?.items ?? []) if (i.dataType) s.add(i.dataType);
    return [...s].sort();
  }, [graph, neighbors.data]);

  /** A facet selection is a whitelist; empty means "no filter", not "hide all".
   *  Declared HERE, above the scene memo that calls it — a later const would be
   *  in the temporal dead zone when that memo's callback runs. */
  const passesType = useCallback(
    (dataType: string | undefined) => !typeFilter.size || (!!dataType && typeFilter.has(dataType)),
    [typeFilter],
  );

  const starItems = useMemo(() => {
    const items = neighbors.data?.items ?? [];
    // Facet = object filter; captures/notes carry no dataType and must survive
    // a facet pick (requiring one deleted the whole semantic star field).
    return typeFilter.size
      ? items.filter((i) => !i.dataType || typeFilter.has(i.dataType))
      : items;
  }, [neighbors.data, typeFilter]);

  // Merge the static constellation with the semantic star field.
  const { canvasNodes, canvasLinks, coreLayout } = useMemo(() => {
    if (!graph)
      return {
        canvasNodes: [] as CanvasNode[],
        canvasLinks: [] as CanvasLink[],
        coreLayout: null as CoreLayout | null,
      };
    // Taxonomy stars arrive PINNED to their baked coordinates (fx/fy/fz —
    // the spatial-memory contract); the force engine only places stars/dust.
    // Knowledge scope = subtree size (how much knowledge sits under a node) —
    // drives node SIZE so extent reads at a glance, while LEVEL drives the form.
    const kids = new Map<string, string[]>();
    for (const n of graph.nodes) {
      if (n.parentId) {
        const a = kids.get(n.parentId) ?? [];
        a.push(n.id);
        kids.set(n.parentId, a);
      }
    }
    // Subtree slice (?root=): keep-set walked over the kids map. Nodes outside
    // it, and objects not anchored inside it, are never built — every edge
    // layer below already guards on drawn endpoints, so they need nothing.
    let keep: Set<string> | null = null;
    if (rootId && nodeById.has(rootId)) {
      keep = new Set([rootId]);
      const stack = [rootId];
      while (stack.length) {
        for (const c of kids.get(stack.pop()!) ?? []) {
          if (!keep.has(c)) {
            keep.add(c);
            stack.push(c);
          }
        }
      }
    }
    const sceneTaxonomy = keep ? graph.nodes.filter((n) => keep.has(n.id)) : graph.nodes;
    const sceneObjects = keep
      ? (graph.objects ?? []).filter((o) => o.anchors.some((a) => keep.has(a)))
      : graph.objects ?? [];
    /** Is this taxonomy node in the scene? (nodeById alone lies under a slice.) */
    const nodeIn = (id: string) => (keep ? keep.has(id) : nodeById.has(id));
    // Slice hue: the whole subtree shares one corpus root, so category hue
    // collapses to monochrome — recolour by the slice root's DIRECT children
    // instead, hash-frozen so growing the subtree never re-hues it.
    const hueOf = (id: string): number => {
      if (!keep || !rootId) return hueByCategory.get(rootOf(id)) ?? 210;
      let cur = id;
      while (cur !== rootId && nodeById.get(cur)?.parentId && nodeById.get(cur)!.parentId !== rootId) {
        cur = nodeById.get(cur)!.parentId!;
      }
      return Math.round(hash01(cur) * 360);
    };
    const scopeById = new Map<string, number>();
    const scopeOf = (id: string): number => {
      const cached = scopeById.get(id);
      if (cached !== undefined) return cached;
      let s = 0;
      for (const c of kids.get(id) ?? []) s += 1 + scopeOf(c);
      scopeById.set(id, s);
      return s;
    };
    graph.nodes.forEach((n) => scopeOf(n.id));
    const nodes: CanvasNode[] = sceneTaxonomy.map((n) => ({
      ...n,
      fx: n.x,
      fy: n.y,
      fz: n.z,
      categoryHue: hueOf(n.id),
      scope: scopeById.get(n.id) ?? 0,
    }));
    const links: CanvasLink[] = graph.links
      .filter((l) => nodeIn(l.source) && nodeIn(l.target))
      .map((l) => ({ ...l }));
    const objectNode = (o: GraphObject, level: number, p: [number, number, number]): CanvasNode => ({
      id: `obj:${o.id}`,
      name: o.title,
      kind: 'object',
      level,
      childCount: 0,
      hasNote: false,
      dataType: o.type,
      object: true,
      form: o.form,
      // First taxonomy anchor — the star this body orbits; B2b clusters by it.
      anchor: o.anchors[0],
      glyph: o.glyph,
      // fs relPath — the core view renders file leaves as satellite cubes.
      path: o.path,
      // Recency (file mtime / card updatedAt) — the "Recent" lens gradient.
      mtime: o.mtime,
      // Body colour encodes its DATA TYPE (asset hue), not the constellation.
      categoryHue: o.hue,
      fx: p[0],
      fy: p[1],
      fz: p[2],
    });
    let coreLayout: CoreLayout | null = null;
    if (coreOn) {
      // Files core: EVERY object (anchored or not) relocates to the 3D core at
      // the ring center; taxonomy stars stay pinned, rays tether objects to
      // their anchors across space. See core.ts for the reorder geometries.
      //
      // User-root constellations join the core too: slug roots (the nOS
      // self-model, future domain packs) live on the OUTER user ring in the
      // observer view, but the core is the "everything in the middle"
      // projection — leaving them outside strands their skills/cards' anchors
      // above the ring with a cross-sky ray bundle. Core-only override of the
      // pinned fx (observer spatial memory untouched); `sat` damps the L0
      // nebula halo so a relocated root can't white-out the core.
      for (const n of sceneTaxonomy) {
        if (n.parentId || !/^[a-z][a-z0-9-]*$/.test(n.id)) continue;
        const satPos = userRootConstellation(
          n.id,
          { x: n.x ?? 0, y: n.y ?? 0 },
          (id) => [...(kids.get(id) ?? [])].sort(),
        );
        for (const nd of nodes) {
          const p = satPos.get(nd.id);
          if (p) {
            nd.fx = p[0];
            nd.fy = p[1];
            nd.fz = p[2];
            nd.sat = true;
          }
        }
      }
      const galaxyPosOf = (nodeId: string) => {
        const g = nodeById.get(rootOf(nodeId));
        return g && g.x !== undefined ? { id: g.id, x: g.x, y: g.y!, z: g.z! } : null;
      };
      const layout = computeCore(sceneObjects, coreOrder, {
        unfiledLabel: t('explore.core.unfiled'),
        galaxyOf: (o) => {
          // Mapped objects without body-extracted anchors cluster under their
          // mapping's taxonomy root instead of ~unanchored (taxonomy order).
          const anchor =
            o.anchors[0] ?? (o.mapping ? mappingById.get(o.mapping)?.taxonomyRoot : undefined);
          return anchor ? galaxyPosOf(anchor) : null;
        },
        mappings: graph.fsMappings ?? [],
        galaxyPosOf,
      });
      for (const o of sceneObjects) {
        if (!passesType(o.type)) continue;
        const p = layout.positions.get(`obj:${o.id}`);
        if (p) nodes.push(objectNode(o, 99, p));
      }
      // Folder-hub recency = newest descendant mtime, walked over the layout's
      // own fs edges (dir→dir, dir→obj). Feeds ONLY the "Recent" lens
      // recolour — placement stays byte-identical with the lens off or on.
      const mtimeByObj = new Map<string, number>();
      for (const o of sceneObjects) {
        if (o.mtime !== undefined) mtimeByObj.set(`obj:${o.id}`, o.mtime);
      }
      const childrenByDir = new Map<string, string[]>();
      for (const l of layout.fsLinks) {
        const a = childrenByDir.get(l.source) ?? [];
        a.push(l.target);
        childrenByDir.set(l.source, a);
      }
      const newestMemo = new Map<string, number | undefined>();
      const newestOf = (id: string): number | undefined => {
        if (newestMemo.has(id)) return newestMemo.get(id);
        newestMemo.set(id, undefined); // guard (fs trees are acyclic; cheap)
        let best: number | undefined;
        for (const c of childrenByDir.get(id) ?? []) {
          const m = c.startsWith('obj:') ? mtimeByObj.get(c) : newestOf(c);
          if (m !== undefined && (best === undefined || m > best)) best = m;
        }
        newestMemo.set(id, best);
        return best;
      };
      for (const f of layout.folders) {
        const p = layout.positions.get(f.id);
        if (!p) continue;
        // Repo dirs (server-side `.git` detection) upgrade to language spheres.
        const ds = dirStatByPath.get(f.path);
        nodes.push({
          id: f.id,
          // Only the CENTRAL core root is "Root" — standalone mapping hubs and
          // type hubs are depth 0 too, but carry their own label.
          name: f.depth === 0 && !f.mapping && !f.assetType ? t('explore.core.root') : f.name,
          kind: 'folder',
          level: 98,
          childCount: f.count,
          hasNote: false,
          folder: true,
          mtime: newestOf(f.id),
          ...(ds?.repo ? { repo: true, bytes: ds.bytes, exts: ds.exts } : {}),
          // TYPE hubs take the hue of the bodies they hold (asset-types.ts), so a
          // cluster and its members read as one thing; folder hubs stay slate.
          categoryHue: f.hue ?? 215,
          fx: p[0],
          fy: p[1],
          fz: p[2],
        });
      }
      // Endpoint guard on EVERY core edge: the Data-types facet hides objects
      // AFTER the layout computed its links, and an edge into an undrawn node
      // makes d3's link init throw mid-update — the scene then collapses onto
      // the origin as one giant bloom ball. Only edges whose both endpoints
      // are actually in the scene may ship.
      const drawnCore = new Set(nodes.map((n) => n.id));
      for (const l of layout.fsLinks) {
        if (drawnCore.has(l.source) && drawnCore.has(l.target)) links.push({ ...l, fs: true });
      }
      for (const r of layout.rays) {
        if (drawnCore.has(r.source) && nodeIn(r.target)) links.push({ ...r, ray: true });
      }
      // Mapping-hub tethers (hub → taxonomy root/links); the nodeIn filter
      // drops dangling anchors (deleted ext taxonomy nodes, sliced-out stars).
      for (const r of layout.mrays) {
        if (drawnCore.has(r.source) && nodeIn(r.target)) links.push({ ...r, mray: true });
      }
      coreLayout = layout;
    } else {
      // Orbital layer: anchored knowledge objects orbit their taxonomy star as
      // TYPED bodies (planet/moon/asteroid/comet/station by data type). Positions
      // are PINNED around the star's baked coordinate — not force dust — so
      // dragging the star never scatters them. Grouped by anchor so each body's
      // (index, count) is stable across renders. Only the first anchor is used;
      // remaining anchors stay panel/drawer facts. Unanchored objects render
      // only in the core view — free-floating dust would break spatial memory.
      const byAnchor = new Map<string, GraphObject[]>();
      for (const o of sceneObjects) {
        const anchor = o.anchors[0];
        if (!anchor) continue;
        // Filter BEFORE grouping: orbital slots are assigned by (index, count)
        // within the group, so filtering afterwards would leave gaps and shift
        // every surviving card as facets change.
        if (!passesType(o.type)) continue;
        const g = byAnchor.get(anchor);
        if (g) g.push(o);
        else byAnchor.set(anchor, [o]);
      }
      for (const [anchor, group] of byAnchor) {
        const star = nodeById.get(anchor);
        // nodeIn guard: under a slice an object can be kept via anchors[1]
        // while anchors[0] was sliced out — don't orbit an undrawn star.
        if (!star || star.x === undefined || !nodeIn(anchor)) continue;
        group.forEach((o, i) => {
          const p = orbitalPosition(
            { x: star.x!, y: star.y!, z: star.z! },
            i,
            group.length,
            o.form,
            o.id,
            // Clearance proxy for the star's rendered size — galaxies/constellations
            // (level ≤ 1) are far bigger bodies than a level-2 star, so their
            // orbiters must clear a wider glow. B1: 10 for stars (was a flat 5).
            (star.level ?? 2) <= 1 ? 26 : 10,
          );
          nodes.push(objectNode(o, (star.level ?? 0) + 1, p));
        });
      }
    }
    // Object→object refs + Track R3 typed relations share a drawn-endpoint
    // filter: the orbital branch renders only anchored objects, and a link to an
    // undrawn endpoint would crash force-graph. `resolveRel` maps a (ref,kind)
    // to its drawn node id — obj:<id> for objects, the bare id for taxonomy —
    // or null when that body isn't in the scene.
    const drawnObj = new Set(nodes.filter((n) => n.id.startsWith('obj:')).map((n) => n.id));
    const resolveRel = (ref: string, kind: 'node' | 'object'): string | null =>
      kind === 'object'
        ? drawnObj.has(`obj:${ref}`)
          ? `obj:${ref}`
          : null
        : nodeIn(ref)
          ? ref
          : null;
    const pairKey = (a: string, b: string) => [a, b].sort().join('\u0000');
    // Typed cross-type relations (Vazby) — confirmed (+ high-conf proposed under
    // ?relations=all) edges across every kind pair, coloured from the
    // relation_types registry, verb-labelled at the midpoint, width by
    // confidence. A pair drawn here suppresses its plain [[object:…]] olink below
    // (an untyped ref upgrades to the typed edge — never double-drawn).
    const typedPairs = new Set<string>();
    if (showLinks) {
      for (const r of graph.crossRelations ?? []) {
        const s = resolveRel(r.from, r.fromKind);
        const tg = resolveRel(r.to, r.toKind);
        if (!s || !tg) continue;
        typedPairs.add(pairKey(s, tg));
        links.push({
          source: s,
          target: tg,
          relation: true,
          vazba: true,
          relType: r.type,
          relVerb: r.label,
          relColor: r.color,
          confidence: r.confidence,
        });
      }
    }
    // Object→object ref edges ([[object:<id>]] wiki links) — violet GL lines
    // between drawn bodies, UNLESS a typed relation already draws that pair.
    // A wiki ref asserts "these two cards mention each other", not a typed
    // relation, so it is its OWN layer: the Ontology toggle must not claim it,
    // and it must not draw when the user has asked for no edges.
    if (showLinks && graph.objectLinks?.length) {
      for (const l of graph.objectLinks) {
        const s = `obj:${l.source}`;
        const tg = `obj:${l.target}`;
        if (!drawnObj.has(s) || !drawnObj.has(tg)) continue;
        if (typedPairs.has(pairKey(s, tg))) continue;
        links.push({ source: s, target: tg, olink: true });
      }
    }
    // Concept-relation overlay (imported research graph, e.g. ToE) — typed
    // cross-node edges between taxonomy stars, gated by the toggle. Both
    // endpoints are pinned taxonomy nodes, so these are pure drawn edges.
    if (showLinks) {
      for (const r of graph.relations ?? []) {
        if (nodeIn(r.source) && nodeIn(r.target)) {
          links.push({
            source: r.source,
            target: r.target,
            relation: true,
            relType: r.type,
            explored: r.explored,
          });
        }
      }
    }
    if (focusId) {
      // Focus-halo center: the focused node's coordinates (baked taxonomy
      // star, or a core layout position for dir: hubs).
      const fc = nodeById.get(focusId);
      // Focus centre. Resolving ALL node classes (not just taxonomy) is
      // load-bearing: an object/table/folder focus is NOT in nodeById, so the
      // old lookup returned undefined → the dust below went unpinned → the sim
      // reheated over every node (see the orbit note). Objects/folders carry the
      // pinned fx we just built; core hubs come from the layout map.
      const builtFocus = nodes.find((n) => n.id === focusId);
      // Built node FIRST: in the core view a relocated user-root star carries
      // its core fx, while nodeById still holds the baked outer-ring position
      // — preferring the latter parked the halo (and its tethers) across the
      // sky from the node the camera just flew to.
      const fp: [number, number, number] | undefined =
        builtFocus?.fx != null
          ? [builtFocus.fx, builtFocus.fy!, builtFocus.fz!]
          : fc && fc.x !== undefined
            ? [fc.x, fc.y!, fc.z!]
            : coreLayout?.positions.get(focusId);
      let dustIdx = 0;
      for (const item of starItems) {
        if (item.kind === 'taxonomy' && item.nodeId && nodeIn(item.nodeId)) {
          // Tree member: no new node, just the dashed semantic edge.
          links.push({ source: focusId, target: item.nodeId, semantic: true, distance: item.distance });
        } else {
          const id = `star:${item.kind}:${item.refId}`;
          // Deterministic ORBIT around the focus, not force dust: the d3
          // engine spawned these at the ring center and the pinned-star
          // charge field shot them out of view. Radius = semantic distance
          // (closer hit = tighter orbit), golden-angle spread, hash tilt;
          // GraphCanvas animates the very slow revolution + tether lines.
          const r = 24 + Math.min(item.distance ?? 0.8, 1.4) * 70;
          const phase = dustIdx * 2.399963 + hash01(id) * 0.6;
          const tilt = (hash01(`${id}:t`) - 0.5) * 1.1;
          const speed = (0.03 + hash01(`${id}:w`) * 0.03) * (hash01(`${id}:d`) < 0.5 ? 1 : -1);
          dustIdx++;
          // ALWAYS pin the dust — never leave a node force-free. A single
          // unpinned node flips hasUnpinnedNode, which reheats the d3 sim over
          // EVERY node; d3's charge then rebuilds a Barnes-Hut octree across all
          // 20k+ bodies each tick (pinned strengths are 0 but still in the tree)
          // → a multi-second freeze on focus and ~0.1 FPS at scale. Fall back to
          // the origin if the focus centre is somehow unknown — orbiting the
          // origin beats freezing the whole app.
          const c = fp ?? [0, 0, 0];
          const orbit = { cx: c[0], cy: c[1], cz: c[2], r, phase, tilt, speed };
          nodes.push({
            id,
            name: item.name,
            kind: item.kind,
            level: 99,
            childCount: 0,
            hasNote: false,
            dataType: item.dataType,
            star: true,
            distance: item.distance,
            categoryHue: 45,
            orbit,
            // Pinned at the orbit's t=0 point; the GraphCanvas animator revolves
            // it and draws its own tether, so nothing is ever force-free.
            fx: orbit.cx + r * Math.cos(phase),
            fy: orbit.cy + r * Math.sin(phase) * Math.sin(tilt),
            fz: orbit.cz + r * Math.sin(phase) * Math.cos(tilt),
          });
        }
      }
    }
    return { canvasNodes: nodes, canvasLinks: links, coreLayout };
  }, [graph, focusId, starItems, hueByCategory, nodeById, showLinks, passesType, coreOn, coreOrder, rootId, t, dirStatByPath, mappingById, rootOf]);

  const openTarget = (id: string) => {
    // (No `topic:` branch — the topic core order was culled; topic hubs are
    // never built, so the id can't occur.)
    if (id.startsWith('dir:')) {
      // Core folder hub: warp the camera AND open a light folder panel —
      // name, mapping popisek, direct contents. Without it a click on the
      // (possibly empty) root hub reads as a dead click.
      const f = coreLayout?.folders.find((x) => x.id === id);
      if (f) {
        const folderById = new Map(coreLayout!.folders.map((x) => [x.id, x]));
        const children = coreLayout!.fsLinks
          .filter((l) => l.source === id)
          .map((l) => {
            if (l.target.startsWith('obj:')) {
              const o = (graph?.objects ?? []).find((x) => `obj:${x.id}` === l.target);
              return o ? { id: l.target, name: o.title, dataType: o.type } : null;
            }
            const cf = folderById.get(l.target);
            return cf ? { id: cf.id, name: cf.name, folder: true, count: cf.count } : null;
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);
        const mapping = f.mapping ? mappingById.get(f.mapping) : undefined;
        const ds = dirStatByPath.get(f.path);
        setDrawer({
          id,
          name: f.depth === 0 && !f.mapping ? t('explore.core.root') : f.name,
          kind: 'folder',
          description: mapping?.description,
          isStar: false,
          path: f.path.startsWith('@') ? undefined : f.path,
          children,
          ...(ds?.repo ? { repo: true, bytes: ds.bytes, langs: repoLangs(ds.exts) } : {}),
        });
      }
      setFocusId(null);
      requestAnimationFrame(() => setFocusId(id));
      return;
    }
    if (id.startsWith('obj:')) {
      const o = (graph?.objects ?? []).find((x) => `obj:${x.id}` === id);
      if (o) {
        setDrawer({
          id,
          name: o.title,
          kind: 'object',
          dataType: o.type,
          isStar: true,
          // Focus targets the OBJECT itself (its cube in the core, its orbital
          // body otherwise) — NOT its taxonomy anchor. Anchoring focus to
          // anchors[0] flew the camera out of the core to the anchor star's
          // ring position (e.g. "Computer Science") on a cube's Focus click.
          nodeId: id,
        });
      }
      return;
    }
    if (id.startsWith('star:')) {
      const [, kind, ...ref] = id.split(':');
      const item = (neighbors.data?.items ?? []).find(
        (i) => i.kind === kind && i.refId === ref.join(':'),
      );
      if (item) {
        setDrawer({
          id,
          name: item.name,
          kind: item.kind,
          dataType: item.dataType,
          description: item.description,
          url: item.url,
          isStar: true,
          nodeId: item.nodeId,
        });
      }
      return;
    }
    const n = nodeById.get(id);
    if (!n) return;
    setDrawer({
      id,
      name: n.name,
      kind: n.kind,
      dataType: n.dataType,
      // K1 description arrives via DetailPanel's per-node fetch, not the drawer.
      isStar: false,
    });
    setFocusId(id);
  };

  /** Null-then-set so re-focusing the same id still fires the camera warp. */
  const warpTo = (id: string) => {
    setFocusId(null);
    requestAnimationFrame(() => setFocusId(id));
  };

  // ── Search: debounced top-5 dropdown over /api/search/semantic. A click
  // routes through openTarget, so an object hit selects THE OBJECT (drawer +
  // focus), not its parent anchor — and unanchored objects are reachable.
  useEffect(() => {
    const q = jumpQuery.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const tmr = setTimeout(async () => {
      try {
        const res = await apiFetch<{ items: SearchHit[] }>(
          `/api/search/semantic?q=${encodeURIComponent(q)}&limit=5`,
        );
        setHits(res.items);
      } catch {
        setHits([]);
      }
    }, 250);
    return () => clearTimeout(tmr);
  }, [jumpQuery]);

  /** "parent" column of a dropdown row: taxonomy parent / object anchor star. */
  const hitParentName = (h: SearchHit): string | undefined => {
    if (h.kind === 'taxonomy') {
      const p = nodeById.get(h.refId)?.parentId;
      return p ? nodeById.get(p)?.name : undefined;
    }
    const anchor = h.kind === 'object' ? objectById.get(h.refId)?.anchors[0] : h.nodeId;
    return anchor ? nodeById.get(anchor)?.name : undefined;
  };

  const pickHit = (h: SearchHit) => {
    setHits(null);
    setJumpMiss(false);
    if (h.kind === 'taxonomy' && nodeById.has(h.refId)) {
      openTarget(h.refId);
      warpTo(h.refId);
      return;
    }
    if (h.kind === 'object' && objectById.has(h.refId)) {
      openTarget(`obj:${h.refId}`);
      warpTo(`obj:${h.refId}`);
      return;
    }
    // Capture/note (or an object outside the payload): drawer from the hit
    // itself, warp to its anchor star when it has one.
    setDrawer({
      id: `star:${h.kind}:${h.refId}`,
      name: h.name,
      kind: h.kind,
      dataType: h.dataType,
      description: h.description,
      url: h.url,
      isStar: true,
      nodeId: h.nodeId,
    });
    if (h.nodeId && nodeById.has(h.nodeId)) warpTo(h.nodeId);
  };

  /** Enter = first hit; fetches synchronously when the debounce hasn't fired. */
  const jumpToFirst = async () => {
    const q = jumpQuery.trim();
    if (!q) return;
    if (hits?.length) {
      pickHit(hits[0]);
      return;
    }
    try {
      const res = await apiFetch<{ items: SearchHit[] }>(
        `/api/search/semantic?q=${encodeURIComponent(q)}&limit=5`,
      );
      if (res.items.length) pickHit(res.items[0]);
      else setJumpMiss(true);
    } catch {
      setJumpMiss(true);
    }
  };

  // Canvas size tracks its container (the graph libs need explicit px).
  const canvasRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Typed relations touching the PANEL TARGET, in EITHER direction, resolved
  // to display names. Unlike the drawn edges this is not filtered to bodies in
  // the scene: the rail is a reading surface, and a relation to something
  // currently off-screen is exactly what the user came here to discover.
  const targetId = drawer?.id ?? null;
  const targetRelations = useMemo<FocusRelation[]>(() => {
    if (!targetId || !graph?.crossRelations) return [];
    // The target can be a taxonomy node OR an object (`obj:` id) — relations
    // match on the bare ref + the right kind.
    const bare = targetId.startsWith('obj:') ? targetId.slice(4) : targetId;
    const focusKind: 'node' | 'object' = targetId.startsWith('obj:') ? 'object' : 'node';
    const nameOf = (ref: string, kind: 'node' | 'object') =>
      kind === 'node' ? nodeById.get(ref)?.name ?? ref : objectById.get(ref)?.title ?? ref;
    const out: FocusRelation[] = [];
    for (const r of graph.crossRelations) {
      const isFrom = r.fromKind === focusKind && r.from === bare;
      const isTo = r.toKind === focusKind && r.to === bare;
      if (!isFrom && !isTo) continue;
      out.push({
        type: r.type,
        label: r.label || r.type,
        color: r.color ?? undefined,
        confidence: r.confidence ?? undefined,
        direction: isFrom ? 'out' : 'in',
        otherRef: isFrom ? r.to : r.from,
        otherKind: isFrom ? r.toKind : r.fromKind,
        otherName: isFrom ? nameOf(r.to, r.toKind) : nameOf(r.from, r.fromKind),
      });
    }
    return out;
  }, [targetId, graph, nodeById, objectById]);

  // The ONE rail content — rendered as the desktop right rail or inside the
  // mobile Sheet (never both).
  const detailEl = (
    <DetailPanel
      target={drawer}
      nodeById={nodeById}
      objects={graph?.objects ?? []}
      objectLinks={graph?.objectLinks ?? []}
      relations={targetRelations}
      // Both kinds route through openTarget: it does drawer + focus + warp
      // consistently, so chasing a relation never dead-ends the rail.
      onRelationClick={(r) => openTarget(r.otherKind === 'node' ? r.otherRef : `obj:${r.otherRef}`)}
      onClose={() => setDrawer(null)}
      onFocus={(id) => warpTo(id)}
      onSelect={openTarget}
      onSliceRoot={(id) => setRootId(id)}
    />
  );

  // Mobile: picking anything opens the Sheet — the tap needs feedback.
  useEffect(() => {
    if (isMobile && drawer) setPanelOpen(true);
  }, [isMobile, drawer]);

  // Slice breadcrumb chip content — the root's full ancestry path.
  const slicePath = useMemo(() => {
    if (!rootId) return null;
    const parts: string[] = [];
    let cur = nodeById.get(rootId);
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    }
    return parts.length ? parts.join(' › ') : rootId;
  }, [rootId, nodeById]);

  return (
    <div className="flex h-screen flex-col bg-[hsl(222,45%,7%)] text-foreground dark">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 sm:gap-3 sm:px-4">
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link to="/">
            <ArrowLeft className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">{t('common.back')}</span>
          </Link>
        </Button>
        <h1 className="shrink-0 text-sm font-semibold">{t('explore.title')}</h1>
        {rootId && (
          <span
            className="flex max-w-56 shrink-0 items-center gap-1.5 rounded-full border border-teal-400/40 bg-teal-400/10 px-2 py-0.5 text-xs text-teal-200"
            data-testid="explore-slice-chip"
          >
            <span className="truncate" title={slicePath ?? undefined}>
              {slicePath}
            </span>
            <button
              className="shrink-0 hover:text-white"
              aria-label={t('common.close')}
              onClick={() => setRootId(null)}
            >
              ✕
            </button>
          </span>
        )}
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={jumpQuery}
              onChange={(e) => {
                setJumpQuery(e.target.value);
                setJumpMiss(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && jumpToFirst()}
              onBlur={() => setHits(null)}
              placeholder={t('explore.jump.placeholder')}
              className={`h-8 w-full pl-7 text-xs sm:w-56 ${jumpMiss ? 'border-destructive' : ''}`}
              aria-label={t('explore.jump.placeholder')}
            />
            {hits && hits.length > 0 && (
              <ul
                className="absolute left-0 right-0 top-9 z-30 overflow-hidden rounded-md border border-white/10 bg-slate-950/95 shadow-xl"
                data-testid="explore-search-results"
              >
                {hits.map((h) => (
                  <li key={`${h.kind}:${h.refId}`}>
                    {/* onMouseDown beats the input's onBlur (which closes us). */}
                    <button
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-slate-800"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickHit(h);
                      }}
                    >
                      <span className="truncate">{h.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {h.dataType ?? h.kind}
                        {hitParentName(h) ? ` · ${hitParentName(h)}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div
            className="flex shrink-0 overflow-hidden rounded-md border border-white/10"
            data-testid="explore-view-control"
          >
            {VIEWS.map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-2 py-1 text-xs ${
                  view === v
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted/60'
                }`}
              >
                {t(`explore.view.${v}`)}
              </button>
            ))}
          </div>
          <Button
            variant={showLinks ? 'default' : 'outline'}
            size="sm"
            className="h-8 shrink-0 gap-1.5 text-xs"
            onClick={() => setShowLinks((v) => !v)}
            data-testid="explore-links-toggle"
            title={t('explore.toggle.linksHint')}
          >
            <Waypoints className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('explore.toggle.links')}</span>
          </Button>
          {/* Facet chips — the object-type whitelist filters the SCENE. */}
          {availableTypes.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-1">
              {availableTypes.map((dt) => (
                <Badge
                  key={dt}
                  variant={typeFilter.size === 0 || typeFilter.has(dt) ? 'default' : 'outline'}
                  className="cursor-pointer text-[10px]"
                  onClick={() =>
                    setTypeFilter((prev) => {
                      const next = new Set(prev);
                      if (next.has(dt)) next.delete(dt);
                      else next.add(dt);
                      return next;
                    })
                  }
                >
                  {dt}
                </Badge>
              ))}
            </div>
          )}
          <Button
            variant={recent ? 'default' : 'outline'}
            size="sm"
            className="h-8 shrink-0 text-xs"
            onClick={() => setRecent((v) => !v)}
            title={t('explore.lens.recentTitle')}
          >
            {t('explore.lens.recent')}
          </Button>
          {isMobile && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              data-testid="explore-panel-toggle"
              onClick={() => setPanelOpen(true)}
              aria-label={t('explore.panel.title')}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Link counts are exposed for e2e: the scene itself is WebGL, so without
            a seam a layer toggle can only be asserted through the URL — which is
            exactly how a stale useMemo dependency once shipped, changing the URL
            while the geometry never recomputed. */}
        <div
          ref={canvasRef}
          className="relative min-w-0 flex-1"
          data-testid="explore-canvas"
          data-link-count={canvasLinks.length}
          data-olink-count={canvasLinks.filter((l) => l.olink).length}
          data-vazba-count={canvasLinks.filter((l) => l.vazba).length}
          data-object-count={canvasNodes.filter((n) => n.object).length}
        >
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('common.loading')}
            </div>
          ) : (
            <GraphCanvas
              nodes={canvasNodes}
              links={canvasLinks}
              focusId={focusId}
              onNodeClick={openTarget}
              width={size.w}
              height={size.h}
              lens={recent ? { axis: RECENT_AXIS } : undefined}
              coreView={coreOn}
            />
          )}
          {!isLoading && recent && (
            <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center gap-1.5 rounded-lg border border-slate-500/25 bg-slate-950/85 px-2 py-1.5 text-xs text-slate-300">
              <span className="flex items-center gap-1" data-testid="recent-legend">
                <span className="opacity-60">{t('explore.lens.recentHot')}</span>
                <span
                  className="h-2 w-14 rounded-full"
                  style={{ background: 'linear-gradient(to right, hsl(18 85% 60%), hsl(218 50% 60%))' }}
                />
                <span className="opacity-60">{t('explore.lens.recentCold')}</span>
              </span>
            </div>
          )}
        </div>
        {isMobile ? (
          <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
            <SheetContent side="right" className="w-[85vw] max-w-sm overflow-y-auto p-0">
              <SheetTitle className="sr-only">{t('explore.panel.title')}</SheetTitle>
              {detailEl}
            </SheetContent>
          </Sheet>
        ) : (
          <aside className="w-80 shrink-0 border-l">{detailEl}</aside>
        )}
      </div>

    </div>
  );
}
