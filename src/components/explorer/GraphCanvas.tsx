/**
 * The 2.5D canvas: one merged force-graph rendered flat (2D, radial dag) by
 * default, lifting into full 3D on demand. Both renderers consume the SAME
 * node/link arrays, so the toggle is purely a camera/dimension change —
 * that is the "plane that goes into more dimensions on interaction".
 *
 * Stars (semantic hits that are captures/notes, i.e. NOT part of the
 * hard-coded taxonomy) arrive as extra nodes with star=true, linked to the
 * focus by a semantic link whose rest-length grows with vector distance —
 * the force engine then naturally places them "in the distance" behind the
 * focused constellation. Taxonomy hits reuse their existing tree node and
 * only gain the dashed semantic link.
 */
import { useMemo, useRef, useEffect, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import ForceGraph3D from 'react-force-graph-3d';

export interface CanvasNode {
  id: string;
  name: string;
  kind: string;
  level: number;
  childCount: number;
  hasNote: boolean;
  dataType?: string;
  star?: boolean;
  distance?: number;
  categoryHue: number;
}

export interface CanvasLink {
  source: string;
  target: string;
  semantic?: boolean;
  distance?: number;
}

interface Props {
  nodes: CanvasNode[];
  links: CanvasLink[];
  is3D: boolean;
  focusId: string | null;
  onNodeClick: (id: string) => void;
  width: number;
  height: number;
}

const STAR_COLOR: Record<string, string> = {
  capture: '#f59e0b',
  note: '#a78bfa',
};

function nodeColor(n: CanvasNode, focusId: string | null): string {
  if (n.star) return STAR_COLOR[n.dataType ?? ''] ?? '#fbbf24';
  const l = n.id === focusId ? 72 : n.kind === 'item' ? 46 : 58;
  const s = n.id === focusId ? 95 : 70;
  return `hsl(${n.categoryHue} ${s}% ${l}%)`;
}

function nodeSize(n: CanvasNode): number {
  if (n.star) return 3;
  if (n.kind === 'category') return 9;
  if (n.kind === 'subcategory') return 4 + Math.min(n.childCount / 6, 3);
  return 2;
}

export default function GraphCanvas({ nodes, links, is3D, focusId, onNodeClick, width, height }: Props) {
  const fg2dRef = useRef<any>(null);
  const fg3dRef = useRef<any>(null);

  const graphData = useMemo(() => {
    // force-graph mutates its input (source/target become object refs) —
    // hand it shallow copies so React Query's cache stays clean.
    return {
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    };
  }, [nodes, links]);

  // Semantic links pull stars to rest at a radius proportional to vector
  // distance; tree links keep the constellation tight. Deferred + guarded:
  // right after the 2D↔3D toggle the newly mounted renderer's simulation is
  // not ready yet and touching it throws (`… reading 'tick'`), which kills
  // the render loop (black canvas).
  useEffect(() => {
    const t = setTimeout(() => {
      const ref = is3D ? fg3dRef.current : fg2dRef.current;
      if (!ref) return;
      try {
        const linkForce = ref.d3Force('link');
        if (linkForce) {
          linkForce.distance((l: any) =>
            l.semantic ? 60 + (l.distance ?? 0.5) * 220 : l.target?.star ? 40 : 24,
          );
          ref.d3ReheatSimulation();
        }
      } catch {
        // Engine not initialised yet — default link distances are fine.
      }
    }, 300);
    return () => clearTimeout(t);
  }, [is3D, graphData]);

  // Center the camera on the focused node once the engine has placed it.
  useEffect(() => {
    if (!focusId) return;
    const t = setTimeout(() => {
      const ref = is3D ? fg3dRef.current : fg2dRef.current;
      const node = graphData.nodes.find((n: any) => n.id === focusId) as any;
      if (!ref || !node || node.x === undefined) return;
      if (is3D) {
        ref.cameraPosition({ x: node.x, y: node.y, z: (node.z ?? 0) + 260 }, node, 800);
      } else {
        ref.centerAt(node.x, node.y, 800);
        ref.zoom(3, 800);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [focusId, is3D, graphData]);

  const handleClick = useCallback((node: any) => onNodeClick(node.id), [onNodeClick]);

  const common = {
    graphData,
    nodeId: 'id',
    nodeRelSize: 2.4,
    nodeLabel: (n: any) =>
      n.star ? `☆ ${n.name}${n.distance ? ` · d=${n.distance.toFixed(2)}` : ''}` : n.name,
    nodeVal: (n: any) => nodeSize(n),
    nodeColor: (n: any) => nodeColor(n, focusId),
    linkColor: (l: any) => (l.semantic ? 'rgba(251,191,36,0.55)' : 'rgba(120,130,150,0.25)'),
    linkWidth: (l: any) => (l.semantic ? 1.2 : 0.4),
    onNodeClick: handleClick,
    backgroundColor: 'rgba(0,0,0,0)',
    width,
    height,
  } as const;

  if (is3D) {
    return (
      <ForceGraph3D
        ref={fg3dRef}
        {...common}
        linkOpacity={0.4}
        nodeOpacity={0.92}
        showNavInfo={false}
      />
    );
  }

  return (
    <ForceGraph2D
      ref={fg2dRef}
      {...common}
      dagMode="radialout"
      dagLevelDistance={42}
      linkLineDash={(l: any) => (l.semantic ? [3, 3] : null)}
      nodeCanvasObjectMode={() => 'after'}
      nodeCanvasObject={(node: any, ctx, globalScale) => {
        // Labels: categories always; the rest only when zoomed in enough.
        const show =
          node.kind === 'category' || node.star ? globalScale > 0.9 : globalScale > 2.2;
        if (!show) return;
        const fontSize = Math.max(10 / globalScale, 1.6);
        ctx.font = `${node.kind === 'category' ? '600 ' : ''}${fontSize}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = node.star ? 'rgba(251,191,36,0.9)' : 'rgba(226,232,240,0.85)';
        ctx.fillText(node.name, node.x, node.y + nodeSize(node) / 2 + 1.5);
      }}
    />
  );
}
