export const settingsApi = {
  saveSetting: async (key: string, value: string) => {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value })
    });
    if (!response.ok) throw new Error('Failed to save setting');
  },

  getSetting: async (key: string): Promise<string | null> => {
    const response = await fetch(`/api/settings/${key}`);
    if (!response.ok) throw new Error('Failed to get setting');
    return response.json();
  }
};