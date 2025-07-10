export const metadataApi = {
  getAllMetadata: async () => {
    const response = await fetch('/api/metadata');
    if (!response.ok) throw new Error('Failed to fetch metadata');
    return response.json();
  },

  getMetadataByDomain: async (domain: string) => {
    const response = await fetch(`/api/metadata/domain/${domain}`);
    if (!response.ok) throw new Error('Failed to fetch metadata by domain');
    return response.json();
  },

  saveMetadata: async (metadata: any) => {
    const response = await fetch('/api/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    });
    if (!response.ok) throw new Error('Failed to save metadata');
    return response.json();
  }
};