import { describe, expect, it } from 'vitest';
import { parseCardFrontmatter } from './fs-sync';

/**
 * The two honored keys decide things fs-sync could not previously express:
 * `type` (a skill card landed as 'page' by extension, making the skill facet and
 * its visual form unreachable for the whole router corpus) and `title`
 * (basename-only titling produced nine cards named `_stack.md`).
 */
describe('parseCardFrontmatter', () => {
  it('honors type and title, strips the block from the body', () => {
    const r = parseCardFrontmatter('---\ntype: skill\ntitle: upload-file\n---\nBody text [[nos.iiab.nextcloud]].\n');
    expect(r.type).toBe('skill');
    expect(r.title).toBe('upload-file');
    expect(r.body).toBe('Body text [[nos.iiab.nextcloud]].\n');
    expect(r.fm).toEqual({ type: 'skill', title: 'upload-file' });
  });

  it('rejects a type outside the slug charset but keeps it visible in fm', () => {
    const r = parseCardFrontmatter('---\ntype: Not A Slug\n---\nbody\n');
    expect(r.type).toBeUndefined(); // falls back to the extension type
    expect(r.fm?.type).toBe('Not A Slug'); // preserved, never interpreted
  });

  it('unknown keys ride along verbatim without being honored', () => {
    const r = parseCardFrontmatter('---\ntype: skill\nowner: bob\n---\nbody\n');
    expect(r.fm).toEqual({ type: 'skill', owner: 'bob' });
  });

  it('a malformed or absent block is body text, never an error', () => {
    // A producer typo must not eat the card.
    expect(parseCardFrontmatter('---\nnever closed').body).toBe('---\nnever closed');
    expect(parseCardFrontmatter('plain body').body).toBe('plain body');
    expect(parseCardFrontmatter(undefined).body).toBeUndefined();
    // an empty block carries no keys → treated as body, not as frontmatter
    expect(parseCardFrontmatter('---\n---\nbody').body).toBe('---\n---\nbody');
  });

  it('caps a runaway title instead of storing it', () => {
    const r = parseCardFrontmatter(`---\ntitle: ${'x'.repeat(500)}\n---\nbody`);
    expect(r.title!.length).toBe(200);
  });
});
