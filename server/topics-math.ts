/**
 * Topics mode — pure clustering + labelling math (topic-mode-spec §1.1).
 *
 * NO db imports, NO RNG, Float32Array throughout: same inputs ⇒ bit-identical
 * output (the spatial-memory contract). Cooperative chunking is expressed via
 * the optional `onTile` yield so the orchestrator (server/topics.ts) can keep
 * the event loop responsive during a background run — this module never
 * schedules anything itself.
 *
 * Vectors are unit-normalized, so cosine distance is `1 − dot` and spherical
 * k-means assigns by maximum dot product; a centroid is the normalized mean of
 * its members.
 */

export interface LloydResult {
  assign: Int32Array;
  centroids: Float32Array;
  iters: number;
}

/** Unit-normalize every row in place. A zero row (degenerate vector) is left
 *  untouched — it contributes 0 to every dot product and lands wherever the
 *  hysteresis layer keeps it. */
export function normalizeInPlace(data: Float32Array, n: number, dim: number): void {
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let ss = 0;
    for (let j = 0; j < dim; j++) ss += data[base + j] * data[base + j];
    if (ss <= 0) continue;
    const inv = 1 / Math.sqrt(ss);
    for (let j = 0; j < dim; j++) data[base + j] *= inv;
  }
}

/** Argmax dot product of row `r` against the k unit centroids. */
function nearestCentroid(data: Float32Array, r: number, dim: number, centroids: Float32Array, k: number): number {
  const base = r * dim;
  let best = 0;
  let bestDot = -Infinity;
  for (let c = 0; c < k; c++) {
    const cb = c * dim;
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += data[base + j] * centroids[cb + j];
    if (dot > bestDot) {
      bestDot = dot;
      best = c;
    }
  }
  return best;
}

/**
 * Warm-started spherical k-means (Lloyd). Seeds are the stored centroids (the
 * seed-index ↔ topic-id correspondence is preserved by the caller — no
 * matching pass). A cluster that goes empty during an iteration keeps its
 * previous centroid (identity survives a transient vacancy). Tiled at
 * TILE_LLOYD rows with an `onTile` yield between tiles.
 */
export async function lloydWarm(
  data: Float32Array,
  n: number,
  dim: number,
  seeds: Float32Array,
  k: number,
  opts: { maxIter: number; eps: number; onTile?: () => Promise<void>; tile?: number },
): Promise<LloydResult> {
  const tile = opts.tile ?? 500;
  const centroids = new Float32Array(seeds.subarray(0, k * dim));
  const assign = new Int32Array(n);
  const sums = new Float32Array(k * dim);
  const counts = new Int32Array(k);
  let iters = 0;
  for (let iter = 0; iter < opts.maxIter; iter++) {
    iters = iter + 1;
    // Assignment step (tiled).
    for (let start = 0; start < n; start += tile) {
      const end = Math.min(start + tile, n);
      for (let r = start; r < end; r++) assign[r] = nearestCentroid(data, r, dim, centroids, k);
      if (opts.onTile) await opts.onTile();
    }
    // Update step (tiled accumulation, then normalize).
    sums.fill(0);
    counts.fill(0);
    for (let start = 0; start < n; start += tile) {
      const end = Math.min(start + tile, n);
      for (let r = start; r < end; r++) {
        const c = assign[r];
        counts[c]++;
        const rb = r * dim;
        const cb = c * dim;
        for (let j = 0; j < dim; j++) sums[cb + j] += data[rb + j];
      }
      if (opts.onTile) await opts.onTile();
    }
    let maxShift = 0;
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // empty: keep previous centroid
      const cb = c * dim;
      let ss = 0;
      for (let j = 0; j < dim; j++) ss += sums[cb + j] * sums[cb + j];
      const inv = ss > 0 ? 1 / Math.sqrt(ss) : 0;
      let shift = 0;
      for (let j = 0; j < dim; j++) {
        const nv = sums[cb + j] * inv;
        const d = nv - centroids[cb + j];
        shift += d * d;
        centroids[cb + j] = nv;
      }
      if (shift > maxShift) maxShift = shift;
    }
    if (Math.sqrt(maxShift) < opts.eps) break;
  }
  return { assign, centroids, iters };
}

/**
 * Farthest-first seed: the data-row index whose nearest existing centroid is
 * the farthest away (max min-distance ⇒ min max-similarity). Deterministic
 * ties break by ascending ref_id. `existing` holds `k` unit centroids; when
 * k===0 the lexicographically smallest ref_id row is returned (the reset seed).
 */
export function farthestFirstSeed(
  data: Float32Array,
  n: number,
  dim: number,
  existing: Float32Array,
  k: number,
  ids: string[],
): number {
  if (n === 0) return -1;
  if (k === 0) {
    let best = 0;
    for (let i = 1; i < n; i++) if (ids[i] < ids[best]) best = i;
    return best;
  }
  let best = -1;
  let bestSim = Infinity; // minimize the nearest-centroid similarity
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let nearSim = -Infinity;
    for (let c = 0; c < k; c++) {
      const cb = c * dim;
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += data[base + j] * existing[cb + j];
      if (dot > nearSim) nearSim = dot;
    }
    if (nearSim < bestSim || (nearSim === bestSim && best >= 0 && ids[i] < ids[best])) {
      bestSim = nearSim;
      best = i;
    }
  }
  return best;
}

// ── c-TF-IDF labelling (decision #6) ──────────────────────────────────────────

export interface LabelDoc {
  id: string;
  title: string;
  tags: string[];
  description?: string;
  body?: string;
}

// Inline en+cs stopword lists (diacritics kept — cs is a first-class locale).
const STOP_EN = [
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two',
  'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'that', 'with', 'have',
  'this', 'will', 'your', 'from', 'they', 'know', 'want', 'been', 'good', 'much', 'some', 'time',
  'very', 'when', 'come', 'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such', 'take',
  'than', 'them', 'well', 'were', 'what', 'about', 'would', 'there', 'their', 'which', 'were', 'into',
  'more', 'most', 'other', 'these', 'those', 'then', 'also', 'each', 'only', 'both', 'onto', 'upon',
  'while', 'after', 'before', 'being', 'could', 'should', 'where', 'because', 'between', 'through',
  'during', 'above', 'below', 'again', 'further', 'once', 'under', 'same', 'does', 'doing', 'down',
  'off', 'own', 'per', 'via', 'yet', 'was', 'and', 'not', 'nor', 'yes', 'may', 'might', 'must',
  'shall', 'ought', 'need', 'used', 'using', 'able', 'made', 'sure', 'thing', 'things', 'stuff',
  'etc', 'null', 'true', 'false', 'none',
];
const STOP_CS = [
  'a', 'aby', 'ale', 'ani', 'ano', 'asi', 'az', 'bez', 'bude', 'budem', 'budes', 'by', 'byl', 'byla',
  'byli', 'bylo', 'byt', 'ci', 'clanek', 'clanku', 'co', 'coz', 'cz', 'dalsi', 'design', 'dnes', 'do',
  'ho', 'i', 'jak', 'jako', 'je', 'jeho', 'jej', 'jeji', 'jejich', 'jen', 'jenz', 'jeste', 'ji', 'jine',
  'jiz', 'jsem', 'jses', 'jsme', 'jsou', 'jste', 'k', 'kam', 'kde', 'kdo', 'kdyz', 'ke', 'kdy', 'ktera',
  'ktere', 'kteri', 'kterou', 'ktery', 'ku', 'ma', 'mate', 'me', 'mezi', 'mi', 'mit', 'mne', 'mnou',
  'muj', 'muze', 'my', 'na', 'nad', 'nam', 'napiste', 'nas', 'nasi', 'ne', 'nebo', 'nedelaji', 'neg',
  'nejsou', 'neni', 'nez', 'ni', 'nic', 'nove', 'novy', 'o', 'od', 'ode', 'on', 'ona', 'oni', 'ono',
  'pak', 'po', 'pod', 'podle', 'pokud', 'pouze', 'prave', 'pred', 'pres', 'pri', 'pro', 'proc',
  'protoze', 'proto', 'proti', 'prvni', 're', 's', 'se', 'si', 'sice', 'strana', 'sve', 'svych',
  'svym', 'svymi', 'ta', 'tak', 'take', 'takze', 'tam', 'tato', 'te', 'tedy', 'tema', 'ten', 'tento',
  'teto', 'tim', 'timto', 'to', 'tohle', 'toho', 'tohoto', 'tom', 'tomto', 'tomuto', 'tu', 'tuto',
  'tvuj', 'ty', 'tyto', 'u', 'uz', 'v', 've', 'vas', 'vase', 'vice', 'vsak', 'vsechen', 'vsechno',
  'vsichni', 'vy', 'z', 'za', 'zda', 'zde', 'ze', 'zpet', 'zpravy',
];
const STOP = new Set<string>([...STOP_EN, ...STOP_CS]);

const NUMERIC = /^\p{N}+$/u;
const SPLIT = /[^\p{L}\p{N}]+/u;

function addTokens(text: string, weight: number, out: Map<string, number>): void {
  if (!text) return;
  for (const raw of text.split(SPLIT)) {
    if (!raw) continue;
    const t = raw.toLowerCase();
    if (t.length < 3) continue;
    if (NUMERIC.test(t)) continue;
    if (STOP.has(t)) continue;
    out.set(t, (out.get(t) ?? 0) + weight);
  }
}

/** Title preprocessing: filenames split on [-_./] + camelCase → spaces. */
function prepTitle(title: string): string {
  return (title ?? '').replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2').replace(/[-_./]+/g, ' ');
}

/**
 * c-TF-IDF label pipeline (decision #6). Returns per-cluster top-8 terms and a
 * ≤28-char label (top 1–3 terms joined " · "). Corpus-level stop rule drops
 * terms present in >60 % of clusters; collisions dedupe by appending the next
 * distinctive term to the later cluster (ordered by id). Fully deterministic:
 * every ranking tie breaks lexicographically.
 *
 * Cooperative: tokenizing every cluster's docs is the heaviest sync span in a
 * run, so an optional `onTile` yield is awaited after each cluster's docs are
 * tokenized and after each cluster is ranked. Yields never affect output — the
 * result stays bit-identical for identical input (spatial-memory contract).
 *
 * An empty label (a cluster with no labelable docs — e.g. a mixed-owner cluster
 * that carries no shared content, see server/topics.ts) is returned as '' with
 * no terms: the cid is NEVER used as a fallback label, since a raw topic id is
 * not a name the viewer should see.
 */
export async function cTfIdfLabels(
  docsByCluster: Map<string, LabelDoc[]>,
  onTile?: () => Promise<void>,
): Promise<Map<string, { label: string; terms: string[] }>> {
  const clusterIds = [...docsByCluster.keys()].sort();
  const numClusters = clusterIds.length;
  const out = new Map<string, { label: string; terms: string[] }>();
  if (numClusters === 0) return out;

  // Per-cluster weighted term frequencies + corpus df/frequency.
  const tfByCluster = new Map<string, Map<string, number>>();
  const df = new Map<string, number>(); // clusters containing the term
  const corpusFreq = new Map<string, number>(); // total tf across clusters
  let totalTf = 0;
  for (const cid of clusterIds) {
    const tf = new Map<string, number>();
    for (const doc of docsByCluster.get(cid) ?? []) {
      addTokens(prepTitle(doc.title), 2, tf);
      for (const tag of doc.tags ?? []) addTokens(tag, 3, tf);
      addTokens(doc.description ?? '', 1, tf);
      addTokens((doc.body ?? '').slice(0, 1000), 1, tf);
    }
    tfByCluster.set(cid, tf);
    for (const [term, w] of tf) {
      df.set(term, (df.get(term) ?? 0) + 1);
      corpusFreq.set(term, (corpusFreq.get(term) ?? 0) + w);
      totalTf += w;
    }
    if (onTile) await onTile();
  }
  const A = totalTf / numClusters; // mean total tf per cluster
  const dfCap = 0.6 * numClusters;

  // Rank each cluster's terms; drop corpus-wide stop terms (df > 60%).
  const rankedByCluster = new Map<string, string[]>();
  for (const cid of clusterIds) {
    const tf = tfByCluster.get(cid)!;
    let sumTf = 0;
    for (const w of tf.values()) sumTf += w;
    const scored: Array<{ term: string; score: number }> = [];
    for (const [term, w] of tf) {
      if ((df.get(term) ?? 0) > dfCap && numClusters > 1) continue;
      const ft = corpusFreq.get(term) ?? w;
      const score = (sumTf > 0 ? w / sumTf : 0) * Math.log(1 + A / ft);
      scored.push({ term, score });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
    rankedByCluster.set(cid, scored.slice(0, 8).map((s) => s.term));
    if (onTile) await onTile();
  }

  // Build labels (≤28 chars, up to 3 terms) with collision dedupe by id order.
  const used = new Set<string>();
  for (const cid of clusterIds) {
    const ranked = rankedByCluster.get(cid) ?? [];
    let label = buildLabel(ranked, 3);
    if (label && used.has(label)) {
      // Append the next distinctive term until unique or terms exhausted.
      for (let take = 4; take <= ranked.length && used.has(label); take++) {
        label = buildLabel(ranked, take);
      }
    }
    // An empty label stays empty (no members / no labelable docs — e.g. a
    // mixed-owner cluster with no shared content): never fall back to the raw
    // cid, which would surface an internal id in the UI. Non-empty labels keep
    // their prior collision behavior.
    used.add(label);
    out.set(cid, { label, terms: ranked });
  }
  return out;
}

function buildLabel(terms: string[], maxTerms: number): string {
  const picked: string[] = [];
  for (const t of terms) {
    if (picked.length >= maxTerms) break;
    const next = [...picked, t].join(' · ');
    if (next.length > 28 && picked.length > 0) break;
    picked.push(t);
    if ([...picked].join(' · ').length >= 28) break;
  }
  let label = picked.join(' · ');
  if (label.length > 28) label = label.slice(0, 28).trimEnd();
  return label;
}
