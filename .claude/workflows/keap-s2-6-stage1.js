export const meta = {
  name: 'keap-s2-6-stage1',
  description: 'S2⁶ stage 1 — visibility-ladder fix (rbac tiers → getVisibleObjects) + the graph-metadata card contract',
  whenToUse: 'S2⁶ stage 1 of 2, per docs/specs/table-graph-metadata-spec.md (decisions D1=rbac-ladder, D3=materialise locked). KEAP-internal + independent of the nOS face: wire the server/rbac.ts tier ladder into getVisibleObjects/canReadObject (fixes tier-scoped objects rendering for the right callers, not admins-only), and land the optional `graph` metadata block on the create-table contract with the CARD visual override wired end-to-end. mode:"rows" is accepted by the schema but treated as card-only in stage 1 (materialisation is stage 2). Launch on feat/s2-6-table-graph.',
  phases: [
    { title: 'Scout', detail: 'audit getVisibleObjects/canReadObject callers + identity groups plumbing + card render' },
    { title: 'Implement', detail: 'ladder fix + graph block schema + card visual override + e2e' },
    { title: 'Verify', detail: 'adversarial visibility-leak + regression refuters + fixer' },
    { title: 'Gate', detail: 'build + lint baseline + vitest + e2e' },
  ],
}

const SPEC = 'docs/specs/table-graph-metadata-spec.md'

const INVARIANTS = `
KEAP invariants (violating any = the work is wrong):
- Spatial memory: taxonomy stars never move; all layout is deterministic, keyed by immutable ids.
- The fs-sync USERS pass (server/fs-sync.ts) is behaviorally FROZEN.
- DEFAULT-SAFE: a table with NO \`graph\` block behaves byte-identically to today (one table-<slug> card, generic asteroid/hue-180). Every existing table — INCLUDING the nOS face config tables (face-layouts/wallpapers/controls) — must be unaffected. Prove it (an existing-table e2e stays green).
- VISIBILITY IS LOAD-BEARING: the ladder fix must be a strict SUPERSET of today — nothing that renders now may stop rendering. 'shared' stays any-authenticated (rank 99); 'private' stays owner+admin only; admin (seeAll) still sees all. A tier-scoped object becomes visible to the tiers rbac.ts already grants, and to NO ONE else. NEVER widen private. NEVER leak across tenants.
- ONE SOURCE OF TRUTH: reuse server/rbac.ts (tierRank/readableVisibilities/visibilityGrantsRead) — do NOT hand-roll a second ladder. The caller's GROUPS come from identity (X-Authentik-Groups), the same source isAdmin derives from.
- STAGE-1 SCOPE ONLY: land the \`graph\` schema block + the CARD visual override (form/hue/glyph) + \`graph.mode\` plumbed through syncCard→frontmatter→graph.ts. mode:'rows' is ACCEPTED by the schema but renders CARD-ONLY in stage 1 (materialisation/syncRows is stage 2 — do NOT build it here). No knowledge_object per row in this stage.
- Lint: record BASELINE before changing anything; errors stay 0, warnings must not grow past the CI cap (31). Type new code properly, never eslint-disable.
- Every UI string → src/i18n/locales/en.json AND cs.json (stage 1 is backend-heavy; any label counts).
- e2e: npm run build && npx playwright test must pass; every new behaviour gets a spec assertion. vitest for pure logic (rbac mapping).
- Commit completed work on the CURRENT branch (conventional message). NEVER touch main, never tag, never push, never bump the nOS pin.
`

phase('Scout')
const scout = await agent(`In /Users/pazny/projects/knowledge-explorer-and-preserver, read ${SPEC} (§3 the graph contract, §3-card override, §4 the visibility fix) then map EXACTLY what stage 1 touches. Return terse file:line anchors:
1) server/db.ts getVisibleObjects (~1197-1207) + canReadObject (~904-911): the exact current filters. EVERY caller of getVisibleObjects and canReadObject across server/ (grep — graph.ts:181 is one; find the rest). For each, what identity is in scope (does it have req.user.groups? or only userId/isAdmin?).
2) The identity shape: server/identity.ts — does req.user carry \`groups\` (the X-Authentik-Groups list)? If not, where do groups live and how is isAdmin derived? What must be threaded so getVisibleObjects can compute tierRank(groups).
3) server/rbac.ts: the exact signatures of tierRank(groups), readableVisibilities(rank), visibilityGrantsRead(visibility,rank) — confirm they take a groups[]/rank and return the tier list for an IN() clause.
4) shared/contracts/table.ts createTableRequestSchema (~192-201): the exact field list + where an optional \`graph\` block attaches; is there a superRefine to add cross-field validation? The CelestialForm enum location (server/asset-types.ts / src orbital.ts) to reuse for graph.card.form.
5) server/tables.ts syncCard (~189-218): where frontmatter is assembled (so graph.card + graph.mode land in frontmatter.graph); server/graph.ts:186-217 where the card's form/hue/glyph is derived (assetDescriptor) — the exact point a frontmatter.graph.card override would apply.
6) server/agent.ts POST /agent/v1/tables (~581-588): the create passthrough object where a \`graph\` field must be forwarded.
Return an implementation brief with the caller audit (the full list), the groups-threading path, and the exact override-application points. Do NOT propose behaviour beyond the spec.`, { schema: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } } })

phase('Implement')
const impl = await agent(`${INVARIANTS}
Implement S2⁶ STAGE 1 in /Users/pazny/projects/knowledge-explorer-and-preserver, per ${SPEC} and this scout brief:
${scout.brief}

Requirements:
- VISIBILITY LADDER FIX (§4): thread the caller's GROUPS into getVisibleObjects (and canReadObject). Replace the flat \`user_id = ? OR visibility = 'shared'\` with \`user_id = ? OR visibility IN (<readableVisibilities(tierRank(groups))>)\` using server/rbac.ts (do NOT hand-roll). admin/seeAll unchanged (all rows). Update EVERY caller found in the audit to pass groups (from req.user). A caller with no group context (internal/system) must default to the SAFEST behaviour (treat as owner-only/no-tier — never widen). Add a vitest for the mapping (tierRank/readableVisibilities → the SQL IN list) and a helper if it clarifies.
- GRAPH METADATA BLOCK (§3): add the optional \`graph\` block to createTableRequestSchema (graphMetaSchema: mode enum 'card'|'rows' default 'card'; card {form?,hue?,glyph?}; node {...} + edges [...] DEFINED per spec so the contract is visible, but STAGE 1 only IMPLEMENTS \`card\` + \`mode\`). superRefine: when node/anchorColumn/edges[].column are present they must name real schema columns; kind/edges[].type are lowercase-kebab slugs. Reuse the CelestialForm enum. mode:'rows' is accepted but stage-1 render is CARD-ONLY (documented in code).
- CARD VISUAL OVERRIDE: syncCard stores \`graph\` verbatim in frontmatter.graph; server/graph.ts applies frontmatter.graph.card.{form,hue,glyph} over the assetDescriptor default for a type='table' card (fallback = today's asteroid/hue-180). Deterministic.
- AGENT PASSTHROUGH: server/agent.ts POST /agent/v1/tables forwards an optional \`graph\` field into the create request (validated by the schema). Add it to OPENAPI_SPEC.
- e2e (extend the tables spec or a new e2e/table-graph.spec.ts): (a) the VISIBILITY MATRIX — a tier-users card visible to a nos-users caller, invisible to a nos-guests caller, visible to admin; a shared card visible to all; a private card owner+admin only; (b) a table with graph.card override renders the overridden form/hue; (c) an EXISTING table with NO graph block is byte-identical (regression); (d) mode:'rows' renders card-only in stage 1.
- ROADMAP.md: note S2⁶ stage 1 shipped (visibility ladder + card contract).
Build + lint + vitest + e2e locally until green, then commit. Return a summary of files changed + decisions taken + the exact caller audit you updated.`, { effort: 'high' })

phase('Verify')
const verdicts = await parallel([
  () => agent(`Adversarially REFUTE the VISIBILITY side of the latest commits on the current branch in /Users/pazny/projects/knowledge-explorer-and-preserver: "${impl.slice(0, 1600)}". Attack: (a) a caller of getVisibleObjects/canReadObject that was NOT updated to pass groups (grep every call site — a missed one either crashes or silently falls back to a WRONG visibility set); (b) the fix WIDENING 'private' or leaking across tenants/users; (c) a tier-scoped object becoming visible to a caller BELOW its entitled tier (off-by-one in tierRank/readableVisibilities usage, or admin-only paths regressing); (d) something that renders today NO LONGER rendering (the superset property broken — e.g. 'shared' or own dropped); (e) a system/internal caller with no groups defaulting to OVER-broad instead of owner-only. Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
  () => agent(`Adversarially REFUTE the CONTRACT/REGRESSION side of the latest commits on the current branch in /Users/pazny/projects/knowledge-explorer-and-preserver: (a) an EXISTING table with no graph block is NOT byte-identical (the card form/hue/glyph changed, or frontmatter shape drifted, breaking the face config tables); (b) mode:'rows' accidentally materialises rows / draws row-nodes in stage 1 (must be card-only — stage 2 owns materialisation); (c) the graph schema rejects a valid create or accepts an invalid one (superRefine gaps: a column ref that doesn't exist, a non-slug kind/type); (d) the /agent/v1/tables passthrough drops or mangles the graph field; (e) i18n en/cs drift; determinism of the card override. Default to refuted=true when uncertain.`, { schema: { type: 'object', required: ['refuted', 'findings'], properties: { refuted: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } } } }),
])
const problems = verdicts.filter(Boolean).flatMap((v) => (v.refuted ? v.findings : []))
if (problems.length) {
  await agent(`${INVARIANTS}
Fix these verified findings in /Users/pazny/projects/knowledge-explorer-and-preserver (current branch), then re-run build+lint+vitest+e2e and commit:
${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`, { effort: 'high' })
}

phase('Gate')
const gate = await agent(`In /Users/pazny/projects/knowledge-explorer-and-preserver run the release gates and report honestly: 1) npm run build; 2) npx eslint . (report the final error + warning totals); 3) npm test (vitest, report pass/fail); 4) npx playwright test (report pass/fail counts). Do NOT fix anything.`, { effort: 'low', schema: { type: 'object', required: ['buildOk', 'lintErrors', 'lintWarnings', 'unitPassed', 'e2ePassed', 'e2eFailed'], properties: { buildOk: { type: 'boolean' }, lintErrors: { type: 'number' }, lintWarnings: { type: 'number' }, unitPassed: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' } } } })
return { impl, problems, gate }
