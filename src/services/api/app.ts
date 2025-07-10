import { AppMetadata } from '../../types/database';

export const appApi = {
  getAppMetadata: async (): Promise<AppMetadata | null> => {
    const response = await fetch('/api/app-metadata');
    if (!response.ok) throw new Error('Failed to fetch app metadata');
    return response.json();
  }
};