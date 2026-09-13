/**
 * The universe canvas — 3D only (ROADMAP Track U; the 2.5D/2D renderer was
 * retired 2026-07-11 by owner decision: one renderer, one force config).
 *
 * OBSERVER mode: orbit camera over the baked universe. Taxonomy stars arrive
 * PINNED (fx/fy/fz from the U1 layout bake — the spatial-memory contract);
 * the force engine only places free bodies (semantic stars, nebula dust)
 * around them.
 *
 * Stars (semantic hits that are captures/notes/objects, i.e. NOT part of the
 * hard-coded taxonomy) arrive as extra nodes with star=true, linked to the
 * focus by a semantic link whose rest-length grows with vector distance —
 * the force engine then naturally places them "in the distance" behind the
 * focused constellation. Taxonomy hits reuse their existing tree node and
 * only gain the dashed semantic link. Nebula nodes are anchored knowledge
 * objects orbiting their taxonomy star on a short leash.
 *
 * LOD doctrine (explore-decomplexity Phase C): ONE pixel curve. A body draws
 * once it is BODY_PX tall on screen (hysteresis ratio LOD_HYST), a name plate
 * once it is past its per-level gate (roots earlier than leaves). Labels
 * fade opacity rather than popping. All plates are constant-pixel
 * (sizeAttenuation=false). All labels come from ONE proximity pool (cap
 * LABEL_MAX, ranked by px/gate) plus the unconditional focus + hover plates.
 */
import { useMemo, useRef, useEffect, useCallback } from 'react';
import ForceGraph3D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-3d';
import SpriteText from 'three-spritetext';
import { hash01, langOfPath, langColor } from './repoVisuals';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { forceCollide } from 'd3-force-3d';
import { FORM_SIZE, type CelestialForm } from './orbital';

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

// Track R3 typed-relation overlay budget: a SPARSE overlay affords midpoint
// verb plates AND confidence-width tubes (a mesh + draw call each); past this
// the Vazby render as width-0 GL lines with hover-only verbs. One cap, both
// uses — they were provably the identical boolean.
const REL_LABEL_CAP = 300;

// ── The one pixel curve ─────────────────────────────────────────────────────
// Every threshold is a PIXEL number (radius ÷ distance × focal factor), so the
// policy is resolution- and FOV-aware instead of hand-tuned per screen.
const BODY_PX = 2; // a body draws once its on-screen radius passes this
const LABEL_PX = 4; // L2+ / objects — BEFORE bodies are big
const LABEL_PX_L0 = 1.1; // root galaxies: zoomToFit leaves them ~3 px
const LABEL_PX_L1 = 3; // constellations: hidden at fit (~2.3 px), in once you lean in
const LOD_HYST = 0.7; // hide at show×0.7 — one hysteresis ratio, not a second constant
const LABEL_MAX = 48; // proximity-pool cap, largest-on-screen first
const LABEL_TEXT_PX = 14; // constant on-screen text height of every plate
const LABEL_FADE_MS = 360; // opacity lerp; reduced-motion snaps
// The observer camera's FOV — three-render-objects' PerspectiveCamera default.
// Nothing changes it any more (the ship-mode FOV kick is gone), so the
// screen-fraction label scale can be computed once per plate, no per-frame JS.
const CAM_FOV = 50;

// PERF/B2a — above this many observer-view bodies, the per-body Mesh draw calls
// (buildAssetMesh) are the bound, so the bodies collapse into per-form
// InstancedMeshes (the effect further down). Below it the individual meshes
// stay — few, cheap, and they keep the apparent-size LOD.
const ORBITAL_INSTANCE_CAP = 300;
// PERF/S4 — same doctrine for core file cubes: past this many the leaves render
// as ONE InstancedMesh instead of thousands of individual cube draw calls.
const CUBE_INSTANCE_CAP = 400;

export interface CanvasNode {
  id: string;
  name: string;
  kind: string;
  level: number;
  childCount: number;
  dataType?: string;
  star?: boolean;
  /** Anchored knowledge object rendering as a typed body orbiting its star. */
  object?: boolean;
  /** Synthetic files-core folder node (`dir:<path>`) — a hub, not data. */
  folder?: boolean;
  /** fs path (objects: file relPath; used for core-view cubes + lang colour). */
  path?: string;
  /** Repo folder hub — bytes-sized default sphere. */
  repo?: boolean;
  /** Subtree file bytes (repo hubs) — modulates the sphere size. */
  bytes?: number;
  /** Extension byte buckets (repo hubs) — the language mix source. */
  exts?: Array<[string, number]>;
  /** Celestial form (objects only) — planet | moon | asteroid | comet | station. */
  form?: CelestialForm;
  /** Anchor taxonomy node id (objects) — the star this body orbits. */
  anchor?: string;
  glyph?: string;
  distance?: number;
  categoryHue: number;
  /** Knowledge scope = subtree size (descendants) — drives node SIZE. */
  scope?: number;
  /** Core-view relocated user-root subtree (slug roots) — damps the L0 halo
   *  so a 560u nebula sprite never sits inside the core. */
  sat?: boolean;
  /** Focus-halo orbit (semantic dust): slow revolution around the focus. */
  orbit?: { cx: number; cy: number; cz: number; r: number; phase: number; tilt: number; speed: number };
  /** Recency (unix seconds): objects = file mtime / card updatedAt; folder
   *  hubs = newest descendant. The "Recent" lens age gradient reads this. */
  mtime?: number;
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
  /** Track R3 typed cross-type relation (Vazby): registry colour + verb label +
   *  confidence-driven width. Distinct from the ToE `relation` layer above. */
  vazba?: boolean;
  relVerb?: string;
  relColor?: string | null;
  confidence?: number | null;
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
  /** Recency lens: recolour objects/hubs on the mtime age gradient. */
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

export interface LensState { axis?: string }

// ── Recency lens ─────────────────────────────────────────────────────────────
// axis === RECENT_AXIS recolours knowledge objects (file mtime / card
// updatedAt) and folder hubs (newest descendant) on an age gradient — hot
// amber for this week cooling to steel blue at a year+. Taxonomy stars keep
// their structural hue. RECOLOR ONLY — zero position changes (spatial memory).
export const RECENT_AXIS = 'recent';
const WEEK_S = 7 * 86400;
const YEAR_S = 365 * 86400;
function ageColor(mtime: number, focus = false): string {
  const age = Math.max(0, Date.now() / 1000 - mtime);
  // t: 0 = touched this week (hot) → 1 = a year+ old (cold). Log-scaled so
  // weeks/months spread across the gradient instead of bunching at cold.
  const t = age <= WEEK_S ? 0 : Math.min(1, Math.log(age / WEEK_S) / Math.log(YEAR_S / WEEK_S));
  const hue = 18 + t * 200; // hot amber-orange → cold steel blue
  const sat = 85 - t * 35;
  return `hsl(${hue} ${sat}% ${focus ? 78 : 60}%)`;
}
/** Object-mesh body colour — the recency lens overrides the identity hue. */
function bodyColor(node: CanvasNode, fallback: string, lens?: LensState): string {
  if (lens?.axis === RECENT_AXIS && node.mtime !== undefined) return ageColor(node.mtime);
  return fallback;
}

/** The body colour a knowledge object / file cube renders with, given the view
 *  + lens. Shared by the mesh builders (initial paint) and the in-place lens
 *  recolour (GraphCanvas) so the two can NEVER drift — file cubes carry the
 *  language colour, everything else the data-type hue; the recency lens
 *  overrides both. */
function objectBodyColor(node: CanvasNode, coreView: boolean, lens?: LensState): string {
  if (coreView && node.path) {
    const lang = langOfPath(node.path);
    return bodyColor(node, lang ? langColor(lang) : `hsl(${node.categoryHue}, 70%, 60%)`, lens);
  }
  return bodyColor(node, `hsl(${node.categoryHue}, 54%, 59%)`, lens);
}

function nodeColor(n: CanvasNode, focusId: string | null, lens?: LensState): string {
  if (lens?.axis === RECENT_AXIS) {
    // Recency lens: only objects + folder hubs shift to the age gradient;
    // everything else falls through to its structural colour untouched.
    if ((n.object || n.folder) && n.mtime !== undefined)
      return ageColor(n.mtime, n.id === focusId);
  }
  if (n.folder) return `hsl(${n.categoryHue} 22% 64% / 0.9)`; // core folder hub — slate (215)
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

function nodeSize(n: CanvasNode): number {
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
  return base;
}

/** Rendered radius of the body an object actually draws with. Objects REPLACE
 *  the default sphere with a form mesh scaled by bodyScale(); everything else
 *  IS the default sphere (√val · nodeRelSize). ONE function shared by the LOD,
 *  the label offset, the hover offset and the focus pulse — four call sites
 *  that previously each used a radius the bodies didn't have. */
function renderedRadius(n: CanvasNode): number {
  return n.object ? bodyScale(n) : Math.sqrt(Math.max(nodeSize(n), 0.01)) * 2.4;
}

/** On-screen body radius at which a name plate may appear. Roots are the
 *  overview's orientation skeleton — they must read from farther than a leaf. */
function labelGatePx(n: CanvasNode): number {
  if (n.object || n.star) return LABEL_PX;
  const lvl = n.level ?? 2;
  if (lvl <= 0) return LABEL_PX_L0;
  if (lvl === 1) return LABEL_PX_L1;
  return LABEL_PX;
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

const _nebulaTex = radialSprite('rgba(255,255,255,0.9)', 'rgba(255,255,255,0.28)');
const _discTex = radialSprite('rgba(255,255,255,1)', 'rgba(255,255,255,0.35)');

/** Hollow ring — the focus pulse outline (a stroke, not a glow blob). */
function ringTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 7;
  g.beginPath();
  g.arc(64, 64, 54, 0, Math.PI * 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}
const _pulseTex = ringTexture();

// Decorative overlays (nebula halo, galaxy disc, labels) must NOT intercept
// clicks — a 560u nebula sprite would swallow every click meant for a star
// inside that domain. Disable raycast so only the node's core sphere (or an
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

/** Rendered radius of an object's form mesh — size IS the data channel
 *  (FORM_SIZE per type), no per-body jitter corrupting it. */
function bodyScale(node: CanvasNode): number {
  return (FORM_SIZE[node.form ?? 'asteroid'] ?? 1.4) * 2.4;
}

/** One typed orbital body: a per-form mesh (new Mesh off shared geometry). */
function buildAssetMesh(node: CanvasNode, lens?: LensState): THREE.Object3D {
  const form = node.form ?? 'asteroid';
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(objectBodyColor(node, false, lens)),
  });
  const mesh = new THREE.Mesh(_formGeo[form] ?? _formGeo.asteroid, mat);
  mesh.scale.setScalar(bodyScale(node));
  return mesh;
}

const _cubeGeo = new THREE.BoxGeometry(1, 1, 1);

// ── The ONE plate recipe ─────────────────────────────────────────────────────
// Constant-pixel text: sizeAttenuation=false makes three's sprite shader
// multiply the scale by the view depth, so a scale expressed as a screen
// fraction renders at the same pixel size at ANY distance — zero per-frame JS.
// screen px = scale · viewH / (2·tan(fov/2))  ⇒  scale = px · 2·tan(fov/2) / viewH.
function plate(
  text: string,
  textPx: number,
  viewH: number,
  opts: { color?: string; bg?: string; border?: string } = {},
): THREE.Sprite {
  const sprite = new SpriteText(text);
  sprite.color = opts.color ?? '#dfe6f5';
  sprite.textHeight = 1; // unit text height — the screen-fraction scale below is then exact
  sprite.fontSize = 110; // higher-res canvas → sharper, less blur when scaled
  sprite.fontWeight = '600';
  // Solid dark plate + hairline border so labels read as data annotations,
  // not glowing sci-fi text — legible over bright stars/nebulae.
  sprite.backgroundColor = opts.bg ?? 'rgba(8,12,22,0.86)';
  sprite.padding = 0.55;
  sprite.borderRadius = 0.5;
  sprite.borderWidth = 0.14;
  sprite.borderColor = opts.border ?? 'rgba(180,195,225,0.35)';
  const label = sprite as unknown as THREE.Sprite;
  label.material.depthWrite = false;
  label.material.depthTest = false; // else closer bodies eat the plate (renderOrder is not enough)
  label.material.sizeAttenuation = false;
  label.material.transparent = true;
  const s = (2 * Math.tan((CAM_FOV * Math.PI) / 360) * textPx) / Math.max(viewH, 1);
  label.scale.set(label.scale.x * s, label.scale.y * s, 1);
  // Hang the plate fully BELOW its anchor point (the body's bottom edge), so
  // a constant-pixel plate never covers the body it names at any distance.
  label.center.set(0.5, 1.05);
  return noRaycast(label) as THREE.Sprite;
}

/** Core-view file leaf: a small satellite cube, lang-coloured. Names come from
 *  the proximity label pool like everything else. */
function buildFileCube(node: CanvasNode, lens?: LensState): THREE.Object3D {
  const color = objectBodyColor(node, true, lens);
  const mesh = new THREE.Mesh(_cubeGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }));
  mesh.scale.setScalar(2.6);
  mesh.rotation.y = hash01(node.id) * Math.PI; // deterministic variety
  mesh.rotation.x = hash01(`${node.id}:x`) * 0.5;
  return mesh;
}

// ── PERF — instanced regimes ─────────────────────────────────────────────────
// Above the caps, bodies render as InstancedMeshes drawn from a SCENE overlay
// instead of thousands of individual Mesh draw calls. Each node still gets its
// own invisible-but-raycastable stub as its nodeThreeObject, so
// react-force-graph positions it and per-node picking is unchanged; the overlay
// only mirrors those pinned positions. three r0.185 raycasts objects regardless
// of `visible` (Raycaster tests layers, not visibility), so an invisible stub
// stays clickable at the body's exact bounds, and the overlay lives outside the
// forceGraph subtree so RFG's own raycaster never sees it.
const _cubeInstMat = new THREE.MeshBasicMaterial(); // white base; per-instance colour tints it
const _stubMat = new THREE.MeshBasicMaterial(); // never rendered (the stub is visible=false)
const _assetInstMat = new THREE.MeshBasicMaterial();

/** Core-view file leaf, instanced variant: an invisible pick stub matching the
 *  cube's bounds + rotation. The visible body is drawn by the overlay below. */
function fileCubeStub(node: CanvasNode): THREE.Object3D {
  const mesh = new THREE.Mesh(_cubeGeo, _stubMat);
  mesh.scale.setScalar(2.6); // match buildFileCube — this IS the raycast target
  mesh.rotation.y = hash01(node.id) * Math.PI;
  mesh.rotation.x = hash01(`${node.id}:x`) * 0.5;
  mesh.visible = false; // 0 draw calls; still raycastable (three tests layers, not visible)
  return mesh;
}

/** Observer-view orbital body, instanced variant: an invisible pick stub
 *  matching the per-form body geometry/scale. The visible body is drawn by the
 *  per-form InstancedMesh overlay below. */
function assetStub(node: CanvasNode): THREE.Object3D {
  const form = node.form ?? 'asteroid';
  const mesh = new THREE.Mesh(_formGeo[form] ?? _formGeo.asteroid, _stubMat);
  mesh.scale.setScalar(bodyScale(node)); // match buildAssetMesh
  mesh.visible = false; // 0 draw calls; still raycastable (three tests layers, not visible)
  return mesh;
}

/** A CanvasNode as the force engine sees it (position/velocity fields added). */
type GraphNode = NodeObject<CanvasNode>;
/** A CanvasLink as the force engine sees it (source/target become node refs). */
type GraphLink = LinkObject<CanvasNode, CanvasLink>;

/** Objects REPLACE the default sphere (their body IS the custom mesh); every
 *  other class extends it (halo added beside the sphere body). Module-level =
 *  a STABLE identity: an inline arrow here changes every render, and
 *  react-force-graph clears its whole node-object cache (rebuilding every
 *  mesh) whenever this accessor's identity changes — S3 must not pay that on a
 *  lens toggle. */
const extendsDefaultSphere = (n: GraphNode) => !n.object;
type GraphRef = ForceGraphMethods<GraphNode, GraphLink>;

export default function GraphCanvas({ nodes, links, focusId, onNodeClick, width, height, lens, coreView }: Props) {
  const fgRef = useRef<GraphRef | undefined>(undefined);
  const didFitRef = useRef(false);
  const coreViewRef = useRef(coreView);
  // Live lens, read by nodeThreeObject WITHOUT being one of its deps: keeping
  // it out of the useCallback deps holds the accessor's identity stable across
  // a lens toggle, so react-force-graph never clears its node-object cache (a
  // full mesh rebuild). The toggle's recolour is applied in place below.
  const lensRef = useRef(lens);
  lensRef.current = lens;
  // Live focus for the label pool (a focus change must not rebuild the pool).
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  // PERF/S4: the live scene-overlay InstancedMesh of core file cubes (null when
  // not in the instanced regime). The build effect owns its lifecycle; the lens
  // effect recolours it in place.
  const cubeOverlayRef = useRef<THREE.InstancedMesh | null>(null);
  // B2a — per-form InstancedMeshes for the observer orbital bodies, each paired
  // with its source node list so the lens recolour maps instance→node.
  const assetOverlayRef = useRef<Array<{ mesh: THREE.InstancedMesh; nodes: CanvasNode[] }> | null>(null);

  // THE one rAF loop. Every animated concern (dust orbit, LOD + label pool,
  // focus pulse) registers a per-frame task here instead of owning its own
  // requestAnimationFrame — one loop, one camera read per frame.
  const frameTasks = useRef(new Set<(now: number) => void>());
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      for (const t of frameTasks.current) t(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Files core: fly INTO the ring center when the core switches on, back out
  // to the whole sky when it switches off.
  useEffect(() => {
    if (coreViewRef.current === coreView) return;
    coreViewRef.current = coreView;
    const ref = fgRef.current;
    if (!ref) return;
    try {
      if (coreView) {
        // Frame radius ~1000: the central core (≤420) plus the SAT ring (700)
        // where standalone mappings AND relocated user-root constellations sit
        // — the old 820u close-up cropped everything on that ring.
        ref.cameraPosition({ x: 0, y: -320, z: 1550 }, { x: 0, y: 0, z: 0 }, warpMs(1200));
      } else {
        ref.zoomToFit(warpMs(900), 60);
      }
    } catch {
      // Renderer not ready — the toggle just skips the flight.
    }
  }, [coreView]);

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

  const graphData = useMemo(() => {
    // force-graph mutates its input (source/target become object refs) —
    // hand it shallow copies so React Query's cache stays clean.
    return {
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    };
  }, [nodes, links]);

  // S3 force-sim freeze: taxonomy stars, objects, folder/repo hubs AND the
  // focus-halo dust all arrive fx/fy/fz-pinned (spatial-memory contract), so
  // the d3 sim has NOTHING to solve unless an orbit-less fallback dust node is
  // unpinned. When none is, the engine is frozen outright (cooldownTicks 0) —
  // positions still init from fx, so nothing moves.
  const hasUnpinnedNode = useMemo(
    () => graphData.nodes.some((n) => n.fx == null),
    [graphData],
  );

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
        // clusters don't sit on top of each other. S3: a pinned node (fx set)
        // never moves and shouldn't push either — gate both forces to 0 for
        // pinned nodes so only the unpinned fallback dust participates.
        const charge = ref.d3Force('charge');
        if (charge) charge.strength((n: CanvasNode) => (n.fx != null ? 0 : -55));
        ref.d3Force(
          'collide',
          forceCollide((n: CanvasNode) => (n.fx != null ? 0 : renderedRadius(n) + 4)),
        );
        // Only reheat when there's actually an unpinned node to solve for;
        // otherwise the engine is frozen (cooldownTicks 0) and a reheat would
        // just spin one no-op cycle.
        if (hasUnpinnedNode) ref.d3ReheatSimulation();
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
  }, [graphData, hasUnpinnedNode]);

  // Warp to the focused node once the engine placed it — the "semantic
  // hyperspace jump" (search or click sets focus, the camera travels).
  useEffect(() => {
    if (!focusId) return;
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
  }, [focusId, graphData]);

  const handleClick = useCallback((node: GraphNode) => onNodeClick(node.id), [onNodeClick]);

  // HOVER PLATE — a name for whatever the cursor is on, unconditionally.
  // The label pool is a budget; this answers a direct question — "what is
  // that?" — so it obeys nothing: no cap, no pixel gate, one plate at a time.
  // Same recipe as the pool plates, only slightly brighter, because it is the
  // one you asked about.
  const hoverRef = useRef<{ id: string; sprite: THREE.Sprite } | null>(null);
  const handleHover = useCallback((node: GraphNode | null) => {
    const ref = fgRef.current;
    if (!ref) return;
    let scene: THREE.Scene;
    try {
      scene = ref.scene();
    } catch {
      return; // renderer not ready
    }
    const cur = hoverRef.current;
    const n = node as CanvasNode | null;
    if (cur && cur.id === n?.id) return; // same node — nothing to redraw
    if (cur) {
      scene.remove(cur.sprite);
      (cur.sprite.material.map as THREE.Texture | null)?.dispose?.();
      cur.sprite.material.dispose();
      hoverRef.current = null;
    }
    const nx = n?.fx ?? (n as GraphNode | null)?.x;
    const ny = n?.fy ?? (n as GraphNode | null)?.y;
    const nz = n?.fz ?? (n as GraphNode | null)?.z;
    if (!n || nx == null || ny == null || nz == null) return;
    const label = plate(n.name, LABEL_TEXT_PX, height, {
      color: '#ffffff',
      bg: 'rgba(8,12,22,0.94)',
      border: 'rgba(125,211,252,0.75)', // sky-300: "this is the one"
    });
    label.position.set(nx, ny - renderedRadius(n), nz);
    label.renderOrder = 999; // never occluded by the body it names
    scene.add(label);
    hoverRef.current = { id: n.id, sprite: label };
  }, [height]);

  // Drop the plate on unmount — a hover that outlives the canvas leaks a
  // texture and paints a name over whatever replaces it.
  useEffect(
    () => () => {
      const cur = hoverRef.current;
      if (!cur) return;
      cur.sprite.parent?.remove(cur.sprite);
      (cur.sprite.material.map as THREE.Texture | null)?.dispose?.();
      cur.sprite.material.dispose();
      hoverRef.current = null;
    },
    [],
  );

  // PERF/S4: instance the file cubes in exactly the regime that is slow — core
  // view with a large field. PERF/B2a: the observer-view twin for orbital
  // bodies. Below the caps the per-node meshes stay (few, cheap).
  const instanceCubes = useMemo(
    () => Boolean(coreView) && nodes.filter((n) => n.object && n.path).length > CUBE_INSTANCE_CAP,
    [nodes, coreView],
  );
  const instanceBodies = useMemo(
    () => !coreView && nodes.filter((n) => n.object).length > ORBITAL_INSTANCE_CAP,
    [nodes, coreView],
  );
  // Track R3 typed-relation overlay: sparse ⇒ midpoint verb plates + confidence
  // tubes; dense ⇒ width-0 GL lines with hover-only verbs.
  const relLabels = useMemo(() => links.filter((l) => l.vazba).length <= REL_LABEL_CAP, [links]);

  // Node meshes. Objects REPLACE the default sphere with their typed body (or
  // an invisible pick stub in the instanced regimes); taxonomy nodes ADD a
  // level-appropriate halo next to the default sphere; everything else IS the
  // default sphere. All NAMES come from the label pool + hover — no permanent
  // per-class plates.
  const nodeThreeObject = useCallback((node: GraphNode) => {
    if (node.object) {
      // lensRef (not lens) so a toggle doesn't change this accessor's identity
      // and force a full mesh rebuild — the body is painted with the live lens
      // here and recoloured in place by the effect below on subsequent toggles.
      const lens = lensRef.current;
      if (coreView && node.path) {
        return instanceCubes ? fileCubeStub(node) : buildFileCube(node, lens);
      }
      return instanceBodies ? assetStub(node) : buildAssetMesh(node, lens);
    }
    // Taxonomy celestial hierarchy — galaxy › constellation › star halos.
    // A relocated user-root (core view, node.sat) trades its 560u nebula for
    // the 70u constellation disc — inside the core the full nebula would
    // additive-bloom the whole center into one white ball.
    if (node.level === 0) return node.sat ? galaxyDisc(node.categoryHue) : nebulaSprite(node.categoryHue);
    if (node.level === 1) return galaxyDisc(node.categoryHue);
    if (node.level === 2) return starGlow(node.categoryHue);
    // Falsy return keeps the default sphere — a runtime contract the library
    // typings don't model (they only allow Object3D), hence the double cast.
    return false as unknown as THREE.Object3D;
  }, [coreView, instanceCubes, instanceBodies]);

  // Lens recolour, IN PLACE (replaces the old fgRef.refresh(), which set
  // _flushObjects → cleared the node-object cache → rebuilt thousands of
  // meshes + canvas textures on every toggle). Object/file BODIES replace the
  // default sphere, so the nodeColor accessor can't reach them; recolour their
  // existing material here. Default spheres (taxonomy/folder hubs) recolour
  // via the nodeColor accessor, which re-reads on this same render. No
  // position, geometry, or object is touched — pure material.color writes.
  useEffect(() => {
    for (const n of graphData.nodes) {
      if (!n.object) continue;
      // Instanced bodies are recoloured via their overlay's instanceColor,
      // not the invisible stub — skip here.
      if (instanceCubes && n.path) continue;
      if (instanceBodies) continue;
      const obj = (n as CanvasNode & { __threeObj?: THREE.Object3D }).__threeObj;
      if (!(obj instanceof THREE.Mesh)) continue;
      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      (mat as THREE.MeshBasicMaterial).color?.set(objectBodyColor(n, Boolean(coreView), lens));
    }
  }, [lens, coreView, graphData, instanceCubes, instanceBodies]);

  // PERF/S4 — the instanced-cube overlay lifecycle. ONE InstancedMesh added to
  // the renderer SCENE (NOT the forceGraph subtree, so react-force-graph's
  // raycaster never traverses it and picking is left entirely to the per-node
  // stubs). Instance matrices come straight from the pinned fx/fy/fz, which is
  // exactly where RFG positions each node's stub, so the visible body and its
  // pick target coincide and spatial memory is byte-identical. Rebuilt only
  // when the node set or the regime flag change, never per frame.
  useEffect(() => {
    if (!instanceCubes) return;
    const cubes = graphData.nodes.filter((n) => n.object && n.path && n.fx != null);
    if (!cubes.length) return;
    const mesh = new THREE.InstancedMesh(_cubeGeo, _cubeInstMat, cubes.length);
    mesh.frustumCulled = false; // one draw call spanning the whole core — don't risk a bad whole-batch cull
    noRaycast(mesh); // belt-and-suspenders; it is not under forceGraph anyway
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    cubes.forEach((n, i) => {
      dummy.position.set(n.fx!, n.fy!, n.fz!);
      dummy.rotation.set(hash01(`${n.id}:x`) * 0.5, hash01(n.id) * Math.PI, 0); // == buildFileCube
      dummy.scale.setScalar(2.6);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, col.set(objectBodyColor(n, true, lensRef.current)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    cubeOverlayRef.current = mesh;
    // Attach once the renderer scene exists (mirrors the dressing guards).
    let raf = 0;
    let scene: THREE.Scene | null = null;
    const attach = () => {
      const ref = fgRef.current;
      if (ref) {
        try {
          scene = ref.scene();
          scene.add(mesh);
          return;
        } catch {
          // Renderer not ready — retry next frame.
        }
      }
      raf = requestAnimationFrame(attach);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      scene?.remove(mesh);
      mesh.dispose(); // frees the instance buffers; shared geo/material are untouched
      cubeOverlayRef.current = null;
    };
  }, [graphData, instanceCubes]);

  // PERF/S4 — recolour the instanced cubes IN PLACE on a lens toggle (recency
  // gradient), the instanceColor twin of the in-place body recolour above. Same
  // filter/order as the build effect, so instance i always maps to node i.
  useEffect(() => {
    const mesh = cubeOverlayRef.current;
    if (!mesh) return;
    const cubes = graphData.nodes.filter((n) => n.object && n.path && n.fx != null);
    const col = new THREE.Color();
    cubes.forEach((n, i) => mesh.setColorAt(i, col.set(objectBodyColor(n, true, lens))));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [lens, graphData]);

  // PERF/B2a — the observer-body overlay lifecycle, the S4 pattern extended to
  // the FIVE celestial forms (each its own geometry → its own InstancedMesh).
  // Matrices come from the pinned fx/fy/fz (byte-identical to where RFG
  // positions each stub), so visible body and pick target coincide.
  useEffect(() => {
    if (!instanceBodies) return;
    const bodies = graphData.nodes.filter((n) => n.object && n.fx != null) as Array<
      CanvasNode & { fx: number; fy: number; fz: number }
    >;
    if (!bodies.length) return;
    const byForm = new Map<CelestialForm, Array<CanvasNode & { fx: number; fy: number; fz: number }>>();
    for (const n of bodies) {
      const f = (n.form ?? 'asteroid') as CelestialForm;
      const arr = byForm.get(f);
      if (arr) arr.push(n);
      else byForm.set(f, [n]);
    }
    const groups: Array<{ mesh: THREE.InstancedMesh; nodes: CanvasNode[] }> = [];
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    for (const [form, list] of byForm) {
      const body = new THREE.InstancedMesh(_formGeo[form] ?? _formGeo.asteroid, _assetInstMat, list.length);
      body.frustumCulled = false; // spans the whole universe — no whole-batch cull
      noRaycast(body); // picking stays on the per-node stubs
      list.forEach((n, i) => {
        dummy.position.set(n.fx, n.fy, n.fz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(bodyScale(n)); // == buildAssetMesh / assetStub
        dummy.updateMatrix();
        body.setMatrixAt(i, dummy.matrix);
        body.setColorAt(i, col.set(objectBodyColor(n, false, lensRef.current)));
      });
      body.instanceMatrix.needsUpdate = true;
      if (body.instanceColor) body.instanceColor.needsUpdate = true;
      groups.push({ mesh: body, nodes: list });
    }
    assetOverlayRef.current = groups;
    let raf = 0;
    let scene: THREE.Scene | null = null;
    const attach = () => {
      const ref = fgRef.current;
      if (ref) {
        try {
          scene = ref.scene();
          for (const g of groups) scene.add(g.mesh);
          return;
        } catch {
          // Renderer not ready — retry next frame.
        }
      }
      raf = requestAnimationFrame(attach);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      if (scene) for (const g of groups) scene.remove(g.mesh);
      for (const g of groups) g.mesh.dispose();
      assetOverlayRef.current = null;
    };
  }, [graphData, instanceBodies]);

  // PERF/B2a — recolour the instanced bodies in place on a lens toggle. The
  // stored node lists preserve the build order, so instance i maps to node i.
  useEffect(() => {
    const groups = assetOverlayRef.current;
    if (!groups) return;
    const col = new THREE.Color();
    for (const { mesh, nodes } of groups) {
      nodes.forEach((n, i) => mesh.setColorAt(i, col.set(objectBodyColor(n, false, lens))));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [lens, graphData]);

  // Focus-halo orbits: semantic dust circles the focused node VERY slowly
  // (a revolution takes ~2–3.5 min). Runs outside the d3 engine — the sim
  // cools down and stops syncing, so the animator drives the nodes' three
  // objects directly and draws its own tether lines to the focus center.
  useEffect(() => {
    const dust = graphData.nodes.filter((n: CanvasNode) => n.orbit) as Array<
      CanvasNode & { x?: number; y?: number; z?: number; __threeObj?: THREE.Object3D }
    >;
    if (!dust.length) return;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(dust.length * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x8a6a14, transparent: true, opacity: 0.55 });
    const lines = new THREE.LineSegments(geo, mat);
    noRaycast(lines);
    let sceneObj: THREE.Scene | null = null;
    const t0 = performance.now();
    const task = () => {
      const ref = fgRef.current;
      if (!ref) return;
      if (!sceneObj) {
        try {
          sceneObj = ref.scene();
          sceneObj!.add(lines);
        } catch {
          return; // renderer not ready yet — retry next frame
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
    };
    const tasks = frameTasks.current;
    tasks.add(task);
    return () => {
      tasks.delete(task);
      sceneObj?.remove(lines);
      geo.dispose();
      mat.dispose();
    };
  }, [graphData]);

  // THE pixel-curve pass: body LOD + the label pool, one camera-driven step.
  //
  // Per moved frame it computes each pinned node's on-screen radius in PIXELS
  // (renderedRadius ÷ distance × focal factor). Individually-drawn observer
  // bodies toggle visibility at BODY_PX (hysteresis LOD_HYST); the LABEL_MAX
  // largest nodes past their *per-level* gate get a constant-pixel name plate
  // (L0 roots from farther than leaves), plus the focus node unconditionally.
  // Rank is "how many times over your own gate" so roots keep the overview
  // slots. Plates fade opacity instead of popping visible.
  // ponytail: the cache grows with every node ever labeled (bounded by node
  // count, rebuilt on graphData change); add an LRU cap if texture memory
  // ever matters.
  useEffect(() => {
    type Pinned = CanvasNode & { fx: number; fy: number; fz: number; __threeObj?: THREE.Object3D };
    // Orbit dust moves per frame — the hover plate covers it; the pool sticks
    // to pinned nodes so a plate's position is set once.
    const cands = graphData.nodes.filter((n) => n.fx != null && !n.orbit) as Pinned[];
    if (!cands.length) return;
    const radius = cands.map((n) => renderedRadius(n));
    const gate = cands.map((n) => labelGatePx(n));
    const byId = new Map(cands.map((n, i) => [n.id, i] as const));
    // Body LOD only applies to objects that own a drawn per-node mesh: the
    // instanced regimes draw everything (cheap), core cubes are dense on
    // purpose, and taxonomy/hub spheres are the orientation skeleton.
    const lodIdx: number[] = [];
    if (!coreView && !instanceBodies) cands.forEach((n, i) => { if (n.object) lodIdx.push(i); });
    const pool = new Map<string, THREE.Sprite>();
    const held = new Set<string>(); // hysteresis: in-band even if currently under the cap
    let want = new Set<string>();
    let scene: THREE.Scene | null = null;
    let lastX = Infinity, lastY = Infinity, lastZ = Infinity;
    let lastFocus: string | null | undefined;
    let lastT = 0;
    let fading = false;
    const focal = height / (2 * Math.tan((CAM_FOV * Math.PI) / 360)); // world→px at unit distance
    const task = (now: number) => {
      const ref = fgRef.current;
      if (!ref) return;
      if (!scene) {
        try {
          scene = ref.scene();
        } catch {
          return; // renderer not ready — retry next frame
        }
      }
      const dt = lastT ? Math.min(now - lastT, 48) : 16;
      lastT = now;
      const cp = ref.camera().position;
      const dmx = cp.x - lastX, dmy = cp.y - lastY, dmz = cp.z - lastZ;
      const camMoved = dmx * dmx + dmy * dmy + dmz * dmz > 0.5;
      const focusNow = focusRef.current;
      // Recompute the want-set only when the camera/focus actually moved; keep
      // ticking while a fade is in flight so plates don't freeze mid-opacity.
      if (camMoved || focusNow !== lastFocus) {
        lastX = cp.x; lastY = cp.y; lastZ = cp.z;
        lastFocus = focusNow;
        const px = new Float64Array(cands.length);
        for (let i = 0; i < cands.length; i++) {
          const n = cands[i];
          const d = Math.hypot(cp.x - n.fx, cp.y - n.fy, cp.z - n.fz) || 1;
          px[i] = (radius[i] / d) * focal;
        }
        for (const i of lodIdx) {
          const obj = cands[i].__threeObj;
          if (!obj) continue;
          if (obj.visible) {
            if (px[i] < BODY_PX * LOD_HYST) obj.visible = false;
          } else if (px[i] > BODY_PX) {
            obj.visible = true;
          }
        }
        for (let i = 0; i < cands.length; i++) {
          const id = cands[i].id;
          if (held.has(id)) {
            if (px[i] < gate[i] * LOD_HYST) held.delete(id);
          } else if (px[i] > gate[i]) {
            held.add(id);
          }
        }
        const vis: Array<{ i: number; score: number }> = [];
        for (const id of held) {
          const i = byId.get(id);
          if (i === undefined) continue;
          vis.push({ i, score: px[i] / gate[i] });
        }
        vis.sort((a, b) => b.score - a.score);
        want = new Set<string>();
        for (const v of vis.slice(0, LABEL_MAX)) want.add(cands[v.i].id);
        if (lastFocus) want.add(lastFocus);
      } else if (!fading) {
        return;
      }
      fading = false;
      const step = REDUCED_MOTION ? 1 : dt / LABEL_FADE_MS;
      for (const id of want) {
        if (pool.has(id)) continue;
        const i = byId.get(id);
        if (i === undefined) continue;
        const n = cands[i];
        const label = plate(n.name, LABEL_TEXT_PX, height);
        (label.material as THREE.SpriteMaterial).opacity = 0;
        label.position.set(n.fx, n.fy - radius[i], n.fz);
        scene.add(label);
        pool.set(id, label);
      }
      for (const [id, s] of pool) {
        const m = s.material as THREE.SpriteMaterial;
        const target = want.has(id) ? 1 : 0;
        const next = m.opacity + Math.sign(target - m.opacity) * Math.min(step, Math.abs(target - m.opacity));
        m.opacity = next;
        s.visible = next > 0.02;
        if (Math.abs(next - target) > 0.02) fading = true;
      }
    };
    const tasks = frameTasks.current;
    tasks.add(task);
    return () => {
      tasks.delete(task);
      for (const [, s] of pool) {
        s.parent?.remove(s);
        (s.material.map as THREE.Texture | null)?.dispose?.();
        s.material.dispose();
      }
      pool.clear();
    };
  }, [graphData, coreView, instanceBodies, height]);

  // Focus pulse — a short blinking outline ring on the focused node once a
  // focus lands (click, search, "Focus in graph"), so the target catches the
  // eye even when the near-hop guard skipped all camera motion — the case the
  // owner flagged: the panel closes, the camera stays, and nothing visibly
  // happened. ~2.6s, tracking the node; reduced motion = steady fade, no blink.
  useEffect(() => {
    if (!focusId) return;
    const node = graphData.nodes.find((n) => n.id === focusId) as
      | (CanvasNode & { x?: number; y?: number; z?: number })
      | undefined;
    if (!node) return;
    const r = Math.max(renderedRadius(node), 2.4);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: _pulseTex,
        color: 0xe8f0ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    noRaycast(sprite);
    let scene: THREE.Scene | null = null;
    const t0 = performance.now();
    const DUR = 2600;
    const tasks = frameTasks.current;
    const task = () => {
      const ref = fgRef.current;
      if (!ref) return;
      if (!scene) {
        try {
          scene = ref.scene();
          scene.add(sprite);
        } catch {
          return; // renderer not ready — retry next frame
        }
      }
      const t = (performance.now() - t0) / DUR;
      if (t >= 1) {
        tasks.delete(task);
        scene?.remove(sprite);
        sprite.material.dispose();
        return; // done — no further frames
      }
      // Follow the node (focus dust keeps orbiting; pinned nodes are static).
      sprite.position.set(node.x ?? node.fx ?? 0, node.y ?? node.fy ?? 0, node.z ?? node.fz ?? 0);
      const blink = REDUCED_MOTION ? 1 : 0.45 + 0.55 * Math.abs(Math.cos(t * Math.PI * 5));
      sprite.material.opacity = (1 - t) * 0.9 * blink;
      sprite.scale.setScalar(r * (3.6 - 1.6 * t));
    };
    tasks.add(task);
    return () => {
      tasks.delete(task);
      scene?.remove(sprite);
      sprite.material.dispose();
    };
  }, [focusId, graphData]);

  // Memoised so the accessor identity only changes on a focus/lens change (an
  // inline arrow changes every render → a node digest every render). These
  // drive the DEFAULT-sphere recolour/resize; on a lens toggle their new
  // identity makes react-force-graph re-read them (cache NOT cleared, no
  // rebuild). Custom object bodies are recoloured by the in-place effect above.
  const nodeColorFn = useCallback((n: GraphNode) => nodeColor(n, focusId, lens), [focusId, lens]);
  const nodeValFn = useCallback((n: GraphNode) => nodeSize(n), []);
  // No HTML tooltip — the in-scene hover plate answers "what is that?".
  const noTooltip = useCallback(() => '', []);
  // Track R3: a verb plate for each typed cross-type edge, capped by relLabels.
  const linkThreeObjectFn = useCallback(
    (l: GraphLink): THREE.Object3D =>
      l.vazba && relLabels && l.relVerb
        ? plate(l.relVerb, 12, height, { color: '#e9eefc' })
        : (false as unknown as THREE.Object3D),
    [relLabels, height],
  );
  // EXTEND (not replace) the default line/tube for a typed edge that carries a
  // verb plate — same predicate as the sprite accessor. With extend the library
  // wraps [default line/tube, sprite] in a group, so the registry-hue/confidence
  // tube (linkColor + linkWidth) still draws AND gets default endpoint
  // positioning; without it the sprite REPLACES the edge and no connector shows.
  // For every other link the predicate is false → unchanged single-object path.
  const linkExtendFn = useCallback(
    (l: GraphLink): boolean => Boolean(l.vazba && relLabels && l.relVerb),
    [relLabels],
  );
  // `link` is typed `object` (not GraphLink) to satisfy the library's standalone
  // LinkPositionUpdateFn generic, which binds its own {} defaults rather than the
  // component's CanvasLink — a narrower param would fail the assignment.
  const linkPositionUpdateFn = useCallback(
    (
      obj: THREE.Object3D,
      coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
      link: object,
    ): boolean => {
      const l = link as GraphLink;
      // Only position the SPRITE, and only in the extended (labeled) regime — the
      // predicate MUST match linkExtendFn/linkThreeObjectFn. `obj` is then the
      // group's custom child (the verb plate); the default tube is positioned by
      // the library because the group is extended. Returning false anywhere else
      // (unlabeled Vazby, bulk lines) lets the default straight-line/tube
      // positioning run — returning true there would strand the tube unpositioned.
      if (!(l.vazba && relLabels && l.relVerb)) return false;
      const { start, end } = coords;
      obj.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
      return true;
    },
    [relLabels],
  );

  return (
    <ForceGraph3D
      ref={fgRef}
      // trackball, not orbit: orbit clamps polar angle at the poles — a drag
      // that reaches the Y axis hits a wall. Trackball has no such stop.
      controlType="trackball"
      graphData={graphData}
      nodeId="id"
      nodeRelSize={2.4}
      nodeLabel={noTooltip}
      nodeVal={nodeValFn}
      nodeColor={nodeColorFn}
      nodeThreeObject={nodeThreeObject}
      nodeThreeObjectExtend={extendsDefaultSphere}
      linkThreeObject={linkThreeObjectFn}
      linkThreeObjectExtend={linkExtendFn}
      linkPositionUpdate={linkPositionUpdateFn}
      // Typed cross-type edges carry their verb on hover — the fallback when a
      // dense Vazby overlay (>REL_LABEL_CAP) drops the always-on midpoint plates,
      // so the verb is never fully invisible. Bulk/other links have no link label.
      linkLabel={(l: GraphLink) => (l.vazba && l.relVerb ? l.relVerb : '')}
      linkColor={(l: GraphLink) =>
        l.vazba
          ? l.relColor ?? 'rgba(148,163,184,0.6)' // typed cross-type: registry hue
          : l.relation
          ? REL_COLOR[l.relType] ?? 'rgba(148,163,184,0.5)'
          : l.ray || l.mray
            // Lines (width 0) ignore per-link alpha — the dimming is baked
            // into the rgb instead. ONE tether colour: object→anchor and
            // hub→anchor answer the same question.
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
        // skeleton, fs edges, rays — thousands at scale) MUST stay lines;
        // only the sparse overlays may afford tubes.
        l.vazba
          ? relLabels
            ? 0.6 + (l.confidence ?? 0.5) * 1.4 // sparse typed overlay: width by confidence (0.6–2.0)
            : 0 // dense overlay → GL line (PERF doctrine: tubes stay sparse)
          : l.relation
          ? 0.8 // ToE research edges — one width, the colour is the channel
          : l.semantic
            ? 1.2 // focus star field — dozens at most
            : 0
      }
      onNodeClick={handleClick}
      onNodeHover={handleHover}
      backgroundColor="rgba(0,0,0,0)"
      width={width}
      height={height}
      linkOpacity={0.4}
      nodeOpacity={0.92}
      // PERF: the d3 tick (charge + collide over every node) halves the frame
      // rate while it runs, and EVERY graphData change reheats it. Settle
      // faster and stop sooner — pinned stars don't need the sim at all, only
      // the semantic dust does.
      // S3: when NOTHING is unpinned (the usual case — all stars/objects/dust
      // are fx-pinned), freeze the engine outright (0 ticks). Positions still
      // initialise from fx, so this moves nothing; it just skips the 6s of
      // no-op ticking. cooldownTime stays 6000 to bound the unpinned case.
      cooldownTicks={hasUnpinnedNode ? Infinity : 0}
      cooldownTime={6000}
      d3AlphaDecay={0.04}
      showNavInfo={false}
    />
  );
}
