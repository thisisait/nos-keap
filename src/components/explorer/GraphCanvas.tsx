/**
 * The universe canvas — 3D only (ROADMAP Track U; the 2.5D/2D renderer was
 * retired 2026-07-11 by owner decision: one renderer, one force config).
 *
 * This is the OBSERVER mode: orbit camera over the baked universe. Taxonomy
 * stars arrive PINNED (fx/fy/fz from the U1 layout bake — the spatial-memory
 * contract); the force engine only places free bodies (semantic stars,
 * nebula dust) around them. Ship mode swaps the camera controller for a
 * third-person low-poly rocket with custom physics, not the scene.
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
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { forceCollide } from 'd3-force-3d';
import { createShipModel, type ShipModelParts } from './ShipModel';
import { useShipController } from './useShipController';

export type CameraMode = 'observer' | 'ship';

const REDUCED_MOTION =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Camera travel time — reduced motion means instant cuts, not slow pans. */
export function warpMs(ms: number): number {
  return REDUCED_MOTION ? 0 : ms;
}

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
  /** Baked position pin (U1) — d3-force never moves fx/fy/fz nodes. */
  fx?: number;
  fy?: number;
  fz?: number;
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
  /** observer = orbit camera; ship = 3rd-person low-poly rocket. */
  mode: CameraMode;
  /** Called every engine tick with the current ship telemetry (ship mode only). */
  onShipUpdate?: (state: { speed: number; boosting: boolean; thrust: number }) => void;
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

export default function GraphCanvas({ nodes, links, focusId, onNodeClick, width, height, mode, onShipUpdate }: Props) {
  const fgRef = useRef<any>(null);
  const didFitRef = useRef(false);
  const modelRef = useRef<ShipModelParts | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const { shipRef, tick, reset } = useShipController(mode === 'ship');

  const _camOffset = useMemo(() => new THREE.Vector3(0, 3.5, -14), []);
  const _lookOffset = useMemo(() => new THREE.Vector3(0, 1.5, 8), []);
  const _targetPos = useMemo(() => new THREE.Vector3(), []);
  const _lookTarget = useMemo(() => new THREE.Vector3(), []);
  const _forward = useMemo(() => new THREE.Vector3(), []);

  // Deep-space dressing, once per mount: a decorative starfield shell far
  // beyond the data (never clickable, never part of spatial memory) and an
  // UnrealBloom pass that makes stars glow. Camera far plane pushed out so
  // the shell stays visible.
  useEffect(() => {
    const t = setTimeout(() => {
      const ref = fgRef.current;
      if (!ref) return;
      try {
        const cam = ref.camera();
        cam.far = 40000;
        cam.updateProjectionMatrix();

        const N = 1600;
        const positions = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
          const r = 6000 + Math.random() * 5000;
          const theta = Math.acos(2 * Math.random() - 1);
          const phi = Math.random() * Math.PI * 2;
          positions[i * 3] = r * Math.sin(theta) * Math.cos(phi);
          positions[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
          positions[i * 3 + 2] = r * Math.cos(theta);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
          color: 0x93a4c8,
          size: 1.6,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.65,
          depthWrite: false,
        });
        const starfield = new THREE.Points(geo, mat);
        ref.scene().add(starfield);

        const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.85, 0.55, 0.12);
        ref.postProcessingComposer().addPass(bloom);

        return; // cleanup handled below via closure capture
      } catch {
        // Renderer not ready — dressing is decorative, skip silently.
      }
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ship mode: mount the player model, disable built-in controls, lock the
  // pointer, and start from the current camera orientation.
  useEffect(() => {
    if (mode !== 'ship') return;
    const t = setTimeout(() => {
      const ref = fgRef.current;
      if (!ref) return;
      try {
        const cam = ref.camera();
        const scene = ref.scene();
        const model = createShipModel();
        modelRef.current = model;
        scene.add(model.group);

        // Start the ship where the camera is, facing the same way.
        reset(cam.position, cam.quaternion);

        // Disable the graph's camera controls so we own the camera.
        if (typeof ref.enableNavigationControls === 'function') {
          ref.enableNavigationControls(false);
        }
        const controls = ref.controls();
        if (controls && typeof controls.enabled === 'boolean') {
          controls.enabled = false;
        }

        // Pointer lock for smooth mouse look.
        const canvas = ref.renderer()?.domElement;
        if (canvas && document.pointerLockElement !== canvas) {
          canvas.requestPointerLock?.();
        }
      } catch {
        // Renderer not ready yet.
      }
    }, 100);

    return () => {
      clearTimeout(t);
      try {
        const ref = fgRef.current;
        if (!ref) return;
        const model = modelRef.current;
        if (model) {
          ref.scene().remove(model.group);
          model.group.traverse((obj: THREE.Object3D) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry?.dispose();
              const material = obj.material;
              if (Array.isArray(material)) {
                material.forEach((m) => m.dispose());
              } else {
                material?.dispose();
              }
            }
          });
          modelRef.current = null;
        }
        if (typeof ref.enableNavigationControls === 'function') {
          ref.enableNavigationControls(true);
        }
        const controls = ref.controls();
        if (controls && typeof controls.enabled === 'boolean') {
          controls.enabled = true;
        }
        if (document.pointerLockElement) {
          document.exitPointerLock?.();
        }
      } catch {
        // Ignore cleanup errors.
      }
    };
  }, [mode, reset]);

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
        // The baked universe is big (galaxy ring r≈1400) — frame it once so
        // the observer starts seeing the whole sky, not one galaxy's flank.
        if (!didFitRef.current) {
          didFitRef.current = true;
          ref.zoomToFit(warpMs(600), 60);
        }
      } catch {
        // Engine not initialised yet — default forces are fine.
      }
    }, 300);
    return () => clearTimeout(t);
  }, [graphData]);

  // Warp to the focused node once the engine placed it — the "semantic
  // hyperspace jump" (search or click sets focus, the camera travels).
  // In ship mode we own the camera, so skip the warp.
  useEffect(() => {
    if (!focusId || mode === 'ship') return;
    const t = setTimeout(() => {
      const ref = fgRef.current;
      const node = graphData.nodes.find((n: any) => n.id === focusId) as any;
      if (!ref || !node || node.x === undefined) return;
      ref.cameraPosition({ x: node.x, y: node.y, z: (node.z ?? 0) + 260 }, node, warpMs(1100));
    }, 400);
    return () => clearTimeout(t);
  }, [focusId, graphData, mode]);

  const handleClick = useCallback((node: any) => onNodeClick(node.id), [onNodeClick]);

  // Per-frame update in ship mode: physics, animation, camera, trail.
  const updateFrame = useCallback(
    (dt: number) => {
      const ref = fgRef.current;
      const model = modelRef.current;
      if (!ref || !model) return;

      tick(dt);

      const ship = shipRef.current;
      const group = model.group;
      const flame = model.flame;
      const trail = model.trail;

      group.position.copy(ship.position);
      group.quaternion.copy(ship.quaternion);

      // Animate flame length/width by thrust + boost.
      const baseFlame = 0.4;
      const thrust = ship.thrust;
      const boosting = ship.boosting;
      const now = performance.now();
      const pulse = 1 + Math.sin(now * 0.02) * 0.08;
      const flameLen = (baseFlame + thrust * 1.2 + (boosting ? 1.4 : 0)) * pulse;
      const flameWidth = baseFlame + thrust * 0.4 + (boosting ? 0.3 : 0);
      flame.scale.set(flameWidth, flameWidth, flameLen);
      flame.position.z = -2.6 - flameLen * 0.5;
      flame.material.opacity = 0.7 + thrust * 0.2 + (boosting ? 0.1 : 0);

      // Trail length and color from speed.
      const speedRatio = Math.min(ship.speed / 240, 1);
      const trailLen = 1 + ship.speed * 0.025;
      trail.scale.set(1 + speedRatio * 0.5, 1 + speedRatio * 0.5, trailLen);
      trail.position.z = -3.0 - trailLen * 0.5;
      trail.material.opacity = 0.25 + speedRatio * 0.55;
      trail.material.color.setHex(boosting ? 0xfacc15 : 0x67e8f9);

      // Third-person camera: smooth follow behind the ship.
      const cam = ref.camera();
      _camOffset.set(0, 3.5, -14).applyQuaternion(ship.quaternion);
      _targetPos.copy(ship.position).add(_camOffset);
      cam.position.lerp(_targetPos, 1 - Math.exp(-2.5 * dt));

      _forward.set(0, 0, 1).applyQuaternion(ship.quaternion);
      _lookTarget.copy(ship.position).addScaledVector(_forward, 8).add(_lookOffset);
      cam.lookAt(_lookTarget);

      const targetFov = 60 + (boosting ? 12 : 0) + speedRatio * 6;
      cam.fov = THREE.MathUtils.lerp(cam.fov, targetFov, 0.1);
      cam.updateProjectionMatrix();

      onShipUpdate?.({ speed: ship.speed, boosting, thrust });
    },
    [tick, shipRef, _camOffset, _lookOffset, _targetPos, _lookTarget, _forward, onShipUpdate],
  );

  // Drive the ship with our own requestAnimationFrame loop so it keeps
  // running even after the d3-force simulation has cooled down.
  useEffect(() => {
    if (mode !== 'ship') {
      lastTimeRef.current = null;
      return;
    }
    let raf = 0;
    const loop = (now: number) => {
      if (lastTimeRef.current != null) {
        const dt = Math.min((now - lastTimeRef.current) / 1000, 0.1);
        updateFrame(dt);
      }
      lastTimeRef.current = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lastTimeRef.current = null;
    };
  }, [mode, updateFrame]);

  // Always-on labels: galaxy names (categories) so the observer never loses
  // orientation, and star names so semantic hits are readable at a glance.
  // Everything else keeps the hover tooltip only. Returning a falsy object
  // with nodeThreeObjectExtend keeps the default sphere; the sprite is
  // ADDED next to it, not a replacement.
  const nodeThreeObject = useCallback((node: any) => {
    if (node.kind !== 'category' && !node.star) return false as any;
    const sprite = new SpriteText(node.name) as THREE.Sprite;
    sprite.color = node.star ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.92)';
    sprite.textHeight = node.kind === 'category' ? 7 : 3.5;
    sprite.position.y = -(Math.sqrt(nodeSize(node)) * 2.4 + 6);
    sprite.material.depthWrite = false;
    return sprite;
  }, []);

  return (
    <ForceGraph3D
      ref={fgRef}
      controlType="orbit"
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
      linkOpacity={0.4}
      nodeOpacity={0.92}
      showNavInfo={false}
      enablePointerInteraction={mode !== 'ship'}
      enableNodeDrag={mode !== 'ship'}
    />
  );
}
