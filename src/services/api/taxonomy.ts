import { apiFetch } from './client';
import { TaxonomyMetadata } from '../../types/database';

/**
 * The server stores curated metadata as { id, data } (data = arbitrary JSON).
 * The UI edits flat fields (name/description/icon/links/translations), so
 * this client is the flatten/unflatten seam.
 */
interface ServerTaxonomyMetadata {
  id: string;
  data: any;
  updatedAt: number;
}

function toFlat(row: ServerTaxonomyMetadata): TaxonomyMetadata {
  const d = row.data ?? {};
  return {
    id: row.id,
    name: d.name ?? '',
    description: d.description ?? '',
    icon: d.icon ?? '',
    links: typeof d.links === 'string' ? d.links : JSON.stringify(d.links ?? {}),
    requiredData: d.requiredData ?? undefined,
    translations:
      typeof d.translations === 'string' ? d.translations : JSON.stringify(d.translations ?? {}),
    updatedAt: row.updatedAt,
  };
}

export const taxonomyApi = {
  getTaxonomyMetadata: async (id?: string): Promise<TaxonomyMetadata[] | TaxonomyMetadata | null> => {
    if (id) {
      const row = await apiFetch<ServerTaxonomyMetadata | null>(
        `/api/taxonomy-metadata/${encodeURIComponent(id)}`,
      );
      return row ? toFlat(row) : null;
    }
    const rows = await apiFetch<ServerTaxonomyMetadata[]>('/api/taxonomy-metadata');
    return rows.map(toFlat);
  },

  saveTaxonomyMetadata: (metadata: TaxonomyMetadata) => {
    const { id, updatedAt: _updatedAt, data: _data, ...fields } = metadata;
    return apiFetch('/api/taxonomy-metadata', {
      method: 'POST',
      body: JSON.stringify({ id, data: fields }),
    });
  },

  deleteTaxonomyMetadata: (id: string) =>
    apiFetch(`/api/taxonomy-metadata/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
