/**
 * SQLite persistence — full port of the old src/services/database.server.ts.
 *
 * Structural changes vs the IIAB-era schema:
 *   1. Every user-scoped table gains `user_id` (default 'local') so per-user
 *      state works behind Authentik header-OIDC. The old schema was implicitly
 *      single-tenant.
 *   2. User-scoped content tables also gain `visibility` ('private' default).
 *      Nothing reads it yet — it exists so the future sharing/social phase
 *      (COMPLETION_PROPOSAL.md, Phase S) needs no schema rework. No code may
 *      assume single-user semantics.
 *   3. `taxonomy_metadata` (the Admin-curated knowledge layer) stays GLOBAL —
 *      it is the shared knowledge base that humans and nOS agents consume;
 *      writes are admin-gated in routes.ts and attributed via `updated_by`.
 *   4. DB path is `KEAP_DATA_DIR` (mounted volume), not process.cwd()/data.
 *   5. The fake sample courses from the old insertSampleData() are gone —
 *      empty state is real state.
 */
import Database from 'libsql';
import fs from 'node:fs';
import path from 'node:path';

let db: Database.Database | null = null;
let vectorsOk = false;

const DATA_DIR = process.env.KEAP_DATA_DIR ?? path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'keap.db');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS course_progress (
     user_id TEXT NOT NULL DEFAULT 'local',
     course_id INTEGER NOT NULL,
     progress INTEGER DEFAULT 0,
     completed_chapters INTEGER DEFAULT 0,
     visibility TEXT NOT NULL DEFAULT 'private',
     updated_at INTEGER DEFAULT (strftime('%s','now')),
     PRIMARY KEY (user_id, course_id)
   )`,
  `CREATE TABLE IF NOT EXISTS completed_items (
     user_id TEXT NOT NULL DEFAULT 'local',
     id TEXT NOT NULL,
     visibility TEXT NOT NULL DEFAULT 'private',
     completed_at INTEGER DEFAULT (strftime('%s','now')),
     PRIMARY KEY (user_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS taxonomy_metadata (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     updated_by TEXT,
     updated_at INTEGER DEFAULT (strftime('%s','now'))
   )`,
  `CREATE TABLE IF NOT EXISTS api_taxonomy_metadata (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL DEFAULT 'local',
     title TEXT NOT NULL,
     description TEXT,
     url TEXT,
     domain TEXT,
     metadata TEXT,
     visibility TEXT NOT NULL DEFAULT 'private',
     created_at INTEGER DEFAULT (strftime('%s','now')),
     updated_at INTEGER DEFAULT (strftime('%s','now'))
   )`,
  `CREATE TABLE IF NOT EXISTS homepage_tiles (
     user_id TEXT NOT NULL DEFAULT 'local',
     id TEXT NOT NULL,
     title TEXT NOT NULL,
     type TEXT NOT NULL,
     position INTEGER NOT NULL,
     visible INTEGER DEFAULT 1,
     config TEXT,
     updated_at INTEGER DEFAULT (strftime('%s','now')),
     PRIMARY KEY (user_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS recent_activity (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL DEFAULT 'local',
     item_id TEXT NOT NULL,
     item_type TEXT NOT NULL,
     timestamp INTEGER DEFAULT (strftime('%s','now'))
   )`,
  `CREATE TABLE IF NOT EXISTS app_metadata (
     id TEXT PRIMARY KEY,
     version TEXT NOT NULL,
     last_updated INTEGER DEFAULT (strftime('%s','now')),
     total_items INTEGER DEFAULT 0,
     completed_items INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     user_id TEXT NOT NULL DEFAULT 'local',
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     updated_at INTEGER DEFAULT (strftime('%s','now')),
     PRIMARY KEY (user_id, key)
   )`,
  `CREATE TABLE IF NOT EXISTS todos (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL DEFAULT 'local',
     title TEXT NOT NULL,
     completed INTEGER DEFAULT 0,
     visibility TEXT NOT NULL DEFAULT 'private',
     created_at INTEGER DEFAULT (strftime('%s','now')),
     updated_at INTEGER DEFAULT (strftime('%s','now'))
   )`,
];

// ── Vector layer (libSQL native) ──────────────────────────────────────────────
// One table for every embeddable object kind; the vector sits NEXT to the row
// reference, so joins + filters + distance run in a single SQL statement (the
// reason libSQL replaced better-sqlite3 here). Dimension is fixed to 768
// (nomic-embed-text); switching to a model with a different dimension requires
// DROP TABLE embeddings + a full re-sync from the host-side embed job.
// content_hash invalidates stale vectors when the source text changes.
const VECTOR_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS embeddings (
     kind TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     model TEXT NOT NULL,
     dim INTEGER NOT NULL,
     content_hash TEXT NOT NULL,
     vector F32_BLOB(768),
     updated_at INTEGER DEFAULT (strftime('%s','now')),
     PRIMARY KEY (kind, ref_id)
   )`,
  `CREATE INDEX IF NOT EXISTS embeddings_vec_idx
     ON embeddings(libsql_vector_idx(vector))`,
];

export async function initDb(): Promise<void> {
  if (db) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  for (const stmt of SCHEMA) db.exec(stmt);
  // Vector tables degrade gracefully: if the runtime lacks the libSQL vector
  // functions (e.g. a stock-SQLite build), semantic features stay off and the
  // FTS/tree surfaces keep working — same pattern as the agent-token 503s.
  try {
    for (const stmt of VECTOR_SCHEMA) db.exec(stmt);
    vectorsOk = true;
  } catch (err) {
    vectorsOk = false;
    console.warn('[db] vector layer unavailable, semantic features disabled:', err);
  }
  initializeAppMetadata();
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialised — call initDb() first');
  return db;
}

/** True when the libSQL vector layer initialised (embeddings table + ANN index). */
export function vectorSearchAvailable(): boolean {
  return vectorsOk;
}

// ── Courses ───────────────────────────────────────────────────────────────────

export interface UserProgress {
  courseId: number;
  progress: number;
  completedChapters: number;
}

export function getAllCourses(userId: string): UserProgress[] {
  return getDb()
    .prepare(
      'SELECT course_id as courseId, progress, completed_chapters as completedChapters FROM course_progress WHERE user_id = ?',
    )
    .all(userId) as UserProgress[];
}

export function updateCourseProgress(
  userId: string,
  courseId: number,
  progress: number,
  completedChapters: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO course_progress (user_id, course_id, progress, completed_chapters, updated_at)
       VALUES (?, ?, ?, ?, strftime('%s','now'))
       ON CONFLICT(user_id, course_id) DO UPDATE SET
         progress = excluded.progress,
         completed_chapters = excluded.completed_chapters,
         updated_at = excluded.updated_at`,
    )
    .run(userId, courseId, progress, completedChapters);
}

// ── Completed items ───────────────────────────────────────────────────────────

export function getCompletedItems(userId: string): string[] {
  return getDb()
    .prepare('SELECT id FROM completed_items WHERE user_id = ?')
    .all(userId)
    .map((r: any) => r.id);
}

export function toggleCompletedItem(userId: string, itemId: string): void {
  const d = getDb();
  const row = d.prepare('SELECT 1 FROM completed_items WHERE user_id = ? AND id = ?').get(userId, itemId);
  if (row) {
    d.prepare('DELETE FROM completed_items WHERE user_id = ? AND id = ?').run(userId, itemId);
  } else {
    d.prepare('INSERT INTO completed_items (user_id, id) VALUES (?, ?)').run(userId, itemId);
  }
}

// ── Curated taxonomy metadata (GLOBAL knowledge layer, admin-written) ─────────

export interface TaxonomyMetadata {
  id: string;
  data: any;
  updatedAt: number;
}

export function getTaxonomyMetadata(id?: string): TaxonomyMetadata[] | TaxonomyMetadata | null {
  const d = getDb();
  if (id) {
    const row = d.prepare('SELECT * FROM taxonomy_metadata WHERE id = ?').get(id) as any;
    if (!row) return null;
    return { id: row.id, data: JSON.parse(row.data), updatedAt: row.updated_at };
  }
  const rows = d.prepare('SELECT * FROM taxonomy_metadata').all() as any[];
  return rows.map((row) => ({ id: row.id, data: JSON.parse(row.data), updatedAt: row.updated_at }));
}

export function saveTaxonomyMetadata(metadata: { id: string; data: any }, updatedBy: string): void {
  getDb()
    .prepare(
      `INSERT INTO taxonomy_metadata (id, data, updated_by, updated_at)
       VALUES (?, ?, ?, strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(metadata.id, JSON.stringify(metadata.data), updatedBy);
}

export function deleteTaxonomyMetadata(id: string): void {
  getDb().prepare('DELETE FROM taxonomy_metadata WHERE id = ?').run(id);
}

// ── Captured page metadata (owner-scoped; admins see all) ────────────────────

export interface ApiTaxonomyMetadata {
  id: string;
  userId?: string;
  title: string;
  description?: string;
  url?: string;
  domain?: string;
  metadata?: any;
  createdAt: number;
  updatedAt: number;
}

function mapCaptureRow(row: any): ApiTaxonomyMetadata {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    url: row.url,
    domain: row.domain,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllMetadataApi(userId: string, seeAll: boolean): ApiTaxonomyMetadata[] {
  const d = getDb();
  const rows = seeAll
    ? d.prepare('SELECT * FROM api_taxonomy_metadata ORDER BY updated_at DESC').all()
    : d.prepare('SELECT * FROM api_taxonomy_metadata WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  return (rows as any[]).map(mapCaptureRow);
}

export function getMetadataByDomainApi(userId: string, seeAll: boolean, domain: string): ApiTaxonomyMetadata[] {
  const d = getDb();
  const rows = seeAll
    ? d.prepare('SELECT * FROM api_taxonomy_metadata WHERE domain = ? ORDER BY updated_at DESC').all(domain)
    : d
        .prepare('SELECT * FROM api_taxonomy_metadata WHERE user_id = ? AND domain = ? ORDER BY updated_at DESC')
        .all(userId, domain);
  return (rows as any[]).map(mapCaptureRow);
}

export function saveMetadataApi(
  userId: string,
  metadata: Omit<ApiTaxonomyMetadata, 'createdAt' | 'updatedAt'>,
): void {
  getDb()
    .prepare(
      `INSERT INTO api_taxonomy_metadata (id, user_id, title, description, url, domain, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         url = excluded.url,
         domain = excluded.domain,
         metadata = excluded.metadata,
         updated_at = excluded.updated_at`,
    )
    .run(
      metadata.id,
      userId,
      metadata.title,
      metadata.description ?? null,
      metadata.url ?? null,
      metadata.domain ?? null,
      metadata.metadata ? JSON.stringify(metadata.metadata) : null,
    );
}

// ── Homepage tiles (per-user UI config) ──────────────────────────────────────

export interface HomepageTile {
  id: string;
  title: string;
  type: string;
  position: number;
  visible: boolean;
  config?: any;
}

export function getHomepageTiles(userId: string): HomepageTile[] {
  const rows = getDb()
    .prepare('SELECT * FROM homepage_tiles WHERE user_id = ? ORDER BY position')
    .all(userId) as any[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    position: row.position,
    visible: Boolean(row.visible),
    config: row.config ? JSON.parse(row.config) : null,
  }));
}

export function saveHomepageTiles(userId: string, tiles: HomepageTile[]): void {
  const d = getDb();
  const replaceAll = d.transaction((rows: HomepageTile[]) => {
    d.prepare('DELETE FROM homepage_tiles WHERE user_id = ?').run(userId);
    const insert = d.prepare(
      'INSERT INTO homepage_tiles (user_id, id, title, type, position, visible, config) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const tile of rows) {
      insert.run(
        userId,
        tile.id,
        tile.title,
        tile.type,
        tile.position,
        tile.visible ? 1 : 0,
        tile.config ? JSON.stringify(tile.config) : null,
      );
    }
  });
  replaceAll(tiles);
}

// ── Activity (per-user) ───────────────────────────────────────────────────────

export function trackActivity(userId: string, itemId: string, itemType: string): void {
  getDb()
    .prepare('INSERT INTO recent_activity (user_id, item_id, item_type) VALUES (?, ?, ?)')
    .run(userId, itemId, itemType);
}

export function getRecentActivity(userId: string, type?: string, limit = 10): any[] {
  const d = getDb();
  if (type) {
    return d
      .prepare('SELECT * FROM recent_activity WHERE user_id = ? AND item_type = ? ORDER BY timestamp DESC LIMIT ?')
      .all(userId, type, limit);
  }
  return d
    .prepare('SELECT * FROM recent_activity WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?')
    .all(userId, limit);
}

// ── App metadata (global) ─────────────────────────────────────────────────────

export interface AppMetadata {
  id: string;
  version: string;
  lastUpdated: number;
  totalItems: number;
  completedItems: number;
}

function initializeAppMetadata(): void {
  const d = getDb();
  const existing = d.prepare('SELECT COUNT(*) as count FROM app_metadata').get() as { count: number };
  if (existing.count === 0) {
    d.prepare("INSERT INTO app_metadata (id, version, total_items, completed_items) VALUES ('main', '1.0.0', 0, 0)").run();
  }
}

export function getAppMetadata(): AppMetadata | null {
  const row = getDb().prepare("SELECT * FROM app_metadata WHERE id = 'main'").get() as any;
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    lastUpdated: row.last_updated,
    totalItems: row.total_items,
    completedItems: row.completed_items,
  };
}

// ── Settings (per-user) ───────────────────────────────────────────────────────

export function saveSetting(userId: string, key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, strftime('%s','now'))
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(userId, key, value);
}

export function getSetting(userId: string, key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE user_id = ? AND key = ?').get(userId, key) as any;
  return row ? row.value : null;
}

// ── Todos (per-user) ──────────────────────────────────────────────────────────

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}

export function getTodos(userId: string): TodoItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as any[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    completed: Boolean(row.completed),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function saveTodo(
  userId: string,
  todo: { id: string; title: string; completed?: boolean; createdAt?: number },
): void {
  getDb()
    .prepare(
      `INSERT INTO todos (id, user_id, title, completed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         completed = excluded.completed,
         updated_at = excluded.updated_at
       WHERE todos.user_id = excluded.user_id`,
    )
    .run(todo.id, userId, todo.title, todo.completed ? 1 : 0, todo.createdAt ?? Math.floor(Date.now() / 1000));
}

export function deleteTodo(userId: string, id: string): void {
  getDb().prepare('DELETE FROM todos WHERE user_id = ? AND id = ?').run(userId, id);
}

// ── Taxonomy full-text index (agent surface) ─────────────────────────────────
// FTS5 over the static taxonomy tree. Rebuilt on every startup — the dataset
// is a compiled-in constant, so the index is derived state, never a source.

export interface FtsHit {
  id: string;
  rank: number;
}

export function rebuildTaxonomyFts(
  nodes: Array<{ id: string; name: string; description?: string; path: string }>,
): void {
  const d = getDb();
  d.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS taxonomy_fts USING fts5(id UNINDEXED, name, description, path)`,
  );
  const rebuild = d.transaction(() => {
    d.prepare('DELETE FROM taxonomy_fts').run();
    const insert = d.prepare('INSERT INTO taxonomy_fts (id, name, description, path) VALUES (?, ?, ?, ?)');
    for (const n of nodes) insert.run(n.id, n.name, n.description ?? '', n.path);
  });
  rebuild();
}

export function searchTaxonomyFts(query: string, limit: number): FtsHit[] {
  // Quote each token so user input can't inject FTS5 syntax (NEAR, *, etc.).
  const match = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .join(' ');
  if (!match) return [];
  try {
    return getDb()
      .prepare('SELECT id, rank FROM taxonomy_fts WHERE taxonomy_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(match, limit) as FtsHit[];
  } catch {
    return [];
  }
}

// ── Corpus stats (agent health endpoint) ─────────────────────────────────────

export function corpusStats(): { captures: number; curatedNotes: number } {
  const d = getDb();
  const captures = (d.prepare('SELECT COUNT(*) AS c FROM api_taxonomy_metadata').get() as any).c;
  const curatedNotes = (d.prepare('SELECT COUNT(*) AS c FROM taxonomy_metadata').get() as any).c;
  return { captures, curatedNotes };
}

// ── Embeddings (libSQL vector layer) ──────────────────────────────────────────
// Vectors are written by the host-side sync job (nOS Pulse: Ollama on the host
// loopback → POST /agent/v1/embeddings) — the container never needs to reach
// an embedder for node-anchored distance queries.

export type EmbeddingKind = 'taxonomy' | 'capture' | 'note';

export interface NeighborHit {
  kind: EmbeddingKind;
  refId: string;
  distance: number;
}

export function embeddingStats(): { total: number; byKind: Record<string, number>; model: string | null } {
  if (!vectorsOk) return { total: 0, byKind: {}, model: null };
  const d = getDb();
  const rows = d.prepare('SELECT kind, COUNT(*) AS c FROM embeddings GROUP BY kind').all() as any[];
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byKind[r.kind] = r.c;
    total += r.c;
  }
  const m = d.prepare('SELECT model FROM embeddings LIMIT 1').get() as any;
  return { total, byKind, model: m?.model ?? null };
}

/** ref_id → content_hash for one kind — drives the pending/stale diff. */
export function getEmbeddingHashes(kind: EmbeddingKind): Map<string, string> {
  if (!vectorsOk) return new Map();
  const rows = getDb().prepare('SELECT ref_id, content_hash FROM embeddings WHERE kind = ?').all(kind) as any[];
  return new Map(rows.map((r) => [r.ref_id, r.content_hash]));
}

export function upsertEmbeddings(
  model: string,
  dim: number,
  items: Array<{ kind: EmbeddingKind; refId: string; contentHash: string; vector: number[] }>,
): number {
  if (!vectorsOk) throw new Error('vector layer unavailable');
  const d = getDb();
  const insert = d.prepare(
    `INSERT INTO embeddings (kind, ref_id, model, dim, content_hash, vector, updated_at)
     VALUES (?, ?, ?, ?, ?, vector32(?), strftime('%s','now'))
     ON CONFLICT(kind, ref_id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       content_hash = excluded.content_hash,
       vector = excluded.vector,
       updated_at = excluded.updated_at`,
  );
  const tx = d.transaction((rows: typeof items) => {
    for (const it of rows) {
      insert.run(it.kind, it.refId, model, dim, it.contentHash, JSON.stringify(it.vector));
    }
  });
  tx(items);
  return items.length;
}

/** Drop vectors whose source row no longer exists (deleted capture/note). */
export function pruneEmbeddings(kind: EmbeddingKind, liveIds: Set<string>): number {
  if (!vectorsOk) return 0;
  const d = getDb();
  const stored = d.prepare('SELECT ref_id FROM embeddings WHERE kind = ?').all(kind) as any[];
  const del = d.prepare('DELETE FROM embeddings WHERE kind = ? AND ref_id = ?');
  let pruned = 0;
  const tx = d.transaction(() => {
    for (const r of stored) {
      if (!liveIds.has(r.ref_id)) {
        del.run(kind, r.ref_id);
        pruned++;
      }
    }
  });
  tx();
  return pruned;
}

/**
 * k nearest (mode=related) or farthest (mode=unrelated) stored vectors from an
 * anchor row. Nearest uses the DiskANN index (vector_top_k); farthest is a
 * full scan — DiskANN has no "farthest" query, and at ~1k rows a scan is free.
 */
export function vectorNeighbors(
  anchorKind: EmbeddingKind,
  anchorRefId: string,
  mode: 'related' | 'unrelated',
  kinds: EmbeddingKind[],
  limit: number,
): NeighborHit[] | null {
  if (!vectorsOk) return null;
  const d = getDb();
  const anchor = d
    .prepare('SELECT vector_extract(vector) AS v FROM embeddings WHERE kind = ? AND ref_id = ?')
    .get(anchorKind, anchorRefId) as any;
  if (!anchor?.v) return null;
  return vectorNeighborsOf(anchor.v, mode, kinds, limit, { kind: anchorKind, refId: anchorRefId });
}

/** Same as vectorNeighbors but anchored on a raw query vector (live embed). */
export function vectorNeighborsOf(
  vectorJson: string,
  mode: 'related' | 'unrelated',
  kinds: EmbeddingKind[],
  limit: number,
  exclude?: { kind: string; refId: string },
): NeighborHit[] {
  if (!vectorsOk) return [];
  const d = getDb();
  const kindFilter = kinds.length ? `AND e.kind IN (${kinds.map(() => '?').join(',')})` : '';
  if (mode === 'related') {
    // Over-fetch from the ANN index, then kind-filter + self-exclude in SQL.
    const rows = d
      .prepare(
        `SELECT e.kind, e.ref_id AS refId,
                vector_distance_cos(e.vector, vector32(?)) AS distance
         FROM vector_top_k('embeddings_vec_idx', vector32(?), ?) AS v
         JOIN embeddings e ON e.rowid = v.id
         WHERE 1=1 ${kindFilter}
         ORDER BY distance ASC`,
      )
      .all(vectorJson, vectorJson, Math.min(limit * 4 + 1, 256), ...kinds) as any[];
    return rows
      .filter((r) => !(exclude && r.kind === exclude.kind && r.refId === exclude.refId))
      .slice(0, limit);
  }
  const rows = d
    .prepare(
      `SELECT e.kind, e.ref_id AS refId,
              vector_distance_cos(e.vector, vector32(?)) AS distance
       FROM embeddings e
       WHERE 1=1 ${kindFilter}
       ORDER BY distance DESC
       LIMIT ?`,
    )
    .all(vectorJson, ...kinds, limit + 1) as any[];
  return rows
    .filter((r) => !(exclude && r.kind === exclude.kind && r.refId === exclude.refId))
    .slice(0, limit);
}
