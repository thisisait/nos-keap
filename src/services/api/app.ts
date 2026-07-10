import { apiFetch } from './client';
import { AppMetadata } from '../../types/database';

export const appApi = {
  getAppMetadata: () => apiFetch<AppMetadata | null>('/api/app-metadata'),
};
