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
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphObject {
  id: string;
  title: string;
  type: string;
  anchors: string[];
}

export interface GraphPayload {
  nodes: GraphNode[];
  links: GraphLink[];
  /** The user's knowledge objects anchored to taxonomy nodes — the nebula layer. */
  objects: GraphObject[];
  meta: {
    vectors: boolean;
    embeddings: { total: number; byKind: Record<string, number>; model: string | null };
    liveEmbed: boolean;
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
