/**
 * nOS content-service link map — REPLACES the old (phantom) src/config/iiab.ts.
 *
 * The IIAB-era app hard-coded IIAB module paths (/kiwix, /kolibri, /sugarizer)
 * and mocked an "IIAB network" of servers. On nOS the real, live content
 * services a knowledge app links to are first-class nOS roles, each reachable
 * at `<service>.<tenant_domain>` behind the same Authentik SSO session (cookie
 * domain `.<tld>` gives cross-subdomain SSO — one login covers all of these).
 *
 * These are BUILD-TIME defaults; the backend can override them at runtime from
 * env (KEAP_TENANT_DOMAIN, KEAP_LINKS_JSON) so one image serves any tenant.
 *
 * A `requiredData` reference on a taxonomy item (e.g. "kiwix:wikipedia_en")
 * resolves against this map to produce a deep link into the live nOS service.
 */
export interface NosContentService {
  key: string;
  label: string;
  subdomain: string; // <subdomain>.<tenant_domain>
  kind: 'library' | 'media' | 'files' | 'ai' | 'cms' | 'books';
  enabled: boolean;
}

const TENANT_DOMAIN =
  (typeof window !== 'undefined' && (window as any).__KEAP_TENANT_DOMAIN__) || 'dev.local';

/** nOS roles that actually ship as content sources (see nOS `iiab` stack). */
export const nosContentServices: NosContentService[] = [
  { key: 'kiwix', label: 'Kiwix (offline Wikipedia & ZIM)', subdomain: 'kiwix', kind: 'library', enabled: true },
  { key: 'nextcloud', label: 'Nextcloud (files & docs)', subdomain: 'cloud', kind: 'files', enabled: true },
  { key: 'jellyfin', label: 'Jellyfin (media)', subdomain: 'jellyfin', kind: 'media', enabled: true },
  { key: 'calibre', label: 'Calibre-Web (e-books)', subdomain: 'books', kind: 'books', enabled: true },
  { key: 'openwebui', label: 'Open WebUI (local AI chat)', subdomain: 'chat', kind: 'ai', enabled: true },
  { key: 'wordpress', label: 'WordPress (site/blog)', subdomain: 'blog', kind: 'cms', enabled: false },
];

export function serviceUrl(key: string, pathSuffix = ''): string | null {
  const svc = nosContentServices.find((s) => s.key === key && s.enabled);
  if (!svc) return null;
  return `https://${svc.subdomain}.${TENANT_DOMAIN}${pathSuffix}`;
}

/** Resolve a taxonomy item's `requiredData` (e.g. "kiwix:wikipedia") to a URL. */
export function resolveRequiredData(requiredData?: string): string | null {
  if (!requiredData) return null;
  const [key, ...rest] = requiredData.split(':');
  const suffix = rest.join(':');
  return serviceUrl(key, suffix ? `/${suffix}` : '');
}
