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
import { useMemo, useState, useRef, useLayoutEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Rocket, Orbit, Search, Waypoints, Boxes } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/services/api/client';
import GraphCanvas, {
  type CanvasNode,
  type CanvasLink,
  type CameraMode,
  type LensState,
} from '@/components/explorer/GraphCanvas';

// Semantic-lens axes the user can colour the map by (must match node_features).
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
import { repoLangs } from '@/components/explorer/repoVisuals';

export default function Explore() {
  const { t, i18n } = useTranslation();
  const { data: graph, isLoading } = useGraph();

  const [focusId, setFocusId] = useState<string | null>(null);
  const [mode, setMode] = useState<NeighborMode>('related');
  const [kinds, setKinds] = useState<string[]>(['taxonomy', 'capture', 'note', 'object']);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>('observer');
  const [showRelations, setShowRelations] = useState(true);
  const [jumpQuery, setJumpQuery] = useState('');
  const [jumpMiss, setJumpMiss] = useState(false);
  const [shipHud, setShipHud] = useState({ speed: 0, boosting: false, thrust: 0 });
  const [lens, setLens] = useState<LensState>({});
  // Files core: objects leave their orbital slots and form a 3D core at the
  // ring center, reordered by filesystem / taxonomy / (later) topic.
  const [core, setCore] = useState<{ on: boolean; order: CoreOrder }>({ on: false, order: 'fs' });

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

  // Focus can land on a synthetic core node (`dir:…`) — the camera warps
  // there, but the semantic-neighbourhood query is taxonomy-only.
  const taxonomyFocus = focusId && nodeById.has(focusId) ? focusId : null;
  const neighbors = useNeighbors(taxonomyFocus, mode, kinds);

  // Hue per top-level category — the constellation's colour identity.
  const hueByCategory = useMemo(() => {
    const cats = (graph?.nodes ?? []).filter((n) => n.kind === 'category');
    return new Map(cats.map((c, i) => [c.id, Math.round((i / Math.max(cats.length, 1)) * 360)]));
  }, [graph]);

  const rootOf = (id: string): string => {
    let cur = nodeById.get(id);
    while (cur?.parentId) cur = nodeById.get(cur.parentId);
    return cur?.id ?? id;
  };

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
      glyph: o.glyph,
      // fs relPath — the core view renders file leaves as satellite cubes.
      path: o.path,
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
      const layout = computeCore(graph.objects ?? [], core.order, {
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
      for (const o of graph.objects ?? []) {
        const p = layout.positions.get(`obj:${o.id}`);
        if (p) nodes.push(objectNode(o, 99, p));
      }
      for (const f of layout.folders) {
        const p = layout.positions.get(f.id);
        if (!p) continue;
        // Repo dirs (server-side `.git` detection) upgrade to language spheres.
        const ds = dirStatByPath.get(f.path);
        nodes.push({
          id: f.id,
          // Only the CENTRAL core root is "Root" — standalone mapping hubs are
          // depth 0 too, but carry their mapping label.
          name: f.depth === 0 && !f.mapping ? t('explore.core.root') : f.name,
          kind: 'folder',
          level: 98,
          childCount: f.count,
          hasNote: false,
          folder: true,
          ...(ds?.repo ? { repo: true, bytes: ds.bytes, exts: ds.exts } : {}),
          categoryHue: 215,
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
            5,
          );
          nodes.push(objectNode(o, (star.level ?? 0) + 1, p));
        });
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
      for (const item of starItems) {
        if (item.kind === 'taxonomy' && item.nodeId && nodeById.has(item.nodeId)) {
          // Tree member: no new node, just the dashed semantic edge.
          links.push({ source: focusId, target: item.nodeId, semantic: true, distance: item.distance });
        } else {
          const id = `star:${item.kind}:${item.refId}`;
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
          });
          links.push({ source: focusId, target: id, semantic: true, distance: item.distance });
        }
      }
    }
    return { canvasNodes: nodes, canvasLinks: links, coreLayout };
  }, [graph, focusId, starItems, hueByCategory, nodeById, showRelations, core, t]);

  const availableTypes = useMemo(
    () => [...new Set((neighbors.data?.items ?? []).map((i) => i.dataType).filter(Boolean))] as string[],
    [neighbors.data],
  );

  const openTarget = (id: string) => {
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
          nodeId: o.anchors[0],
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
            />
          )}
          {!isLoading && core.on && (
            <div className="absolute bottom-14 left-3 z-10 flex items-center gap-1.5 rounded-lg border border-slate-500/25 bg-slate-950/85 px-2 py-1.5 text-xs text-slate-300">
              <span className="opacity-60">{t('explore.core.toggle')}</span>
              {(['fs', 'taxonomy', 'topic'] as const).map((o) => (
                <button
                  key={o}
                  disabled={o === 'topic'}
                  title={o === 'topic' ? t('explore.core.topicSoon') : undefined}
                  className={`rounded px-1.5 py-0.5 ${
                    core.order === o
                      ? 'bg-teal-400 text-slate-900'
                      : o === 'topic'
                        ? 'cursor-not-allowed opacity-40'
                        : 'hover:bg-slate-700/60'
                  }`}
                  onClick={() => setCore((c) => ({ ...c, order: o }))}
                >
                  {t(`explore.core.order.${o}`)}
                </button>
              ))}
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
              next.has(dt) ? next.delete(dt) : next.add(dt);
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
