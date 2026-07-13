/**
 * Data-access RBAC — maps the global nOS Authentik tiers onto table visibility.
 *
 * KEAP runs behind Authentik header-OIDC; the caller's tier arrives as group
 * membership in `req.user.groups`. Table access used to see only `isAdmin`
 * (Tier-1) + ownerId + a binary tenant-wide `shared` flag — Tiers 2/3/4 were
 * invisible, and a guest could create/own tables like a manager. This module
 * threads the four tiers through, reusing the existing `visibility` column as
 * an ordered scope (no schema migration).
 *
 * Ranks: lower = more privileged. admin=1, manager=2, user=3, guest=4.
 * An authenticated caller with no recognized tier group defaults to guest
 * (least privilege).
 */

/** The scope a table is shared at. Widened from the old private|shared pair. */
export type TableVisibility =
  | 'private'
  | 'tier-managers'
  | 'tier-users'
  | 'tier-guests'
  | 'shared';

export const TABLE_VISIBILITIES: TableVisibility[] = [
  'private',
  'tier-managers',
  'tier-users',
  'tier-guests',
  'shared',
];

const TIER_GROUPS: Record<number, string[]> = {
  1: ['nos-providers', 'nos-admins'],
  2: ['nos-managers'],
  3: ['nos-users'],
  4: ['nos-guests'],
};

/** Lowest (most-privileged) tier rank the caller holds; guest (4) if none. */
export function tierRank(groups: string[]): number {
  for (const rank of [1, 2, 3, 4]) {
    if (TIER_GROUPS[rank].some((g) => groups.includes(g))) return rank;
  }
  return 4;
}

// Minimum caller rank a visibility grants READ to. 0 = owner/admin only
// (never granted by tier); 99 = any authenticated caller.
const VISIBILITY_MIN_RANK: Record<TableVisibility, number> = {
  private: 0,
  'tier-managers': 2,
  'tier-users': 3,
  'tier-guests': 4,
  shared: 99,
};

/** Does a table's visibility grant READ to a caller of the given rank? */
export function visibilityGrantsRead(visibility: string, rank: number): boolean {
  const min = VISIBILITY_MIN_RANK[visibility as TableVisibility];
  if (min === undefined || min === 0) return false; // unknown value or private → deny
  return rank <= min;
}

/** Non-owner visibilities a caller of `rank` may read — for the list SQL IN(). */
export function readableVisibilities(rank: number): TableVisibility[] {
  return (['tier-managers', 'tier-users', 'tier-guests', 'shared'] as TableVisibility[]).filter(
    (v) => visibilityGrantsRead(v, rank),
  );
}

/** Guests (rank 4) are read-only — everyone else may create/own tables. */
export function canCreateTables(rank: number): boolean {
  return rank <= 3;
}
