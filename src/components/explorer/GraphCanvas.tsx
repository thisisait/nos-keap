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
import ForceGraph3D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-3d';
import SpriteText from 'three-spritetext';
import { repoLangs, repoTexture, langOfPath, langColor } from './repoVisuals';
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
function warpMs(ms: number): number {
  return REDUCED_MOTION ? 0 : ms;
}

/**
 * Near-hop guard: clicking a node the user is ALREADY looking at from close
 * up must not yank the camera into the canonical (+z axis) frame — that
 * re-center loses the place they were inspecting. Skip all camera motion
 * when the new focus sits within NEAR_HOP_TARGET of the current orbit
 * target AND the camera itself is within NEAR_HOP_CAMERA of the node
 * (i.e. the node is legible in the current close-up). Far jumps — search,
 * cross-galaxy clicks, zoomed-out picks — still warp.
 */
const NEAR_HOP_TARGET = 300;
const NEAR_HOP_CAMERA = 750;

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
  /** Synthetic files-core folder node (`dir:<path>`) — a hub, not data. */
  folder?: boolean;
  /** fs path (objects: file relPath; used for core-view cubes + lang colour). */
  path?: string;
  /** Repo folder hub — renders as a textured language sphere. */
  repo?: boolean;
  /** Subtree file bytes (repo hubs) — modulates the sphere size. */
  bytes?: number;
  /** Extension byte buckets (repo hubs) — the language mix source. */
  exts?: Array<[string, number]>;
  /** Celestial form (objects only) — planet | moon | asteroid | comet | station. */
  form?: CelestialForm;
  glyph?: string;
  distance?: number;
  categoryHue: number;
  /** Knowledge scope = subtree size (descendants) — drives node SIZE. */
  scope?: number;
  /** Focus-halo orbit (semantic dust): slow revolution around the focus. */
  orbit?: { cx: number; cy: number; cz: number; r: number; phase: number; tilt: number; speed: number };
  /** Embedding-derived semantic-lens features (colour/size channels). */
  features?: Record<string, number>;
  /** Linked-data enrichment (Wikidata QID + entity typing + QRank scope). */
  meta?: { qid?: string; keapType?: string; schemaType?: string; wdLabel?: string;
    confidence?: string; scopeRank?: number; scopeNorm?: number };
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
  /** Files-core folder-tree edge (dir→dir, dir→file). */
  fs?: boolean;
  /** Files-core tether: object → its taxonomy anchor, across space. */
  ray?: boolean;
  /** Mapping-hub tether: mapped-folder hub → its taxonomy root/links. */
  mray?: boolean;
  /** Object→object ref edge ([[object:<id>]] wiki link between cards). */
  olink?: boolean;
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
  /** Semantic lens: recolour stars by an embedding-derived axis + size by centrality. */
  lens?: LensState;
  /** Files core active — flying the camera in/out of the ring center. */
  coreView?: boolean;
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

// Semantic-lens state: colour by a chosen embedding-derived axis + size by
// centrality. Positions never change — the lens only re-skins the stars.
export interface LensState { axis?: string; sizeByCentrality?: boolean }

// Diverging blue→red gradient over an axis score (~[-0.35, 0.35] in practice).
function lensColor(score: number, focus: boolean): string {
  const t = Math.max(0, Math.min(1, (score + 0.35) / 0.7)); // → [0,1]
  const hue = 235 - t * 235; // low = blue (calm), high = red (toward the +pole)
  return `hsl(${hue} 78% ${focus ? 80 : 56}%)`;
}
function nodeFeature(n: CanvasNode, key: string): number | undefined {
  const f = (n as { features?: Record<string, number> }).features;
  const v = f?.[key];
  return typeof v === 'number' ? v : undefined;
}

function nodeColor(n: CanvasNode, focusId: string | null, lens?: LensState): string {
  // Semantic lens: taxonomy stars are recoloured by their axis projection; the
  // structural hue (below) is the default when the lens is off / feature absent.
  if (lens?.axis && !n.object && !n.star) {
    const s = nodeFeature(n, lens.axis);
    if (s !== undefined) return lensColor(s, n.id === focusId);
  }
  if (n.folder) return `hsl(${n.categoryHue} 22% 64% / 0.9)`; // core folder hub — slate (215); topic hubs violet (265)
  if (n.object) return `hsl(${n.categoryHue} 72% 60%)`; // hue = data-type identity
  if (n.star) return STAR_COLOR[n.kind] ?? STAR_COLOR[n.dataType ?? ''] ?? '#fbbf24';
  if (n.level === 0) return `hsl(${n.categoryHue} 55% 55% / 0.22)`; // faint nebula core
  if (n.level === 1) return `hsl(${n.categoryHue} 62% 62%)`; // galaxy
  const depth = Math.min(n.level - 2, 5);
  const l = n.id === focusId ? 82 : 68 - depth * 4; // color temperature
  const s = 58 + depth * 6;
  return `hsl(${n.categoryHue} ${s}% ${l}%)`;
}

// Depth → celestial FORM (galaxy › constellation › star › planet › satellite);
// knowledge scope (subtree size) → SIZE within the level, so extent reads at a
// glance while the form still marks the taxonomy level.
const LEVEL_BASE = [26, 14, 8, 5, 3.2];
const LEVEL_SCOPE_REF = [600, 250, 130, 20, 10]; // typical subtree max per level

function nodeSize(n: CanvasNode, lens?: LensState): number {
  let base: number;
  // Repo hubs: size follows the subtree's file bytes (log scale) — a 1 MB
  // toy and a 500 MB monorepo should read differently at a glance.
  if (n.repo) base = 3 + Math.min(5, Math.log10(1 + (n.bytes ?? 0) / 2048));
  else if (n.folder) base = 2 + Math.min(3, Math.sqrt(n.childCount || 1));
  else if (n.object) base = FORM_SIZE[n.form ?? 'asteroid'] ?? 1.4;
  else if (n.star) base = 3;
  else {
    const lvl = Math.min(n.level, 4);
    const ref = LEVEL_SCOPE_REF[lvl] ?? 6;
    // sparse node ~0.55×, knowledge-rich node ~1.9× its level base (noticeable).
    const t = Math.min(1, Math.log1p(n.scope ?? 0) / Math.log1p(ref));
    base = (LEVEL_BASE[lvl] ?? 2.6) * (0.55 + 1.35 * t);
  }
  // Semantic lens: additionally scale by centrality (hubs bigger).
  if (lens?.sizeByCentrality && !n.object && !n.star && (n.level ?? 2) >= 2) {
    const c = nodeFeature(n, 'centrality');
    if (c !== undefined) base *= 0.7 + Math.max(0, Math.min(1, c)) * 1.6;
  }
  return base;
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

// A star's soft halo (L2) — makes the field-level "stars" twinkle above the
// planets/satellites below them. Structural hue; the sphere core carries the
// lens colour so the two read together.
function starGlow(hue: number): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: _discTex,
      color: new THREE.Color(`hsl(${hue}, 78%, 66%)`),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  s.scale.setScalar(17);
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

const _repoGeo = new THREE.SphereGeometry(1, 24, 16);
const _cubeGeo = new THREE.BoxGeometry(1, 1, 1);

/** Permanent hub/name plate shared by folder + repo hubs. */
function hubLabel(node: CanvasNode, radius: number): THREE.Sprite {
  const sprite = new SpriteText(node.name);
  sprite.color = '#cfd8ec';
  sprite.textHeight = 2.8;
  sprite.fontSize = 110;
  sprite.fontWeight = '600';
  sprite.backgroundColor = 'rgba(8,12,22,0.86)';
  sprite.padding = 1.6;
  sprite.borderRadius = 1.5;
  sprite.borderWidth = 0.4;
  sprite.borderColor = 'rgba(180,195,225,0.35)';
  const label = sprite as unknown as THREE.Sprite;
  label.position.y = -(radius + 4);
  label.material.depthWrite = false;
  return noRaycast(label) as THREE.Sprite;
}

/** Repo folder hub: language-banded identicon sphere, sized by subtree bytes. */
function buildRepoMesh(node: CanvasNode): THREE.Object3D {
  const langs = repoLangs(node.exts ?? []);
  const tex = repoTexture(node.name, langs);
  const mesh = new THREE.Mesh(_repoGeo, new THREE.MeshBasicMaterial({ map: tex }));
  const r = Math.sqrt(nodeSize(node)) * 2.4; // matches the collide-force radius
  mesh.scale.setScalar(r);
  // Name-seeded axis tilt — repos read as individual "worlds", not a grid of
  // identically-oriented beach balls.
  mesh.rotation.z = (hash01v(node.id) - 0.5) * 0.9;
  mesh.rotation.y = hash01v(`${node.id}:y`) * Math.PI * 2;
  const g = new THREE.Group();
  g.add(mesh, hubLabel(node, r));
  return g;
}

/** Core-view file leaf: a small satellite cube, lang-coloured, optional name. */
function buildFileCube(node: CanvasNode, withLabel: boolean): THREE.Object3D {
  const lang = node.path ? langOfPath(node.path) : undefined;
  const color = lang ? langColor(lang) : `hsl(${node.categoryHue}, 70%, 60%)`;
  const mesh = new THREE.Mesh(_cubeGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }));
  mesh.scale.setScalar(2.6);
  mesh.rotation.y = hash01v(node.id) * Math.PI; // deterministic variety
  mesh.rotation.x = hash01v(`${node.id}:x`) * 0.5;
  if (!withLabel) return mesh;
  const sprite = new SpriteText(node.name);
  sprite.color = '#aeb8d0';
  sprite.textHeight = 2;
  sprite.fontSize = 110;
  const label = sprite as unknown as THREE.Sprite;
  label.position.y = -3.6;
  label.material.depthWrite = false;
  noRaycast(label);
  const g = new THREE.Group();
  g.add(mesh, label);
  return g;
}

/** A CanvasNode as the force engine sees it (position/velocity fields added). */
type GraphNode = NodeObject<CanvasNode>;
/** A CanvasLink as the force engine sees it (source/target become node refs). */
type GraphLink = LinkObject<CanvasNode, CanvasLink>;
/** The imperative graph handle. `enableNavigationControls` is a runtime
 *  method the wrapper forwards but the typings omit — kept optional, the
 *  call sites already feature-detect it. */
type GraphRef = ForceGraphMethods<GraphNode, GraphLink> & {
  enableNavigationControls?: (enable: boolean) => void;
};

/** FNV-ish 0..1 hash — deterministic per-node variety (rotation, tilt). */
function hash01v(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export default function GraphCanvas({ nodes, links, focusId, onNodeClick, width, height, mode, onShipUpdate, lens, coreView }: Props) {
  const fgRef = useRef<GraphRef | undefined>(undefined);
  const didFitRef = useRef(false);
  const coreViewRef = useRef(coreView);
  const modelRef = useRef<ShipModelParts | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  // react-force-graph caches node styling; when the semantic lens changes, force
  // it to re-read nodeColor/nodeVal so the recolour/resize applies live (without
  // this the accessors only re-run on a graphData change). Camera is untouched.
  useEffect(() => {
    fgRef.current?.refresh?.();
  }, [lens?.axis, lens?.sizeByCentrality]);

  // Files core: fly INTO the ring center when the core switches on, back out
  // to the whole sky when it switches off. Ship mode owns its own camera.
  useEffect(() => {
    if (coreViewRef.current === coreView) return;
    coreViewRef.current = coreView;
    if (mode === 'ship') return;
    const ref = fgRef.current;
    if (!ref) return;
    try {
      if (coreView) {
        ref.cameraPosition({ x: 0, y: -220, z: 820 }, { x: 0, y: 0, z: 0 }, warpMs(1200));
      } else {
        ref.zoomToFit(warpMs(900), 60);
      }
    } catch {
      // Renderer not ready — the toggle just skips the flight.
    }
  }, [coreView, mode]);
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
        const cam = ref.camera() as THREE.PerspectiveCamera;
        cam.far = 40000;
        cam.updateProjectionMatrix();

        // PERF: full Retina DPR (2–3×) quadruples the fragment load — and the
        // bloom composer multiplies it again. 1.5 is visually indistinguishable
        // on this dense additive scene and roughly halves the GPU bill.
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        ref.renderer()?.setPixelRatio(dpr);
        ref.postProcessingComposer()?.setPixelRatio?.(dpr);

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
        // is tight. (strength, radius, threshold) PERF: the blur mip chain runs
        // at HALF resolution — for a glow this soft the difference is invisible,
        // the ~13 fullscreen blur passes get 4× cheaper.
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(Math.round(width / 2), Math.round(height / 2)),
          0.22,
          0.18,
          0.75,
        );
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

        // Start the ship where the camera is, facing the same way — UNLESS the
        // camera sits inside the galaxy ring (initial frame, files-core
        // close-up): a pilot spawned in the empty ring center sees nothing.
        // Those starts relocate to a hangar vantage outside the ring, nose
        // toward the center, the whole sky ahead.
        const camDist = Math.hypot(cam.position.x, cam.position.y, cam.position.z);
        if (camDist < 1900) {
          // Hangar vantage: the galaxy ring lives in the XY plane (r=1400).
          // Park outside the rim, slightly above the plane, nose at the
          // nearest arc — galaxies ~800u ahead fill the canopy while the rest
          // of the ring curves away to both sides. (The ring CENTER is empty
          // space — aiming there, or spawning inside it, shows a blank sky.)
          const pos = new THREE.Vector3(0, -2050, 420);
          const target = new THREE.Vector3(0, -1350, 0);
          // Ship forward is LOCAL +Z (thrust convention) — Matrix4.lookAt is
          // camera-convention (-z view), so eye/target swap to point +z there.
          const look = new THREE.Matrix4().lookAt(target, pos, new THREE.Vector3(0, 1, 0));
          reset(pos, new THREE.Quaternion().setFromRotationMatrix(look));
        } else {
          reset(cam.position, cam.quaternion);
        }

        // Disable the graph's camera controls so we own the camera.
        if (typeof ref.enableNavigationControls === 'function') {
          ref.enableNavigationControls(false);
        }
        const controls = ref.controls() as { enabled?: boolean };
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
        const controls = ref.controls() as { enabled?: boolean };
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
          // By the time the force runs, the engine has resolved id targets
          // into node objects — type the callback to that runtime shape.
          linkForce.distance((l: { semantic?: boolean; distance?: number; target?: GraphNode }) =>
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
          forceCollide((n: CanvasNode) => Math.sqrt(nodeSize(n)) * 2.4 + 4),
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
      const node = graphData.nodes.find((n) => n.id === focusId) as GraphNode | undefined;
      if (!ref || !node || node.x === undefined) return;
      const ctrl = (typeof ref.controls === 'function' ? ref.controls() : null) as {
        target?: { x: number; y: number; z: number };
      } | null;
      const cam = (typeof ref.camera === 'function' ? ref.camera() : null) as {
        position?: { x: number; y: number; z: number };
      } | null;
      const nz = node.z ?? 0;
      if (ctrl?.target && cam?.position) {
        const dTarget = Math.hypot(node.x - ctrl.target.x, node.y - ctrl.target.y, nz - ctrl.target.z);
        const dCamera = Math.hypot(node.x - cam.position.x, node.y - cam.position.y, nz - cam.position.z);
        if (dTarget < NEAR_HOP_TARGET && dCamera < NEAR_HOP_CAMERA) return;
      }
      // Approach from the CURRENT viewing side. A fixed +z destination flipped
      // the camera to the node's far side whenever the user had orbited past
      // it — the scene mirror-swung mid-flight. Flying along the existing
      // camera→node sightline keeps the same framing distance with no flip.
      let dest = { x: node.x, y: node.y, z: nz + 260 };
      if (cam?.position) {
        const vx = cam.position.x - node.x;
        const vy = cam.position.y - node.y;
        const vz = cam.position.z - nz;
        const len = Math.hypot(vx, vy, vz);
        if (len > 1e-3) {
          const k = 260 / len;
          dest = { x: node.x + vx * k, y: node.y + vy * k, z: nz + vz * k };
        }
      }
      // The x-undefined guard above ensures the engine has placed the node.
      ref.cameraPosition(dest, node as { x: number; y: number; z: number }, warpMs(1100));
    }, 400);
    return () => clearTimeout(t);
  }, [focusId, graphData, mode]);

  const handleClick = useCallback((node: GraphNode) => onNodeClick(node.id), [onNodeClick]);

  // Per-frame update in ship mode: physics, animation, camera, trail.
  const updateFrame = useCallback(
    (dt: number) => {
      const ref = fgRef.current;
      const model = modelRef.current;
      if (!ref || !model) return;

      tick(dt);

      const ship = shipRef.current;
      const cam = ref.camera() as THREE.PerspectiveCamera;
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

  // Cube name plates are per-node canvas textures — cap them to small fields
  // so a 20k-file mapping doesn't allocate 20k sprite canvases at once.
  const fileLabels = useMemo(
    () => Boolean(coreView) && nodes.filter((n) => n.object && n.path).length <= 400,
    [nodes, coreView],
  );

  // Always-on labels: galaxy names (categories) so the observer never loses
  // orientation, and star names so semantic hits are readable at a glance.
  // Everything else keeps the hover tooltip only. Returning a falsy object
  // with nodeThreeObjectExtend keeps the default sphere; the sprite is
  // ADDED next to it, not a replacement.
  const nodeThreeObject = useCallback((node: GraphNode) => {
    // Objects: a typed body REPLACES the default sphere (extend=false below).
    // In the core view, fs-file leaves become satellite CUBES (lang-coloured,
    // named while the field is small enough to stay legible).
    if (node.object) {
      if (coreView && node.path) return buildFileCube(node, fileLabels);
      return buildAssetMesh(node);
    }
    // Repo folder hubs: the language-banded identicon sphere REPLACES the
    // default hub sphere (extend=false below).
    if (node.repo) return buildRepoMesh(node);
    // Files-core folders: the default sphere is the hub, a permanent label
    // names it — folder names ARE the orientation inside the core.
    if (node.folder) {
      const g = new THREE.Group();
      const sprite = new SpriteText(node.name);
      sprite.color = '#cfd8ec';
      sprite.textHeight = 2.8;
      sprite.fontSize = 110;
      sprite.fontWeight = '600';
      sprite.backgroundColor = 'rgba(8,12,22,0.86)';
      sprite.padding = 1.6;
      sprite.borderRadius = 1.5;
      sprite.borderWidth = 0.4;
      sprite.borderColor = 'rgba(180,195,225,0.35)';
      const label = sprite as unknown as THREE.Sprite;
      label.position.y = -(Math.sqrt(nodeSize(node)) * 2.4 + 4);
      label.material.depthWrite = false;
      noRaycast(label);
      g.add(label);
      return g;
    }
    // Taxonomy celestial hierarchy — a level-appropriate halo ADDED next to the
    // default sphere (the sphere is the lens-coloured body): galaxy › constellation
    // › star, then planets (L3) and satellites (L4+) are the bare sphere by size.
    const g = new THREE.Group();
    if (node.level === 0) g.add(nebulaSprite(node.categoryHue)); // galaxy
    else if (node.level === 1) g.add(galaxyDisc(node.categoryHue)); // constellation
    else if (node.level === 2) g.add(starGlow(node.categoryHue)); // star
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
    // Falsy return keeps the default sphere — a runtime contract the library
    // typings don't model (they only allow Object3D), hence the double cast.
    return g.children.length ? g : (false as unknown as THREE.Object3D);
  }, [coreView, fileLabels]);

  // Focus-halo orbits: semantic dust circles the focused node VERY slowly
  // (a revolution takes ~2–3.5 min). Runs outside the d3 engine — the sim
  // cools down and stops syncing, so the animator drives the nodes' three
  // objects directly and draws its own tether lines to the focus center.
  useEffect(() => {
    const dust = graphData.nodes.filter((n: CanvasNode) => n.orbit) as Array<
      CanvasNode & { x?: number; y?: number; z?: number; __threeObj?: THREE.Object3D }
    >;
    if (!dust.length || mode === 'ship') return;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(dust.length * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x8a6a14, transparent: true, opacity: 0.55 });
    const lines = new THREE.LineSegments(geo, mat);
    noRaycast(lines);
    let sceneObj: THREE.Scene | null = null;
    let raf = 0;
    const t0 = performance.now();
    const step = () => {
      const ref = fgRef.current;
      if (ref) {
        if (!sceneObj) {
          try {
            sceneObj = ref.scene();
            sceneObj!.add(lines);
          } catch {
            // Renderer not ready yet — retry next frame.
          }
        }
        // Reduced motion: the halo still forms (placement is information),
        // it just does not revolve.
        const t = REDUCED_MOTION ? 0 : (performance.now() - t0) / 1000;
        dust.forEach((n, i) => {
          const o = n.orbit!;
          const th = o.phase + t * o.speed;
          const x = o.cx + o.r * Math.cos(th);
          const y = o.cy + o.r * Math.sin(th) * Math.sin(o.tilt);
          const z = o.cz + o.r * Math.sin(th) * Math.cos(o.tilt);
          // Keep the data-side coords in step (raycast targets, future focus)
          // AND move the rendered object — the engine stopped syncing.
          n.fx = n.x = x;
          n.fy = n.y = y;
          n.fz = n.z = z;
          n.__threeObj?.position.set(x, y, z);
          pos[i * 6] = o.cx;
          pos[i * 6 + 1] = o.cy;
          pos[i * 6 + 2] = o.cz;
          pos[i * 6 + 3] = x;
          pos[i * 6 + 4] = y;
          pos[i * 6 + 5] = z;
        });
        geo.attributes.position.needsUpdate = true;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      sceneObj?.remove(lines);
      geo.dispose();
      mat.dispose();
    };
  }, [graphData, mode]);


  return (
    <ForceGraph3D
      ref={fgRef}
      controlType="orbit"
      graphData={graphData}
      nodeId="id"
      nodeRelSize={2.4}
      nodeLabel={(n: GraphNode) =>
        n.star ? `☆ ${n.name}${n.distance ? ` · d=${n.distance.toFixed(2)}` : ''}` : n.name
      }
      nodeVal={(n: GraphNode) => nodeSize(n, lens)}
      nodeColor={(n: GraphNode) => nodeColor(n, focusId, lens)}
      nodeThreeObject={nodeThreeObject}
      nodeThreeObjectExtend={(n: GraphNode) => !n.object && !n.repo}
      linkColor={(l: GraphLink) =>
        l.relation
          ? REL_COLOR[l.relType] ?? 'rgba(148,163,184,0.5)'
          : l.mray
            ? 'rgba(45,212,191,0.6)' // mapping-hub tether — the loudest teal
            : l.ray
              // Lines (width 0) ignore per-link alpha — the dimming is baked
              // into the rgb instead (teal ×0.4, slate ×0.45, base ×0.25).
              ? '#12554c' // core tether — teal, the objects' colour family
              : l.olink
                ? '#433064' // object→object ref — violet (#a78bfa ×0.4)
                : l.fs
                  ? '#434953' // folder skeleton — quiet slate
                  : l.semantic
                    ? 'rgba(251,191,36,0.55)'
                    : '#1e2126'
      }
      linkWidth={(l: GraphLink) =>
        // PERF: any non-zero width promotes the link to a TubeGeometry MESH
        // (one draw call each); width 0 renders a GL line. Bulk links (tree
        // skeleton, fs edges, per-object rays — thousands at scale) MUST stay
        // lines; only the sparse overlays may afford tubes.
        l.relation
          ? l.explored === 'barely'
            ? 1.8 // research frontier — brightest/thickest
            : l.explored === 'partially'
              ? 1.1
              : l.explored === 'well'
                ? 0.6
                : 0.8
          : l.mray
            ? 1.4 // mapping-hub tethers — a handful per mapping
            : l.semantic
              ? 1.2 // focus star field — dozens at most
              : 0
      }
      onNodeClick={handleClick}
      backgroundColor="rgba(0,0,0,0)"
      width={width}
      height={height}
      linkOpacity={0.4}
      nodeOpacity={0.92}
      // PERF: the d3 tick (charge + collide over every node) halves the frame
      // rate while it runs, and EVERY graphData change reheats it. Settle
      // faster and stop sooner — pinned stars don't need the sim at all, only
      // the semantic dust does.
      cooldownTime={6000}
      d3AlphaDecay={0.04}
      showNavInfo={false}
      enablePointerInteraction={mode !== 'ship'}
      enableNodeDrag={mode !== 'ship'}
    />
  );
}
