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
 *               Admin-mapped folders (fs_mappings) join here: nested mappings
 *               hang under the central core as `@<mapId>` hubs, standalone
 *               mappings form their own constellations on a ring OUTSIDE the
 *               core, tethered to their taxonomy anchors by hub-level rays.
 *   taxonomy  — objects cluster by their first anchor's galaxy, each cluster
 *               sits at the SAME ring angle as its galaxy (scaled inward), so
 *               rays leave the core radially and never cross it.
 *   topic     — embedding-space clustering OUTSIDE the taxonomy: server-side
 *               k-means over object vectors ships birth-frozen `theta` per
 *               topic (graph.topics). Hubs land on a violet ring via chain-
 *               spread (only colliding hubs shift); unclustered objects hold
 *               the center as `~untopiced` fog. Relabels restyle, never move.
 *
 * Pure functions, deterministic in their inputs (same hash-jitter approach as
 * server/layout.ts) — re-renders and toggle round-trips are always stable.
 * Mapping geometry is keyed by the immutable mapping ID, never the label:
 * renaming a mapping must not move a single node.
 */
import type { GraphObject } from '@/hooks/useExplorerData';

export type CoreOrder = 'fs' | 'taxonomy' | 'topic';

export const CORE_MAX = 420; // keep well inside the ring's clear zone (~1000)
const FS_LEVEL_RADIUS = [0, 230, 105, 50, 28]; // shells per folder depth
const TAX_RING = 280; // by-taxonomy cluster ring radius
const TOPIC_RING = 280; // topic constellation ring (TAX_RING band)
const TOPIC_MIN_SEP = 0.35; // min rad between topic hubs — chain-spread (decision #10)
// Standalone mapping constellations sit on their own ring: outside the core
// (CORE_MAX 420), inside the taxonomy clear zone (~1000). Worst subtree
// extent ≈ (120+55+28+16+…)·1.15 ≈ 260 ⇒ constellations span r ∈ [440, 960].
const SAT_RING = 700;
const SAT_LEVEL_RADIUS = [0, 120, 55, 28, 16]; // shells per depth inside a hub
const SAT_MIN_SEP = 0.35; // min rad between hubs — ~17 per ring
// Object rays collapse into hub-level aggregates past this many anchored
// objects in one mapping — 5k tethers from one folder would white-out the map.
const AGGREGATE_RAYS_AT = 200;
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

function satRadius(depth: number): number {
  if (depth < SAT_LEVEL_RADIUS.length) return SAT_LEVEL_RADIUS[depth];
  const beyond = depth - (SAT_LEVEL_RADIUS.length - 1);
  return Math.max(8, SAT_LEVEL_RADIUS[SAT_LEVEL_RADIUS.length - 1] * Math.pow(0.55, beyond));
}

/** Mapped-folder hub input (a GraphMapping subset) — the id keys all geometry. */
export interface CoreMapping {
  id: string;
  label: string;
  /** true = under the central Files core, false = standalone constellation. */
  nested: boolean;
  taxonomyRoot?: string;
  taxonomyLinks: string[];
}

export interface CoreFolder {
  id: string; // `dir:<path>` ('' path = the core root hub)
  name: string;
  path: string;
  depth: number;
  count: number; // direct children (dirs + files)
  /** Set on mapping hubs (`dir:@<mapId>`) — carries the label + ray source. */
  mapping?: string;
  /** Set on topic hubs (`topic:<id>`) — carries the cluster id (topic order). */
  topic?: string;
}

export interface CoreLayout {
  /** Synthetic folder nodes (fs order only; empty otherwise). */
  folders: CoreFolder[];
  /** Pinned position per node id (`obj:<id>` and `dir:<path>`). */
  positions: Map<string, [number, number, number]>;
  /** Folder-tree / topic-hub edges (dir→dir, dir→obj, topic→obj) — fs + topic orders. */
  fsLinks: Array<{ source: string; target: string }>;
  /** Object → taxonomy-anchor tethers (all orders keep the rays). */
  rays: Array<{ source: string; target: string }>;
  /** Mapping hub → taxonomy-anchor tethers (root + links) — fs order only. */
  mrays: Array<{ source: string; target: string }>;
}

interface FsTreeDir {
  path: string;
  name: string;
  dirs: Map<string, FsTreeDir>;
  files: GraphObject[];
}

/** Walk/extend a tree to the dir at `segments` below `root` (path-prefixed). */
function dirOf(root: FsTreeDir, segments: string[]): FsTreeDir {
  let cur = root;
  let path = root.path;
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
}

interface TreeOut {
  folders: CoreFolder[];
  positions: Map<string, [number, number, number]>;
  fsLinks: Array<{ source: string; target: string }>;
}

/** Recursive shell placement — shared by the central core (fsRadius) and the
 *  standalone constellations (satRadius); only the radius profile differs. */
function place(
  dir: FsTreeDir,
  at: [number, number, number],
  depth: number,
  radiusOf: (depth: number) => number,
  out: TreeOut,
): void {
  const dirId = `dir:${dir.path}`;
  out.positions.set(dirId, at);
  // Stable child order: dirs first, then files, each alphabetical — indices
  // (and so positions) survive unrelated additions elsewhere in the tree.
  const childDirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const childFiles = [...dir.files].sort((a, b) => a.title.localeCompare(b.title));
  out.folders.push({ id: dirId, name: dir.name, path: dir.path, depth, count: childDirs.length + childFiles.length });
  const n = childDirs.length + childFiles.length;
  const r = radiusOf(depth + 1);
  childDirs.forEach((child, i) => {
    const d = fibDir(i, n, child.path);
    const jitter = 0.85 + hash01(`r:${child.path}`) * 0.3;
    const p: [number, number, number] = [at[0] + d[0] * r * jitter, at[1] + d[1] * r * jitter, at[2] + d[2] * r * jitter];
    out.fsLinks.push({ source: dirId, target: `dir:${child.path}` });
    place(child, p, depth + 1, radiusOf, out);
  });
  childFiles.forEach((o, i) => {
    const idx = childDirs.length + i;
    const d = fibDir(idx, n, o.id);
    const jitter = 0.85 + hash01(`r:${o.id}`) * 0.3;
    out.positions.set(`obj:${o.id}`, [at[0] + d[0] * r * jitter, at[1] + d[1] * r * jitter, at[2] + d[2] * r * jitter]);
    out.fsLinks.push({ source: dirId, target: `obj:${o.id}` });
  });
}

function fsLayout(
  usersObjects: GraphObject[],
  nested: Array<{ mapping: CoreMapping; objects: GraphObject[] }>,
  unfiledLabel: string,
  out: TreeOut,
): void {
  const root: FsTreeDir = { path: '', name: '', dirs: new Map(), files: [] };
  // Admin view can carry several users' objects — path trees would collide
  // ("documents/…" × N users), so with multiple owners each tree roots under
  // its owner's uid. The single-user case stays clean and unprefixed.
  // Computed over the USERS partition only: `fsmap:` owners would otherwise
  // flip multiOwner on and re-root every real user's tree.
  const owners = new Set(usersObjects.filter((o) => o.path).map((o) => o.owner ?? ''));
  const multiOwner = owners.size > 1;
  for (const o of usersObjects) {
    if (o.path) {
      const segs = o.path.split('/').filter(Boolean);
      if (multiOwner) segs.unshift(o.owner ?? '?');
      dirOf(root, segs.slice(0, -1)).files.push(o);
    } else {
      // Hand-written OKF cards without a filesystem identity gather in one
      // pseudo-folder — they belong to the core, just not to a real path.
      dirOf(root, [unfiledLabel]).files.push(o);
    }
  }
  // Nested mapping objects enter under a synthetic '@<mapId>' top segment:
  // the mapping becomes a depth-1 hub (`dir:@<mapId>`) that cannot collide
  // with real folders, and every position hangs off the immutable id — the
  // human label is stamped on afterwards (computeCore post-process).
  for (const { mapping, objects } of nested) {
    for (const o of objects) {
      const pathSegs = o.path ? o.path.split('/').filter(Boolean) : [];
      dirOf(root, [`@${mapping.id}`, ...pathSegs.slice(0, -1)]).files.push(o);
    }
  }
  place(root, [0, 0, 0], 0, fsRadius, out);
}

/** One standalone mapping constellation: hub at `at`, subtree in SAT shells. */
function standaloneLayout(
  mapping: CoreMapping,
  objects: GraphObject[],
  at: [number, number, number],
  out: TreeOut,
): void {
  const root: FsTreeDir = { path: `@${mapping.id}`, name: `@${mapping.id}`, dirs: new Map(), files: [] };
  for (const o of objects) {
    const pathSegs = o.path ? o.path.split('/').filter(Boolean) : [];
    dirOf(root, pathSegs.slice(0, -1)).files.push(o);
  }
  place(root, at, 0, satRadius, out);
}

/**
 * Standalone hub positions on the SAT ring. θ comes from the mapping's anchor
 * galaxy (the constellation faces its taxonomy home) or an id hash; collisions
 * resolve by sorting on (θ, id) and pushing clockwise to exactly SAT_MIN_SEP —
 * deterministic AND order-independent, so adding a mapping never scrambles the
 * others. ~17 hubs fit one ring; overflow spills to rings at y ± 260
 * (documented scale limit).
 */
function placeHubs(
  mappings: CoreMapping[],
  galaxyPosOf: (nodeId: string) => { id: string; x: number; y: number; z: number } | null,
): Array<{ mapping: CoreMapping; at: [number, number, number] }> {
  const hubs = mappings.map((m) => {
    const g = m.taxonomyRoot ? galaxyPosOf(m.taxonomyRoot) : null;
    const theta = g ? Math.atan2(g.z, g.x) : 2 * Math.PI * hash01(`map:${m.id}`);
    const y = (hash01(`my:${m.id}`) - 0.5) * 240;
    return { m, theta, y };
  });
  hubs.sort((a, b) => a.theta - b.theta || a.m.id.localeCompare(b.m.id));
  const perRing = Math.floor((2 * Math.PI) / SAT_MIN_SEP); // 17 — no wrap collision
  return hubs.map((h, i) => {
    const ring = Math.floor(i / perRing);
    if (i % perRing !== 0) {
      // Predecessor is in the same ring (ring boundaries reset the chain).
      const prev = hubs[i - 1];
      if (h.theta < prev.theta + SAT_MIN_SEP) h.theta = prev.theta + SAT_MIN_SEP;
    }
    const y = h.y + (ring > 0 ? Math.ceil(ring / 2) * 260 * (ring % 2 === 1 ? 1 : -1) : 0);
    return { mapping: h.m, at: [Math.cos(h.theta) * SAT_RING, y, Math.sin(h.theta) * SAT_RING] };
  });
}

function taxonomyLayout(
  objects: GraphObject[],
  galaxyOf: (o: GraphObject) => { id: string; x: number; y: number; z: number } | null,
): TreeOut {
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

/**
 * Topic-hub angles via CHAIN-SPREAD (decision #10) — the SAT_MIN_SEP clockwise
 * push's stable-identity cousin. θ is birth-frozen server-side; here we resolve
 * ONLY collisions: sort hubs by (θ, id), find maximal chains whose neighbours
 * sit closer than TOPIC_MIN_SEP, and re-space each chain's members at exactly
 * TOPIC_MIN_SEP centered on the chain's circular mean (order preserved, wrap
 * unrolled). A non-colliding hub renders at its EXACT frozen θ; a topic birth
 * perturbs only the hubs inside its own collision chain — deterministic and
 * order-independent. y is an id-hashed vertical jitter. Returns center per id.
 */
function topicHubPositions(
  topics: Array<{ id: string; theta: number }>,
): Map<string, [number, number, number]> {
  const TWO_PI = 2 * Math.PI;
  const norm = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
  const hubs = topics
    .map((t) => ({ id: t.id, theta: norm(t.theta) }))
    .sort((a, b) => a.theta - b.theta || a.id.localeCompare(b.id));
  const n = hubs.length;
  const out = new Map<string, [number, number, number]>();
  if (n === 0) return out;

  // Circular gap to the predecessor (index 0 wraps around from the last hub).
  const gap = (i: number) =>
    i === 0 ? hubs[0].theta + TWO_PI - hubs[n - 1].theta : hubs[i].theta - hubs[i - 1].theta;

  const angleOf = new Map<string, number>();
  // Spread one contiguous chain (indices in sorted order) at exact separation,
  // centered on the unrolled circular mean; single-member chains stay put.
  const spread = (chain: number[]) => {
    const unrolled = [hubs[chain[0]].theta];
    for (let c = 1; c < chain.length; c++) {
      let g = hubs[chain[c]].theta - hubs[chain[c - 1]].theta;
      if (g < 0) g += TWO_PI; // wrap within the chain
      unrolled.push(unrolled[c - 1] + g);
    }
    const m = chain.length;
    const mean = unrolled.reduce((s, a) => s + a, 0) / m;
    chain.forEach((idx, c) => angleOf.set(hubs[idx].id, mean + (c - (m - 1) / 2) * TOPIC_MIN_SEP));
  };

  // Anchor the linear walk at a real break (gap ≥ sep). None ⇒ the whole ring
  // is one wrapped chain (feasible: K_MAX·0.35 = 5.6 < 2π, so rare).
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (gap(i) >= TOPIC_MIN_SEP) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    spread(hubs.map((_, i) => i));
  } else {
    let i = start;
    for (let seen = 0; seen < n; ) {
      const chain = [i];
      let j = (i + 1) % n;
      while (seen + chain.length < n && gap(j) < TOPIC_MIN_SEP) {
        chain.push(j);
        j = (j + 1) % n;
      }
      spread(chain);
      seen += chain.length;
      i = j;
    }
  }

  for (const t of topics) {
    const theta = angleOf.get(t.id);
    if (theta === undefined) continue;
    const y = (hash01(`ty:${t.id}`) - 0.5) * 160;
    out.set(t.id, [Math.cos(theta) * TOPIC_RING, y, Math.sin(theta) * TOPIC_RING]);
  }
  return out;
}

/**
 * Topic order: object-only constellations keyed by the immutable topic id.
 * Assigned objects orbit their topic hub on the violet ring; everything else
 * (no topic, or a topic filtered out of this viewer's payload) gathers in the
 * hubless `~untopiced` fog at the origin — the `~unanchored` precedent. Labels
 * are stamped on hub nodes only; NO geometry keys off the label.
 */
function topicLayout(
  objects: GraphObject[],
  topics: Array<{ id: string; label: string; theta: number }>,
  untopicedLabel: string,
): TreeOut {
  const positions = new Map<string, [number, number, number]>();
  const folders: CoreFolder[] = [];
  const fsLinks: Array<{ source: string; target: string }> = [];
  const topicIds = new Set(topics.map((t) => t.id));

  const byTopic = new Map<string, GraphObject[]>();
  const untopiced: GraphObject[] = [];
  for (const o of objects) {
    if (o.topic && topicIds.has(o.topic)) {
      const g = byTopic.get(o.topic);
      if (g) g.push(o);
      else byTopic.set(o.topic, [o]);
    } else {
      untopiced.push(o);
    }
  }

  // ~untopiced center fog — hubless, sorted by id (byte-identical to taxonomy).
  const fog = [...untopiced].sort((a, b) => a.id.localeCompare(b.id));
  const fogR = Math.min(200, 24 + 10 * Math.sqrt(fog.length));
  fog.forEach((o, i) => {
    const d = fibDir(i, fog.length, `~untopiced:${o.id}`);
    positions.set(`obj:${o.id}`, [d[0] * fogR, d[1] * fogR, d[2] * fogR]);
  });

  // Fog aggregation hub — grown ONLY past the ray-collapse threshold, so below
  // it the classic hubless fog stays byte-identical. It is a pure ray SOURCE at
  // the fog center (no fsLinks, no fog object moves): computeCore fans its rays
  // hub→distinct-anchor, mirroring the mapping/topic-hub collapse. The sentinel
  // `topic` id keeps Explore's violet-hue + label path (never resolved as a real
  // cluster; the empty node id `topic:` is what the aggregate rays source from).
  const anchoredFog = fog.reduce((n, o) => n + (o.anchors.length > 0 ? 1 : 0), 0);
  if (anchoredFog > AGGREGATE_RAYS_AT) {
    positions.set('topic:', [0, 0, 0]);
    folders.push({ id: 'topic:', name: untopicedLabel, path: '~topic/~untopiced', depth: 0, count: fog.length, topic: '~untopiced' });
  }

  // Hub + member spheres — only non-empty topics grow a hub node.
  const hubPos = topicHubPositions(topics);
  for (const t of topics) {
    const members = byTopic.get(t.id);
    if (!members || members.length === 0) continue;
    const at = hubPos.get(t.id) ?? [0, 0, 0];
    positions.set(`topic:${t.id}`, at);
    folders.push({ id: `topic:${t.id}`, name: t.label, path: `~topic/${t.id}`, depth: 0, count: members.length, topic: t.id });
    const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
    const r = Math.min(200, 24 + 10 * Math.sqrt(sorted.length));
    sorted.forEach((o, i) => {
      const d = fibDir(i, sorted.length, `${t.id}:${o.id}`);
      positions.set(`obj:${o.id}`, [at[0] + d[0] * r, at[1] + d[1] * r, at[2] + d[2] * r]);
      fsLinks.push({ source: `topic:${t.id}`, target: `obj:${o.id}` });
    });
  }

  return { folders, positions, fsLinks };
}

export function computeCore(
  objects: GraphObject[],
  order: CoreOrder,
  opts: {
    unfiledLabel: string;
    /** Label stamped on the ~untopiced fog hub (topic order, past threshold). */
    untopicedLabel: string;
    galaxyOf: (o: GraphObject) => { id: string; x: number; y: number; z: number } | null;
    /** Mapped-folder hubs (fs_mappings) — [] keeps the classic core intact. */
    mappings: CoreMapping[];
    /** Baked position of a taxonomy node's ROOT galaxy — standalone hubs face it. */
    galaxyPosOf: (nodeId: string) => { id: string; x: number; y: number; z: number } | null;
    /** Topic hubs (graph.topics) — birth-frozen θ; [] keeps topic order empty. */
    topics?: Array<{ id: string; label: string; theta: number }>;
  },
): CoreLayout {
  if (order === 'taxonomy') {
    // No hubs exist in this order — mapped objects cluster via the caller's
    // galaxyOf fallback (mapping taxonomyRoot), rays stay strictly per-object.
    const base = taxonomyLayout(objects, opts.galaxyOf);
    const rays: Array<{ source: string; target: string }> = [];
    for (const o of objects) {
      for (const a of new Set(o.anchors)) rays.push({ source: `obj:${o.id}`, target: a });
    }
    return { ...base, rays, mrays: [] };
  }

  if (order === 'topic') {
    // Inserted BEFORE the fs fall-through: `order='topic'` must never render
    // the filesystem tree. Rays follow the taxonomy anchors (per-object, or
    // hub-aggregated past AGGREGATE_RAYS_AT — decision #11). The '' bucket
    // aggregates too once its fog grows a hub (topicLayout, same threshold);
    // below it the fog stays hubless with per-object rays.
    const topics = opts.topics ?? [];
    const base = topicLayout(objects, topics, opts.untopicedLabel);
    const topicIds = new Set(topics.map((t) => t.id));
    const hubIds = new Set(base.folders.filter((f) => f.topic).map((f) => f.id));
    const byTopic = new Map<string, GraphObject[]>();
    for (const o of objects) {
      const tid = o.topic && topicIds.has(o.topic) ? o.topic : '';
      const g = byTopic.get(tid);
      if (g) g.push(o);
      else byTopic.set(tid, [o]);
    }
    const rays: Array<{ source: string; target: string }> = [];
    for (const [tid, members] of byTopic) {
      const anchored = members.filter((o) => o.anchors.length > 0);
      const hubId = `topic:${tid}`;
      if (anchored.length > AGGREGATE_RAYS_AT && hubIds.has(hubId)) {
        const targets = new Set<string>();
        for (const o of anchored) for (const a of o.anchors) targets.add(a);
        for (const a of targets) rays.push({ source: hubId, target: a });
      } else {
        for (const o of anchored) {
          for (const a of new Set(o.anchors)) rays.push({ source: `obj:${o.id}`, target: a });
        }
      }
    }
    return { ...base, rays, mrays: [] };
  }

  // Partition: users tree (no mapping — or an unknown mapping id, defensive:
  // disabled mappings still ship, so this shouldn't occur) vs nested vs
  // standalone per mapping.
  const byId = new Map(opts.mappings.map((m) => [m.id, m]));
  const usersObjects: GraphObject[] = [];
  const objsByMapping = new Map<string, GraphObject[]>();
  for (const o of objects) {
    const m = o.mapping ? byId.get(o.mapping) : undefined;
    if (!m) {
      usersObjects.push(o);
    } else {
      const g = objsByMapping.get(m.id);
      if (g) g.push(o);
      else objsByMapping.set(m.id, [o]);
    }
  }

  const out: TreeOut = { folders: [], positions: new Map(), fsLinks: [] };
  const nestedMappings = opts.mappings.filter((m) => m.nested);
  const standaloneMappings = opts.mappings.filter((m) => !m.nested);
  fsLayout(
    usersObjects,
    nestedMappings
      .map((m) => ({ mapping: m, objects: objsByMapping.get(m.id) ?? [] }))
      .filter((e) => e.objects.length > 0),
    opts.unfiledLabel,
    out,
  );
  // Standalone constellations always place their hub — an empty mapping is
  // still a labeled, tethered landmark the admin just created.
  for (const { mapping, at } of placeHubs(standaloneMappings, opts.galaxyPosOf)) {
    standaloneLayout(mapping, objsByMapping.get(mapping.id) ?? [], at, out);
  }
  // Post-process hub folders (`@<mapId>`, no slash): label + mapping stamped
  // AFTER layout so a label edit can never reorder siblings or move geometry.
  for (const f of out.folders) {
    if (f.path.startsWith('@') && !f.path.includes('/')) {
      const m = byId.get(f.path.slice(1));
      if (m) {
        f.name = m.label;
        f.mapping = m.id;
      }
    }
  }
  const hubIds = new Set(out.folders.filter((f) => f.mapping).map((f) => f.id));

  // The rays are the point of the core: every object stays tethered to ALL
  // its taxonomy anchors, so the semantic ties remain visible across space.
  // The users tree collapses into its root hub (`dir:`, the core center) once
  // its anchored objects exceed AGGREGATE_RAYS_AT — one hub→anchor ray per
  // distinct anchor, exactly like a mapping; below the threshold it keeps
  // today's per-object rays byte-identically. Mapping buckets follow suit.
  const rays: Array<{ source: string; target: string }> = [];
  const anchoredUsers = usersObjects.filter((o) => o.anchors.length > 0);
  if (anchoredUsers.length > AGGREGATE_RAYS_AT && out.positions.has('dir:')) {
    const targets = new Set<string>();
    for (const o of anchoredUsers) for (const a of o.anchors) targets.add(a);
    for (const a of targets) rays.push({ source: 'dir:', target: a });
  } else {
    for (const o of usersObjects) {
      for (const a of new Set(o.anchors)) rays.push({ source: `obj:${o.id}`, target: a });
    }
  }
  for (const m of opts.mappings) {
    const anchored = (objsByMapping.get(m.id) ?? []).filter((o) => o.anchors.length > 0);
    const hubId = `dir:@${m.id}`;
    if (anchored.length > AGGREGATE_RAYS_AT && hubIds.has(hubId)) {
      const targets = new Set<string>();
      for (const o of anchored) for (const a of o.anchors) targets.add(a);
      for (const a of targets) rays.push({ source: hubId, target: a });
    } else {
      for (const o of anchored) {
        for (const a of new Set(o.anchors)) rays.push({ source: `obj:${o.id}`, target: a });
      }
    }
  }
  // Mapping-level rays: hub → taxonomyRoot + each taxonomy link. Only for
  // hubs that exist (a nested mapping with zero objects grows no hub node).
  const mrays: Array<{ source: string; target: string }> = [];
  for (const m of opts.mappings) {
    const hubId = `dir:@${m.id}`;
    if (!hubIds.has(hubId)) continue;
    const targets = new Set<string>(m.taxonomyLinks);
    if (m.taxonomyRoot) targets.add(m.taxonomyRoot);
    for (const t of targets) mrays.push({ source: hubId, target: t });
  }
  return { ...out, rays, mrays };
}
