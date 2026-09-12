# Explore de-complexity — the ratified revision spec

2026-09-12. Source: five-lane ponytail-ultra survey (wf_8385a486-386, full
findings in the session scratchpad `survey.json`) + operator direction:
"too many toggles without informational value, LOD unusable (late, unlabeled
nodes), and the map must be able to show SLICES of real data (e.g. the
accounting ontology 04.11 with its tables/rows)". Metric everywhere:
**information per pixel**. This file is the SoT for the implementation wave;
deviations need a reason recorded here.

## Ratified decisions (my review over the surveys)

Where I OVERRIDE the ultra proposals: celestial forms/glyphs/hues STAY (the
S2⁶ `graph.card` override is a shipped nOS contract — killing forms breaks
it); the starfield shell + bloom STAY (product identity, cheap, not an
information channel); core keeps THREE group orders (fs/taxonomy/type — lane 1
wanted 2, lane 5 wanted a different 2; taxonomy grouping is the subtree story,
type is inventory, fs is provenance). Everything else below is as surveyed.

## Phase A — server: row anchors + payload diet

1. **Row-anchor fallback (the slice blocker).** `syncRows` (server/tables.ts
   ~:470-479): when a row has no `anchorColumn` value, fall back to the table
   CARD's own node anchors (`existingCard.links` kind='node' → first ref).
   Without this, projected `table-invoice:row-*` rows are anchorless — invisible
   in orbital view, "unfiled" in core. Test in table-sync-rows.test.ts.
2. **Drop bulk prose.** `/api/graph` nodes lose `description`/`descriptionCs`
   (~500 chars × 2615 nodes; the UI shows ONE node's prose, and DetailPanel
   already has a per-node fetch to ride). Adapt client references; the HTML
   hover tooltip dies in Phase C anyway.
3. **Lean object read.** graph route must not read object BODIES
   (db lean variant: every column except `body`; keep `links` + `frontmatter`
   — anchors/objectLinks/path/mapping/mtime/graph.card come from them).
4. **`/api/graph?meta=1`** returns `{meta, counts}` only; ExploreMapTile
   (homepage) switches to it with its own query key — the tile currently
   downloads the whole corpus to show two numbers.

## Phase B — Explore.tsx: controls, state, slice

KILL: ship cameraMode (+HUD, useShipController, ShipModel), `detail`
auto/full (auto always), neighbor mode related/unrelated (hardcode related),
the 4 `kinds[]` checkboxes (always all), the 4 semantic lens axes + `hubs`
checkbox (node_features is dead + orphaned rows), core order `topic`
(disabled button until clustering is demonstrably populated).

KEEP: Recent lens as ONE toggle ("Barvit podle stáří" — mtime/updatedAt is
real data, it has a legend).

MERGE: `showOntology` + `showOlinks` → single `showLinks` ("Vazby", URL
`?rel`, gates typed relations + concept overlay + object links).

VIEW: one segmented control "Zobrazení": **Konstelace** (core off) |
**Složky** (core fs) | **Taxonomie** (core taxonomy) | **Typy** (core type).
URL `?view=`; migrate old `?core` params.

SLICE (`?root=<nodeId>`, client-side v1): state + the existing URL writer;
in the scene memo walk the already-built `kids` map from root → keep-set →
filter nodes + objects (`anchors.some(in keep)`); edges/rays/relations need
nothing (both-endpoints-drawn guards exist). Hue: recolour by slice-root's
direct children (hash-frozen) so a subtree isn't monochrome. Header shows a
breadcrumb chip (root path, ✕ = clear). DetailPanel gains "Zobrazit jen tento
podstrom" on taxonomy nodes. `/explore?root=04.11` is the shareable
accounting-slice URL. (Server-side `?root` filtering = later phase, when
payload size hurts even after the diet.)

SEARCH: dropdown of top 5 hits (name · kind · parent), click routes through
`openTarget` — an object hit selects THE OBJECT (drawer + focus), not its
parent anchor; unanchored objects are reachable (today they red-flash as
"not found"). Enter = first hit.

FIX: `passesType` must not require truthy dataType (a facet pick currently
deletes the whole semantic star field — captures/notes carry none). FIX: the
focus desync — focusing `obj:`/`dir:` ids must show that thing's name+info
in the rail instead of "no focus".

## Phase C — GraphCanvas.tsx: LOD, labels, layers

LABELS (the operator's headline complaint, quantified by lane 2):
- `sizeAttenuation = false` on label sprites + screen-fraction scale →
  constant ~14 px text at any distance (today labels are world-scaled, so
  the overview has NO readable text at all).
- One pixel helper `px(r, dist)`; body drawn if px > 2 (hysteresis ratio
  0.7), label if px > 4 — labels arrive BEFORE bodies are big (today the
  label threshold is ~2× stricter than the body threshold = "naskakuje
  pozdě"). Level≥2 taxonomy nodes get labels via the same pool (today they
  have NO permanent-label path — the exact ontology-slice case).
- ONE label source: proximity pool over ALL nodes ranked by px, cap ~48,
  plus unconditional focus + hover. Plates cached by id. One rAF loop.
- ONE radius function `renderedRadius(n)` shared by LOD, label offset,
  hover offset, focus pulse (today four call sites use a radius the bodies
  don't have).
- DELETE: STAR/FOLDER/anchor label-count booleans (the `<= 400` cliffs),
  HUGE_FIELD, PROX_LABEL_* extra constants, all `forceDetail` sites, the
  HTML `nodeLabel` tooltip, duplicate REL_TUBE_CAP.

LAYERS — kill (information-competing or dead): cluster nebula impostors
(opacity 0 forever in the default view — dead code), ~untopiced fog +
sentinel hub, repo language spheres + identicon speckle, planet rings, comet
tails, per-body size/lightness jitter, ToE `explored` width tiers (one
width), ray/mray colour split (one colour). Ship-mode branches go with
Phase B's kill.

LAYERS — keep: starfield shell, bloom, celestial forms + glyphs + asset
hues (S2⁶ card contract), category hue, focus pulse, typed-relation overlay
(verb plates, registry colour, confidence width), recency lens, anchor rays
with the existing AGGREGATE_RAYS_AT collapse.

## Phase D — panels

Merge SidePanel INTO DetailPanel: one right rail — breadcrumb → name (type,
zone) → prose (brief via BriefBody) → "Uvnitř" (children/contents) →
"Souvisí" (anchored objects + object links + typed relations grouped by
verb) → "Otevřít kde žije". Kill: distance numbers, corpus-stat caption,
related/unrelated UI, Sources checkboxes. Mobile Sheet shows the same
content. Remove the Describe / New-sub-node authoring forms (~130 lines,
2 mutations) — authoring lives in admin/moderation and the agent door, not
in the map. Header after the cut: Back · title · search · Zobrazení ·
Vazby · facet chips (moved from rail) · stáří toggle.

## Phase E — verify

tsc clean, vitest green (fix e2e/ship asserts, core-type-order), lint no
NEW errors, `npm run build` passes, i18n keys pruned. Update this spec with
any recorded deviation.

## Recorded deviations

- `/api/graph` still ships viewer-scoped `topics[]` and `object.topic` (tenant
  leak guard + clustering e2e). Node `features` / linked-data `meta`, mapping
  `tags`/`enabled`/`count`, and relation `status`/`explored` were dropped —
  Explore no longer reads them.
- Hover name plates are a separate sprite (`hoverRef`), not members of the
  proximity pool. Spec asked for "pool + unconditional focus + hover"; this
  is that split, not a second label system.
- `REL_LABEL_CAP` (300) stays as the one dense-Vazby cliff (midpoint plates
  vs width-0 lines). The duplicate `REL_TUBE_CAP` is gone.
- Recency toggle copy is "Nedávné" / "Recent", not the spec's "Barvit podle
  stáří" — the tooltip carries the colour-by-age meaning.
- Server-side `?root=` filtering remains later, as written.
- Hierarchical label LOD (L0 farther, L1 later, ~360 ms fade) and Trackball
  Controls replaced the spec's single px-threshold + OrbitControls polar wall.
