/**
 * Data layer for the /explore vector explorer.
 *
 * ['graph']                          — the whole taxonomy as nodes+links
 * ['graph-neighbors', id, mode, k]   — stars around the focused node
 *
 * Both degrade: meta.vectors=false (or semantic:false) means the corpus has
 * no embeddings yet — the explorer then offers the tree + zone mode only.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/services/api/client';

export interface GraphNode {
  id: string;
  name: string;
  kind: 'category' | 'subcategory' | 'item';
  parentId: string | null;
  level: number;
  childCount: number;
  hasNote: boolean;
  dataType?: string;
  /** Resolved content link — the DetailPanel's "open in service" action. */
  url?: string;
  /** Track T zone + provenance. */
  zone?: 'anchor' | 'votable' | 'free';
  ext?: boolean;
  /** K1 curated description (en canonical) + cs localization. */
  description?: string;
  descriptionCs?: string;
  /** Baked star position (U1) — present once the server has a layout. */
  x?: number;
  y?: number;
  z?: number;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphObject {
  id: string;
  title: string;
  type: string;
  /** Canonical asset type + the celestial body it orbits as (asset-types.ts). */
  assetType: string;
  form: 'planet' | 'moon' | 'asteroid' | 'comet' | 'station';
  glyph: string;
  hue: number;
  anchors: string[];
  /** Filesystem identity (doctrine tree / fs-sync) — drives the files core. */
  path?: string;
  /** Owner uid — lets an admin's files core keep users' trees apart. */
  owner?: string;
  /** Mapped-folder provenance (fs_mappings id) — groups the object under its
   *  mapping's hub instead of the owner's tree. */
  mapping?: string;
}

/** One admin-managed mapped folder (fs_mappings) — hub label + placement. */
export interface GraphMapping {
  id: string;
  label: string;
  /** Admin-entered popisek — surfaces in the hub's folder panel. */
  description?: string;
  /** true = nested under the central Files core; false = standalone constellation. */
  nested: boolean;
  /** Primary taxonomy anchor (hub ray target); dangling ids are filtered server-side. */
  taxonomyRoot?: string;
  taxonomyLinks: string[];
  tags: string[];
  /** Disabled mappings still ship — their retained objects need placement + labels. */
  enabled: boolean;
  count: number;
}

/** A typed cross-node relation (imported research graph overlay, e.g. ToE). */
export interface GraphRelation {
  source: string;
  target: string;
  type: string;
  explored: string | null;
}

export interface GraphPayload {
  nodes: GraphNode[];
  links: GraphLink[];
  /** The user's knowledge objects anchored to taxonomy nodes — the nebula layer. */
  objects: GraphObject[];
  /** Typed concept-relation overlay (beyond parent-child) — rendered behind a toggle. */
  relations?: GraphRelation[];
  /** Mapped-folder hubs — labels + placement for the files core (admin-managed). */
  fsMappings?: GraphMapping[];
  meta: {
    vectors: boolean;
    embeddings: { total: number; byKind: Record<string, number>; model: string | null };
    liveEmbed: boolean;
    layoutVersion: string | null;
  };
}

export type NeighborMode = 'related' | 'unrelated';

export interface NeighborItem {
  kind: 'taxonomy' | 'capture' | 'note' | 'object';
  refId: string;
  distance: number;
  name: string;
  description?: string;
  dataType?: string;
  url?: string;
  nodeId?: string;
}

export interface NeighborsPayload {
  id: string;
  mode: NeighborMode;
  semantic: boolean;
  items: NeighborItem[];
}

export function useGraph() {
  return useQuery({
    queryKey: ['graph'],
    queryFn: () => apiFetch<GraphPayload>('/api/graph'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useNeighbors(
  focusId: string | null,
  mode: NeighborMode,
  kinds: string[],
  limit = 25,
) {
  return useQuery({
    queryKey: ['graph-neighbors', focusId, mode, kinds.join(','), limit],
    queryFn: () =>
      apiFetch<NeighborsPayload>(
        `/api/graph/neighbors?id=${encodeURIComponent(focusId!)}&mode=${mode}&kinds=${kinds.join(',')}&limit=${limit}`,
      ),
    enabled: Boolean(focusId),
    staleTime: 60 * 1000,
  });
}
