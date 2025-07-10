export const completionApi = {
  getCompletedItems: async (): Promise<string[]> => {
    const response = await fetch('/api/completed-items');
    if (!response.ok) throw new Error('Failed to fetch completed items');
    return response.json();
  },

  toggleItemCompletion: async (itemId: string) => {
    const response = await fetch(`/api/completed-items/${itemId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error('Failed to toggle item completion');
  }
};