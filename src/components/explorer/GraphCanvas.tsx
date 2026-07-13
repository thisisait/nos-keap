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
import { FORM_SIZE, type CelestialForm } from './orbital';

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
  /** Anchored knowledge object rendering as a typed body orbiting its star. */
  object?: boolean;
  /** Celestial form (objects only) — planet | moon | asteroid | comet | station. */
  form?: CelestialForm;
  glyph?: string;
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
  /** Typed concept relation (imported research graph overlay, e.g. ToE). */
  relation?: boolean;
  relType?: string;
  explored?: string | null;
}

// Concept-relation edge palette (ToE research edges). Generic 'related-concept'
// is a muted slate; the typed research edges each get a hue.
const REL_COLOR: Record<string, string> = {
  duality: '#f472b6',
  conflict: '#f87171',
  conjecture: '#fbbf24',
  limit: '#22d3ee',
  'shared-math': '#a78bfa',
  'shared-structure': '#34d399',
  'related-concept': 'rgba(120,130,150,0.30)',
};

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

// ── Cosmology tiers ──────────────────────────────────────────────────────────
// L0 taxonomy roots render as translucent NEBULAE (galaxy-clusters), L1 as
// GALAXY discs, L2+ as STARS graded by depth (hotter/whiter shallow → cooler/
// redder deep). Anchored objects are typed orbital bodies (see buildAssetMesh).

function nodeColor(n: CanvasNode, focusId: string | null): string {
  if (n.object) return `hsl(${n.categoryHue} 72% 60%)`; // hue = data-type identity
  if (n.star) return STAR_COLOR[n.kind] ?? STAR_COLOR[n.dataType ?? ''] ?? '#fbbf24';
  if (n.level === 0) return `hsl(${n.categoryHue} 55% 55% / 0.22)`; // faint nebula core
  if (n.level === 1) return `hsl(${n.categoryHue} 62% 62%)`; // galaxy
  const depth = Math.min(n.level - 2, 5);
  const l = n.id === focusId ? 82 : 68 - depth * 4; // color temperature
  const s = 58 + depth * 6;
  return `hsl(${n.categoryHue} ${s}% ${l}%)`;
}

function nodeSize(n: CanvasNode): number {
  if (n.object) return FORM_SIZE[n.form ?? 'asteroid'] ?? 1.4;
  if (n.star) return 3;
  if (n.level === 0) return 22; // nebula core
  if (n.level === 1) return 11; // galaxy
  return Math.max(2, 7 - (n.level - 2) * 1.1); // graded stars
}

// ── Shared GPU resources (built ONCE, never per-node) ────────────────────────
// Sharing a material/geometry across nodes is fine; sharing a Mesh instance is
// NOT (three positions it), so buildAssetMesh news one Mesh per node off the
// shared geometry.

function radialSprite(inner: string, mid: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.4, mid);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function tailSprite(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

const _nebulaTex = radialSprite('rgba(255,255,255,0.9)', 'rgba(255,255,255,0.28)');
const _discTex = radialSprite('rgba(255,255,255,1)', 'rgba(255,255,255,0.35)');
const _cometTex = tailSprite();

// Decorative overlays (nebula halo, galaxy disc, labels, comet tail) must NOT
// intercept clicks — a 560u nebula sprite would swallow every click meant for a
// star inside that domain. Disable raycast so only the node's core sphere (or an
// object's asset mesh) is the click target.
const noRaycast = (o: THREE.Object3D) => {
  o.raycast = () => {};
  return o;
};

const _formGeo: Record<CelestialForm, THREE.BufferGeometry> = {
  planet: new THREE.SphereGeometry(1, 16, 12),
  moon: new THREE.SphereGeometry(1, 10, 8),
  asteroid: new THREE.IcosahedronGeometry(1, 0),
  station: new THREE.OctahedronGeometry(1, 0),
  comet: new THREE.SphereGeometry(1, 10, 8),
};
const _ringGeo = new THREE.RingGeometry(1.5, 2.2, 24);

function nebulaSprite(hue: number): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: _nebulaTex,
      color: new THREE.Color(`hsl(${hue}, 45%, 48%)`),
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  s.scale.setScalar(560); // ~2× LEVEL_RADIUS[1] so it visually contains its galaxies
  return noRaycast(s) as THREE.Sprite;
}

function galaxyDisc(hue: number): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: _discTex,
      color: new THREE.Color(`hsl(${hue}, 55%, 52%)`),
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  s.scale.setScalar(70);
  return noRaycast(s) as THREE.Sprite;
}

/** One typed orbital body: a per-form mesh (new Mesh off shared geometry). */
function buildAssetMesh(node: CanvasNode): THREE.Object3D {
  const form = node.form ?? 'asteroid';
  const size = (FORM_SIZE[form] ?? 1.4) * 2.4;
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${node.categoryHue}, 70%, 60%)`) });
  const mesh = new THREE.Mesh(_formGeo[form] ?? _formGeo.asteroid, mat);
  mesh.scale.setScalar(size);
  if (form === 'planet') {
    const ring = new THREE.Mesh(_ringGeo, mat);
    ring.rotation.x = Math.PI / 2.4;
    ring.scale.setScalar(size);
    noRaycast(ring);
    const g = new THREE.Group();
    g.add(mesh, ring);
    return g;
  }
  if (form === 'comet') {
    const tail = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: _cometTex,
        color: mat.color,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    tail.scale.set(size * 6, size * 1.2, 1);
    tail.center.set(0.1, 0.5);
    noRaycast(tail);
    const g = new THREE.Group();
    g.add(mesh, tail);
    return g;
  }
  return mesh;
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

        // Subtle bloom only — a faint core glow on the brightest stars, not a
        // scene-wide neon wash (scientific, not sci-fi). High threshold so most
        // pixels (and text labels) stay crisp; low strength/radius so the halo
        // is tight. (strength, radius, threshold)
        const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.22, 0.18, 0.75);
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
            l.semantic ? 90 + (l.distance ?? 0.5) * 260 : l.target?.star ? 55 : 38,
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
    // Objects: a typed body REPLACES the default sphere (extend=false below).
    if (node.object) return buildAssetMesh(node);
    // Taxonomy: nebula/galaxy halo + label ADDED next to the default sphere.
    const g = new THREE.Group();
    if (node.level === 0) g.add(nebulaSprite(node.categoryHue));
    if (node.level === 1) g.add(galaxyDisc(node.categoryHue));
    if (node.level <= 1 || node.star) {
      const sprite = new SpriteText(node.name);
      sprite.color = '#e9eefc';
      sprite.textHeight = node.level <= 1 ? 6 : 3.2;
      sprite.fontSize = 110; // higher-res canvas → sharper, less blur when scaled
      sprite.fontWeight = '600';
      // Solid dark plate + hairline border so labels read as data annotations,
      // not glowing sci-fi text — legible over bright stars/nebulae.
      sprite.backgroundColor = 'rgba(8,12,22,0.86)';
      sprite.padding = node.level <= 1 ? 2.5 : 1.6;
      sprite.borderRadius = 1.5;
      sprite.borderWidth = 0.4;
      sprite.borderColor = 'rgba(180,195,225,0.35)';
      const label = sprite as unknown as THREE.Sprite;
      label.position.y = -(Math.sqrt(nodeSize(node)) * 2.4 + 6);
      label.material.depthWrite = false;
      noRaycast(label);
      g.add(label);
    }
    return g.children.length ? g : (false as any);
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
      nodeThreeObjectExtend={(n: any) => !n.object}
      linkColor={(l: any) =>
        l.relation
          ? REL_COLOR[l.relType] ?? 'rgba(148,163,184,0.5)'
          : l.semantic
            ? 'rgba(251,191,36,0.55)'
            : 'rgba(120,130,150,0.25)'
      }
      linkWidth={(l: any) =>
        l.relation
          ? l.explored === 'barely'
            ? 1.8 // research frontier — brightest/thickest
            : l.explored === 'partially'
              ? 1.1
              : l.explored === 'well'
                ? 0.6
                : 0.8
          : l.semantic
            ? 1.2
            : 0.4
      }
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
