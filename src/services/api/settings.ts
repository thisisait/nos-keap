import { apiFetch } from './client';

export const settingsApi = {
  saveSetting: (key: string, value: string) =>
    apiFetch('/api/settings', { method: 'POST', body: JSON.stringify({ key, value }) }),
  getSetting: (key: string) => apiFetch<string | null>(`/api/settings/${encodeURIComponent(key)}`),
};
