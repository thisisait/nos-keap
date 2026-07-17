import { apiFetch } from './client';

/** One mounted KEAP_FS_ROOTS entry — `exists` is a live mount probe. */
export interface FsRoot {
  key: string;
  path: string;
  exists: boolean;
}

export interface FsRootsPayload {
  roots: FsRoot[];
  /** The per-user tree line (fs-sync users pass) — read-only context here. */
  userFiles: {
    dir: string | null;
    configured: boolean;
    intervalS: number;
    lastRun: { at: string; result: Record<string, unknown> } | null;
  };
}

export interface FsBrowseDir {
  name: string;
  dirCount: number;
  fileCount: number;
}

export interface FsBrowsePayload {
  root: string;
  path: string;
  parent: string;
  dirs: FsBrowseDir[];
  fileCount: number;
  sampleFiles: string[];
  /** true = >500 sibling dirs, the list is partial. */
  truncated: boolean;
  /** Mapping id whose (root, relPath) equals or is an ancestor of this path. */
  mappedBy: string | null;
}

/** Object-materialization template: type override + static frontmatter. */
export interface FsMappingSchema {
  type?: string;
  frontmatter?: Record<string, unknown>;
}

export interface FsMappingLastSync {
  at: string | null;
  scanned: number;
  upserted: number;
  removed: number;
  unchanged: number;
  capped: boolean;
  pruneRefused: boolean;
  tookMs: number;
  error: string | null;
}

export interface FsMappingStatus {
  objectCount: number;
  rootAvailable: boolean;
  lastSync: FsMappingLastSync | null;
}

export interface FsMapping {
  id: string;
  rootKey: string;
  relPath: string;
  label: string;
  description?: string | null;
  nestUnderFiles: boolean;
  schema: FsMappingSchema;
  tags: string[];
  taxonomyRoot?: string | null;
  taxonomyLinks: string[];
  visibility: 'shared' | 'private';
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  status: FsMappingStatus;
}

/** One mirror pass result (create's firstSync, PATCH's resync, sync now). */
export interface FsMappingSyncResult {
  scanned: number;
  upserted: number;
  removed: number;
  unchanged: number;
  capped: boolean;
  pruneRefused: boolean;
  rootAvailable: boolean;
  tookMs: number;
  error?: string;
}

/** POST body; PATCH sends any subset of the same fields. */
export interface FsMappingDraft {
  rootKey: string;
  relPath: string;
  label: string;
  description?: string | null;
  nestUnderFiles?: boolean;
  schema?: FsMappingSchema;
  tags?: string[];
  taxonomyRoot?: string | null;
  taxonomyLinks?: string[];
  visibility?: 'shared' | 'private';
  enabled?: boolean;
}

export const fsMappingsApi = {
  roots: () => apiFetch<FsRootsPayload>('/api/fs/roots'),

  browse: (root: string, path: string) =>
    apiFetch<FsBrowsePayload>(
      `/api/fs/browse?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),

  list: () => apiFetch<FsMapping[]>('/api/fs/mappings'),

  create: (draft: FsMappingDraft) =>
    apiFetch<{ mapping: FsMapping; firstSync: FsMappingSyncResult | null }>('/api/fs/mappings', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),

  update: (id: string, patch: Partial<FsMappingDraft>) =>
    apiFetch<{ mapping: FsMapping; resync: FsMappingSyncResult | null }>(
      `/api/fs/mappings/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  remove: (id: string) =>
    apiFetch<{ removedObjects: number }>(`/api/fs/mappings/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  sync: (id: string) =>
    apiFetch<FsMappingSyncResult>(`/api/fs/mappings/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
    }),
};
