/**
 * Server-side resolution of taxonomy `requiredData` refs (e.g. "kiwix:wikipedia_en")
 * into live nOS content-service URLs.
 *
 * Mirror of the SPA-side map in src/config/nos.ts (which resolves against
 * window.__KEAP_TENANT_DOMAIN__); the server resolves against the
 * KEAP_TENANT_DOMAIN env var, which the nOS role sets to the tenant domain.
 * Keep the two service maps in sync.
 */

/**
 * `type` is the explorer's dataType facet — what KIND of knowledge lives
 * behind the link (the /explore side panel filters stars by it).
 */
export type ContentType =
  | 'encyclopedia'
  | 'files'
  | 'media'
  | 'books'
  | 'ai'
  | 'rss'
  | 'wiki'
  | 'notes'
  | 'maps'
  | 'blog';

interface ContentService {
  key: string;
  label: string;
  subdomain: string;
  type: ContentType;
  enabled: boolean;
}

// Subdomains MUST match the nOS `<svc>_domain` defaults in default.config.yml
// (the 2026-07-11 audit fixed jellyfin/openwebui/wordpress drift).
const SERVICES: ContentService[] = [
  { key: 'kiwix', label: 'Kiwix (offline Wikipedia & ZIM)', subdomain: 'kiwix', type: 'encyclopedia', enabled: true },
  { key: 'nextcloud', label: 'Nextcloud (files & docs)', subdomain: 'cloud', type: 'files', enabled: true },
  { key: 'jellyfin', label: 'Jellyfin (media)', subdomain: 'media', type: 'media', enabled: true },
  { key: 'calibre', label: 'Calibre-Web (e-books)', subdomain: 'books', type: 'books', enabled: true },
  { key: 'openwebui', label: 'Open WebUI (local AI chat)', subdomain: 'ai', type: 'ai', enabled: true },
  { key: 'miniflux', label: 'Miniflux (RSS feeds)', subdomain: 'rss', type: 'rss', enabled: true },
  { key: 'outline', label: 'Outline (team wiki)', subdomain: 'wiki', type: 'wiki', enabled: true },
  { key: 'bookstack', label: 'BookStack (documentation)', subdomain: 'bookstack', type: 'wiki', enabled: true },
  { key: 'hedgedoc', label: 'HedgeDoc (collaborative notes)', subdomain: 'hedgedoc', type: 'notes', enabled: true },
  { key: 'maps', label: 'Offline Maps', subdomain: 'maps', type: 'maps', enabled: true },
  { key: 'wordpress', label: 'WordPress (site/blog)', subdomain: 'wordpress', type: 'blog', enabled: false },
];

const TENANT_DOMAIN = process.env.KEAP_TENANT_DOMAIN ?? 'dev.local';

export function resolveContentRef(
  ref?: string,
): { ref: string; service: string; type: ContentType; url: string } | null {
  if (!ref) return null;
  const [key, ...rest] = ref.split(':');
  const svc = SERVICES.find((s) => s.key === key && s.enabled);
  if (!svc) return null;
  const suffix = rest.join(':');
  return {
    ref,
    service: svc.label,
    type: svc.type,
    url: `https://${svc.subdomain}.${TENANT_DOMAIN}${suffix ? `/${suffix}` : ''}`,
  };
}

export function listContentServices() {
  return SERVICES.filter((s) => s.enabled).map((s) => ({
    key: s.key,
    label: s.label,
    type: s.type,
    url: `https://${s.subdomain}.${TENANT_DOMAIN}`,
  }));
}

/** dataType facet for a capture: match its URL/domain against the catalog. */
export function inferCaptureType(domain?: string, url?: string): ContentType | 'capture' {
  const host = domain || (url ? url.replace(/^https?:\/\//, '').split('/')[0] : '');
  if (host) {
    const svc = SERVICES.find(
      (s) => s.enabled && (host === `${s.subdomain}.${TENANT_DOMAIN}` || host.startsWith(`${s.subdomain}.`)),
    );
    if (svc) return svc.type;
  }
  return 'capture';
}
