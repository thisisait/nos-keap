export const activityApi = {
  trackActivity: async (itemId: string, itemType: string) => {
    const response = await fetch('/api/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, itemType })
    });
    if (!response.ok) throw new Error('Failed to track activity');
  },

  getRecentActivity: async (type?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (limit) params.set('limit', limit.toString());
    
    const response = await fetch(`/api/activity?${params}`);
    if (!response.ok) throw new Error('Failed to fetch recent activity');
    return response.json();
  }
};