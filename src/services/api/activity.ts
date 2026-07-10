import { apiFetch } from './client';

export interface ActivityEntry {
  id: number;
  item_id: string;
  item_type: string;
  timestamp: number;
}

export const activityApi = {
  trackActivity: (itemId: string, itemType: string) =>
    apiFetch('/api/activity', { method: 'POST', body: JSON.stringify({ itemId, itemType }) }),

  getRecentActivity: (type?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (limit) params.set('limit', String(limit));
    return apiFetch<ActivityEntry[]>(`/api/activity?${params}`);
  },
};
