import { apiFetch } from './client';

/** One stored relation row for the moderation queue (db.RelationRow) plus the
 *  human labels the server resolves for its endpoints. Mirrors the shape of
 *  server/relations-routes.ts GET /api/admin/relations. */
export interface AdminRelation {
  id: string;
  fromRef: string;
  fromKind: 'node' | 'object';
  toRef: string;
  toKind: 'node' | 'object';
  type: string;
  confidence: number | null;
  justification: string | null;
  source: 'toe' | 'derived' | 'manual';
  status: 'proposed' | 'confirmed' | 'rejected';
  model: string | null;
  createdAt: number | null;
  fromLabel: string;
  toLabel: string;
}

/** One controlled-vocabulary verb (relation_types). */
export interface AdminRelationType {
  type: string;
  label: string;
  color: string | null;
  description: string | null;
  status: 'seed' | 'proposed' | 'confirmed';
}

export interface AdminRelationsPayload {
  relations: AdminRelation[];
  types: AdminRelationType[];
}

export const relationsApi = {
  /** status: proposed (default) | confirmed | rejected | all. */
  list: (status = 'proposed') =>
    apiFetch<AdminRelationsPayload>(`/api/admin/relations?status=${encodeURIComponent(status)}`),

  /** Decide one edge: proposed → confirmed | rejected. */
  decide: (id: string, status: 'confirmed' | 'rejected') =>
    apiFetch(`/api/admin/relations/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  /** Confirm a proposed verb into the live palette (optional colour override). */
  confirmType: (type: string, color?: string) =>
    apiFetch<AdminRelationType>(`/api/admin/relation-types/${encodeURIComponent(type)}`, {
      method: 'POST',
      body: JSON.stringify({ status: 'confirmed', color }),
    }),

  /** Reject (retire) a proposed verb. */
  rejectType: (type: string) =>
    apiFetch(`/api/admin/relation-types/${encodeURIComponent(type)}`, { method: 'DELETE' }),
};
