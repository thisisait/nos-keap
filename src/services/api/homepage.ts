import { apiFetch } from './client';
import { HomepageTile } from '../../types/database';

export const homepageApi = {
  getHomepageTiles: () => apiFetch<HomepageTile[]>('/api/homepage-tiles'),
  saveHomepageTiles: (tiles: HomepageTile[]) =>
    apiFetch('/api/homepage-tiles', { method: 'POST', body: JSON.stringify(tiles) }),
};
