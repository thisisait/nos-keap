/**
 * /explore — the 2.5D knowledge-space explorer (the cortex made visible).
 *
 * The taxonomy renders as a flat radial constellation map; focusing a node
 * queries the libSQL vector corpus for its semantic neighbourhood and hangs
 * the hits as "stars behind the constellation" — points that are NOT part of
 * the hard-coded tree (captures, curated notes) or distant tree nodes,
 * placed by vector distance. The side panel picks the relation mode
 * (related / most-unrelated), source kinds, and dataType facets. One toggle
 * lifts the same graph into full 3D.
 */
import { useCallback, useMemo, useState, useRef, useLayoutEffect, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Rocket, Orbit, Search, Waypoints, Boxes, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/services/api/client';
import GraphCanvas, {
  RECENT_AXIS,
  type CanvasNode,
  type CanvasLink,
  type CameraMode,
  type LensState,
} from '@/components/explorer/GraphCanvas';

// Semantic-lens axes the user can colour the map by (must match node_features).
// The "Recent" lens (RECENT_AXIS) is a special case OUTSIDE this list: it
// reads mtime, not node_features, recolours objects/folder hubs instead of
// taxonomy stars, and carries its own i18n label + gradient legend.
const LENS_AXES = [
  { key: 'abstractness', label: 'Abstract ↔ Concrete' },
  { key: 'scale', label: 'Macro ↔ Micro' },
  { key: 'formalness', label: 'Formal ↔ Empirical' },
  { key: 'dynamism', label: 'Dynamic ↔ Static' },
] as const;
import SidePanel from '@/components/explorer/SidePanel';
import DetailPanel, { type DrawerTarget } from '@/components/explorer/DetailPanel';
import {
  useGraph,
  useNeighbors,
  type NeighborItem,
  type NeighborMode,
  type GraphObject,
} from '@/hooks/useExplorerData';
import { orbitalPosition } from '@/components/explorer/orbital';
import { computeCore, type CoreLayout, type CoreOrder } from '@/components/explorer/core';
import { repoLangs, hash01 } from '@/components/explorer/repoVisuals';

export default function Explore() {
  const { t, i18n } = useTranslation();
  const { data: graph, isLoading } = useGraph();

  // Addressable view: focus / core order / lens / relations round-trip through
  // the URL query so any explore state is a shareable link. Read ONCE at mount
  // (below, in the state initializers); a single effect writes state → URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialParams = useRef(searchParams).current;

  const [focusId, setFocusId] = useState<string | null>(() => initialParams.get('focus') || null);
  const [mode, setMode] = useState<NeighborMode>('related');
  const [kinds, setKinds] = useState<string[]>(['taxonomy', 'capture', 'note', 'object']);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>('observer');
  const [showRelations, setShowRelations] = useState(() => initialParams.get('rel') !== '0');
  // Detail mode: 'full' forces every orbital body in full form (no instancing /
  // apparent-size hiding) for small fields; 'auto' lets the perf LODs engage.
  const [detail, setDetail] = useState<'auto' | 'full'>(() =>
    initialParams.get('detail') === 'full' ? 'full' : 'auto',
  );
  const [jumpQuery, setJumpQuery] = useState('');
  const [jumpMiss, setJumpMiss] = useState(false);
  const [shipHud, setShipHud] = useState({ speed: 0, boosting: false, thrust: 0 });
  const [lens, setLens] = useState<LensState>(() => {
    const axis = initialParams.get('lens');
    return axis ? { axis } : {};
  });
  // Files core: objects leave their orbital slots and form a 3D core at the
  // ring center, reordered by filesystem / taxonomy / (later) topic.
  const [core, setCore] = useState<{ on: boolean; order: CoreOrder }>(() => {
    const c = initialParams.get('core');
    const orders: CoreOrder[] = ['fs', 'taxonomy', 'topic'];
    return c && orders.includes(c as CoreOrder)
      ? { on: true, order: c as CoreOrder }
      : { on: false, order: 'fs' };
  });

  // State → URL (replace, so a focus change doesn't spam the back stack). This
  // is the ONLY writer; the initializers above are the only reader, so there's
  // no read/write loop. An empty value drops the param → clean shareable URLs.
  useEffect(() => {
    const p = new URLSearchParams();
    if (focusId) p.set('focus', focusId);
    if (core.on) p.set('core', core.order);
    if (lens.axis) p.set('lens', lens.axis);
    if (!showRelations) p.set('rel', '0');
    if (detail === 'full') p.set('detail', 'full');
    setSearchParams(p, { replace: true });
  }, [focusId, core.on, core.order, lens.axis, showRelations, detail, setSearchParams]);

  // Semantic hyperspace jump: hybrid search → plot course to the best hit's
  // star (objects/captures resolve to their anchor node). Focus does the
  // actual warp (GraphCanvas flies the camera on focus change).
  const hyperspaceJump = async () => {
    const q = jumpQuery.trim();
    if (!q) return;
    try {
      const res = await apiFetch<{ items: Array<{ kind: string; refId: string; nodeId?: string }> }>(
        `/api/search/semantic?q=${encodeURIComponent(q)}&limit=5`,
      );
      const target = res.items.find((i) => i.nodeId || i.kind === 'taxonomy');
      const nodeId = target?.nodeId ?? (target?.kind === 'taxonomy' ? target.refId : null);
      if (nodeId) {
        setJumpMiss(false);
        setFocusId(null); // re-trigger the warp even when jumping to the same star
        requestAnimationFrame(() => setFocusId(nodeId));
      } else {
        setJumpMiss(true);
      }
    } catch {
      setJumpMiss(true);
    }
  };

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

  // Topic order is available only once the server ships clusters; when it is
  // not, the Topics button is disabled AND the effective order falls back to
  // fs — topics can vanish on a payload refresh, and a silent wrong order
  // (topic → fs render) is exactly the hazard the branch guards against.
  const topicsReady = (graph?.topics?.length ?? 0) > 0;
  const effectiveOrder: CoreOrder = core.order === 'topic' && !topicsReady ? 'fs' : core.order;
  // Coverage caption (topic order): how many visible objects landed in a
  // cluster this viewer can see — the rest hold the ~untopiced center fog.
  const topicCoverage = useMemo(() => {
    const objs = graph?.objects ?? [];
    const known = new Set((graph?.topics ?? []).map((tp) => tp.id));
    const assigned = objs.reduce((n, o) => n + (o.topic && known.has(o.topic) ? 1 : 0), 0);
    return { assigned, total: objs.length };
  }, [graph]);

  // Focus can land on a synthetic core node (`dir:…`) — the camera warps
  // there, but the semantic-neighbourhood query is taxonomy-only.
  const taxonomyFocus = focusId && nodeById.has(focusId) ? focusId : null;
  const neighbors = useNeighbors(taxonomyFocus, mode, kinds);

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

  const starItems = useMemo(() => {
    const items = neighbors.data?.items ?? [];
    return typeFilter.size ? items.filter((i) => i.dataType && typeFilter.has(i.dataType)) : items;
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
    const nodes: CanvasNode[] = graph.nodes.map((n) => ({
      ...n,
      fx: n.x,
      fy: n.y,
      fz: n.z,
      categoryHue: hueByCategory.get(rootOf(n.id)) ?? 210,
      scope: scopeById.get(n.id) ?? 0,
    }));
    const links: CanvasLink[] = graph.links.map((l) => ({ ...l }));
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
    if (core.on) {
      // Files core: EVERY object (anchored or not) relocates to the 3D core at
      // the ring center; taxonomy stars stay pinned, rays tether objects to
      // their anchors across space. See core.ts for the reorder geometries.
      const galaxyPosOf = (nodeId: string) => {
        const g = nodeById.get(rootOf(nodeId));
        return g && g.x !== undefined ? { id: g.id, x: g.x, y: g.y!, z: g.z! } : null;
      };
      const layout = computeCore(graph.objects ?? [], effectiveOrder, {
        unfiledLabel: t('explore.core.unfiled'),
        untopicedLabel: t('explore.core.untopiced'),
        topics: graph.topics ?? [],
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
      for (const o of graph.objects ?? []) {
        const p = layout.positions.get(`obj:${o.id}`);
        if (p) nodes.push(objectNode(o, 99, p));
      }
      // Folder-hub recency = newest descendant mtime, walked over the layout's
      // own fs edges (dir→dir, dir→obj). Feeds ONLY the "Recent" lens
      // recolour — placement stays byte-identical with the lens off or on.
      const mtimeByObj = new Map<string, number>();
      for (const o of graph.objects ?? []) {
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
          // topic hubs are depth 0 too, but carry their own label (without the
          // `!f.topic` guard every topic hub would be renamed "Files").
          name: f.depth === 0 && !f.mapping && !f.topic ? t('explore.core.root') : f.name,
          kind: 'folder',
          level: 98,
          childCount: f.count,
          hasNote: false,
          folder: true,
          mtime: newestOf(f.id),
          ...(ds?.repo ? { repo: true, bytes: ds.bytes, exts: ds.exts } : {}),
          // Topic hubs render violet (semantic space); folder hubs stay blue.
          categoryHue: f.topic ? 265 : 215,
          fx: p[0],
          fy: p[1],
          fz: p[2],
        });
      }
      for (const l of layout.fsLinks) links.push({ ...l, fs: true });
      for (const r of layout.rays) {
        if (nodeById.has(r.target)) links.push({ ...r, ray: true });
      }
      // Mapping-hub tethers (hub → taxonomy root/links); the nodeById filter
      // drops dangling anchors (deleted ext taxonomy nodes) silently.
      for (const r of layout.mrays) {
        if (nodeById.has(r.target)) links.push({ ...r, mray: true });
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
      for (const o of graph.objects ?? []) {
        const anchor = o.anchors[0];
        if (!anchor) continue;
        const g = byAnchor.get(anchor);
        if (g) g.push(o);
        else byAnchor.set(anchor, [o]);
      }
      for (const [anchor, group] of byAnchor) {
        const star = nodeById.get(anchor);
        if (!star || star.x === undefined) continue;
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
        : nodeById.has(ref)
          ? ref
          : null;
    const pairKey = (a: string, b: string) => [a, b].sort().join(' ');
    // Typed cross-type relations (Vazby) — confirmed (+ high-conf proposed under
    // ?relations=all) edges across every kind pair, coloured from the
    // relation_types registry, verb-labelled at the midpoint, width by
    // confidence. A pair drawn here suppresses its plain [[object:…]] olink below
    // (an untyped ref upgrades to the typed edge — never double-drawn).
    const typedPairs = new Set<string>();
    if (showRelations) {
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
    if (graph.objectLinks?.length) {
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
    if (showRelations) {
      for (const r of graph.relations ?? []) {
        if (nodeById.has(r.source) && nodeById.has(r.target)) {
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
      const fp: [number, number, number] | undefined =
        fc && fc.x !== undefined
          ? [fc.x, fc.y!, fc.z!]
          : builtFocus?.fx != null
            ? [builtFocus.fx, builtFocus.fy!, builtFocus.fz!]
            : coreLayout?.positions.get(focusId);
      let dustIdx = 0;
      for (const item of starItems) {
        if (item.kind === 'taxonomy' && item.nodeId && nodeById.has(item.nodeId)) {
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
  }, [graph, focusId, starItems, hueByCategory, nodeById, showRelations, core, effectiveOrder, t, dirStatByPath, mappingById, rootOf]);

  const availableTypes = useMemo(
    () => [...new Set((neighbors.data?.items ?? []).map((i) => i.dataType).filter(Boolean))] as string[],
    [neighbors.data],
  );

  const openTarget = (id: string) => {
    if (id.startsWith('topic:')) {
      // Topic hub: warp the camera AND open a panel with the cluster label,
      // its members (the hub→obj spokes), and the c-TF-IDF term chips.
      const topic = (graph?.topics ?? []).find((x) => `topic:${x.id}` === id);
      if (topic) {
        const children = (coreLayout?.fsLinks ?? [])
          .filter((l) => l.source === id)
          .map((l) => {
            const o = (graph?.objects ?? []).find((x) => `obj:${x.id}` === l.target);
            return o ? { id: l.target, name: o.title, dataType: o.type } : null;
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);
        setDrawer({
          id,
          name: topic.label,
          kind: 'folder',
          isStar: false,
          children,
          terms: topic.terms,
        });
      }
      setFocusId(null);
      requestAnimationFrame(() => setFocusId(id));
      return;
    }
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
          distance: item.distance,
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
      // K1: prefer the cs localization when the UI runs Czech.
      description: (i18n.language?.startsWith('cs') && n.descriptionCs) || n.description,
      isStar: false,
    });
    setFocusId(id);
  };

  const onPanelItem = (item: NeighborItem) => {
    setDrawer({
      id: item.nodeId ?? `star:${item.kind}:${item.refId}`,
      name: item.name,
      kind: item.kind,
      dataType: item.dataType,
      description: item.description,
      url: item.url,
      distance: item.distance,
      isStar: item.kind !== 'taxonomy',
      nodeId: item.nodeId,
    });
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

  return (
    <div className="flex h-screen flex-col bg-[hsl(222,45%,7%)] text-foreground dark">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t('common.back')}
          </Link>
        </Button>
        <h1 className="text-sm font-semibold">{t('explore.title')}</h1>
        <span className="text-xs text-muted-foreground">
          {graph
            ? t('explore.stats', {
                nodes: graph.nodes.length,
                embedded: graph.meta.embeddings.total,
              })
            : '…'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={jumpQuery}
              onChange={(e) => {
                setJumpQuery(e.target.value);
                setJumpMiss(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && hyperspaceJump()}
              placeholder={t('explore.jump.placeholder')}
              className={`h-8 w-56 pl-7 text-xs ${jumpMiss ? 'border-destructive' : ''}`}
              aria-label={t('explore.jump.placeholder')}
            />
          </div>
          <Button
            variant={cameraMode === 'ship' ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setCameraMode((m) => (m === 'ship' ? 'observer' : 'ship'))}
          >
            {cameraMode === 'ship' ? <Orbit className="h-3.5 w-3.5" /> : <Rocket className="h-3.5 w-3.5" />}
            {t(cameraMode === 'ship' ? 'explore.camera.observer' : 'explore.camera.ship')}
          </Button>
          <Button
            variant={showRelations ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setShowRelations((v) => !v)}
            title="Toggle typed concept-relation edges (research web)"
          >
            <Waypoints className="h-3.5 w-3.5" />
            Vazby
          </Button>
          <Button
            variant={core.on ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setCore((c) => ({ ...c, on: !c.on }))}
            title={t('explore.core.tooltip')}
          >
            <Boxes className="h-3.5 w-3.5" />
            {t('explore.core.toggle')}
          </Button>
          <Button
            variant={detail === 'full' ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setDetail((d) => (d === 'full' ? 'auto' : 'full'))}
            title="Detail: Auto lets performance LODs engage at scale; Full shows every body in full form"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {detail === 'full' ? 'Full' : 'Auto'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div ref={canvasRef} className="relative min-w-0 flex-1">
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
              mode={cameraMode}
              onShipUpdate={setShipHud}
              lens={lens}
              coreView={core.on}
              detail={detail}
            />
          )}
          {!isLoading && core.on && (
            <div className="absolute bottom-14 left-3 z-10 flex items-center gap-1.5 rounded-lg border border-slate-500/25 bg-slate-950/85 px-2 py-1.5 text-xs text-slate-300">
              <span className="opacity-60">{t('explore.core.toggle')}</span>
              {(['fs', 'taxonomy', 'topic'] as const).map((o) => (
                <button
                  key={o}
                  disabled={o === 'topic' && !topicsReady}
                  title={o === 'topic' && !topicsReady ? t('explore.core.topicUnavailable') : undefined}
                  className={`rounded px-1.5 py-0.5 ${
                    core.order === o
                      ? 'bg-teal-400 text-slate-900'
                      : o === 'topic' && !topicsReady
                        ? 'cursor-not-allowed opacity-40'
                        : 'hover:bg-slate-700/60'
                  }`}
                  onClick={() => setCore((c) => ({ ...c, order: o }))}
                >
                  {t(`explore.core.order.${o}`)}
                </button>
              ))}
              {effectiveOrder === 'topic' && topicCoverage.assigned < topicCoverage.total && (
                <span className="ml-1 opacity-60">
                  {t('explore.core.topicCoverage', {
                    assigned: topicCoverage.assigned,
                    total: topicCoverage.total,
                  })}
                </span>
              )}
            </div>
          )}
          {!isLoading && (
            <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1.5 rounded-lg border border-slate-500/25 bg-slate-950/85 px-2 py-1.5 text-xs text-slate-300">
              <span className="opacity-60">Lens</span>
              <button
                className={`rounded px-1.5 py-0.5 ${!lens.axis ? 'bg-slate-200 text-slate-900' : 'hover:bg-slate-700/60'}`}
                onClick={() => setLens((l) => ({ ...l, axis: undefined }))}
              >
                Off
              </button>
              {LENS_AXES.map((a) => (
                <button
                  key={a.key}
                  title={a.label}
                  className={`rounded px-1.5 py-0.5 ${lens.axis === a.key ? 'bg-sky-400 text-slate-900' : 'hover:bg-slate-700/60'}`}
                  onClick={() => setLens((l) => ({ ...l, axis: a.key }))}
                >
                  {a.label.split(' ')[0]}
                </button>
              ))}
              <button
                title={t('explore.lens.recentTitle')}
                className={`rounded px-1.5 py-0.5 ${lens.axis === RECENT_AXIS ? 'bg-orange-400 text-slate-900' : 'hover:bg-slate-700/60'}`}
                onClick={() => setLens((l) => ({ ...l, axis: RECENT_AXIS }))}
              >
                {t('explore.lens.recent')}
              </button>
              {lens.axis === RECENT_AXIS && (
                <span className="ml-1 flex items-center gap-1" data-testid="recent-legend">
                  <span className="opacity-60">{t('explore.lens.recentHot')}</span>
                  <span
                    className="h-2 w-14 rounded-full"
                    style={{ background: 'linear-gradient(to right, hsl(18 85% 60%), hsl(218 50% 60%))' }}
                  />
                  <span className="opacity-60">{t('explore.lens.recentCold')}</span>
                </span>
              )}
              <label className="ml-1 flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!lens.sizeByCentrality}
                  onChange={(e) => setLens((l) => ({ ...l, sizeByCentrality: e.target.checked }))}
                />
                hubs
              </label>
            </div>
          )}
          <DetailPanel
            target={drawer}
            nodeById={nodeById}
            objects={graph?.objects ?? []}
            objectLinks={graph?.objectLinks ?? []}
            onClose={() => setDrawer(null)}
            onFocus={(id) => {
              setDrawer(null);
              setFocusId(id);
            }}
            onSelect={openTarget}
          />
          {cameraMode === 'ship' && (
            <>
              {/* Ship HUD: crosshair + control hints. Pure overlay, no logic. */}
              <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/40 text-lg select-none">
                +
              </div>
              <div className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 rounded-md bg-black/60 px-4 py-2 text-white/90 backdrop-blur-sm">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/50">
                  <span>SPD</span>
                  <span className="font-mono text-cyan-300">{Math.round(shipHud.speed)}</span>
                </div>
                <div className="h-1.5 w-32 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full bg-cyan-400 transition-[width] duration-75"
                    style={{ width: `${Math.min((shipHud.speed / 520) * 100, 100)}%` }}
                  />
                </div>
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider">
                  <span className={shipHud.boosting ? 'text-yellow-300' : 'text-white/30'}>
                    {shipHud.boosting ? 'BOOST' : 'boost'}
                  </span>
                </div>
                <div className="text-[10px] text-white/60">{t('explore.camera.shipHint')}</div>
              </div>
            </>
          )}
        </div>
        <SidePanel
          focusName={focusId ? nodeById.get(focusId)?.name ?? null : null}
          mode={mode}
          onModeChange={setMode}
          kinds={kinds}
          onKindsChange={setKinds}
          typeFilter={typeFilter}
          onTypeToggle={(dt) =>
            setTypeFilter((prev) => {
              const next = new Set(prev);
              if (next.has(dt)) next.delete(dt);
              else next.add(dt);
              return next;
            })
          }
          availableTypes={availableTypes}
          items={neighbors.data?.items ?? []}
          loading={neighbors.isFetching}
          semantic={neighbors.data?.semantic ?? false}
          vectorsReady={graph?.meta.vectors ?? false}
          onItemClick={onPanelItem}
        />
      </div>

    </div>
  );
}
