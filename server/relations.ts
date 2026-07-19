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
  const rows = db.nearCrossKindPairs(RELATION_KINDS, maxDistance, limit, opts?.sinceTs);
  const out = rows.map((r) => {
    const o = orient(r.aRefId, toRelationKind(r.aKind), r.bRefId, toRelationKind(r.bKind));
    return { ...o, distance: r.distance, similarity: clampSim(r.distance) };
  });
  console.log(`[relations] candidatePairs: ${out.length} cross-kind pairs (maxDistance=${maxDistance}, limit=${limit})`);
  return out;
}

/**
 * Anchored recall: the nearest neighbours of one node/object across kinds,
 * above the threshold, already-stored pairs skipped, self excluded. Used by the
 * agent candidates endpoint's anchored mode.
 */
export function anchoredCandidates(
  anchorKind: db.RelationKind,
  anchorId: string,
  opts?: { maxDistance?: number; limit?: number },
): CandidatePair[] {
  const maxDistance = opts?.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const limit = Math.min(opts?.limit ?? CANDIDATE_CAP, CANDIDATE_CAP);
  if (!db.vectorSearchAvailable()) return [];
  const hits = db.vectorNeighbors(toEmbeddingKind(anchorKind), anchorId, 'related', RELATION_KINDS, limit);
  if (!hits) return [];
  const out: CandidatePair[] = [];
  for (const h of hits) {
    if (h.distance > maxDistance) continue;
    if (h.kind === toEmbeddingKind(anchorKind) && h.refId === anchorId) continue; // self
    if (db.relationPairExists(anchorId, h.refId)) continue;
    const o = orient(anchorId, anchorKind, h.refId, toRelationKind(h.kind));
    out.push({ ...o, distance: h.distance, similarity: clampSim(h.distance) });
  }
  return out.slice(0, limit);
}
