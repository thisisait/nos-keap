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

/** The scope a table is shared at — the LADDER lives in
 *  shared/contracts/visibility.ts (dtt-share-model: one source; caddy's
 *  transcript visibility imports the same module). This module keeps only the
 *  tier→rank resolution and the grant checks. */
import {
  tableVisibilitySchema,
  VISIBILITY_MIN_RANK,
  type Principal,
  type RowSharing,
  type ShareEntry,
  type TableVisibilityContract,
  type VisibilityGrade,
} from '../shared/contracts/visibility';

export type TableVisibility = TableVisibilityContract;

export const TABLE_VISIBILITIES: TableVisibility[] = tableVisibilitySchema.options;

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

/**
 * The non-owner visibilities a caller with these Authentik groups may read —
 * the object-graph SQL IN() list (server/db.ts getVisibleObjects/canReadObject).
 * ONE SOURCE OF TRUTH: composes tierRank + readableVisibilities, the same ladder
 * the table registry uses. 'shared' is rank 99, so this is ALWAYS a strict
 * superset of the old flat `visibility='shared'` filter (nothing that renders
 * today stops rendering), and NEVER includes 'private' (rank 0 → never granted).
 * An empty/unrecognized group set collapses to guest (rank 4) = the least-
 * privilege authenticated bucket [tier-guests, shared] — never wider.
 */
export function readableVisibilitiesFor(groups: string[]): TableVisibility[] {
  return readableVisibilities(tierRank(groups));
}

/** Guests (rank 4) are read-only — everyone else may create/own tables. */
export function canCreateTables(rank: number): boolean {
  return rank <= 3;
}

// ── dtt-share-model: principal-aware access (the human door's full model) ────

export function grantFor(sharedWith: ShareEntry[] | undefined, principal: Principal): 'read' | 'write' | null {
  const e = sharedWith?.find((x) => x.principal === principal);
  return e ? e.access : null;
}

/** Most-restrictive composition of the table grade and a row's narrowing
 *  grade (settlement #3: a row may narrow tier exposure, never widen it).
 *  Restrictiveness = the MIN_RANK ordering; ties go to the row's grade. */
export function effectiveGrade(table: string, row?: VisibilityGrade): string {
  if (!row) return table;
  const t = VISIBILITY_MIN_RANK[table as VisibilityGrade];
  if (t === undefined) return row; // unknown table grade → the row's narrowing stands
  return VISIBILITY_MIN_RANK[row] <= t ? row : table;
}

export interface ShareCaller {
  principal: Principal;
  /** bare uid for legacy ownerId comparison (data_tables.user_id is unprefixed) */
  id: string;
  isAdmin: boolean;
  groups: string[];
}

interface TableLike {
  ownerId: string;
  visibility: string;
  sharedWith?: ShareEntry[];
}

/** Table READ: admin, owner, tier ladder, or an explicit grant. (A row-only
 *  grantee reaches the table via hasRowGrantFor at the route — existence is
 *  implied by the row grant, rows are filtered per row below.) */
export function canReadTableAs(t: TableLike, c: ShareCaller): boolean {
  if (c.isAdmin || t.ownerId === c.id) return true;
  if (grantFor(t.sharedWith, c.principal)) return true;
  return visibilityGrantsRead(t.visibility, tierRank(c.groups));
}

/** Table WRITE: owner/admin as ever, plus an explicit WRITE grant — the one
 *  capability the old owner-or-admin gate could not express. */
export function canWriteTableAs(t: TableLike, c: ShareCaller): boolean {
  if (c.isAdmin || t.ownerId === c.id) return true;
  return grantFor(t.sharedWith, c.principal) === 'write';
}

/** Row READ: admin, table owner, row owner, any grant (table ∪ row — grants
 *  UNION and may cross the grade wall), else the tier ladder over the
 *  most-restrictive composed grade. */
export function canReadRowAs(t: TableLike, sharing: RowSharing | undefined, c: ShareCaller): boolean {
  if (c.isAdmin || t.ownerId === c.id) return true;
  if (sharing?.owner === c.principal) return true;
  if (grantFor(t.sharedWith, c.principal) || grantFor(sharing?.sharedWith, c.principal)) return true;
  return visibilityGrantsRead(effectiveGrade(t.visibility, sharing?.visibility), tierRank(c.groups));
}

/** Row WRITE: admin, table owner, row owner, or a WRITE grant (table ∪ row). */
export function canWriteRowAs(t: TableLike, sharing: RowSharing | undefined, c: ShareCaller): boolean {
  if (c.isAdmin || t.ownerId === c.id) return true;
  if (sharing?.owner === c.principal) return true;
  return (
    grantFor(t.sharedWith, c.principal) === 'write' ||
    grantFor(sharing?.sharedWith, c.principal) === 'write'
  );
}

/** May this caller CHANGE a row's sharing (visibility/grants)? Owner-class
 *  only: admin, table owner, or the row's own owner — a write GRANTEE edits
 *  values, never the shares. */
export function canShareRowAs(t: TableLike, sharing: RowSharing | undefined, c: ShareCaller): boolean {
  return c.isAdmin || t.ownerId === c.id || sharing?.owner === c.principal;
}
