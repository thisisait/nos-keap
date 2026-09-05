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

  it("'system' exists in the ladder but is NOT accepted by the table surface yet", () => {
    // A grade the doors would store but not enforce is a promise the operator
    // sees broken — acceptance follows enforcement.
    expect(visibilityGradeSchema.safeParse('system').success).toBe(true);
    expect(tableVisibilitySchema.safeParse('system' as never).success).toBe(false);
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
