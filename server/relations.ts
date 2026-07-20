/**
 * Typed-relation candidate recall (Track R3 stage 1).
 *
 * The pipeline: KEAP pulls candidate pairs from the libSQL vector index
 * (cross-kind top-K / corpus sweep), the HOST-side classifier (Sonnet) types
 * them against the controlled vocabulary, and KEAP stores the typed results as
 * proposed relations with provenance (server/agent.ts POST /relations). KEAP
 * itself NEVER calls an LLM — this module only surfaces geometry.
 *
 * A relation kind ('node' | 'object') maps onto an embedding kind: a taxonomy
 * node is embedded as kind='taxonomy', a knowledge object as kind='object'.
 * These share one 768-d space (nomic), so cross-kind neighbours are just "don't
 * pin the kind to one value".
 */
import * as db from './db';

/** Distance below which a pair is worth typing (cosine). Similarity = 1 − dist. */
export const DEFAULT_MAX_DISTANCE = 0.35;
/** Hard cap on candidates returned in one call, independent of the agent limit. */
export const CANDIDATE_CAP = 200;
/**
 * How many pairs one ref may claim before the sweep starts spending its slots
 * elsewhere. Pure distance order lets an "attractor" — a generically-worded node
 * that sits near everything — eat the batch: a live sweep of 50 spent 25 slots on
 * two nodes ("Databases", "NoSQL Databases"), so the classifier kept re-deciding
 * the same edge instead of seeing the corpus. This is a REORDERING, not a filter:
 * a second pass appends everything the cap deferred, so the returned SET is
 * unchanged and only the front of the batch gets more diverse.
 */
export const PER_REF_SOFT_CAP = 3;
/**
 * Floor for the anchored ANN window. The kind filter runs AFTER vector_top_k, so
 * the window must be wide enough to contain rows of the complementary kind before
 * that filter can find any — independent of how many candidates the caller wants.
 */
export const MIN_ANCHOR_WINDOW = 64;

export interface CandidatePair {
  fromRef: string;
  fromKind: db.RelationKind;
  toRef: string;
  toKind: db.RelationKind;
  /** Cosine distance in [0, 2]; smaller = nearer. */
  distance: number;
  /** 1 − distance, clamped to [0, 1] — the "how alike" score for the classifier. */
  similarity: number;
}

const RELATION_KINDS: db.EmbeddingKind[] = ['taxonomy', 'object'];

/** embedding kind → relation kind ('taxonomy' collapses onto 'node'). */
export function toRelationKind(embedKind: string): db.RelationKind {
  return embedKind === 'object' ? 'object' : 'node';
}

/** relation kind → embedding kind ('node' expands to 'taxonomy'). */
export function toEmbeddingKind(relKind: db.RelationKind): db.EmbeddingKind {
  return relKind === 'object' ? 'object' : 'taxonomy';
}

const clampSim = (distance: number): number => Math.max(0, Math.min(1, 1 - distance));

/**
 * Orient a pair deterministically: when a node meets an object, the OBJECT is
 * the `from` endpoint (a doc "supports"/"exemplifies" a concept reads the right
 * way round, and an object id never collides with a dotted node-id prefix — the
 * ingest-reset belt-and-suspenders). Same-kind pairs keep their input order.
 */
function orient(
  aRef: string,
  aKind: db.RelationKind,
  bRef: string,
  bKind: db.RelationKind,
): { fromRef: string; fromKind: db.RelationKind; toRef: string; toKind: db.RelationKind } {
  if (aKind === bKind || aKind === 'object') {
    return { fromRef: aRef, fromKind: aKind, toRef: bRef, toKind: bKind };
  }
  return { fromRef: bRef, fromKind: bKind, toRef: aRef, toKind: aKind };
}

/**
 * Corpus sweep: the nearest cross-kind pairs across the whole vector index,
 * above the similarity threshold, deduped (a↔b once), already-stored pairs
 * skipped, optionally incremental (only pairs touching a vector changed after
 * `sinceTs`). Pure + deterministic (distance-ordered) + bounded.
 */
export function candidatePairs(opts?: {
  maxDistance?: number;
  limit?: number;
  sinceTs?: number;
}): CandidatePair[] {
  const maxDistance = opts?.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const limit = Math.min(opts?.limit ?? CANDIDATE_CAP, CANDIDATE_CAP);
  if (!db.vectorSearchAvailable()) return [];
  // Over-fetch so the diversity pass has something to choose between; without a
  // surplus the reordering below is a no-op.
  const fetch = Math.min(Math.max(limit * 4, limit), CANDIDATE_CAP);
  const rows = db.nearCrossKindPairs(RELATION_KINDS, maxDistance, fetch, opts?.sinceTs);
  const pairs = rows.map((r) => {
    const o = orient(r.aRefId, toRelationKind(r.aKind), r.bRefId, toRelationKind(r.bKind));
    return { ...o, distance: r.distance, similarity: clampSim(r.distance) };
  });

  // Pass 1 (distance order, ≤ PER_REF_SOFT_CAP per endpoint) then pass 2 (the
  // deferred remainder, still distance-ordered). Counting BOTH endpoints is what
  // defuses the attractor: the hot ref is usually the `to` node.
  const seen = new Map<string, number>();
  const take = (p: CandidatePair) => {
    seen.set(p.fromRef, (seen.get(p.fromRef) ?? 0) + 1);
    seen.set(p.toRef, (seen.get(p.toRef) ?? 0) + 1);
  };
  const diverse: CandidatePair[] = [];
  const deferred: CandidatePair[] = [];
  for (const p of pairs) {
    const hot = (seen.get(p.fromRef) ?? 0) >= PER_REF_SOFT_CAP || (seen.get(p.toRef) ?? 0) >= PER_REF_SOFT_CAP;
    if (hot) deferred.push(p);
    else {
      diverse.push(p);
      take(p);
    }
  }
  const out = [...diverse, ...deferred].slice(0, limit);
  console.log(
    `[relations] candidatePairs: ${out.length} cross-kind pairs ` +
      `(maxDistance=${maxDistance}, limit=${limit}, diverse=${Math.min(diverse.length, limit)}, fetched=${pairs.length})`,
  );
  return out;
}

/**
 * Anchored recall: the nearest CROSS-kind neighbours of one node/object, above
 * the threshold, already-stored pairs skipped. This is the cross-type pipeline —
 * same-kind neighbours (node↔node, object↔object, and the anchor itself) are
 * dropped to mirror the corpus sweep's `a.kind <> b.kind` guard; without it the
 * anchored path would surface (and the POST store would accept) same-kind edges
 * the pipeline is not meant to produce. Used by the candidates endpoint's
 * anchored mode.
 */
export function anchoredCandidates(
  anchorKind: db.RelationKind,
  anchorId: string,
  opts?: { maxDistance?: number; limit?: number },
): CandidatePair[] {
  const maxDistance = opts?.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const limit = Math.min(opts?.limit ?? CANDIDATE_CAP, CANDIDATE_CAP);
  if (!db.vectorSearchAvailable()) return [];
  // Ask the index for the COMPLEMENTARY kind only, so the rows that come back
  // are cross-kind by construction rather than mostly same-kind hits we then
  // throw away.
  const searchKind: db.EmbeddingKind = anchorKind === 'object' ? 'taxonomy' : 'object';
  // The kind filter is a POST-filter on the ANN window (db.vectorNeighborsOf runs
  // vector_top_k first, then WHERE kind IN (...)), and that window is sized from
  // the caller's limit. So a small limit gives a window too narrow to contain ANY
  // row of the other kind: measured live, an anchored call returned 8 pairs at
  // limit=8 and ZERO at limit=4 — the same card, the same threshold, the nearest
  // hit sitting at distance 0.353 the whole time. A caller asking for fewer
  // candidates must not get a worse search, so floor the window independently of
  // limit rather than letting it collapse.
  const fetch = Math.min(Math.max(limit * 4, MIN_ANCHOR_WINDOW), CANDIDATE_CAP);
  const hits = db.vectorNeighbors(toEmbeddingKind(anchorKind), anchorId, 'related', [searchKind], fetch);
  if (!hits) return [];
  const out: CandidatePair[] = [];
  for (const h of hits) {
    if (h.distance > maxDistance) continue;
    // Belt and braces: the search is already kind-restricted, so this only guards
    // against the anchor's own row coming back.
    if (toRelationKind(h.kind) === anchorKind) continue;
    if (db.relationPairExists(anchorId, h.refId)) continue;
    const o = orient(anchorId, anchorKind, h.refId, toRelationKind(h.kind));
    out.push({ ...o, distance: h.distance, similarity: clampSim(h.distance) });
    if (out.length >= limit) break;
  }
  return out;
}
