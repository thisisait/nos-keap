/**
 * The universe canvas — 3D only (ROADMAP Track U; the 2.5D/2D renderer was
 * retired 2026-07-11 by owner decision: one renderer, one force config).
 *
 * This is the OBSERVER mode: orbit camera around the radial constellation
 * DAG. The future rocketship mode (U3) swaps the camera controller, not the
 * scene. Until the deterministic layout bake (U1) lands, the radial DAG +
 * seeded force sim is the layout.
 *
 * Stars (semantic hits that are captures/notes/objects, i.e. NOT part of the
 * hard-coded taxonomy) arrive as extra nodes with star=true, linked to the
 * focus by a semantic link whose rest-length grows with vector distance —
 * the force engine then naturally places them "in the distance" behind the
 * focused constellation. Taxonomy hits reuse their existing tree node and
 * only gain the dashed semantic link. Nebula nodes are anchored knowledge
 * objects orbiting their taxonomy star on a short leash.
 */
import { useMemo, useRef, useEffect, useCallback } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import SpriteText from 'three-spritetext';
// @ts-expect-error — no bundled types; same engine react-force-graph uses.
import { forceCollide } from 'd3-force-3d';

export interface CanvasNode {
  id: string;
  name: string;
  kind: string;
  level: number;
  childCount: number;
  hasNote: boolean;
  dataType?: string;
  star?: boolean;
  /** Anchored knowledge object — dust orbiting its taxonomy star. */
  nebula?: boolean;
  distance?: number;
  categoryHue: number;
}

export interface CanvasLink {
  source: string;
  target: string;
  semantic?: boolean;
  nebula?: boolean;
  distance?: number;
}

interface Props {
  nodes: CanvasNode[];
  links: CanvasLink[];
  focusId: string | null;
  onNodeClick: (id: string) => void;
  width: number;
  height: number;
}

const STAR_COLOR: Record<string, string> = {
  capture: '#f59e0b',
  note: '#a78bfa',
  object: '#2dd4bf',
};

function nodeColor(n: CanvasNode, focusId: string | null): string {
  if (n.star) return STAR_COLOR[n.kind] ?? STAR_COLOR[n.dataType ?? ''] ?? '#fbbf24';
  if (n.nebula) return `hsl(${n.categoryHue} 45% 62% / 0.85)`;
  const l = n.id === focusId ? 72 : n.kind === 'item' ? 46 : 58;
  const s = n.id === focusId ? 95 : 70;
  return `hsl(${n.categoryHue} ${s}% ${l}%)`;
}

function nodeSize(n: CanvasNode): number {
  if (n.nebula) return 1.4;
  if (n.star) return 3;
  if (n.kind === 'category') return 9;
  if (n.kind === 'subcategory') return 4 + Math.min(n.childCount / 6, 3);
  return 2;
}

export default function GraphCanvas({ nodes, links, focusId, onNodeClick, width, height }: Props) {
  const fgRef = useRef<any>(null);

  const graphData = useMemo(() => {
    // force-graph mutates its input (source/target become object refs) —
    // hand it shallow copies so React Query's cache stays clean.
    return {
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    };
  }, [nodes, links]);

  // Semantic links pull stars to rest at a radius proportional to vector
  // distance; tree links keep the constellation tight; nebula dust sits on a
  // short leash. Deferred + guarded: right after mount the simulation is not
  // ready yet and touching it throws, which kills the render loop.
  useEffect(() => {
    const t = setTimeout(() => {
      const ref = fgRef.current;
      if (!ref) return;
      try {
        const linkForce = ref.d3Force('link');
        if (linkForce) {
          linkForce.distance((l: any) =>
            l.semantic ? 90 + (l.distance ?? 0.5) * 260 : l.nebula ? 20 : l.target?.star ? 55 : 38,
          );
        }
        // Breathing room: stronger repulsion + a collide force so sibling
        // clusters don't sit on top of each other (radius tracks the node's
        // rendered size: r = sqrt(val) * nodeRelSize, plus padding).
        const charge = ref.d3Force('charge');
        if (charge) charge.strength(-55);
        ref.d3Force(
          'collide',
          forceCollide((n: any) => Math.sqrt(nodeSize(n)) * 2.4 + 4),
        );
        ref.d3ReheatSimulation();
      } catch {
        // Engine not initialised yet — default forces are fine.
      }
    }, 300);
    return () => clearTimeout(t);
  }, [graphData]);

  // Fly the observer camera to the focused node once the engine placed it.
  useEffect(() => {
    if (!focusId) return;
    const t = setTimeout(() => {
      const ref = fgRef.current;
      const node = graphData.nodes.find((n: any) => n.id === focusId) as any;
      if (!ref || !node || node.x === undefined) return;
      ref.cameraPosition({ x: node.x, y: node.y, z: (node.z ?? 0) + 260 }, node, 800);
    }, 400);
    return () => clearTimeout(t);
  }, [focusId, graphData]);

  const handleClick = useCallback((node: any) => onNodeClick(node.id), [onNodeClick]);

  // Always-on labels: galaxy names (categories) so the observer never loses
  // orientation, and star names so semantic hits are readable at a glance.
  // Everything else keeps the hover tooltip only. Returning a falsy object
  // with nodeThreeObjectExtend keeps the default sphere; the sprite is
  // ADDED next to it, not a replacement.
  const nodeThreeObject = useCallback((node: any) => {
    if (node.kind !== 'category' && !node.star) return false as any;
    const sprite = new SpriteText(node.name);
    sprite.color = node.star ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.92)';
    sprite.textHeight = node.kind === 'category' ? 7 : 3.5;
    sprite.position.y = -(Math.sqrt(nodeSize(node)) * 2.4 + 6);
    sprite.material.depthWrite = false;
    return sprite;
  }, []);

  return (
    <ForceGraph3D
      ref={fgRef}
      graphData={graphData}
      nodeId="id"
      nodeRelSize={2.4}
      nodeLabel={(n: any) =>
        n.star ? `☆ ${n.name}${n.distance ? ` · d=${n.distance.toFixed(2)}` : ''}` : n.name
      }
      nodeVal={(n: any) => nodeSize(n)}
      nodeColor={(n: any) => nodeColor(n, focusId)}
      nodeThreeObject={nodeThreeObject}
      nodeThreeObjectExtend={true}
      linkColor={(l: any) => (l.semantic ? 'rgba(251,191,36,0.55)' : 'rgba(120,130,150,0.25)')}
      linkWidth={(l: any) => (l.semantic ? 1.2 : 0.4)}
      onNodeClick={handleClick}
      backgroundColor="rgba(0,0,0,0)"
      width={width}
      height={height}
      dagMode="radialout"
      dagLevelDistance={80}
      linkOpacity={0.4}
      nodeOpacity={0.92}
      showNavInfo={false}
    />
  );
}
