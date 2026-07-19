/**
 * Topics mode — clustering orchestration + IO (topic-mode-spec §1.2, §1.3).
 *
 * Warm-started spherical k-means over stored kind='object' vectors with sticky
 * identities: a topic id, once minted, never changes meaning, position, or
 * membership without a measured cause. Centroid anchoring gives identity,
 * assignment hysteresis damps membership, birth-frozen θ pins geometry.
 * Re-running on unchanged data is a byte-level no-op.
 *
 * Event-loop safety (decision #2): vectors are read as raw JSON strings, parsed
 * tile-wise into one preallocated Float32Array with `await setImmediate`
 * between tiles; the Lloyd steps yield the same way — no single stall exceeds
 * ~50 ms, so /api/graph and the nOS health probe stay responsive during a
 * background run.
 *
 * Single-flight + coalescing (decision #3): all runs serialize through an
 * internal promise chain; scheduleTopicRecluster is a trailing-edge debounce.
 *
 * S1 ships INERT: the pipeline populates migration-005 tables but nothing reads
 * them yet (payload + UI land in later stages).
 */
import crypto from 'node:crypto';
import * as db from './db';
import { EMBED_DIM } from './embeddings';
import { anchorNodeIds, type ObjectRef } from './objects';
import { getAncestors } from './taxonomy';
import {
  lloydWarm,
  normalizeInPlace,
  farthestFirstSeed,
  cTfIdfLabels,
  type LabelDoc,
} from './topics-math';

const DIM = EMBED_DIM; // 768
const MIN_OBJECTS = 8;
const TAU = 0.04; // assignment-hysteresis cosine-distance margin
const K_MIN = 3;
const K_MAX = 16;
const MAX_ITER = 50;
const EPS = 1e-4;
const EMPTY_RUNS_PRUNE = 3;
const LABEL_CHURN = 0.25; // cumulative churn that promotes label_auto → label
const TILE_PARSE = 200;
const TILE_LLOYD = 500;
const DEBOUNCE_MS = 15_000;
const DEBOUNCE_MAX_MS = 60_000;
const BOOT_DELAY_MS = 15_000;
// Model-flip hysteresis (decision #5 hardening): a dominant-model change is the
// ONE code path that breaks every slot, so it must not fire on noise. A change
// away from the stored model counts as a sanctioned migration only when the new
// dominant model leads the incumbent by ≥ this fraction. Near count-parity —
// the norm when a parallel nOS sidekick embeds under a second model — the
// incumbent holds, so no embed POST can trigger a wholesale reset.
const MODEL_SWITCH_MARGIN = 0.2;

export interface TopicRunResult {
  ok: boolean;
  skipped?: 'no-vectors' | 'too-few';
  k: number;
  n: number;
  moved: number;
  born: string[];
  retired: string[];
  ms: number;
}

// ── FNV-1a hash → [0,1) — the client core.ts twin (θ fallback, decision #6). ──
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function mintTopicId(): string {
  return `t-${crypto.randomBytes(4).toString('hex')}`;
}

const yieldTile = (): Promise<void> => new Promise((r) => setImmediate(r));

// A working topic descriptor threaded through one pass. `seed` is the warm-
// start centroid (stored, or a data row for a birth); the post-hysteresis
// centroid is recomputed before persist.
interface Working {
  id: string;
  seed: Float32Array; // length DIM, unit
  theta: number;
  thetaFrozen: boolean; // survivors keep θ; births compute it from members
  label: string;
  labelLocked: boolean;
  churnAccum: number;
  emptyRuns: number;
}

// ── Single-flight serialization (decision #3) ─────────────────────────────────
let tail: Promise<unknown> = Promise.resolve();

/** Cluster the corpus. Serialized: concurrent callers chain, never overlap. */
export function clusterTopics(opts: { reset?: boolean } = {}): Promise<TopicRunResult> {
  const run = tail.then(
    () => runOnce(opts),
    () => runOnce(opts),
  );
  tail = run.catch(() => {});
  return run;
}

/** Resolve the model a run should cluster under, and whether a dominant-model
 *  change is a sanctioned reset (decision #5). A flip away from the stored model
 *  is honored only when the new dominant model leads the incumbent by
 *  MODEL_SWITCH_MARGIN (or the incumbent has no vectors left) — otherwise the
 *  incumbent holds and clustering continues in its space, so a near-parity
 *  dual-model deployment never suffers wholesale slot loss. Pure function of the
 *  current vector counts → deterministic. null when there are no object vectors. */
function resolveModel(storedModel: string | null): { model: string; reset: boolean } | null {
  const dominant = db.dominantObjectModel();
  if (!dominant) return null;
  if (!storedModel || storedModel === dominant) return { model: dominant, reset: false };
  const counts = db.objectVectorModelCounts();
  const incumbent = counts.get(storedModel) ?? 0;
  const candidate = counts.get(dominant) ?? 0;
  if (incumbent === 0) return { model: dominant, reset: true }; // incumbent retired
  if (candidate >= incumbent * (1 + MODEL_SWITCH_MARGIN)) return { model: dominant, reset: true };
  return { model: storedModel, reset: false }; // hold: no un-caused reset
}

async function runOnce(opts: { reset?: boolean }): Promise<TopicRunResult> {
  const t0 = Date.now();
  const done = (r: Omit<TopicRunResult, 'ms'>): TopicRunResult => ({ ...r, ms: Date.now() - t0 });

  if (!db.vectorSearchAvailable()) return done({ ok: false, skipped: 'no-vectors', k: 0, n: 0, moved: 0, born: [], retired: [] });

  let stored = db.listTopicClusters();
  // ── 1) Model guard (decision #5, hardened): a dominant-model flip is a
  //       sanctioned identity break — old-space centroids are meaningless in the
  //       new one — but only a flip with a sustained margin counts (resolveModel);
  //       near-parity noise holds the incumbent, so slots never reset un-caused.
  const resolved = resolveModel(stored.length > 0 ? stored[0].model : null);
  if (!resolved) return done({ ok: false, skipped: 'no-vectors', k: 0, n: 0, moved: 0, born: [], retired: [] });
  const model = resolved.model;
  const reset = opts.reset === true || resolved.reset;
  if (reset) stored = [];

  // ── 2) Load + tile-parse + normalize into ONE Float32Array (decision #2).
  const raw = db.readObjectVectorsRaw(model);
  const n = raw.length;
  if (n < MIN_OBJECTS) {
    return done({ ok: false, skipped: 'too-few', k: stored.length, n, moved: 0, born: [], retired: [] });
  }
  raw.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // determinism
  const ids = raw.map((r) => r.id);
  const data = new Float32Array(n * DIM);
  for (let start = 0; start < n; start += TILE_PARSE) {
    const end = Math.min(start + TILE_PARSE, n);
    for (let i = start; i < end; i++) {
      const arr = JSON.parse(raw[i].v) as number[];
      const base = i * DIM;
      const len = Math.min(arr.length, DIM);
      for (let j = 0; j < len; j++) data[base + j] = arr[j];
      raw[i].v = ''; // release the ~10 KB JSON string as soon as it is parsed
    }
    await yieldTile();
  }
  raw.length = 0; // the raw rows are fully consumed — do not pin them for the
  //                whole multi-second run (decision #2 memory budget); only the
  //                one Float32Array survives past this point.
  normalizeInPlace(data, n, DIM);

  // ── 3) k hysteresis (decision #15) → build the warm-start working set.
  const kTarget = clamp(Math.round(Math.sqrt(n / 4)), K_MIN, K_MAX);
  const working: Working[] = [];
  const born: string[] = [];

  if (stored.length === 0) {
    // Fresh / reset: k = kTarget, seed 0 = smallest ref_id, rest farthest-first.
    const k = kTarget;
    const existing = new Float32Array(k * DIM);
    const seedRows: number[] = [0];
    existing.set(data.subarray(0, DIM), 0);
    for (let s = 1; s < k; s++) {
      const idx = farthestFirstSeed(data, n, DIM, existing.subarray(0, s * DIM), s, ids);
      seedRows.push(idx);
      existing.set(data.subarray(idx * DIM, idx * DIM + DIM), s * DIM);
    }
    for (const row of seedRows) {
      const id = mintTopicId();
      born.push(id);
      working.push({
        id, seed: new Float32Array(data.subarray(row * DIM, row * DIM + DIM)),
        theta: 0, thetaFrozen: false, label: '', labelLocked: false, churnAccum: 0, emptyRuns: 0,
      });
    }
  } else {
    const kCur = stored.length;
    // Survivors seed from their stored centroid, keep θ + label + churn.
    const survivors: Working[] = stored.map((s) => ({
      id: s.id, seed: Float32Array.from(s.centroid), theta: s.theta, thetaFrozen: true,
      label: s.label, labelLocked: s.labelLocked, churnAccum: s.churnAccum, emptyRuns: s.emptyRuns,
    }));
    if (kTarget - kCur >= 2) {
      // Grow by exactly one: farthest-first from the stored centroids.
      const existing = new Float32Array(kCur * DIM);
      for (let c = 0; c < kCur; c++) existing.set(survivors[c].seed, c * DIM);
      const idx = farthestFirstSeed(data, n, DIM, existing, kCur, ids);
      const id = mintTopicId();
      born.push(id);
      working.push(...survivors, {
        id, seed: new Float32Array(data.subarray(idx * DIM, idx * DIM + DIM)),
        theta: 0, thetaFrozen: false, label: '', labelLocked: false, churnAccum: 0, emptyRuns: 0,
      });
    } else if (kCur - kTarget >= 2) {
      // Shrink by exactly one: retire the smallest (tie: lexicographic id).
      let smallest = stored[0];
      for (const s of stored) {
        if (s.memberCount < smallest.memberCount || (s.memberCount === smallest.memberCount && s.id < smallest.id)) {
          smallest = s;
        }
      }
      working.push(...survivors.filter((w) => w.id !== smallest.id));
    } else {
      working.push(...survivors);
    }
  }

  const k = working.length;
  const seeds = new Float32Array(k * DIM);
  for (let c = 0; c < k; c++) seeds.set(working[c].seed, c * DIM);

  // ── 4) Warm-started Lloyd (yields between tiles).
  const { assign, centroids } = await lloydWarm(data, n, DIM, seeds, k, {
    maxIter: MAX_ITER, eps: EPS, onTile: yieldTile, tile: TILE_LLOYD,
  });

  // ── 5) Assignment hysteresis (decision #5 §1.2.5). `assign[i]` is already the
  //       nearest cluster (max dot); keep the previous topic unless the best is
  //       better by > TAU in cosine distance.
  const priorAssign = reset ? new Map<string, string>() : db.getTopicAssignments();
  const idxById = new Map(working.map((w, c) => [w.id, c]));
  const dCosTo = (row: number, c: number): number => {
    const rb = row * DIM;
    const cb = c * DIM;
    let dot = 0;
    for (let j = 0; j < DIM; j++) dot += data[rb + j] * centroids[cb + j];
    return 1 - dot;
  };
  const finalCluster = new Int32Array(n);
  let moved = 0;
  for (let start = 0; start < n; start += TILE_LLOYD) {
    const end = Math.min(start + TILE_LLOYD, n);
    for (let i = start; i < end; i++) {
      const best = assign[i];
      const prevTopic = priorAssign.get(ids[i]);
      const prevIdx = prevTopic !== undefined ? idxById.get(prevTopic) : undefined;
      let chosen = best;
      if (prevIdx !== undefined && prevIdx !== best) {
        const dBest = dCosTo(i, best);
        const dCur = dCosTo(i, prevIdx);
        chosen = dBest < dCur - TAU ? best : prevIdx; // sticky
      }
      finalCluster[i] = chosen;
      if (prevTopic !== undefined && working[chosen].id !== prevTopic) moved++;
    }
    await yieldTile();
  }

  // ── Recompute centroids as the normalized mean of the FINAL members so the
  //    next warm start reflects what users see (decision #5 §1.2.5).
  const memberRows: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) memberRows[finalCluster[i]].push(i);
  const finalCentroids = new Float32Array(k * DIM);
  for (let c = 0; c < k; c++) {
    const rows = memberRows[c];
    const cb = c * DIM;
    if (rows.length === 0) {
      finalCentroids.set(working[c].seed, cb); // empty: keep previous centroid
      continue;
    }
    for (const r of rows) {
      const rb = r * DIM;
      for (let j = 0; j < DIM; j++) finalCentroids[cb + j] += data[rb + j];
    }
    let ss = 0;
    for (let j = 0; j < DIM; j++) ss += finalCentroids[cb + j] * finalCentroids[cb + j];
    const inv = ss > 0 ? 1 / Math.sqrt(ss) : 0;
    for (let j = 0; j < DIM; j++) finalCentroids[cb + j] *= inv;
    await yieldTile(); // k ≤ K_MAX, so the sum step never blocks for a full pass
  }

  // ── Membership sets (final) incl. carry-forward: an object that still exists
  //    but lost only its vector keeps its assignment (§1.2.8).
  // Trimmed load (decision #2 memory budget): label fields + owner/visibility +
  // links only, body capped at 1 KB in SQL — never every full body at 10k.
  const allObjects = db.getObjectsForTopics();
  const objectsById = new Map<string, db.TopicObjectRow>(allObjects.map((o) => [o.id, o]));
  await yieldTile();
  const survivingIds = new Set(working.map((w) => w.id));
  const clusteredIds = new Set(ids);
  const membersByTopic = new Map<string, string[]>();
  for (const w of working) membersByTopic.set(w.id, []);
  for (let i = 0; i < n; i++) membersByTopic.get(working[finalCluster[i]].id)!.push(ids[i]);
  // Carry-forward prior assignments for still-existing, non-clustered objects.
  const carried: Array<{ objectId: string; topicId: string }> = [];
  for (const [oid, tid] of priorAssign) {
    if (clusteredIds.has(oid)) continue;
    if (!objectsById.has(oid)) continue; // object row gone → drop
    if (!survivingIds.has(tid)) continue; // topic retired → becomes untopiced
    membersByTopic.get(tid)!.push(oid);
    carried.push({ objectId: oid, topicId: tid });
  }

  // ── 6) Birth-frozen θ for new topics; survivors keep θ (decision #9).
  for (const w of working) {
    if (w.thetaFrozen) continue;
    w.theta = computeBirthTheta(membersByTopic.get(w.id) ?? [], w.id, objectsById);
  }

  // ── 7) Labels + churn (decisions #6, #7). Leak-free label scoping (decision
  //       #13 hardening): label + terms are a GLOBAL string shipped to every
  //       viewer who can see ≥1 member, so they must never carry tokens from an
  //       object a co-viewer cannot see. A cluster whose members are ALL private
  //       and ALL owned by one user is seen only by that user → its own private
  //       docs are safe to name it. Any other cluster (a shared member, or
  //       private members spanning ≥2 owners) is labelled from SHARED members
  //       only; with none, the label is empty — no private token crosses the
  //       own+shared visibility boundary the graph is otherwise built on.
  const docsByCluster = new Map<string, LabelDoc[]>();
  const mixedOwner = new Map<string, boolean>(); // topic → labelled shared-only
  for (const w of working) {
    const memberOids = membersByTopic.get(w.id) ?? [];
    let hasShared = false;
    const privateOwners = new Set<string>();
    for (const oid of memberOids) {
      const o = objectsById.get(oid);
      if (!o) continue;
      if (o.visibility === 'shared') hasShared = true;
      else privateOwners.add(o.userId);
    }
    const sharedOnly = hasShared || privateOwners.size > 1;
    mixedOwner.set(w.id, sharedOnly);
    const docs: LabelDoc[] = [];
    for (const oid of memberOids) {
      const o = objectsById.get(oid);
      if (!o) continue;
      if (sharedOnly && o.visibility !== 'shared') continue; // drop private tokens
      docs.push({ id: oid, title: o.title ?? '', tags: o.tags ?? [], description: o.description, body: o.body });
    }
    docsByCluster.set(w.id, docs);
  }
  const labels = await cTfIdfLabels(docsByCluster, yieldTile);
  // Prior membership per topic (for churn).
  const priorByTopic = new Map<string, Set<string>>();
  for (const [oid, tid] of priorAssign) {
    if (!priorByTopic.has(tid)) priorByTopic.set(tid, new Set());
    priorByTopic.get(tid)!.add(oid);
  }

  // ── 8) Lifecycle + assemble final cluster rows.
  const clusters: db.TopicClusterRow[] = [];
  for (const w of working) {
    const members = membersByTopic.get(w.id) ?? [];
    const now = new Set(members);
    const prev = priorByTopic.get(w.id) ?? new Set<string>();
    let joined = 0;
    let left = 0;
    for (const m of now) if (!prev.has(m)) joined++;
    for (const m of prev) if (!now.has(m)) left++;
    const churnDelta = (joined + left) / Math.max(1, prev.size);
    let churnAccum = w.churnAccum + churnDelta;

    const auto = labels.get(w.id) ?? { label: '', terms: [] };
    let label = w.label;
    if (w.labelLocked) {
      // Locked wins; auto/terms still refresh, churn keeps accumulating.
    } else if (mixedOwner.get(w.id)) {
      // Leak-free (decision #13 hardening): a mixed-owner cluster's auto label is
      // already scoped to shared docs, so it must track auto IMMEDIATELY — never
      // let the churn damper keep a stale single-owner-era label (which could
      // carry a private token) alive after the cluster turned multi-owner.
      label = auto.label;
      churnAccum = 0;
    } else if (w.label === '' || churnAccum >= LABEL_CHURN) {
      label = auto.label;
      churnAccum = 0; // promotion resets the accumulator
    }

    let emptyRuns = w.emptyRuns;
    if (members.length === 0) {
      emptyRuns += 1;
      if (emptyRuns >= EMPTY_RUNS_PRUNE) continue; // prune: excluded from clusters → retired below
    } else {
      emptyRuns = 0;
    }

    const cb = idxById.get(w.id)! * DIM;
    clusters.push({
      id: w.id,
      label,
      labelAuto: auto.label,
      labelLocked: w.labelLocked,
      terms: auto.terms,
      churnAccum,
      centroid: Array.from(finalCentroids.subarray(cb, cb + DIM)),
      theta: w.theta,
      memberCount: members.length,
      emptyRuns,
      model,
      updatedAt: 0,
    });
  }

  // Retired = stored ids that no longer survive (reset / shrink / empty-prune).
  const finalIds = new Set(clusters.map((c) => c.id));
  const storedIdsBefore = reset
    ? db.listTopicClusters().map((s) => s.id)
    : working.map((w) => w.id).concat(db.listTopicClusters().map((s) => s.id));
  const retired = [...new Set(storedIdsBefore)].filter((id) => !finalIds.has(id));
  const bornSurviving = born.filter((id) => finalIds.has(id));

  // ── 9) Assignments = clustered (excl. pruned topics) + carried-forward.
  const assignments: Array<{ objectId: string; topicId: string; distance: number }> = [];
  for (let start = 0; start < n; start += TILE_LLOYD) {
    const end = Math.min(start + TILE_LLOYD, n);
    for (let i = start; i < end; i++) {
      const tid = working[finalCluster[i]].id;
      if (!finalIds.has(tid)) continue; // topic pruned this run
      assignments.push({ objectId: ids[i], topicId: tid, distance: dCosTo(i, finalCluster[i]) });
    }
    await yieldTile();
  }
  for (const c of carried) {
    if (!finalIds.has(c.topicId)) continue;
    assignments.push({ objectId: c.objectId, topicId: c.topicId, distance: 0 });
  }

  const paramsJson = JSON.stringify({
    tau: TAU, kTarget, reset: reset || undefined, born: bornSurviving, retired, ms: Date.now() - t0,
  });
  db.applyTopicRun({ clusters, retired, assignments, run: { model, k: clusters.length, n, moved, paramsJson } });

  return done({ ok: true, k: clusters.length, n, moved, born: bornSurviving, retired });
}

/** θ from the majority root galaxy among members' anchors (decision #6/#9);
 *  fallback 2π·hash01('topic:'+id). Deterministic ties: lexicographic root id. */
function computeBirthTheta(
  memberIds: string[],
  topicId: string,
  objectsById: Map<string, db.TopicObjectRow>,
): number {
  const layout = db.getLayout();
  const rootCount = new Map<string, number>();
  for (const oid of memberIds) {
    const o = objectsById.get(oid);
    const anchors = anchorNodeIds((o?.links ?? []) as ObjectRef[]);
    for (const a of anchors) {
      const anc = getAncestors(a);
      const root = anc.length ? anc[0].id : a; // root-first
      rootCount.set(root, (rootCount.get(root) ?? 0) + 1);
    }
  }
  let bestRoot: string | null = null;
  let bestCount = -1;
  for (const [root, count] of [...rootCount.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > bestCount) {
      bestCount = count;
      bestRoot = root;
    }
  }
  if (bestRoot) {
    const p = layout.get(bestRoot);
    if (p) return Math.atan2(p.z, p.x);
  }
  return 2 * Math.PI * hash01(`topic:${topicId}`);
}

/** Admin re-anchor (decision #9): the one sanctioned θ change outside a full
 *  reset. Recomputes θ from the CURRENT majority root galaxy among the topic's
 *  members and persists it. false when the id is unknown. */
export function reanchorTopic(id: string): boolean {
  const memberIds: string[] = [];
  for (const [oid, tid] of db.getTopicAssignments()) if (tid === id) memberIds.push(oid);
  const objectsById = new Map(db.getObjectsForTopics().map((o) => [o.id, o]));
  const theta = computeBirthTheta(memberIds, id, objectsById);
  return db.setTopicTheta(id, theta);
}

// ── Debounce + boot (decisions #3, #4) ────────────────────────────────────────
let timer: ReturnType<typeof setTimeout> | null = null;
let firstScheduledAt = 0;

/** Trailing-edge debounce (15 s, max-wait 60 s) so a bulk embed burst triggers
 *  at most one run per minute plus a final run. Coalescing: repeated schedules
 *  collapse to one timer; the single-flight chain prevents overlap. */
export function scheduleTopicRecluster(delayMs: number = DEBOUNCE_MS): void {
  const now = Date.now();
  if (firstScheduledAt === 0) firstScheduledAt = now;
  if (timer) clearTimeout(timer);
  const fireAt = Math.min(now + delayMs, firstScheduledAt + DEBOUNCE_MAX_MS);
  timer = setTimeout(() => {
    timer = null;
    firstScheduledAt = 0;
    void clusterTopics().catch((err) => console.warn('[topics] recluster failed:', err));
  }, Math.max(0, fireAt - now));
  timer.unref?.(); // never keep the process alive just to recluster
}

/** True when the persisted map is out of date: dominant-model mismatch, or the
 *  object-vector count / max(updated_at) drifted past the last run. */
export function topicsStale(): boolean {
  if (!db.vectorSearchAvailable()) return false;
  const stored = db.listTopicClusters();
  // Same margin-gated resolution as a run (decision #5 hardening): a near-parity
  // dominant-model flip is NOT a migration, so it must not report stale — that
  // would re-trigger a boot recluster on every parity wobble.
  const resolved = resolveModel(stored.length > 0 ? stored[0].model : null);
  if (!resolved) return false; // no object vectors
  if (stored.length === 0) return true; // vectors exist but never clustered
  if (resolved.reset) return true; // a margin-crossing model migration is due
  const { count } = db.objectVectorStats(resolved.model);
  const assigned = db.topicStats().assigned;
  return count !== assigned; // vectors added/removed since the last run
}

/** Boot hook (decision #4): scheduled from INSIDE app.listen so it can never
 *  threaten the nOS health probe. Merely schedules a delayed run when stale. */
export function startTopicSync(): void {
  if (topicsStale()) scheduleTopicRecluster(BOOT_DELAY_MS);
}
