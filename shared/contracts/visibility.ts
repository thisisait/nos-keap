/**
 * Visibility & sharing contract — THE one source (dtt-share-model, 2026-09-05).
 *
 * Operator ruling (nOS docs/plans/datatables-subsystem.md §4 + the
 * caddy-transcript-visibility decision): visibility is a configurable GRADE
 * ladder, defined ONCE. This module is that once. server/rbac.ts imports the
 * ladder (it owns tier→rank resolution and enforcement); nOS's
 * cortex-caddy-transcript-visibility imports the same file; nothing else may
 * re-declare a visibility enum.
 *
 * THE LADDER (ordered by the minimum caller rank that reads it — see
 * VISIBILITY_MIN_RANK; lower rank = more privileged; admin=1 … guest=4):
 *   private        owner + admin only (rank 0 = never granted by tier)
 *   system         system principals only (agents / the estate's own jobs) —
 *                  the one grade the dtt-share-model plan added; a human tier
 *                  NEVER satisfies it, which is why its min-rank is 0 and its
 *                  enforcement keys on the principal namespace, not the rank
 *   tier-managers  Authentik tier 2 and above
 *   tier-users     tier 3 and above
 *   tier-guests    tier 4 and above (any recognized tier)
 *   shared         every authenticated caller (rank 99). This estate has no
 *                  unauthenticated readers, so `shared` IS the plan's
 *                  "public"; a wider grade would be a new row here, not a
 *                  parallel enum somewhere else.
 * Mapping from the plan's spelling: 'owner' → private (ownership is an
 * implicit ROLE — the owner always reads and writes — not a grade),
 * 'public' → shared, 'tier-<n>' → the three tier grades.
 *
 * PRINCIPALS — the ACL vocabulary (nOS docs/doctrine/identity.md §6):
 *   user:<canonicalUid>   canonical slug of the USERNAME (server/uid.ts) —
 *                         NEVER the Authentik uid, which is random and
 *                         regenerates on a tenant blank (identity.ts:83-87)
 *   agent:<name>          AgentKit client-id roster name; external agents
 *                         reserved there (agent:cursor / codex / claude-code)
 * Both halves share one slug grammar: [a-z0-9], dashes inside, max 64.
 * Existing bare `user_id` columns keep their unprefixed spelling — the
 * prefixed form is for the NEW owner/shared_with fields only.
 *
 * SHARING — `shared_with` is an explicit ACL of principals granted read or
 * write, INDEPENDENT of tier (a private table shared with one user is the
 * whole point). Attachment plan (enforcement is a separate, later change —
 * this file is the reviewable contract):
 *   - table-level: `sharing` block on the table metadata (create/update
 *     contracts + TableInfo), enforced by BOTH doors — canReadTable/
 *     canWriteTable grow a shared_with leg beside the tier ladder.
 *   - row-level: the same triple rides RESERVED `__`-prefixed meta keys
 *     (`__owner`, `__visibility`, `__shared_with`) peeled off values exactly
 *     like `__id` — identity and access are never data columns.
 * Absence-safe doctrine (settled): an unreadable table/row is ABSENT (404 /
 * filtered from listings), never a 403 that leaks existence; a write refusal
 * on something the caller CAN read is an explicit 403.
 *
 * Agent-door identity phases (schema-invariant): phase 1 the door trusts
 * `agent:<x-keap-agent>` after bearer validation (COOPERATIVE — the same
 * trust the row lease already extends); phase 2 swaps in per-agent bearers
 * (nOS CredentialResolver) with no change to any shape in this file.
 */
import { z } from 'zod';

// ── The grade ladder ─────────────────────────────────────────────────────────

export const VISIBILITY_GRADES = [
  'private',
  'system',
  'tier-managers',
  'tier-users',
  'tier-guests',
  'shared',
] as const;

export const visibilityGradeSchema = z.enum(VISIBILITY_GRADES);
export type VisibilityGrade = z.infer<typeof visibilityGradeSchema>;

/** Minimum caller TIER RANK a grade grants READ to. 0 = never granted by any
 *  tier (private: owner/admin only; system: principal-namespace check, not a
 *  rank check). 99 = any authenticated caller. Lower rank = more privileged. */
export const VISIBILITY_MIN_RANK: Record<VisibilityGrade, number> = {
  private: 0,
  system: 0,
  'tier-managers': 2,
  'tier-users': 3,
  'tier-guests': 4,
  shared: 99,
};

/** The subset the TABLE surface accepts TODAY. `system` joins when its
 *  enforcement (principal-namespace read check in both doors) lands — a grade
 *  the doors would store but not enforce is a promise the operator sees
 *  broken, so acceptance follows enforcement, never precedes it. */
export const tableVisibilitySchema = z.enum([
  'private',
  'tier-managers',
  'tier-users',
  'tier-guests',
  'shared',
]);
export type TableVisibilityContract = z.infer<typeof tableVisibilitySchema>;

// ── Principals ───────────────────────────────────────────────────────────────

/** One slug grammar for both namespaces: canonicalUid output for users
 *  (server/uid.ts slugifyUid), the AgentKit client-id roster for agents. */
const PRINCIPAL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const principalSchema = z
  .string()
  .max(70)
  .refine(
    (p) => {
      const [ns, name, ...rest] = p.split(':');
      return rest.length === 0 && (ns === 'user' || ns === 'agent') && !!name && PRINCIPAL_NAME.test(name);
    },
    { message: "principal must be user:<canonical-uid> or agent:<name> (slug, max 64)" },
  );
export type Principal = z.infer<typeof principalSchema>;

// ── Shares ───────────────────────────────────────────────────────────────────

export const shareAccessSchema = z.enum(['read', 'write']); // write implies read
export type ShareAccess = z.infer<typeof shareAccessSchema>;

export const shareEntrySchema = z.object({
  principal: principalSchema,
  access: shareAccessSchema,
});
export type ShareEntry = z.infer<typeof shareEntrySchema>;

/** The ACL. Capped — a personal estate shares with people and agents, not
 *  crowds; past the cap the right tool is a tier grade. Duplicate principals
 *  refused so "which entry wins" can never be a question. */
export const sharedWithSchema = z
  .array(shareEntrySchema)
  .max(32)
  .refine((xs) => new Set(xs.map((x) => x.principal)).size === xs.length, {
    message: 'duplicate principal in shared_with',
  });

/** The full share model triple, as it will attach to table metadata and (via
 *  reserved `__` meta keys) to rows. `owner` is a principal, not a grade —
 *  it always reads and writes; `visibility` gates by tier; `sharedWith`
 *  grants across tiers. */
export const sharingSchema = z.object({
  owner: principalSchema.optional(),
  visibility: visibilityGradeSchema.default('private'),
  sharedWith: sharedWithSchema.default([]),
});
export type Sharing = z.infer<typeof sharingSchema>;
