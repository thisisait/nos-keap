/**
 * Server-side resolution of taxonomy `requiredData` refs (e.g. "kiwix:wikipedia_en")
 * into live nOS content-service URLs.
 *
 * Mirror of the SPA-side map in src/config/nos.ts (which resolves against
 * window.__KEAP_TENANT_DOMAIN__); the server resolves against the
 * KEAP_TENANT_DOMAIN env var, which the nOS role sets to the tenant domain.
 * Keep the two service maps in sync.
 */

interface ContentService {
  key: string;
  label: string;
  subdomain: string;
  enabled: boolean;
}

const SERVICES: ContentService[] = [
  { key: 'kiwix', label: 'Kiwix (offline Wikipedia & ZIM)', subdomain: 'kiwix', enabled: true },
  { key: 'nextcloud', label: 'Nextcloud (files & docs)', subdomain: 'cloud', enabled: true },
  { key: 'jellyfin', label: 'Jellyfin (media)', subdomain: 'jellyfin', enabled: true },
  { key: 'calibre', label: 'Calibre-Web (e-books)', subdomain: 'books', enabled: true },
  { key: 'openwebui', label: 'Open WebUI (local AI chat)', subdomain: 'chat', enabled: true },
  { key: 'wordpress', label: 'WordPress (site/blog)', subdomain: 'blog', enabled: false },
];

const TENANT_DOMAIN = process.env.KEAP_TENANT_DOMAIN ?? 'dev.local';

export function resolveContentRef(ref?: string): { ref: string; service: string; url: string } | null {
  if (!ref) return null;
  const [key, ...rest] = ref.split(':');
  const svc = SERVICES.find((s) => s.key === key && s.enabled);
  if (!svc) return null;
  const suffix = rest.join(':');
  return {
    ref,
    service: svc.label,
    url: `https://${svc.subdomain}.${TENANT_DOMAIN}${suffix ? `/${suffix}` : ''}`,
  };
}

export function listContentServices() {
  return SERVICES.filter((s) => s.enabled).map((s) => ({
    key: s.key,
    label: s.label,
    url: `https://${s.subdomain}.${TENANT_DOMAIN}`,
  }));
}
