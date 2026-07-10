import { apiFetch } from './client';
import { ApiTaxonomyMetadata } from '../../types/database';

export const metadataApi = {
  getAllMetadata: () => apiFetch<ApiTaxonomyMetadata[]>('/api/metadata'),
  getMetadataByDomain: (domain: string) =>
    apiFetch<ApiTaxonomyMetadata[]>(`/api/metadata/domain/${encodeURIComponent(domain)}`),
  saveMetadata: (metadata: Partial<ApiTaxonomyMetadata> & { title: string }) =>
    apiFetch<ApiTaxonomyMetadata>('/api/metadata', { method: 'POST', body: JSON.stringify(metadata) }),
};
