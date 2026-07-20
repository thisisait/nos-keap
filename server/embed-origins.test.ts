import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedOrigins } from './embed-origins';

/**
 * `frame-ancestors` takes a SOURCE LIST. The previous interface took one bare
 * host and prefixed `https://`, which silently decided that only one portal
 * could embed KEAP and that http could not — neither of which anyone chose.
 *
 * These values land in a response header, so the validation is the point.
 */
afterEach(() => {
  delete process.env.KEAP_EMBED_ORIGINS;
  delete process.env.KEAP_FACE_HOST;
  vi.restoreAllMocks();
});

describe('embedOrigins', () => {
  it('accepts several origins with explicit schemes', () => {
    process.env.KEAP_EMBED_ORIGINS = 'https://os.example.com,http://localhost:5173';
    expect(embedOrigins()).toEqual(['https://os.example.com', 'http://localhost:5173']);
  });

  it('trims, dedupes and preserves order', () => {
    process.env.KEAP_EMBED_ORIGINS = ' https://a.test , https://b.test ,https://a.test';
    expect(embedOrigins()).toEqual(['https://a.test', 'https://b.test']);
  });

  it('drops entries that could inject into the CSP header', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A newline splits the header; a semicolon appends a directive. Env is not
    // trusted input merely because an operator usually writes it.
    process.env.KEAP_EMBED_ORIGINS = [
      'https://ok.test',
      'https://evil.test; default-src *',
      'https://evil.test\nX-Injected: 1',
      "https://evil.test 'unsafe-inline'",
      'javascript:alert(1)',
      'https://path.test/nope',
      '*',
    ].join(',');
    expect(embedOrigins()).toEqual(['https://ok.test']);
  });

  it('never throws on a malformed list — a bad origin must not stop boot', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KEAP_EMBED_ORIGINS = ',,   ,not-an-origin,';
    expect(embedOrigins()).toEqual([]);
  });

  it('falls back to the deprecated single host, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KEAP_FACE_HOST = 'os.example.com';
    expect(embedOrigins()).toEqual(['https://os.example.com']);
    expect(warn).toHaveBeenCalled(); // deprecation must be audible, not silent
  });

  it('prefers the new variable and ignores the deprecated one entirely', () => {
    process.env.KEAP_EMBED_ORIGINS = 'https://new.test';
    process.env.KEAP_FACE_HOST = 'old.test';
    expect(embedOrigins()).toEqual(['https://new.test']);
  });

  it('falls back to the historical tenant convention only when nothing else is set', () => {
    expect(embedOrigins('example.com')).toEqual(['https://face.example.com']);
  });

  it('permits nothing when nothing is configured', () => {
    // Self-only embedding: the caller prepends 'self'.
    expect(embedOrigins()).toEqual([]);
  });
});
