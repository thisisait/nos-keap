import { HomepageTile } from '../../types/database';

export const homepageApi = {
  getHomepageTiles: async (): Promise<HomepageTile[]> => {
    const response = await fetch('/api/homepage-tiles');
    if (!response.ok) throw new Error('Failed to fetch homepage tiles');
    return response.json();
  },

  saveHomepageTiles: async (tiles: HomepageTile[]) => {
    const response = await fetch('/api/homepage-tiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiles)
    });
    if (!response.ok) throw new Error('Failed to save homepage tiles');
  }
};