import { apiFetch } from './client';

export const completionApi = {
  getCompletedItems: () => apiFetch<string[]>('/api/completed-items'),
  toggleItemCompletion: (itemId: string) =>
    apiFetch(`/api/completed-items/${encodeURIComponent(itemId)}`, { method: 'POST' }),
};
