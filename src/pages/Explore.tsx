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
import { ArrowLeft, Box, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import GraphCanvas, { type CanvasNode, type CanvasLink } from '@/components/explorer/GraphCanvas';
import SidePanel from '@/components/explorer/SidePanel';
import NodeDetailDrawer, { type DrawerTarget } from '@/components/explorer/NodeDetailDrawer';
import {
  useGraph,
  useNeighbors,
  type NeighborItem,
  type NeighborMode,
} from '@/hooks/useExplorerData';

export default function Explore() {
  const { t } = useTranslation();
  const { data: graph, isLoading } = useGraph();

  const [focusId, setFocusId] = useState<string | null>(null);
  const [mode, setMode] = useState<NeighborMode>('related');
  const [kinds, setKinds] = useState<string[]>(['taxonomy', 'capture', 'note']);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [is3D, setIs3D] = useState(false);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);

  const neighbors = useNeighbors(focusId, mode, kinds);

  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph],
  );

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
  const { canvasNodes, canvasLinks } = useMemo(() => {
    if (!graph) return { canvasNodes: [] as CanvasNode[], canvasLinks: [] as CanvasLink[] };
    const nodes: CanvasNode[] = graph.nodes.map((n) => ({
      ...n,
      categoryHue: hueByCategory.get(rootOf(n.id)) ?? 210,
    }));
    const links: CanvasLink[] = graph.links.map((l) => ({ ...l }));
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
    return { canvasNodes: nodes, canvasLinks: links };
  }, [graph, focusId, starItems, hueByCategory, nodeById]);

  const availableTypes = useMemo(
    () => [...new Set((neighbors.data?.items ?? []).map((i) => i.dataType).filter(Boolean))] as string[],
    [neighbors.data],
  );

  const openTarget = (id: string) => {
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
    setDrawer({ id, name: n.name, kind: n.kind, dataType: n.dataType, isStar: false });
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
        <div className="ml-auto flex items-center gap-2 text-xs">
          <Square className="h-3.5 w-3.5" />
          <Switch checked={is3D} onCheckedChange={setIs3D} aria-label="2D/3D" />
          <Box className="h-3.5 w-3.5" />
          <span className="text-muted-foreground">{is3D ? '3D' : '2D'}</span>
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
              is3D={is3D}
              focusId={focusId}
              onNodeClick={openTarget}
              width={size.w}
              height={size.h}
            />
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

      <NodeDetailDrawer
        target={drawer}
        nodeById={nodeById}
        onClose={() => setDrawer(null)}
        onFocus={(id) => {
          setDrawer(null);
          setFocusId(id);
        }}
      />
    </div>
  );
}
