import { describe, it, expect } from 'vitest';
import {
  tierRank,
  readableVisibilities,
  readableVisibilitiesFor,
  visibilityGrantsRead,
} from './rbac';

/**
 * S2⁶ §4 — the object-graph visibility ladder. These assert the exact SQL IN()
 * list getVisibleObjects/canReadObject compose from a caller's Authentik groups.
 * ONE SOURCE OF TRUTH: readableVisibilitiesFor === readableVisibilities(tierRank).
 * The load-bearing invariants: 'shared' is ALWAYS present (strict superset of
 * today's flat filter), 'private' is NEVER present (never widened by a tier),
 * and no tier ever leaks a visibility above the caller's rank.
 */
describe('tierRank — groups → rank (lower = more privileged)', () => {
  it('maps each recognized tier group to its rank', () => {
    expect(tierRank(['nos-admins'])).toBe(1);
    expect(tierRank(['nos-providers'])).toBe(1);
    expect(tierRank(['nos-managers'])).toBe(2);
    expect(tierRank(['nos-users'])).toBe(3);
    expect(tierRank(['nos-guests'])).toBe(4);
  });

  it('defaults an empty / unrecognized group set to guest (least privilege)', () => {
    expect(tierRank([])).toBe(4);
    expect(tierRank(['some-random-group'])).toBe(4);
  });

  it('takes the MOST privileged rank when a caller holds several tier groups', () => {
    expect(tierRank(['nos-guests', 'nos-users', 'nos-managers'])).toBe(2);
    expect(tierRank(['nos-users', 'nos-admins'])).toBe(1);
  });
});

describe('readableVisibilities — rank → SQL IN() list', () => {
  it('manager (rank 2) reads every tier at or below it + shared', () => {
    expect(readableVisibilities(2)).toEqual(['tier-managers', 'tier-users', 'tier-guests', 'shared']);
  });

  it('user (rank 3) reads tier-users + below + shared, NOT tier-managers', () => {
    expect(readableVisibilities(3)).toEqual(['tier-users', 'tier-guests', 'shared']);
  });

  it('guest (rank 4) reads only tier-guests + shared', () => {
    expect(readableVisibilities(4)).toEqual(['tier-guests', 'shared']);
  });

  it('admin (rank 1) would read all tiers + shared (but seeAll bypasses this)', () => {
    expect(readableVisibilities(1)).toEqual(['tier-managers', 'tier-users', 'tier-guests', 'shared']);
  });

  it("NEVER includes 'private' at any rank", () => {
    for (const rank of [1, 2, 3, 4]) {
      expect(readableVisibilities(rank)).not.toContain('private');
    }
  });

  it("ALWAYS includes 'shared' at every rank (strict superset of the old filter)", () => {
    for (const rank of [1, 2, 3, 4]) {
      expect(readableVisibilities(rank)).toContain('shared');
    }
  });
});

describe('readableVisibilitiesFor — the composed helper db.ts calls', () => {
  it('equals readableVisibilities(tierRank(groups)) for every tier', () => {
    const cases: string[][] = [
      [],
      ['nos-guests'],
      ['nos-users'],
      ['nos-managers'],
      ['nos-admins'],
      ['nos-users', 'nos-managers'],
    ];
    for (const groups of cases) {
      expect(readableVisibilitiesFor(groups)).toEqual(readableVisibilities(tierRank(groups)));
    }
  });

  it('a nos-users caller can read a tier-users object, a nos-guests caller cannot', () => {
    expect(readableVisibilitiesFor(['nos-users'])).toContain('tier-users');
    expect(readableVisibilitiesFor(['nos-guests'])).not.toContain('tier-users');
  });
});

describe('visibilityGrantsRead — the row-level check semantics', () => {
  it('tier-users grants read to rank <= 3, denies rank 4', () => {
    expect(visibilityGrantsRead('tier-users', 3)).toBe(true);
    expect(visibilityGrantsRead('tier-users', 2)).toBe(true);
    expect(visibilityGrantsRead('tier-users', 4)).toBe(false);
  });

  it('private is never granted by a tier rank', () => {
    for (const rank of [1, 2, 3, 4]) expect(visibilityGrantsRead('private', rank)).toBe(false);
  });

  it('shared is granted to every rank; an unknown value is denied', () => {
    for (const rank of [1, 2, 3, 4]) expect(visibilityGrantsRead('shared', rank)).toBe(true);
    expect(visibilityGrantsRead('nonsense', 1)).toBe(false);
  });
});
