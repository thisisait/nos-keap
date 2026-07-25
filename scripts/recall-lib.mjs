/**
 * The recall gate's DECISION LAYER, split out of scripts/recall-gate.mjs so it
 * can be tested without an embedder, a server or a corpus.
 *
 * The gate script is I/O: boot, ingest, embed, search, print. Everything that
 * decides what a case MEANS — which hits compete, whether the forbid half ran,
 * what the baseline comparison says, whether the run may be recorded — lives
 * here as plain functions over plain data. That split is not cosmetic: four of
 * the five defects fixed on 2026-07-25 were invisible precisely because the
 * only way to exercise this logic was to run the whole gate against a live
 * estate and read a summary that did not report the quantity that was broken.
 *
 * Tested by scripts/recall-lib.test.mjs. `.mjs`, not `.ts`, on purpose — see
 * vitest.config.ts.
 */

/**
 * Bumped when a fix changes WHAT A PASS MEANS. A baseline records the semantics
 * it was measured under, and a baseline from another generation is refused for
 * comparison exactly like a baseline from another mode or query set: comparing
 * across them manufactures regressions that never happened and hides ones that
 * did.
 *
 *   1  original. The ancestor exemption stripped forbid refs out of the ranking
 *      before they could be compared, so `cleanRank` was unconditionally true
 *      and the "relative order" half of every case was dead.
 *   2  an explicitly forbidden ref is never exempt; forbid refs that resolve to
 *      nothing are reported instead of dropped.
 */
export const SEMANTICS = 2;

export const hitKey = (h) => `${h.kind}:${h.refId}`;

/**
 * The gate ranks WITHIN the self-model scope. The _stack.md failure was a
 * RELATIVE one — generic self-model items capturing queries that specific ones
 * should own — and that is the regression class this gate exists for. Absolute
 * corpus-wide rank (against 790 curated seed nodes) is a different, stricter
 * property: reported as diagnostics, never gated, or every generic phrasing
 * would fail against the seed spine and the gate would be ignored.
 */
export const inScope = (h, scopeRoot) =>
  h.kind === 'object' || (h.kind === 'taxonomy' && (h.refId === scopeRoot || h.refId.startsWith(`${scopeRoot}.`)));

/**
 * A hit whose ONLY leg is 'graph' is context, not relevance: the graph leg hops
 * one step out from the real hits, which structurally boosts parents, siblings
 * and children of everything relevant — a stack is every system's neighbour, so
 * it would rank on topology no matter what its text says. The router routes on
 * MEANING, so the gate ranks only hits that earned a lexical or vector leg.
 */
export const isRelevance = (h) => !Array.isArray(h.legs) || h.legs.length === 0 || h.legs.some((l) => l !== 'graph');

/**
 * Ancestors of the expected target are NAVIGATION, not competition: the graph
 * leg exists to surface a hit's lineage, so a parent stack or the root ranking
 * beside its own child is the search working as designed, while a SIBLING above
 * the target is the _stack.md class. Proper ancestors of any expected ref are
 * therefore excluded from the ranking.
 *
 * TWO things are never exempt, and the second one is the fix:
 *   - anything that is itself expected;
 *   - anything the case explicitly FORBIDS. `forbid` is a written assertion by
 *     the query set's author about relative order; a generic heuristic must not
 *     silently overrule it. It did: every case in nOS's 261-case set forbids
 *     exactly [node:nos, node:nos.<stack>] and expects node:nos.<stack>.<svc>,
 *     so the exemption consumed 100% of the forbid refs in the set, `ranked`
 *     could never contain one, `bestForbidden` was always Infinity, and the
 *     "no forbid ref outranks it" half of all 261 cases was never measured —
 *     while the run reported 261/261 and the summary framed the exemption as
 *     benign navigation.
 */
export function properAncestors(expectedResolved, { scopeRoot, anchorsById = new Map(), protect = [] } = {}) {
  const out = new Set([scopeRoot]);
  const ids = [];
  for (const e of expectedResolved) {
    if (e.kind === 'taxonomy') ids.push(e.refId);
    else ids.push(...(anchorsById.get(e.refId) ?? []));
  }
  for (const id of ids) {
    const segs = id.split('.');
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('.'));
  }
  for (const e of expectedResolved) if (e.kind === 'taxonomy') out.delete(e.refId);
  for (const p of protect) if (p.kind === 'taxonomy') out.delete(p.refId);
  return out;
}

/**
 * How much of a forbid list actually became an assertion. The expect side has
 * always been bucketed by cause; the forbid side was reduced to `.resolved` and
 * its counters thrown away, so a `node:` forbid whose id is absent from the
 * corpus — or a `title:` forbid nothing could scope — disappeared, `forbidden`
 * went empty, `cleanRank` was trivially true and the case was reported as a
 * plain PASS. That is the half the gate was built for, so it reports itself.
 */
export function forbidHealth({ nodeRefs = 0, nodeHits = 0, titleRefs = 0, titleHits = 0, ambiguous = 0 } = {}) {
  const named = nodeRefs + titleRefs;
  const resolved = nodeHits + titleHits;
  return { named, resolved, unresolved: named - resolved, ambiguous };
}

/**
 * Grade one case. `expect` and `forbid` are the FULL resolution records (not
 * just `.resolved`), because what failed to resolve is part of the result.
 *
 * Returns the verdict plus every quantity the summary needs to disclose how
 * much of the case actually ran:
 *   ok / inTop / cleanRank   the two halves, presence and relative order
 *   forbidNamed/Resolved/Comparable  how much of the forbid half was live.
 *     `comparable` is computed, not assumed: it counts forbid refs that survive
 *     the ancestor filter, so if the exemption ever swallows the forbid half
 *     again the number drops to zero in the summary instead of hiding.
 *   degraded[]               causes: measured on LESS than the case named
 */
export function gradeCase({ hits, expect, forbid, anchorsById = new Map(), scopeRoot = 'nos', k = 5 }) {
  const expected = expect.resolved.map(hitKey);
  const forbidden = forbid.resolved.map(hitKey);
  const all = hits.map(hitKey);
  const legsByKey = new Map(hits.map((h) => [hitKey(h), h.legs ?? []]));
  const scoped = hits.filter((h) => inScope(h, scopeRoot) && isRelevance(h)).map(hitKey);
  const top = scoped.slice(0, k);

  const ancestors = properAncestors(expect.resolved, { scopeRoot, anchorsById, protect: forbid.resolved });
  const isExempt = (key) => key.startsWith('taxonomy:') && ancestors.has(key.slice('taxonomy:'.length));
  const ranked = top.filter((key) => !isExempt(key));
  const excluded = top.filter((key) => isExempt(key));

  const bestExpected = Math.min(...expected.map((e) => ranked.indexOf(e) + 1 || Infinity));
  const bestForbidden = Math.min(...forbidden.map((f) => ranked.indexOf(f) + 1 || Infinity));
  const inTop = bestExpected !== Infinity;
  const cleanRank = bestForbidden === Infinity || bestExpected < bestForbidden;
  const ok = inTop && cleanRank;

  const health = forbidHealth(forbid);
  const comparable = forbidden.filter((f) => !isExempt(f));
  const degraded = [];
  if (expect.titleRefs && !expect.titleHits) degraded.push('degraded:card-absent');
  else if (expect.nodeRefs && !expect.nodeHits) degraded.push('degraded:node-absent');
  if (health.named && !comparable.length) degraded.push('degraded:presence-only');
  else if (health.unresolved) degraded.push('degraded:forbid-partial');

  return {
    ok,
    inTop,
    cleanRank,
    bestExpected,
    bestForbidden,
    expected,
    forbidden,
    ranked,
    excluded,
    corpusTop: all.slice(0, 5),
    legsByKey,
    degraded,
    forbidNamed: health.named,
    forbidResolved: health.resolved,
    forbidComparable: comparable.length,
    blockedBy: cleanRank ? null : forbidden.find((f) => ranked.indexOf(f) + 1 === bestForbidden) ?? null,
    nodeIn: expect.resolved.some((e) => e.kind === 'taxonomy' && ranked.includes(hitKey(e))),
    cardIn: expect.resolved.some((e) => e.kind === 'object' && ranked.includes(hitKey(e))),
  };
}

/**
 * Embed the corpus through the REAL loop, and SAY WHETHER IT FINISHED.
 *
 * The loop used to be capped at 12 rounds of 500 with no post-condition: on a
 * corpus bigger than 6000 embeddable items it stopped with pending still deep,
 * the vector leg was populated for an arbitrary prefix (pending lists taxonomy
 * first, so the tail is exactly the fixture cards), competitors that would have
 * outranked the target had no vectors, cases passed on the lexical leg alone —
 * and the gate printed `corpus embedded: 6000 item(s)` and exited 0. A
 * partially embedded corpus is a gate that did not run, so the drain is now a
 * measured post-condition and its absence is a loud skip.
 *
 * `fetchPending` → {items[], total, dim} · `embedBatch(items)` → vector records
 * · `postVectors(records, dim)`. All three are injected so this is testable
 * against fakes.
 */
export async function embedCorpus({ fetchPending, embedBatch, postVectors, maxRounds = 200, log = () => {} }) {
  let embedded = 0;
  let rounds = 0;
  let dim = null;
  let remaining = 0;
  let reason = null;
  let lastTotal = Infinity;
  while (rounds < maxRounds) {
    const pending = await fetchPending();
    dim = pending.dim ?? dim;
    const batch = pending.items ?? [];
    if (!batch.length) { remaining = 0; reason = 'drained'; break; }
    remaining = pending.total ?? batch.length;
    // A pending count that does not shrink means the write-back is not landing.
    // Without this the loop would burn every round re-embedding the same page
    // and then report a round-ceiling, naming the wrong cause.
    if (remaining >= lastTotal) { reason = 'no-progress'; break; }
    lastTotal = remaining;
    rounds++;
    log(`· round ${rounds}: embedding ${batch.length} of ${remaining} pending`);
    const records = await embedBatch(batch);
    if (!records.length) { reason = 'embedder-empty'; break; }
    await postVectors(records, dim);
    embedded += records.length;
    // `remaining` is what the NEXT round would find: the count came from the
    // fetch at the top of this round, before this round's write-back landed.
    remaining = Math.max(0, remaining - records.length);
  }
  if (!reason) reason = 'round-ceiling';
  return { embedded, rounds, remaining, dim, drained: reason === 'drained', reason };
}

/** `--min-measured 261 | 95% | 0` → the case count this run must reach. */
export function measuredFloor(minMeasured, total) {
  if (!minMeasured || minMeasured === '0' || minMeasured === 'none') return 0;
  return String(minMeasured).endsWith('%')
    ? Math.ceil((total * parseFloat(minMeasured)) / 100)
    : parseInt(minMeasured, 10);
}

/**
 * Baseline comparison. Every failing case lands in EXACTLY ONE bucket, because
 * the three baseline sets are disjoint by construction:
 *   regression          the baseline says it passed        (KEAP's ranking moved)
 *   knownFailing        the baseline says it failed        (pre-existing debt)
 *   newlyCoveredFailing the baseline says it was UNMEASURABLE — newly covered,
 *                       failing on its first measurement. This used to be
 *                       reported as "not in the baseline at all — a new
 *                       expectation", which is false (it was there, as a
 *                       coverage gap) AND double-counted it under NEW COVERAGE,
 *                       so one case appeared in two mutually exclusive buckets.
 *   newlyFailing        genuinely absent from the baseline
 */
export function classifyAgainstBaseline({ passing, failing, unmeasurable, baseline }) {
  const wasPassing = new Set(baseline.passing ?? []);
  const wasFailing = new Set(baseline.failing ?? []);
  const wasUnmeasurable = new Set(Object.keys(baseline.unmeasurable ?? {}));
  const known = (q) => wasPassing.has(q) || wasFailing.has(q) || wasUnmeasurable.has(q);
  const nowFailing = [...new Set(failing)];
  const nowPassing = [...new Set(passing)];
  return {
    regressions: nowFailing.filter((q) => wasPassing.has(q)),
    knownFailing: nowFailing.filter((q) => wasFailing.has(q)),
    newlyCoveredFailing: nowFailing.filter((q) => wasUnmeasurable.has(q)),
    newlyFailing: nowFailing.filter((q) => !known(q)),
    coverageLost: [...unmeasurable].filter((q) => wasPassing.has(q) || wasFailing.has(q)),
    fixed: nowPassing.filter((q) => wasFailing.has(q)),
    newCoveragePassing: nowPassing.filter((q) => wasUnmeasurable.has(q)),
    newCoverageFailing: nowFailing.filter((q) => wasUnmeasurable.has(q)),
  };
}

/**
 * Exit code — pure, so the order of the guards is inspectable instead of being
 * a property of where the statements happen to sit.
 *
 * The drain check comes FIRST: if the corpus never finished embedding, no
 * number from the run means anything, including the failures.
 */
export function exitVerdict({
  measured, total, failures = [], need = 0, coverageLost = [], drain = { drained: true },
  hasBaseline = false, regressions = [], newlyCoveredFailing = [], knownFailing = [], newlyFailing = [],
}) {
  if (!drain.drained) {
    return { code: 4, reason: 'not-drained', detail: `${drain.remaining} item(s) still pending after ${drain.rounds} round(s) (${drain.reason})` };
  }
  if (!measured) return { code: 4, reason: 'nothing-measured', detail: `zero measurable cases out of ${total}` };
  // A REGRESSION is a case that passed in the baseline and fails now. That is
  // the failure this gate exists to catch, and it is the only kind of failure
  // that fails the run once a baseline exists.
  if (hasBaseline && regressions.length) {
    return { code: 1, reason: 'regressions', detail: `${regressions.length} case(s) passed in the baseline and fail now` };
  }
  // Without a baseline there is nothing to compare against, so ANY failure
  // fails — you cannot call a failure "known" on a corpus you have never
  // recorded.
  if (!hasBaseline && failures.length) {
    return { code: 1, reason: 'failures', detail: `${failures.length} measured case(s) failed, and there is no baseline to call them known` };
  }
  // A case that was UNMEASURABLE in the baseline and now measures as failing is
  // new information, not a regression. Failing the run for it would punish the
  // act of widening coverage, which is exactly backwards — the whole point of
  // growing the corpus is to find out where recall is weak. It is reported
  // loudly and does not fail.
  //
  // Known failures likewise do not fail the run — and this is the difference
  // between a gate and a permanently red light. The in-repo fixture holds 7
  // nodes across one stack-pair; two of its four cases forbid an ancestor from
  // outranking a skill, which a corpus that small cannot satisfy no matter how
  // good recall is. A gate that can never go green trains people to ignore it,
  // and an ignored gate catches nothing.
  //
  // What stops this becoming a baseline of shame: the known-failing set can
  // only GROW through an explicit --update-baseline (guarded by
  // baselineWriteVerdict), because any pass→fail transition is a regression and
  // fails above. Silence is not available to it.
  if (need && measured < need) {
    return { code: 4, reason: 'below-floor', detail: `measured ${measured}/${total}, below the declared floor of ${need}` };
  }
  if (coverageLost.length) {
    return { code: 4, reason: 'coverage-lost', detail: `${coverageLost.length} case(s) the baseline measured are unmeasurable now` };
  }
  // Green, but never silently: a run carrying known failures or newly-covered
  // failures says so in its reason, so `RECALL_RESULT.exit` distinguishes a
  // clean pass from a pass-with-debt without anyone reading the prose above it.
  if (knownFailing.length || newlyCoveredFailing.length || newlyFailing.length) {
    const parts = [];
    if (knownFailing.length) parts.push(`${knownFailing.length} known failing`);
    if (newlyCoveredFailing.length) parts.push(`${newlyCoveredFailing.length} newly covered and failing`);
    if (newlyFailing.length) parts.push(`${newlyFailing.length} new case(s) failing`);
    return { code: 0, reason: 'pass-with-known-failures', detail: `no regression; ${parts.join(', ')}` };
  }
  return { code: 0, reason: 'pass', detail: null };
}

/**
 * May this run be RECORDED as the baseline?
 *
 * --update-baseline used to write the file at the top of the exit section,
 * before every loud-skip guard. So an operator recording the live baseline
 * while the pulse job was still embedding overwrote a 261/261 record with a
 * 140-case one; the run then printed SKIPPED-LOUD and exited 4, but the damage
 * was already on disk. Every later run compared against 140 — no coverage lost,
 * no regressions, 140/261 clears the default 50% floor — and printed RECALL
 * GATE PASSED while 121 cases that used to be measured were invisible. The
 * whole anti-"corpus exhausted" premise rests on that file, so a degraded run
 * may not touch it without --force-baseline.
 */
export function baselineWriteVerdict({
  measured, total, need = 0, coverageLost = [], drain = { drained: true }, priorMeasured = 0, force = false,
}) {
  const blockers = [];
  if (!drain.drained) blockers.push(`the corpus never finished embedding (${drain.reason}, ${drain.remaining} pending)`);
  if (!measured) blockers.push(`zero measurable cases out of ${total}`);
  else if (need && measured < need) blockers.push(`measured ${measured}/${total}, below the declared floor of ${need}`);
  if (coverageLost.length) blockers.push(`${coverageLost.length} case(s) the current baseline measures are unmeasurable in this run`);
  // `coverageLost` is computed only against a baseline that was ACCEPTED for
  // comparison, so on its own it leaves a hole exactly where the risk is
  // highest: a baseline refused for a mode/semantics mismatch reports no lost
  // coverage at all, and a degraded run could overwrite a fuller record while
  // every other guard stayed quiet. The file's own denominator closes it —
  // fewer measured cases than the file it replaces is coverage erasure
  // whatever the reason the comparison was skipped.
  else if (priorMeasured > measured) {
    blockers.push(`the baseline on disk measures ${priorMeasured}/${total}; this run measures ${measured} — recording it would erase ${priorMeasured - measured} case(s) of coverage`);
  }
  return { allow: !blockers.length || force, forced: !!blockers.length && force, blockers };
}
