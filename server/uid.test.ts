import { describe, expect, it } from 'vitest';
import { canonicalUid, slugifyUid } from './uid';

/**
 * The canonical-uid contract is SHARED with the nOS face BFF ($lib/security/
 * uid.ts, commit e5c3734f). These vectors are the locked contract — if any
 * changes, KEAP row owners and fs-mirror file owners diverge from face. Keep
 * byte-for-byte identical to the nOS suite.
 */
describe('canonicalUid — locked nOS contract vectors', () => {
  const vectors: Array<{ username?: string; email?: string; uid?: string; expect: string; note: string }> = [
    { username: 'akadmin', expect: 'akadmin', note: 'plain' },
    { username: 'Pázny', expect: 'pazny', note: 'czech diacritic folds, not dash-splits' },
    { username: 'Šárka Čížková', expect: 'sarka-cizkova', note: 'diacritics + space' },
    { username: 'Řehoř', expect: 'rehor', note: 'diacritics' },
    { username: 'Pazny.Develop@Gmail.com', expect: 'pazny-develop-gmail-com', note: 'dots/@ → dash' },
    { username: 'john_doe', expect: 'john-doe', note: 'underscore → dash' },
    { username: '', email: 'Petr.Novák@firma.cz', expect: 'petr-novak', note: 'email local-part fallback' },
    { username: '', email: '', uid: 'abc123DEF', expect: 'abc123def', note: 'uid fallback, lowercased' },
  ];
  for (const v of vectors) {
    it(`${JSON.stringify(v.username || v.email || v.uid)} → ${v.expect} (${v.note})`, () => {
      expect(canonicalUid(v.username, v.email, v.uid)).toBe(v.expect);
    });
  }
});

describe('canonicalUid — KEAP-internal edges', () => {
  it('all sources empty → empty string', () => {
    expect(canonicalUid('', '', '')).toBe('');
    expect(canonicalUid(null, null, null)).toBe('');
    expect(canonicalUid(undefined)).toBe('');
  });
  it('idempotent on an already-canonical key (folder-name re-slug)', () => {
    expect(canonicalUid('nos-docs')).toBe('nos-docs');
    expect(canonicalUid('pazny')).toBe('pazny');
  });
  it('trims and collapses leading/trailing/repeat separators', () => {
    expect(slugifyUid('__foo..bar__')).toBe('foo-bar');
    expect(slugifyUid('  Hello   World  ')).toBe('hello-world');
  });
  it('caps at 64 chars and re-trims a dangling dash', () => {
    const out = slugifyUid('a'.repeat(63) + ' bcd'); // 63 a's, then space→dash at index 63
    expect(out.length).toBe(63); // the dash-then-content is cut at 64 → re-trim drops the dash
    expect(out.endsWith('-')).toBe(false);
  });
  it('non-decomposable letters (ß) fall to a separator, not content', () => {
    expect(slugifyUid('straße')).toBe('stra-e');
  });
});
