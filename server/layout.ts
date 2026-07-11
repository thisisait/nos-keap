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
import { allNodes, type FlatNode } from './taxonomy';
import * as db from './db';

const ALGO_VERSION = 'v1';

// Galaxy ring + per-level shell radii. Ring spacing (~733 at 12 galaxies on
// r=1400) must stay larger than two L2 shells (2×260) so galaxies don't
// interleave — revisit together, never independently.
const GALAXY_RING_RADIUS = 1400;
const GALAXY_PLANE_LIFT = 160; // alternate ±z so the ring isn't a flat disc
const LEVEL_RADIUS = [0, 260, 110, 48, 26];

function levelRadius(level: number): number {
  return LEVEL_RADIUS[level] ?? 18;
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
  const nodes = allNodes();
  const version = computeLayoutVersion(nodes);
  if (db.getLayoutVersion() !== version) {
    const points = bakeLayout(nodes);
    db.saveLayout(points, version);
    console.log(`[layout] baked ${points.length} star positions (${version})`);
  }
  return version;
}
