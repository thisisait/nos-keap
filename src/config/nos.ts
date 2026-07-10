/**
 * nOS content-service link map — REPLACES the old (phantom) src/config/iiab.ts.
 *
 * A `requiredData` ref on a taxonomy node (e.g. "kiwix:wikipedia_en") resolves
 * into a deep link into a live nOS service. The authoritative service list
 * comes from the backend at runtime (GET /api/config, driven by
 * KEAP_TENANT_DOMAIN — one image serves any tenant); the static list below is
 * only the fallback while that request is in flight or outside nOS.
 *
 * Keep the fallback map in sync with server/content-links.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/services/api/client';

export interface NosContentService {
  key: string;
  label: string;
  url: string;
}

export interface NosConfig {
  tenantDomain: string;
  services: NosContentService[];
}

const FALLBACK_TENANT = 'dev.local';

export const fallbackNosConfig: NosConfig = {
  tenantDomain: FALLBACK_TENANT,
  services: [
    { key: 'kiwix', label: 'Kiwix (offline Wikipedia & ZIM)', url: `https://kiwix.${FALLBACK_TENANT}` },
    { key: 'nextcloud', label: 'Nextcloud (files & docs)', url: `https://cloud.${FALLBACK_TENANT}` },
    { key: 'jellyfin', label: 'Jellyfin (media)', url: `https://jellyfin.${FALLBACK_TENANT}` },
    { key: 'calibre', label: 'Calibre-Web (e-books)', url: `https://books.${FALLBACK_TENANT}` },
    { key: 'openwebui', label: 'Open WebUI (local AI chat)', url: `https://chat.${FALLBACK_TENANT}` },
  ],
};

/** Tenant config from the backend, with the static fallback until loaded. */
export function useNosConfig(): NosConfig {
  const { data } = useQuery({
    queryKey: ['nos-config'],
    queryFn: () => apiFetch<NosConfig>('/api/config'),
    staleTime: Infinity,
  });
  return data ?? fallbackNosConfig;
}

export interface ResolvedContentLink {
  ref: string;
  service: NosContentService;
  url: string;
}

/** Resolve a `requiredData` ref ("kiwix:wikipedia_en") against the config. */
export function resolveRequiredData(
  ref: string | undefined,
  config: NosConfig,
): ResolvedContentLink | null {
  if (!ref) return null;
  const [key, ...rest] = ref.split(':');
  const service = config.services.find((s) => s.key === key);
  if (!service) return null;
  const suffix = rest.join(':');
  return { ref, service, url: `${service.url}${suffix ? `/${suffix}` : ''}` };
}
