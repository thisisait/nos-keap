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

// PERF/S2 label LOD budgets. Every SpriteText is one canvas + CanvasTexture, so
// a deep folder tree or a dense star field must not allocate thousands of them.
// Beyond these counts the labels fall back to hover-only (nodeLabel tooltip) —
// the same budget the file-cube name plates (fileLabels) already enforce.
const STAR_LABEL_CAP = 400; // level-2 star names
const FOLDER_LABEL_CAP = 400; // files-core folder-hub names
// Galaxy/constellation names are orientation anchors, kept always-on UNTIL the
// object field itself is huge — past that even the top tier is too dense to read.
const HUGE_FIELD = 5000; // objects

// U2″ Phase B (B1) — orbital-object LOD by APPARENT size. A body shows once its
// angular size (rendered radius ÷ camera distance) rises past SHOW and hides
// once it falls below HIDE; the SHOW>HIDE gap is hysteresis, so a body sitting
// exactly at the boundary can't flicker on/off frame to frame. Bigger bodies
// (planets) clear SHOW from farther, so the constellation overview reveals a
// few largest per star; small moons only cross it as the camera closes in — the
// "solar system" materialises on approach WITHOUT a click, and dense stars
// never flood the wide view. Tunables: raise SHOW to reveal later (sparser
// overview), lower it to reveal sooner. rendered radius = √(nodeVal)·nodeRelSize.
const ORBITAL_LOD_SHOW = 0.01; // ~visible when radius/dist exceeds this
const ORBITAL_LOD_HIDE = 0.007; // ~hidden when it drops below this

// PERF/B2a — above this many observer-view bodies, the per-body Mesh draw calls
// (buildAssetMesh) are the bound, so the bodies collapse into per-form
// InstancedMeshes (the effect further down). Below it the individual meshes stay
// — few, cheap, and they keep the ring/tail dressing + the apparent-size LOD.
const ORBITAL_INSTANCE_CAP = 300;
// Below this the apparent-size hiding stays OFF — a small/typical field shows
// every body in full form (the owner's ask). Hiding only declutters the medium
// band (ORBITAL_LOD_MIN … ORBITAL_INSTANCE_CAP); above the cap bodies are
// instanced (all drawn), and the 'full' detail toggle disables hiding outright.
const ORBITAL_LOD_MIN = 150;

// B2b — cluster nebula impostors. Each anchor's orbiting bodies aggregate into a
// soft nebula sprite (dominant hue, sized by the body cloud's extent). It
// cross-fades by APPARENT size (extent ÷ camera distance): a cluster that's
// small on screen (zoomed out / far) shows its nebula; as the camera closes and
// the cluster fills more of the view, the nebula fades out and the individual
// bodies take over. So a distant dense region reads as a shaped nebula instead
// of a wall of overlapping bodies — the U2″ vision, with the Phase-C shader
// nebula later replacing this radial sprite.
const IMPOSTOR_FADE_MIN = 0.05; // ≤ this apparent size → nebula at full opacity
const IMPOSTOR_FADE_MAX = 0.32; // ≥ this → nebula gone, bodies fully in charge

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
  /** Anchor taxonomy node id (objects) — the star this body orbits; the key the
   *  B2b cluster impostors aggregate by. */
  anchor?: string;
  glyph?: string;
  distance?: number;
  categoryHue: number;
  /** Knowledge scope = subtree size (descendants) — drives node SIZE. */
  scope?: number;
  /** Focus-halo orbit (semantic dust): slow revolution around the focus. */
  orbit?: { cx: number; cy: number; cz: number; r: number; phase: number; tilt: number; speed: number };
  /** Recency (unix seconds): objects = file mtime / card updatedAt; folder
   *  hubs = newest descendant. The "Recent" lens age gradient reads this. */
  mtime?: number;
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
  /** Detail mode. 'auto' (default) lets the perf LODs engage at scale
   *  (instancing above the cap, apparent-size hiding for medium fields); 'full'
   *  forces every body in full form — no instancing, no hiding — for when the
   *  field is small enough to just show everything. */
  detail?: 'auto' | 'full';
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
  // Softer saturation than the old neon 70/60, plus a deterministic per-body
  // lightness jitter — a dense field then reads with depth and variety instead
  // of a flat wall of identically-saturated blobs.
  const j = hash01v(`${node.id}:l`);
  return bodyColor(node, `hsl(${node.categoryHue}, 54%, ${52 + j * 14}%)`, lens);
}

function nodeColor(n: CanvasNode, focusId: string | null, lens?: LensState): string {
  if (lens?.axis === RECENT_AXIS) {
    // Recency lens: only objects + plain folder hubs shift to the age
    // gradient (repo spheres keep their language texture); everything else
    // falls through to its structural colour untouched.
    if ((n.object || n.folder) && !n.repo && n.mtime !== undefined)
      return ageColor(n.mtime, n.id === focusId);
  } else if (lens?.axis && !n.object && !n.star) {
    // Semantic lens: taxonomy stars are recoloured by their axis projection; the
    // structural hue (below) is the default when the lens is off / feature absent.
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

// Per-BODY variety so a dense field doesn't read as a wall of identical shapes.
// Deterministic (hash of the id) → stable across renders and byte-identical
// between the individual mesh, the pick stub, and the instanced overlay.

/** Rendered radius, with a per-body size jitter on top of the form base. */
function bodyScale(node: CanvasNode): number {
  const form = node.form ?? 'asteroid';
  return (FORM_SIZE[form] ?? 1.4) * 2.4 * (0.62 + hash01v(`${node.id}:s`) * 0.9);
}

/** Ring geometry for a planet, or null. Only ~60% of planets get one, and each
 *  varies in tilt + size — otherwise every planet is the same Saturn. */
function ringSpec(node: CanvasNode): { tiltX: number; tiltZ: number; scale: number } | null {
  if (hash01v(`${node.id}:ring`) < 0.4) return null;
  return {
    tiltX: Math.PI / 2.4 + (hash01v(`${node.id}:rtx`) - 0.5) * 1.5,
    tiltZ: (hash01v(`${node.id}:rtz`) - 0.5) * 0.7,
    scale: 0.82 + hash01v(`${node.id}:rs`) * 0.6,
  };
}

/** One typed orbital body: a per-form mesh (new Mesh off shared geometry). */
function buildAssetMesh(node: CanvasNode, lens?: LensState): THREE.Object3D {
  const form = node.form ?? 'asteroid';
  const size = bodyScale(node);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(objectBodyColor(node, false, lens)),
    // DoubleSide so the planet ring (a flat RingGeometry) stays visible from
    // BOTH hemispheres — with the default FrontSide it back-face-culls and the
    // ring vanishes whenever the camera orbits behind its plane. The body
    // meshes are convex/opaque, so rendering their back faces is a visual no-op.
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(_formGeo[form] ?? _formGeo.asteroid, mat);
  mesh.scale.setScalar(size);
  const ring = form === 'planet' ? ringSpec(node) : null;
  if (ring) {
    const r = new THREE.Mesh(_ringGeo, mat);
    r.rotation.set(ring.tiltX, 0, ring.tiltZ);
    r.scale.setScalar(size * ring.scale);
    noRaycast(r);
    const g = new THREE.Group();
    g.add(mesh, r);
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
function buildFileCube(node: CanvasNode, withLabel: boolean, lens?: LensState): THREE.Object3D {
  const color = objectBodyColor(node, true, lens);
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

// ── PERF/S4 — instanced core cubes ───────────────────────────────────────────
// When the files-core field is large enough that per-cube name plates are
// already culled (fileLabels off), the file leaves render as ONE InstancedMesh
// drawn from a SCENE overlay instead of thousands of individual Mesh draw calls
// — the measured draw-call-bound surface. Each object node still gets its own
// invisible-but-raycastable stub (fileCubeStub) as its nodeThreeObject, so
// react-force-graph positions it and per-node picking is unchanged; the overlay
// only mirrors those pinned positions for rendering. three r0.185 raycasts
// objects regardless of `visible` (Raycaster tests layers, not visibility), so
// an invisible stub stays clickable at the cube's exact bounds, and the overlay
// lives outside the forceGraph subtree so RFG's own raycaster never sees it.
const _cubeInstMat = new THREE.MeshBasicMaterial(); // white base; per-instance colour tints it
const _stubMat = new THREE.MeshBasicMaterial(); // never rendered (the stub is visible=false)
// B2a — shared instance materials for the observer-view orbital bodies. DoubleSide
// so the (reused) planet-ring InstancedMesh renders both faces, same as the
// non-instanced ring. Bodies are convex, so DoubleSide is a no-op for them.
const _assetInstMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const _ringInstMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

/** Core-view file leaf, instanced variant: an invisible pick stub matching the
 *  cube's bounds + rotation. The visible body is drawn by the overlay below. */
function fileCubeStub(node: CanvasNode): THREE.Object3D {
  const mesh = new THREE.Mesh(_cubeGeo, _stubMat);
  mesh.scale.setScalar(2.6); // match buildFileCube — this IS the raycast target
  mesh.rotation.y = hash01v(node.id) * Math.PI;
  mesh.rotation.x = hash01v(`${node.id}:x`) * 0.5;
  mesh.visible = false; // 0 draw calls; still raycastable (three tests layers, not visible)
  return mesh;
}

/** B2a — observer-view orbital body, instanced variant: an invisible pick stub
 *  matching the per-form body geometry/scale/rotation. The visible body (and
 *  its ring) is drawn by the per-form InstancedMesh overlay below. */
function assetStub(node: CanvasNode): THREE.Object3D {
  const form = node.form ?? 'asteroid';
  const mesh = new THREE.Mesh(_formGeo[form] ?? _formGeo.asteroid, _stubMat);
  mesh.scale.setScalar(bodyScale(node)); // match buildAssetMesh (varied size)
  mesh.rotation.set(hash01v(`${node.id}:x`) * 0.5, hash01v(node.id) * Math.PI, 0);
  mesh.visible = false; // 0 draw calls; still raycastable (three tests layers, not visible)
  return mesh;
}

/** A CanvasNode as the force engine sees it (position/velocity fields added). */
type GraphNode = NodeObject<CanvasNode>;
/** A CanvasLink as the force engine sees it (source/target become node refs). */
type GraphLink = LinkObject<CanvasNode, CanvasLink>;

/** Objects + repos REPLACE the default sphere (their body IS the custom mesh);
 *  every other class extends it (halo/label added beside the sphere body).
 *  Module-level = a STABLE identity: an inline arrow here changes every render,
 *  and react-force-graph clears its whole node-object cache (rebuilding every
 *  mesh) whenever this accessor's identity changes — S3 must not pay that on a
 *  lens toggle. */
const extendsDefaultSphere = (n: GraphNode) => !n.object && !n.repo;
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

export default function GraphCanvas({ nodes, links, focusId, onNodeClick, width, height, mode, onShipUpdate, lens, coreView, detail = 'auto' }: Props) {
  const forceDetail = detail === 'full';
  const fgRef = useRef<GraphRef | undefined>(undefined);
  const didFitRef = useRef(false);
  const coreViewRef = useRef(coreView);
  const modelRef = useRef<ShipModelParts | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  // Live lens, read by nodeThreeObject WITHOUT being one of its deps: keeping
  // it out of the useCallback deps holds the accessor's identity stable across
  // a lens toggle, so react-force-graph never clears its node-object cache (a
  // full mesh rebuild). The toggle's recolour is applied in place below.
  const lensRef = useRef(lens);
  lensRef.current = lens;
  // PERF/S4: the live scene-overlay InstancedMesh of core file cubes (null when
  // not in the instanced regime). The build effect owns its lifecycle; the lens
  // effect recolours it in place.
  const cubeOverlayRef = useRef<THREE.InstancedMesh | null>(null);
  // B2a — per-form InstancedMeshes for the observer orbital bodies (+ ring mesh),
  // each paired with its source node list so the lens recolour maps instance→node.
  const assetOverlayRef = useRef<Array<{ mesh: THREE.InstancedMesh; nodes: CanvasNode[] }> | null>(null);
  // B2b — cluster nebula impostor sprites + their centroids/extent, cross-faded
  // per frame by camera distance (the effect near the overlays owns the fade).
  const impostorRef = useRef<Array<{
    sprite: THREE.Sprite; cx: number; cy: number; cz: number; extent: number; count: number;
  }> | null>(null);

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
        // clusters don't sit on top of each other (radius tracks the node's
        // rendered size: r = sqrt(val) * nodeRelSize, plus padding).
        // S3: a pinned node (fx set) never moves and shouldn't push either —
        // gate both forces to 0 for pinned nodes so only the unpinned fallback
        // dust participates. Pinned charge/collide was pure wasted iteration.
        const charge = ref.d3Force('charge');
        if (charge) charge.strength((n: CanvasNode) => (n.fx != null ? 0 : -55));
        ref.d3Force(
          'collide',
          forceCollide((n: CanvasNode) => (n.fx != null ? 0 : Math.sqrt(nodeSize(n)) * 2.4 + 4)),
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

  // Same LOD budget for the two other unbounded label sources: folder-hub names
  // and level-2 star names. Both derive from `nodes`, so they only re-evaluate
  // on a graphData change — exactly when the node meshes rebuild anyway.
  const folderLabels = useMemo(
    () => nodes.filter((n) => n.folder).length <= FOLDER_LABEL_CAP,
    [nodes],
  );
  const starLabels = useMemo(
    () => nodes.filter((n) => n.star).length <= STAR_LABEL_CAP,
    [nodes],
  );
  // Galaxy/constellation anchors stay on unless the whole object field is huge.
  const anchorLabels = useMemo(
    () => nodes.filter((n) => n.object).length <= HUGE_FIELD,
    [nodes],
  );
  // PERF/S4: instance the file cubes in exactly the regime that is slow — core
  // view with a field too large for name plates (fileLabels off). Below the cap
  // the per-cube meshes stay (few, cheap, and they carry labels); above it the
  // bodies collapse into ONE InstancedMesh overlay (the effect further down),
  // and nodeThreeObject returns invisible pick stubs instead of drawn cubes.
  const instanceCubes = Boolean(coreView) && !fileLabels;
  // B2a — the observer-view twin: above ORBITAL_INSTANCE_CAP anchored bodies the
  // per-body asset meshes collapse into per-form InstancedMeshes (effect below),
  // and nodeThreeObject returns invisible pick stubs. Below the cap the pretty
  // individual meshes stay (rings/tails + apparent-size LOD). Core view is
  // handled by the cube overlay above, so this is observer-only.
  const instanceBodies = useMemo(
    () => !forceDetail && !coreView && nodes.filter((n) => n.object).length > ORBITAL_INSTANCE_CAP,
    [nodes, coreView, forceDetail],
  );
  // B2b — aggregate anchored bodies into clusters (one per anchor star): centroid
  // (body-cloud mean), extent (bbox half-diagonal), count, and a circular-mean
  // dominant hue. Observer view only, and never in 'full' detail (the owner
  // asked to see everything raw then). One O(bodies) pass.
  const clusters = useMemo(() => {
    if (coreView || forceDetail) return [] as Array<{ cx: number; cy: number; cz: number; extent: number; count: number; hue: number }>;
    type Agg = { n: number; sx: number; sy: number; sz: number; hx: number; hy: number;
      minx: number; maxx: number; miny: number; maxy: number; minz: number; maxz: number };
    const acc = new Map<string, Agg>();
    for (const nd of nodes) {
      if (!nd.object || nd.fx == null || nd.fy == null || nd.fz == null || !nd.anchor) continue;
      let a = acc.get(nd.anchor);
      if (!a) {
        a = { n: 0, sx: 0, sy: 0, sz: 0, hx: 0, hy: 0,
          minx: Infinity, maxx: -Infinity, miny: Infinity, maxy: -Infinity, minz: Infinity, maxz: -Infinity };
        acc.set(nd.anchor, a);
      }
      a.n++;
      a.sx += nd.fx; a.sy += nd.fy; a.sz += nd.fz;
      const h = (nd.categoryHue * Math.PI) / 180;
      a.hx += Math.cos(h); a.hy += Math.sin(h);
      if (nd.fx < a.minx) a.minx = nd.fx; if (nd.fx > a.maxx) a.maxx = nd.fx;
      if (nd.fy < a.miny) a.miny = nd.fy; if (nd.fy > a.maxy) a.maxy = nd.fy;
      if (nd.fz < a.minz) a.minz = nd.fz; if (nd.fz > a.maxz) a.maxz = nd.fz;
    }
    const out: Array<{ cx: number; cy: number; cz: number; extent: number; count: number; hue: number }> = [];
    for (const [, a] of acc) {
      // Skip trivially small clusters — a lone body reads fine as itself.
      if (a.n < 3) continue;
      const extent = 0.5 * Math.hypot(a.maxx - a.minx, a.maxy - a.miny, a.maxz - a.minz) + 8;
      out.push({
        cx: a.sx / a.n, cy: a.sy / a.n, cz: a.sz / a.n,
        extent, count: a.n,
        hue: ((Math.atan2(a.hy, a.hx) * 180) / Math.PI + 360) % 360,
      });
    }
    return out;
  }, [nodes, coreView, forceDetail]);

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
      // lensRef (not lens) so a toggle doesn't change this accessor's identity
      // and force a full mesh rebuild — the body is painted with the live lens
      // here and recoloured in place by the effect below on subsequent toggles.
      const lens = lensRef.current;
      if (coreView && node.path) {
        // Instanced regime: an invisible pick stub; the overlay draws the body.
        if (instanceCubes) return fileCubeStub(node);
        return buildFileCube(node, fileLabels, lens);
      }
      // Observer view, dense field: instanced regime — a pick stub; the per-form
      // overlay draws the body (and ring). Below the cap, the full asset mesh.
      if (instanceBodies) return assetStub(node);
      return buildAssetMesh(node, lens);
    }
    // Repo folder hubs: the language-banded identicon sphere REPLACES the
    // default hub sphere (extend=false below).
    if (node.repo) return buildRepoMesh(node);
    // Files-core folders: the default sphere is the hub, a permanent label
    // names it — folder names ARE the orientation inside the core.
    if (node.folder) {
      // Over budget: keep the default hub sphere, drop the name plate (hover only).
      if (!folderLabels) return false as unknown as THREE.Object3D;
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
    // Two label tiers, each on its own budget: galaxy/constellation ANCHORS
    // (level <= 1) stay on unless the field is huge; STAR names cull past the cap.
    const isAnchor = node.level <= 1;
    if ((isAnchor && anchorLabels) || (!isAnchor && node.star && starLabels)) {
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
    // lens is deliberately NOT a dep (read via lensRef): a lens toggle must not
    // change this accessor's identity, or react-force-graph rebuilds EVERY mesh.
    // The recency recolour is applied in place to the existing bodies below.
  }, [coreView, fileLabels, folderLabels, starLabels, anchorLabels, instanceCubes, instanceBodies]);

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
      // Instanced bodies (core cubes OR observer orbital bodies) are recoloured
      // via their overlay's instanceColor, not the invisible stub — skip here.
      if (instanceCubes && n.path) continue;
      if (instanceBodies) continue;
      const obj = (n as CanvasNode & { __threeObj?: THREE.Object3D }).__threeObj;
      if (!obj) continue;
      // buildAssetMesh/buildFileCube return the body Mesh directly, or a Group
      // whose first child is the body (planet ring / comet tail / file label).
      const body = obj instanceof THREE.Mesh ? obj : obj.children[0];
      if (!(body instanceof THREE.Mesh)) continue;
      const mat = Array.isArray(body.material) ? body.material[0] : body.material;
      (mat as THREE.MeshBasicMaterial).color?.set(objectBodyColor(n, Boolean(coreView), lens));
    }
  }, [lens, coreView, graphData, instanceCubes, instanceBodies]);

  // PERF/S4 — the instanced-cube overlay lifecycle. ONE InstancedMesh added to
  // the renderer SCENE (NOT the forceGraph subtree, so react-force-graph's
  // raycaster — objects([forceGraph]) — never traverses it and picking is left
  // entirely to the per-node stubs). Instance matrices come straight from the
  // pinned fx/fy/fz, which is exactly where RFG positions each node's stub, so
  // the visible body and its pick target coincide and spatial memory is
  // byte-identical. Rebuilt only when the node set or the instanced-regime flag
  // change (graphData is memoised), never per frame — the cubes are static.
  // Caveat: because the matrices are baked once from the pinned coords, actively
  // dragging one of these cubes (enableNodeDrag) moves its invisible stub — and
  // so its click/hover target — but not the drawn body until the next rebuild.
  // Node drag is not a required interaction and dragging a spatial-memory-pinned
  // node contradicts the layout contract anyway, so the overlay stays static.
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
      dummy.rotation.set(hash01v(`${n.id}:x`) * 0.5, hash01v(n.id) * Math.PI, 0); // == buildFileCube
      dummy.scale.setScalar(2.6);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, col.set(objectBodyColor(n, true, lensRef.current)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    cubeOverlayRef.current = mesh;
    // Attach once the renderer scene exists (mirrors the dust / dressing guards).
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
  // filter/order as the build effect, so instance i always maps to node i. No
  // position or geometry is touched — pure instanceColor writes.
  useEffect(() => {
    const mesh = cubeOverlayRef.current;
    if (!mesh) return;
    const cubes = graphData.nodes.filter((n) => n.object && n.path && n.fx != null);
    const col = new THREE.Color();
    cubes.forEach((n, i) => mesh.setColorAt(i, col.set(objectBodyColor(n, true, lens))));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [lens, graphData]);

  // PERF/B2a — the observer-body overlay lifecycle, the S4 pattern extended to
  // the FIVE celestial forms (each its own geometry → its own InstancedMesh) plus
  // one ring InstancedMesh at the planet positions. Matrices come from the pinned
  // fx/fy/fz (byte-identical to where RFG positions each stub), so visible body
  // and pick target coincide. Rebuilt only when the node set / regime change;
  // the comet tail (a Sprite) is dropped in this dense regime, like labels are.
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
        dummy.rotation.set(hash01v(`${n.id}:x`) * 0.5, hash01v(n.id) * Math.PI, 0); // == assetStub
        dummy.scale.setScalar(bodyScale(n)); // per-instance varied size (== buildAssetMesh)
        dummy.updateMatrix();
        body.setMatrixAt(i, dummy.matrix);
        body.setColorAt(i, col.set(objectBodyColor(n, false, lensRef.current)));
      });
      body.instanceMatrix.needsUpdate = true;
      if (body.instanceColor) body.instanceColor.needsUpdate = true;
      groups.push({ mesh: body, nodes: list });
      // Planet rings: a parallel InstancedMesh over ONLY the planets that get a
      // ring (~60%), each with its own tilt + size — matches buildAssetMesh, so
      // the field reads as varied Saturns, not one repeated shape.
      if (form === 'planet') {
        const ringNodes = list.filter((n) => ringSpec(n));
        if (ringNodes.length) {
          const ring = new THREE.InstancedMesh(_ringGeo, _ringInstMat, ringNodes.length);
          ring.frustumCulled = false;
          noRaycast(ring);
          ringNodes.forEach((n, i) => {
            const rs = ringSpec(n)!;
            dummy.position.set(n.fx, n.fy, n.fz);
            dummy.rotation.set(rs.tiltX, 0, rs.tiltZ);
            dummy.scale.setScalar(bodyScale(n) * rs.scale);
            dummy.updateMatrix();
            ring.setMatrixAt(i, dummy.matrix);
            ring.setColorAt(i, col.set(objectBodyColor(n, false, lensRef.current)));
          });
          ring.instanceMatrix.needsUpdate = true;
          if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
          groups.push({ mesh: ring, nodes: ringNodes });
        }
      }
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

  // PERF/B2a — recolour the instanced bodies (+ rings) in place on a lens toggle,
  // the instanceColor twin of the cube-overlay recolour. The stored node lists
  // preserve the build order, so instance i always maps to node i per group.
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

  // PERF/B2b — cluster nebula impostor lifecycle. One additive nebula sprite per
  // cluster, coloured by its dominant hue and scaled to its body cloud. Built
  // when the cluster set changes; the cross-fade effect below drives per-frame
  // opacity. Sprites live in the scene (outside the forceGraph subtree) and never
  // raycast, so picking is untouched.
  useEffect(() => {
    if (!clusters.length) return;
    const built = clusters.map((c) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: _nebulaTex,
          color: new THREE.Color(`hsl(${c.hue.toFixed(0)}, 55%, 55%)`),
          opacity: 0, // the cross-fade sets it every frame
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sprite.position.set(c.cx, c.cy, c.cz);
      sprite.scale.setScalar(c.extent * 2.6); // the glow reads bigger than the cloud
      noRaycast(sprite);
      return { sprite, cx: c.cx, cy: c.cy, cz: c.cz, extent: c.extent, count: c.count };
    });
    impostorRef.current = built;
    let raf = 0;
    let scene: THREE.Scene | null = null;
    const attach = () => {
      const ref = fgRef.current;
      if (ref) {
        try {
          scene = ref.scene();
          for (const b of built) scene.add(b.sprite);
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
      if (scene) for (const b of built) scene.remove(b.sprite);
      for (const b of built) b.sprite.material.dispose(); // shared _nebulaTex kept
      impostorRef.current = null;
    };
  }, [clusters]);

  // PERF/B2b — cross-fade the nebula impostors by apparent size each frame. A
  // cluster small on screen (far / zoomed out) shows its nebula at full opacity;
  // as the camera closes and it fills the view, the nebula fades and the bodies
  // take over. Denser clusters (more bodies) keep a stronger nebula. Cheap: one
  // distance + opacity write per cluster, and an idle guard skips a still camera.
  useEffect(() => {
    if (coreView || mode === 'ship') return;
    let raf = 0;
    let lastX = Infinity;
    let lastY = Infinity;
    let lastZ = Infinity;
    const step = () => {
      const ref = fgRef.current;
      const impostors = impostorRef.current;
      if (ref && impostors) {
        const cp = ref.camera().position;
        const dmx = cp.x - lastX;
        const dmy = cp.y - lastY;
        const dmz = cp.z - lastZ;
        if (dmx * dmx + dmy * dmy + dmz * dmz > 0.5) {
          lastX = cp.x;
          lastY = cp.y;
          lastZ = cp.z;
          for (const im of impostors) {
            const dx = cp.x - im.cx;
            const dy = cp.y - im.cy;
            const dz = cp.z - im.cz;
            const app = im.extent / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
            const frac = Math.min(
              1,
              Math.max(0, (app - IMPOSTOR_FADE_MIN) / (IMPOSTOR_FADE_MAX - IMPOSTOR_FADE_MIN)),
            );
            const maxOp = 0.2 + Math.min(1, im.count / 40) * 0.38; // denser → stronger
            const op = maxOp * (1 - frac);
            (im.sprite.material as THREE.SpriteMaterial).opacity = op;
            im.sprite.visible = op > 0.012;
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [clusters, coreView, mode]);

  // U2″ Phase B (B1) — orbital-object LOD. Toggles each anchored body's mesh
  // visibility by its apparent size (rendered radius ÷ camera distance) with
  // hysteresis, so the "solar system" reveals on approach and dense stars never
  // flood the overview. Observer view only — bodies exist solely there (the core
  // view relocates objects to the ring centre as cubes). Hidden bodies also drop
  // out of the raycast (three skips invisible), which is exactly right: you
  // can't click what you can't see. Cheap: one distance + compare per body, and
  // an idle guard skips the whole pass while the camera is still. In the
  // instanced regime the bodies have no drawn per-node object (only stubs), so
  // toggling stub.visible would be a no-op — skip it; instancing makes drawing
  // them all cheap, and distance declutter of whole clusters is B2b's job.
  useEffect(() => {
    // 'full' detail forces every body visible; the instanced regime handles its
    // own drawing; small/typical fields (≤ ORBITAL_LOD_MIN) show in full form.
    if (coreView || mode === 'ship' || instanceBodies || forceDetail) return;
    const bodies = graphData.nodes.filter(
      (n: CanvasNode) => n.object && n.fx != null,
    ) as Array<CanvasNode & { fx: number; fy: number; fz: number; __threeObj?: THREE.Object3D }>;
    if (bodies.length <= ORBITAL_LOD_MIN) return;
    // Rendered radius per body — object size is lens-independent (nodeSize only
    // scales non-objects by centrality), so precompute once for the effect.
    const radius = bodies.map(
      (n) => Math.sqrt(Math.max(nodeSize(n, lensRef.current), 0.01)) * 2.4,
    );
    let raf = 0;
    let lastX = Infinity;
    let lastY = Infinity;
    let lastZ = Infinity;
    const step = () => {
      const ref = fgRef.current;
      if (ref) {
        const cp = ref.camera().position;
        // Idle guard: re-evaluate only once the camera has actually moved
        // (sub-unit drift can't change any body's LOD band).
        const dmx = cp.x - lastX;
        const dmy = cp.y - lastY;
        const dmz = cp.z - lastZ;
        if (dmx * dmx + dmy * dmy + dmz * dmz > 0.5) {
          lastX = cp.x;
          lastY = cp.y;
          lastZ = cp.z;
          for (let i = 0; i < bodies.length; i++) {
            const obj = bodies[i].__threeObj;
            if (!obj) continue;
            const dx = cp.x - bodies[i].fx;
            const dy = cp.y - bodies[i].fy;
            const dz = cp.z - bodies[i].fz;
            const app = radius[i] / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
            if (obj.visible) {
              if (app < ORBITAL_LOD_HIDE) obj.visible = false;
            } else if (app > ORBITAL_LOD_SHOW) {
              obj.visible = true;
            }
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [graphData, coreView, mode, instanceBodies, forceDetail]);

  // Memoised so the accessor identity only changes on a focus/lens change (an
  // inline arrow changes every render → a node digest every render). These
  // drive the DEFAULT-sphere recolour/resize; on a lens toggle their new
  // identity makes react-force-graph re-read them (cache NOT cleared, no
  // rebuild). Custom object bodies are recoloured by the in-place effect above.
  const nodeColorFn = useCallback((n: GraphNode) => nodeColor(n, focusId, lens), [focusId, lens]);
  const nodeValFn = useCallback((n: GraphNode) => nodeSize(n, lens), [lens]);

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
      nodeVal={nodeValFn}
      nodeColor={nodeColorFn}
      nodeThreeObject={nodeThreeObject}
      nodeThreeObjectExtend={extendsDefaultSphere}
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
      // S3: when NOTHING is unpinned (the usual case — all stars/objects/dust
      // are fx-pinned), freeze the engine outright (0 ticks). Positions still
      // initialise from fx, so this moves nothing; it just skips the 6s of
      // no-op ticking. cooldownTime stays 6000 to bound the unpinned case.
      cooldownTicks={hasUnpinnedNode ? Infinity : 0}
      cooldownTime={6000}
      d3AlphaDecay={0.04}
      showNavInfo={false}
      enablePointerInteraction={mode !== 'ship'}
      enableNodeDrag={mode !== 'ship'}
    />
  );
}
