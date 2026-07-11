import { apiFetch } from './client';
import type { KnowledgeObject } from '@/types/database';

export const objectsApi = {
  list: (type?: string) =>
    apiFetch<KnowledgeObject[]>(`/api/objects${type ? `?type=${encodeURIComponent(type)}` : ''}`),

  get: (id: string) => apiFetch<KnowledgeObject>(`/api/objects/${encodeURIComponent(id)}`),

  types: () => apiFetch<string[]>('/api/objects/types'),

  save: (object: Partial<KnowledgeObject> & { type: string; title: string }) =>
    apiFetch<KnowledgeObject>('/api/objects', {
      method: 'POST',
      body: JSON.stringify(object),
    }),

  remove: (id: string) =>
    apiFetch<void>(`/api/objects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
