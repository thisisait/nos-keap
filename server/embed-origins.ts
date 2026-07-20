/**
 * Origins permitted to iframe KEAP, for the CSP `frame-ancestors` directive.
 *
 * `KEAP_EMBED_ORIGINS` is a comma-separated list of full origins
 * (`https://os.example.com,http://localhost:5173`) — the same shape the
 * directive itself takes. It replaces `KEAP_FACE_HOST`, which accepted one bare
 * host and prefixed `https://`, thereby deciding unasked that exactly one portal
 * could embed KEAP and that http could not.
 *
 * Every value lands in a response HEADER, so entries are VALIDATED rather than
 * interpolated. A value carrying whitespace, a semicolon or a newline could
 * otherwise append CSP directives or split the header outright — env is not
 * automatically trusted input just because an operator usually writes it.
 */

/** scheme://host[:port] — no path, no wildcards in the host, no stray syntax. */
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * @param tenantDomain KEAP_TENANT_DOMAIN, used only by the deprecated fallback.
 * @returns validated origins, deduped, order preserved. Never throws: a bad
 *          entry is dropped with a warning, because a malformed origin must not
 *          be able to take the server down at boot.
 */
export function embedOrigins(tenantDomain = ''): string[] {
  const raw = process.env.KEAP_EMBED_ORIGINS ?? '';
  const out: string[] = [];
  const seen = new Set<string>();

  const accept = (candidate: string, source: string) => {
    const v = candidate.trim();
    if (!v) return;
    if (!ORIGIN_RE.test(v)) {
      console.warn(`[csp] ignoring invalid embed origin from ${source}: ${JSON.stringify(v.slice(0, 80))}`);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  if (raw) {
    for (const entry of raw.split(',')) accept(entry, 'KEAP_EMBED_ORIGINS');
    return out;
  }

  // ── deprecated fallbacks (one version) ────────────────────────────────────
  const faceHost = (process.env.KEAP_FACE_HOST ?? '').trim();
  if (faceHost) {
    console.warn(
      '[csp] KEAP_FACE_HOST is deprecated — it takes one bare host and assumes https, ' +
        'so it cannot express multiple portals or a local http origin. Use KEAP_EMBED_ORIGINS.',
    );
    accept(`https://${faceHost}`, 'KEAP_FACE_HOST');
    return out;
  }
  if (tenantDomain) {
    // Historical default: a neighbouring product's subdomain convention, kept
    // only so an older pin keeps embedding until it migrates.
    accept(`https://face.${tenantDomain}`, 'KEAP_TENANT_DOMAIN');
  }
  return out;
}
