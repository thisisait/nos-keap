import { describe, expect, it } from 'vitest';
import {
  VISIBILITY_GRADES,
  VISIBILITY_MIN_RANK,
  principalSchema,
  sharedWithSchema,
  sharingSchema,
  tableVisibilitySchema,
  visibilityGradeSchema,
} from '../shared/contracts/visibility';
import { TABLE_VISIBILITIES } from './rbac';
import { canonicalUid, slugifyUid } from './uid';

/**
 * dtt-share-model contract gates (shape only — enforcement ships separately).
 * The laws pinned here are the ones both repos agreed to on 2026-09-05:
 * one ladder source, the principal grammar, and no grade accepted before it
 * is enforced.
 */
describe('one visibility ladder', () => {
  it('rbac and the table contract read the same source', () => {
    expect(TABLE_VISIBILITIES).toEqual(tableVisibilitySchema.options);
    for (const v of TABLE_VISIBILITIES) {
      expect(VISIBILITY_GRADES).toContain(v);
      expect(VISIBILITY_MIN_RANK[v]).toBeDefined();
    }
  });

  it("'system' is accepted now that its enforcement landed, and is never tier-granted", () => {
    // Acceptance follows enforcement: the human door reads system as rank-0
    // (owner/admin only — share-enforcement.test.ts proves it behaviourally),
    // the agent door serves it under phase-1 estate trust.
    expect(visibilityGradeSchema.safeParse('system').success).toBe(true);
    expect(tableVisibilitySchema.safeParse('system').success).toBe(true);
    expect(VISIBILITY_MIN_RANK.system, 'system must never be tier-granted').toBe(0);
  });
});

describe('principal grammar', () => {
  it.each(['user:pazny', 'agent:librarian', 'agent:claude-code', 'user:a', `agent:${'a'.repeat(64)}`])(
    'accepts %s',
    (p) => expect(principalSchema.safeParse(p).success).toBe(true),
  );

  it.each([
    'pazny', // bare — the ACL form is namespaced
    'device:kiosk', // devices are intake attribution, not shareable principals
    'user:Pazny', // canonicalUid is lowercase by construction
    'user:-x', // no edge dashes (slugifyUid trims them)
    'agent:a:b', // one namespace separator
    'user:', // empty name
    `agent:${'a'.repeat(65)}`, // over the uid cap
  ])('rejects %s', (p) => expect(principalSchema.safeParse(p).success).toBe(false));
});

describe('the uid boundary invariant (settlement #1)', () => {
  // Every NON-EMPTY slug the identity layer can mint must be a legal
  // principal name — otherwise a user exists who cannot own the table they
  // just created. The nasty vectors cover each transform step: diacritics,
  // case, symbol runs, edge dashes, the 64-cap, and multi-signal fallback.
  it.each([
    'Pázny',
    'ALL-CAPS_user',
    '  spaced  name  ',
    'émile@--weird--',
    'x'.repeat(200),
    '-leading-and-trailing-',
    'a',
    '日本語ユーザー latin1',
  ])('slugifyUid(%j) output parses as user:<slug>', (raw) => {
    const slug = slugifyUid(raw);
    if (!slug) return; // the empty hole is refused at enforcement, not here
    expect(principalSchema.safeParse(`user:${slug}`).success, `slug ${JSON.stringify(slug)}`).toBe(true);
  });

  it('the fallback chain (username → email local-part → uid) stays inside the grammar', () => {
    const slug = canonicalUid('***', 'Weird.Náme+tag@example.com', null);
    expect(slug).not.toBe('');
    expect(principalSchema.safeParse(`user:${slug}`).success).toBe(true);
  });
});

describe('shared_with', () => {
  it('refuses duplicate principals — "which entry wins" must never be a question', () => {
    const dup = [
      { principal: 'user:pazny', access: 'read' },
      { principal: 'user:pazny', access: 'write' },
    ];
    expect(sharedWithSchema.safeParse(dup).success).toBe(false);
  });

  it('the sharing triple defaults closed: private, empty ACL', () => {
    const parsed = sharingSchema.parse({});
    expect(parsed.visibility).toBe('private');
    expect(parsed.sharedWith).toEqual([]);
  });
});
