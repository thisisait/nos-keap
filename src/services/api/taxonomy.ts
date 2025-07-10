import { TaxonomyMetadata } from '../../types/database';

export const taxonomyApi = {
  getTaxonomyMetadata: async (id?: string): Promise<TaxonomyMetadata[] | TaxonomyMetadata | null> => {
    const url = id ? `/api/taxonomy-metadata/${id}` : '/api/taxonomy-metadata';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch taxonomy metadata');
    return response.json();
  },

  saveTaxonomyMetadata: async (metadata: TaxonomyMetadata) => {
    const response = await fetch('/api/taxonomy-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    });
    if (!response.ok) throw new Error('Failed to save taxonomy metadata');
  },

  deleteTaxonomyMetadata: async (id: string) => {
    const response = await fetch(`/api/taxonomy-metadata/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete taxonomy metadata');
  }
};