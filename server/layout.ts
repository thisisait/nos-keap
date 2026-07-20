/**
 * Deterministic layout bake — U1, the spatial-memory contract (ROADMAP.md).
 *
 * Coordinates are a PURE FUNCTION of the root index (the taxonomy tree):
 *   - galaxies (categories) sit on a fixed ring, alternating above/below the
 *     galactic plane;
 *   - every deeper node is placed on a Fibonacci-sphere direction around its
 *     parent, radius shrinking per level, with a small hash-seeded jitter so
 *     siblings never form artificial lines.
 *
 * The bake persists to `taxonomy_layout` keyed by `layout_version` =
 * ALGO_VERSION + hash of the (id, parentId) structure. Startup re-bakes ONLY
 * when that version changes — i.e. when the root index itself changed (or the
 * algorithm was deliberately bumped, an owner-approved breaking change).
 * Stars never drift; they move only in one atomic, versioned event.
 *
 * Force simulation still runs in the explorer, but taxonomy nodes arrive
 * pinned (fx/fy/fz) — only semantic stars and nebula dust stay free.
 */
import crypto from 'node:crypto';
import { staticNodes, getNode, nodeLevel, isUserRootId, USER_ROOT_MIN, USER_ROOT_MAX, type FlatNode } from './taxonomy';
import * as db from './db';

const ALGO_VERSION = 'v1';
// Depth bound for the placement fixpoint below — a taxonomy deeper than this is
// a bug, not a tree, and the loop must terminate regardless.
const MAX_PLACEMENT_PASSES = 12;

// Galaxy ring + per-level shell radii. Ring spacing (~733 at 12 galaxies on
// r=1400) must stay larger than two L2 shells (2×260) so galaxies don't
// interleave — revisit together, never independently.
const GALAXY_RING_RADIUS = 1400;
const GALAXY_PLANE_LIFT = 160; // alternate ±z so the ring isn't a flat disc
// User-defined roots (ids 90-99) sit on their OWN ring, outside the seed ring.
// They cannot join the seed ring: that ring's angles are i/categories.length, so
// adding one would move all twelve seed domains. A wider radius also gives the
// self-model its own region instead of parking it inside computer science.
const USER_RING_RADIUS = GALAXY_RING_RADIUS * 1.75;
const LEVEL_RADIUS = [0, 260, 110, 48, 26];

function levelRadius(level: number): number {
  if (level < LEVEL_RADIUS.length) return LEVEL_RADIUS[level];
  // Track T decaying tail: free-zone depth shrinks geometrically ("a frog
  // in a lake, on a planet…") with a floor so dust stays clickable.
  const beyond = level - (LEVEL_RADIUS.length - 1);
  return Math.max(6, LEVEL_RADIUS[LEVEL_RADIUS.length - 1] * Math.pow(0.55, beyond));
}

/** Deterministic 0..1 from a node id — the jitter seed. */
function hash01(id: string, salt: string): number {
  const h = crypto.createHash('sha256').update(`${salt}:${id}`).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** i-th of n points, evenly spread on a unit sphere, hash-jittered. */
function fibonacciDirection(i: number, n: number, id: string): [number, number, number] {
  const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * GOLDEN_ANGLE + hash01(id, 'phi') * 0.5;
  return [Math.cos(phi) * r, y, Math.sin(phi) * r];
}

export interface LayoutPoint {
  nodeId: string;
  x: number;
  y: number;
  z: number;
}

/** The version is the contract: algo + the tree structure, nothing else. */
export function computeLayoutVersion(nodes: FlatNode[]): string {
  const structure = nodes
    .map((n) => `${n.id}>${n.parentId ?? ''}`)
    .sort()
    .join('|');
  const h = crypto.createHash('sha256').update(structure).digest('hex').slice(0, 16);
  return `${ALGO_VERSION}:${h}`;
}

export function bakeLayout(nodes: FlatNode[]): LayoutPoint[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pos = new Map<string, [number, number, number]>();
  const out: LayoutPoint[] = [];

  const categories = nodes.filter((n) => !n.parentId);
  categories.forEach((cat, i) => {
    const angle = (i / Math.max(categories.length, 1)) * Math.PI * 2;
    const p: [number, number, number] = [
      Math.cos(angle) * GALAXY_RING_RADIUS,
      Math.sin(angle) * GALAXY_RING_RADIUS,
      (i % 2 === 0 ? 1 : -1) * GALAXY_PLANE_LIFT * (0.5 + hash01(cat.id, 'lift')),
    ];
    pos.set(cat.id, p);
    out.push({ nodeId: cat.id, x: p[0], y: p[1], z: p[2] });
  });

  // Children placed breadth-first so every parent is positioned first.
  const queue = [...categories];
  let level = 1;
  while (queue.length) {
    const next: FlatNode[] = [];
    for (const parent of queue) {
      const pp = pos.get(parent.id)!;
      const children = parent.childIds
        .map((id) => byId.get(id))
        .filter((n): n is FlatNode => Boolean(n));
      children.forEach((child, i) => {
        const dir = fibonacciDirection(i, children.length, child.id);
        const r = levelRadius(level) * (0.85 + hash01(child.id, 'r') * 0.3);
        const p: [number, number, number] = [
          pp[0] + dir[0] * r,
          pp[1] + dir[1] * r,
          pp[2] + dir[2] * r,
        ];
        pos.set(child.id, p);
        out.push({ nodeId: child.id, x: p[0], y: p[1], z: p[2] });
        next.push(child);
      });
    }
    queue.length = 0;
    queue.push(...next);
    level++;
  }
  return out;
}

/**
 * Startup hook: bake iff the stored layout_version differs from the computed
 * one. Returns the active version either way.
 */
export function ensureLayout(): string {
  // The version contract covers the STATIC seed only — dynamically grown
  // nodes (Track T) are appended and must never trigger (or be moved by)
  // a full re-bake. A version change = a release-level seed change; ext
  // nodes are re-appended deterministically right after.
  const nodes = staticNodes();
  const version = computeLayoutVersion(nodes);
  if (db.getLayoutVersion() !== version) {
    const points = bakeLayout(nodes);
    db.saveLayout(points, version);
    console.log(`[layout] baked ${points.length} star positions (${version})`);
  }
  // Fixpoint, not one pass: a grown node needs its PARENT placed first, and
  // listExtNodes orders by (created_at, ordinal) — which says nothing about
  // ancestry. One pass leaves any child that happens to precede its parent with
  // no position until the next boot, and a node without a position has all of
  // its cards skipped. A whole subtree ingested in one go (a user root and its
  // three levels) makes that ordering collision likely rather than exotic.
  let appended = 0;
  const pending = db.listExtNodes().filter((e) => !db.getLayout().has(e.id));
  for (let pass = 0; pass < MAX_PLACEMENT_PASSES && pending.length; pass++) {
    const before = pending.length;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (appendExtNodeToLayout(pending[i])) {
        pending.splice(i, 1);
        appended++;
      }
    }
    if (pending.length === before) break; // no progress → the rest are unplaceable
  }
  if (appended) console.log(`[layout] appended ${appended} grown star(s)`);
  if (pending.length) {
    console.warn(
      `[layout] ${pending.length} grown star(s) unplaceable (parent missing or outside the user-root range): ` +
        pending.slice(0, 5).map((e) => e.id).join(', '),
    );
  }
  return version;
}

/**
 * Deterministic slot for one user-defined root on the outer ring.
 *
 * Offset by half a SEED step (π/12) so a user root never shares a ray with a
 * seed domain: an alignment would need 10i - 12·slot = 5, and the left side is
 * always even. Without the offset a root could sit directly "behind" a domain
 * from the camera's point of view at every orbit.
 */
function userRootPlacement(id: string): [number, number, number] {
  const slots = USER_ROOT_MAX - USER_ROOT_MIN + 1;
  const slot = Number(id) - USER_ROOT_MIN;
  const angle = (slot / slots) * Math.PI * 2 + Math.PI / 12;
  return [
    Math.cos(angle) * USER_RING_RADIUS,
    Math.sin(angle) * USER_RING_RADIUS,
    (slot % 2 === 0 ? 1 : -1) * GALAXY_PLANE_LIFT * (0.5 + hash01(id, 'lift')),
  ];
}

/** Place + persist one grown node. A non-root's parent must already have a
 *  position; a user-defined ROOT has no parent and gets its own ring slot —
 *  without this branch a root received no position at all, and a node without a
 *  position has every one of its cards skipped (`star.x === undefined`). */
export function appendExtNodeToLayout(ext: {
  id: string;
  parentId: string;
  ordinal: number;
}): boolean {
  const node = getNode(ext.id);
  if (!node) return false;
  if (!ext.parentId) {
    if (!isUserRootId(ext.id)) return false;
    const [x, y, z] = userRootPlacement(ext.id);
    db.appendLayoutPoint(ext.id, x, y, z);
    return true;
  }
  const layout = db.getLayout();
  const pp = layout.get(ext.parentId);
  if (!pp) return false;
  const [x, y, z] = appendPlacement(pp, nodeLevel(ext.id), ext.ordinal, ext.id);
  db.appendLayoutPoint(ext.id, x, y, z);
  return true;
}

/**
 * U1 APPEND (Track T): place ONE new node without touching any existing
 * star. Deterministic in (parent position, the node's own ordinal + id) —
 * never in the sibling count, so later appends cannot move earlier ones.
 * Latitude comes from the id hash, longitude walks the golden angle by
 * ordinal; radius is the level shell with the usual jitter.
 */
export function appendPlacement(
  parent: { x: number; y: number; z: number },
  level: number,
  ordinal: number,
  id: string,
): [number, number, number] {
  const y = 2 * hash01(id, 'lat') - 1;
  const rr = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = ordinal * GOLDEN_ANGLE + hash01(id, 'phi') * 0.5;
  const dir: [number, number, number] = [Math.cos(phi) * rr, y, Math.sin(phi) * rr];
  const r = levelRadius(level) * (0.85 + hash01(id, 'r') * 0.3);
  return [parent.x + dir[0] * r, parent.y + dir[1] * r, parent.z + dir[2] * r];
}
