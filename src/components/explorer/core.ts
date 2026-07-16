/**
 * Files-core layout — the 3D core inside the galaxy ring.
 *
 * The core view relocates knowledge objects (files/documents/cards) from
 * their orbital slots into the EMPTY CENTER of the galaxy ring (the ring
 * sits at r=1400, its innermost taxonomy shells end ~1000 — a core of
 * radius ≤ CORE_MAX stays clear of every star). Taxonomy stars never move:
 * the core is a second, object-only body pinned at the origin, tethered to
 * the taxonomy by RAYS (object → anchor edges).
 *
 * Second-level reordering:
 *   fs        — folder constellations along the filesystem structure
 *               (frontmatter.path from fs-sync / doctrine tree); folders are
 *               synthetic `dir:` nodes, edges follow the tree. DEFAULT.
 *   taxonomy  — objects cluster by their first anchor's galaxy, each cluster
 *               sits at the SAME ring angle as its galaxy (scaled inward), so
 *               rays leave the core radially and never cross it.
 *   topic     — embedding-space clustering OUTSIDE the taxonomy. TBD — needs
 *               a server-side clustering endpoint over object vectors.
 *
 * Pure functions, deterministic in their inputs (same hash-jitter approach as
 * server/layout.ts) — re-renders and toggle round-trips are always stable.
 */
import type { GraphObject } from '@/hooks/useExplorerData';

export type CoreOrder = 'fs' | 'taxonomy' | 'topic';

export const CORE_MAX = 420; // keep well inside the ring's clear zone (~1000)
const FS_LEVEL_RADIUS = [0, 230, 105, 50, 28]; // shells per folder depth
const TAX_RING = 280; // by-taxonomy cluster ring radius
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Cheap deterministic 0..1 from a string (FNV-1a) — mirrors orbital.ts. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** i-th of n points on a unit sphere, hash-jittered (layout.ts twin). */
function fibDir(i: number, n: number, id: string): [number, number, number] {
  const y = n <= 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * GOLDEN_ANGLE + hash01(id) * 0.5;
  return [Math.cos(phi) * r, y, Math.sin(phi) * r];
}

function fsRadius(depth: number): number {
  if (depth < FS_LEVEL_RADIUS.length) return FS_LEVEL_RADIUS[depth];
  const beyond = depth - (FS_LEVEL_RADIUS.length - 1);
  return Math.max(10, FS_LEVEL_RADIUS[FS_LEVEL_RADIUS.length - 1] * Math.pow(0.55, beyond));
}

export interface CoreFolder {
  id: string; // `dir:<path>` ('' path = the core root hub)
  name: string;
  path: string;
  depth: number;
  count: number; // direct children (dirs + files)
}

export interface CoreLayout {
  /** Synthetic folder nodes (fs order only; empty otherwise). */
  folders: CoreFolder[];
  /** Pinned position per node id (`obj:<id>` and `dir:<path>`). */
  positions: Map<string, [number, number, number]>;
  /** Folder-tree edges (dir→dir, dir→obj) — fs order only. */
  fsLinks: Array<{ source: string; target: string }>;
  /** Object → taxonomy-anchor tethers (all orders keep the rays). */
  rays: Array<{ source: string; target: string }>;
}

interface FsTreeDir {
  path: string;
  name: string;
  dirs: Map<string, FsTreeDir>;
  files: GraphObject[];
}

function fsLayout(objects: GraphObject[], unfiledLabel: string): Omit<CoreLayout, 'rays'> {
  const root: FsTreeDir = { path: '', name: '', dirs: new Map(), files: [] };
  const dirOf = (segments: string[]): FsTreeDir => {
    let cur = root;
    let path = '';
    for (const seg of segments) {
      path = path ? `${path}/${seg}` : seg;
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { path, name: seg, dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    return cur;
  };
  // Admin view can carry several users' objects — path trees would collide
  // ("documents/…" × N users), so with multiple owners each tree roots under
  // its owner's uid. The single-user case stays clean and unprefixed.
  const owners = new Set(objects.filter((o) => o.path).map((o) => o.owner ?? ''));
  const multiOwner = owners.size > 1;
  for (const o of objects) {
    if (o.path) {
      const segs = o.path.split('/').filter(Boolean);
      if (multiOwner) segs.unshift(o.owner ?? '?');
      dirOf(segs.slice(0, -1)).files.push(o);
    } else {
      // Hand-written OKF cards without a filesystem identity gather in one
      // pseudo-folder — they belong to the core, just not to a real path.
      dirOf([unfiledLabel]).files.push(o);
    }
  }

  const folders: CoreFolder[] = [];
  const positions = new Map<string, [number, number, number]>();
  const fsLinks: Array<{ source: string; target: string }> = [];

  const place = (dir: FsTreeDir, at: [number, number, number], depth: number) => {
    const dirId = `dir:${dir.path}`;
    positions.set(dirId, at);
    // Stable child order: dirs first, then files, each alphabetical — indices
    // (and so positions) survive unrelated additions elsewhere in the tree.
    const childDirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const childFiles = [...dir.files].sort((a, b) => a.title.localeCompare(b.title));
    folders.push({ id: dirId, name: dir.name, path: dir.path, depth, count: childDirs.length + childFiles.length });
    const n = childDirs.length + childFiles.length;
    const r = fsRadius(depth + 1);
    childDirs.forEach((child, i) => {
      const d = fibDir(i, n, child.path);
      const jitter = 0.85 + hash01(`r:${child.path}`) * 0.3;
      const p: [number, number, number] = [at[0] + d[0] * r * jitter, at[1] + d[1] * r * jitter, at[2] + d[2] * r * jitter];
      fsLinks.push({ source: dirId, target: `dir:${child.path}` });
      place(child, p, depth + 1);
    });
    childFiles.forEach((o, i) => {
      const idx = childDirs.length + i;
      const d = fibDir(idx, n, o.id);
      const jitter = 0.85 + hash01(`r:${o.id}`) * 0.3;
      positions.set(`obj:${o.id}`, [at[0] + d[0] * r * jitter, at[1] + d[1] * r * jitter, at[2] + d[2] * r * jitter]);
      fsLinks.push({ source: dirId, target: `obj:${o.id}` });
    });
  };
  place(root, [0, 0, 0], 0);
  return { folders, positions, fsLinks };
}

function taxonomyLayout(
  objects: GraphObject[],
  galaxyOf: (o: GraphObject) => { id: string; x: number; y: number; z: number } | null,
): Omit<CoreLayout, 'rays'> {
  const groups = new Map<string, { center: [number, number, number]; members: GraphObject[] }>();
  for (const o of objects) {
    const g = galaxyOf(o);
    const key = g?.id ?? '~unanchored';
    let group = groups.get(key);
    if (!group) {
      // The cluster sits at its galaxy's ring angle, scaled into the core —
      // rays then leave radially outward. Unanchored objects hold the center.
      const center: [number, number, number] = g
        ? [(g.x / 1400) * TAX_RING, (g.y / 1400) * TAX_RING, (g.z / 1400) * TAX_RING]
        : [0, 0, 0];
      group = { center, members: [] };
      groups.set(key, group);
    }
    group.members.push(o);
  }
  const positions = new Map<string, [number, number, number]>();
  for (const [key, g] of groups) {
    const members = [...g.members].sort((a, b) => a.id.localeCompare(b.id));
    const r = Math.min(200, 24 + 10 * Math.sqrt(members.length));
    members.forEach((o, i) => {
      const d = fibDir(i, members.length, `${key}:${o.id}`);
      positions.set(`obj:${o.id}`, [g.center[0] + d[0] * r, g.center[1] + d[1] * r, g.center[2] + d[2] * r]);
    });
  }
  return { folders: [], positions, fsLinks: [] };
}

export function computeCore(
  objects: GraphObject[],
  order: CoreOrder,
  opts: {
    unfiledLabel: string;
    galaxyOf: (o: GraphObject) => { id: string; x: number; y: number; z: number } | null;
  },
): CoreLayout {
  const base =
    order === 'taxonomy'
      ? taxonomyLayout(objects, opts.galaxyOf)
      : fsLayout(objects, opts.unfiledLabel); // 'topic' TBD → falls back to fs
  // The rays are the point of the core: every object stays tethered to ALL
  // its taxonomy anchors, so the semantic ties remain visible across space.
  const rays: Array<{ source: string; target: string }> = [];
  for (const o of objects) {
    for (const a of new Set(o.anchors)) rays.push({ source: `obj:${o.id}`, target: a });
  }
  return { ...base, rays };
}
