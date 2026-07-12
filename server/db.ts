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
     source TEXT,
     modality TEXT,
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
  // Baked star positions — pure function of the root index (ROADMAP U1,
  // spatial-memory contract; see server/layout.ts). Rebaked ONLY when
  // layout_version changes.
  `CREATE TABLE IF NOT EXISTS taxonomy_layout (
     node_id TEXT PRIMARY KEY,
     x REAL NOT NULL,
     y REAL NOT NULL,
     z REAL NOT NULL,
     layout_version TEXT NOT NULL
   )`,
  // OKF-aligned index cards (ROADMAP Track S — see server/objects.ts).
  // JSON columns (tags/frontmatter/links) stay opaque here; shape lives in
  // objects.ts. links is derived from body+resource on every write.
  `CREATE TABLE IF NOT EXISTS knowledge_objects (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL DEFAULT 'local',
     type TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT,
     resource TEXT,
     tags TEXT,
     frontmatter TEXT,
     body TEXT,
     links TEXT,
     visibility TEXT NOT NULL DEFAULT 'private',
     created_at INTEGER DEFAULT (strftime('%s','now')),
     updated_at INTEGER DEFAULT (strftime('%s','now'))
   )`,
  // Dynamic taxonomy nodes (Track T free/votable zones) — approved
  // extension proposals materialize here and merge into the static tree at
  // startup (server/taxonomy.ts registerExtNode). ordinal pins the U1
  // append placement forever (spatial-memory contract: new stars appear,
  // existing stars never move).
  `CREATE TABLE IF NOT EXISTS taxonomy_nodes_ext (
     id TEXT PRIMARY KEY,
     parent_id TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     zone TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     proposed_by TEXT NOT NULL,
     approved_by TEXT NOT NULL,
     created_at INTEGER DEFAULT (strftime('%s','now'))
   )`,

  // Curated node descriptions (Track K, K1 taxonomy-describe) — the moderated
  // OVERRIDE layer on top of the seed taxonomy's (mostly missing) descriptions.
  // Descriptions are load-bearing (DescGraph): they ARE the node's search/
  // embedding text. LLM skills propose them (promotions kind='desc'); approval
  // upserts here and the in-memory tree, FTS and the embeddings pending diff
  // pick the change up in the same step. en is canonical (embed/FTS text);
  // cs is the UI localization.
  `CREATE TABLE IF NOT EXISTS node_descriptions (
     node_id TEXT PRIMARY KEY,
     description_en TEXT NOT NULL,
     description_cs TEXT,
     proposed_by TEXT NOT NULL,
     approved_by TEXT NOT NULL,
     updated_at INTEGER DEFAULT (strftime('%s','now'))
   )`,

  // Promotion proposals (server/promotions.ts) — the moderated bridge from
  // the review queue into the curated corpus. An agent (librarian) or a user
  // PROPOSES turning a capture into a knowledge object; the MODERATOR has
  // the final word. votes is the MMO seed: local policy = one admin decision,
  // democratic policy = quorum over votes (deferred to the sharing phase,
  // same doctrine as the spatial-memory consensus note).
  `CREATE TABLE IF NOT EXISTS promotions (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'object',
     capture_id TEXT NOT NULL,
     proposed_by TEXT NOT NULL,
     rationale TEXT,
     object_json TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'proposed',
     votes TEXT NOT NULL DEFAULT '[]',
     decided_by TEXT,
     decided_at INTEGER,
     object_id TEXT,
     created_at INTEGER DEFAULT (strftime('%s','now'))
   )`,

  // Knowledge-lint findings (server/lint.ts). One row per (check, refs)
  // finding with a lifecycle: first_seen on discovery, last_seen refreshed
  // every run that still observes it, resolved_at stamped by the run that
  // no longer does. The lint job notifies only on NEW rows, so a standing
  // finding never spams the A9 channel twice.
  `CREATE TABLE IF NOT EXISTS lint_findings (
     id TEXT PRIMARY KEY,
     check_id TEXT NOT NULL,
     severity TEXT NOT NULL,
     ref_kind TEXT,
     ref_id TEXT,
     message TEXT NOT NULL,
     data TEXT,
     first_seen INTEGER DEFAULT (strftime('%s','now')),
     last_seen INTEGER DEFAULT (strftime('%s','now')),
     resolved_at INTEGER
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
  // Additive column sweep for pre-intake DBs (Wing /events ALTER precedent):
  // source/modality landed with the unified intake — ALTER is idempotent via
  // the duplicate-column catch.
  for (const col of ['source TEXT', 'modality TEXT']) {
    try {
      db.exec(`ALTER TABLE api_taxonomy_metadata ADD COLUMN ${col}`);
    } catch {
      /* duplicate column — already migrated */
    }
  }
  try {
    db.exec("ALTER TABLE promotions ADD COLUMN kind TEXT NOT NULL DEFAULT 'object'");
  } catch {
    /* duplicate column — already migrated */
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
  /** Intake attribution: which ENTRY POINT class produced this capture. */
  source?: string;
  /** Intake modality: url | text | geo | media | audio-transcript. */
  modality?: string;
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
    source: row.source ?? undefined,
    modality: row.modality ?? undefined,
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
  metadata: Omit<ApiTaxonomyMetadata, 'createdAt' | 'updatedAt' | 'source' | 'modality'>,
  intake?: { source: string; modality: string },
): void {
  getDb()
    .prepare(
      `INSERT INTO api_taxonomy_metadata (id, user_id, title, description, url, domain, metadata, source, modality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         url = excluded.url,
         domain = excluded.domain,
         metadata = excluded.metadata,
         source = COALESCE(excluded.source, api_taxonomy_metadata.source),
         modality = COALESCE(excluded.modality, api_taxonomy_metadata.modality),
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
      intake?.source ?? null,
      intake?.modality ?? null,
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

// ── Knowledge objects (per-user OKF index cards; admins see all) ─────────────

export interface KnowledgeObject {
  id: string;
  userId?: string;
  type: string;
  title: string;
  description?: string;
  resource?: string;
  tags?: string[];
  frontmatter?: any;
  body?: string;
  links?: any[];
  visibility?: string;
  createdAt: number;
  updatedAt: number;
}

function mapObjectRow(row: any): KnowledgeObject {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    description: row.description ?? undefined,
    resource: row.resource ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    frontmatter: row.frontmatter ? JSON.parse(row.frontmatter) : undefined,
    body: row.body ?? undefined,
    links: row.links ? JSON.parse(row.links) : undefined,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getObjects(userId: string, seeAll: boolean, type?: string): KnowledgeObject[] {
  const d = getDb();
  const where = [seeAll ? null : 'user_id = ?', type ? 'type = ?' : null].filter(Boolean);
  const params = [...(seeAll ? [] : [userId]), ...(type ? [type] : [])];
  const sql = `SELECT * FROM knowledge_objects ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
  return (d.prepare(sql).all(...params) as any[]).map(mapObjectRow);
}

export function getObject(id: string): KnowledgeObject | null {
  const row = getDb().prepare('SELECT * FROM knowledge_objects WHERE id = ?').get(id) as any;
  return row ? mapObjectRow(row) : null;
}

export function saveObject(
  userId: string,
  o: Omit<KnowledgeObject, 'userId' | 'createdAt' | 'updatedAt'>,
): void {
  getDb()
    .prepare(
      `INSERT INTO knowledge_objects (id, user_id, type, title, description, resource, tags, frontmatter, body, links, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         title = excluded.title,
         description = excluded.description,
         resource = excluded.resource,
         tags = excluded.tags,
         frontmatter = excluded.frontmatter,
         body = excluded.body,
         links = excluded.links,
         visibility = excluded.visibility,
         updated_at = excluded.updated_at`,
    )
    .run(
      o.id,
      userId,
      o.type,
      o.title,
      o.description ?? null,
      o.resource ?? null,
      o.tags ? JSON.stringify(o.tags) : null,
      o.frontmatter ? JSON.stringify(o.frontmatter) : null,
      o.body ?? null,
      o.links ? JSON.stringify(o.links) : null,
      o.visibility ?? 'private',
    );
}

export function deleteObject(id: string): void {
  getDb().prepare('DELETE FROM knowledge_objects WHERE id = ?').run(id);
}

/** Distinct types in use — the "recent types" suggestions in the object form. */
export function objectTypes(): string[] {
  return (getDb().prepare('SELECT DISTINCT type FROM knowledge_objects ORDER BY type').all() as any[]).map(
    (r) => r.type,
  );
}

// ── Baked layout (U1 — deterministic star positions) ─────────────────────────

export function getLayoutVersion(): string | null {
  const row = getDb().prepare('SELECT layout_version FROM taxonomy_layout LIMIT 1').get() as any;
  return row?.layout_version ?? null;
}

export function getLayout(): Map<string, { x: number; y: number; z: number }> {
  const rows = getDb().prepare('SELECT node_id, x, y, z FROM taxonomy_layout').all() as any[];
  return new Map(rows.map((r) => [r.node_id, { x: r.x, y: r.y, z: r.z }]));
}

export function saveLayout(
  points: Array<{ nodeId: string; x: number; y: number; z: number }>,
  version: string,
): void {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM taxonomy_layout').run();
    const ins = d.prepare(
      'INSERT INTO taxonomy_layout (node_id, x, y, z, layout_version) VALUES (?, ?, ?, ?, ?)',
    );
    for (const p of points) ins.run(p.nodeId, p.x, p.y, p.z, version);
  });
  tx();
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
  const match = ftsQuery(query);
  if (!match) return [];
  try {
    return getDb()
      .prepare('SELECT id, rank FROM taxonomy_fts WHERE taxonomy_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(match, limit) as FtsHit[];
  } catch {
    return [];
  }
}

/** Quote each token so user input can't inject FTS5 syntax (NEAR, *, etc.). */
function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .join(' ');
}

// ── Corpus full-text index (S4 — lexical leg of RRF hybrid search) ───────────
// One FTS5 table over EVERY searchable item (taxonomy nodes, captures,
// curated notes, knowledge objects). Rebuilt from the same canonical texts
// the embedding pipeline uses, so the lexical and vector legs of the hybrid
// search always describe the same corpus.

export function rebuildCorpusFts(
  rows: Array<{ kind: EmbeddingKind; refId: string; text: string }>,
): void {
  const d = getDb();
  d.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(kind UNINDEXED, ref_id UNINDEXED, text)`,
  );
  const rebuild = d.transaction(() => {
    d.prepare('DELETE FROM corpus_fts').run();
    const insert = d.prepare('INSERT INTO corpus_fts (kind, ref_id, text) VALUES (?, ?, ?)');
    for (const r of rows) insert.run(r.kind, r.refId, r.text);
  });
  rebuild();
}

export interface CorpusFtsHit {
  kind: EmbeddingKind;
  refId: string;
  rank: number;
}

export function searchCorpusFts(query: string, kinds: EmbeddingKind[], limit: number): CorpusFtsHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const kindFilter = kinds.length ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
  try {
    return getDb()
      .prepare(
        `SELECT kind, ref_id AS refId, rank FROM corpus_fts
         WHERE corpus_fts MATCH ? ${kindFilter} ORDER BY rank LIMIT ?`,
      )
      .all(match, ...kinds, limit) as CorpusFtsHit[];
  } catch {
    return [];
  }
}

// ── Corpus stats (agent health endpoint) ─────────────────────────────────────

export function corpusStats(): { captures: number; curatedNotes: number; objects: number } {
  const d = getDb();
  const captures = (d.prepare('SELECT COUNT(*) AS c FROM api_taxonomy_metadata').get() as any).c;
  const curatedNotes = (d.prepare('SELECT COUNT(*) AS c FROM taxonomy_metadata').get() as any).c;
  const objects = (d.prepare('SELECT COUNT(*) AS c FROM knowledge_objects').get() as any).c;
  return { captures, curatedNotes, objects };
}

// ── Embeddings (libSQL vector layer) ──────────────────────────────────────────
// Vectors are written by the host-side sync job (nOS Pulse: Ollama on the host
// loopback → POST /agent/v1/embeddings) — the container never needs to reach
// an embedder for node-anchored distance queries.

export type EmbeddingKind = 'taxonomy' | 'capture' | 'note' | 'object';

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

// ── Lint findings (server/lint.ts) ────────────────────────────────────────────

export interface LintFindingRow {
  id: string;
  checkId: string;
  severity: string;
  refKind?: string;
  refId?: string;
  message: string;
  data?: any;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
}

function mapLintRow(row: any): LintFindingRow {
  return {
    id: row.id,
    checkId: row.check_id,
    severity: row.severity,
    refKind: row.ref_kind ?? undefined,
    refId: row.ref_id ?? undefined,
    message: row.message,
    data: row.data ? JSON.parse(row.data) : undefined,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    resolvedAt: row.resolved_at ?? null,
  };
}

/**
 * Reconcile a full lint run against the stored findings:
 *   - unknown id            -> insert (NEW finding)
 *   - known, open           -> refresh last_seen
 *   - known, was resolved   -> reopen (resolved_at = NULL, new first_seen)
 *   - open but not in run   -> stamp resolved_at
 * Returns the ids that are new/reopened this run and those just resolved.
 */
export function syncLintFindings(
  findings: Array<{
    id: string;
    checkId: string;
    severity: string;
    refKind?: string;
    refId?: string;
    message: string;
    data?: any;
  }>,
): { newIds: string[]; resolvedIds: string[] } {
  const d = getDb();
  const newIds: string[] = [];
  const resolvedIds: string[] = [];
  const tx = d.transaction(() => {
    const openRows = d
      .prepare('SELECT id FROM lint_findings WHERE resolved_at IS NULL')
      .all() as any[];
    const open = new Set(openRows.map((r) => r.id));
    const seen = new Set<string>();
    const insert = d.prepare(
      `INSERT INTO lint_findings (id, check_id, severity, ref_kind, ref_id, message, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         severity = excluded.severity,
         message = excluded.message,
         data = excluded.data,
         last_seen = strftime('%s','now'),
         first_seen = CASE WHEN lint_findings.resolved_at IS NOT NULL
                           THEN strftime('%s','now') ELSE lint_findings.first_seen END,
         resolved_at = NULL`,
    );
    const wasKnown = d.prepare('SELECT resolved_at, severity, data FROM lint_findings WHERE id = ?');
    for (const f of findings) {
      if (seen.has(f.id)) continue; // a check may emit the same pair twice
      const prior = wasKnown.get(f.id) as any;
      const priorData = prior?.data ? JSON.parse(prior.data) : null;
      const verdict = priorData?.verdict?.verdict;
      // A standing librarian/human verdict outlives the re-detection:
      //   fine          -> stays resolved (skip entirely, no reopen)
      //   dup/contradic -> stays open at the ESCALATED severity, verdict kept
      if (verdict === 'fine') continue;
      seen.add(f.id);
      let severity = f.severity;
      let data = f.data;
      if (verdict === 'duplicate' || verdict === 'contradiction') {
        severity = prior.severity; // escalation from applyLintVerdict wins
        data = { ...(f.data ?? {}), verdict: priorData.verdict };
      }
      if (!prior || prior.resolved_at !== null) newIds.push(f.id);
      insert.run(
        f.id, f.checkId, severity, f.refKind ?? null, f.refId ?? null,
        f.message, data === undefined ? null : JSON.stringify(data),
      );
    }
    const resolve = d.prepare(
      "UPDATE lint_findings SET resolved_at = strftime('%s','now') WHERE id = ?",
    );
    for (const id of open) {
      if (!seen.has(id)) {
        resolve.run(id);
        resolvedIds.push(id);
      }
    }
  });
  tx();
  return { newIds, resolvedIds };
}

export function getLintFindings(includeResolved = false, limit = 500): LintFindingRow[] {
  const d = getDb();
  // Semantic severity ranking — a bare ORDER BY severity is alphabetical
  // (critical, high, info, low, medium) and buries low under info.
  const rank =
    "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  const rows = includeResolved
    ? d.prepare(`SELECT * FROM lint_findings ORDER BY resolved_at IS NULL DESC, ${rank}, last_seen DESC LIMIT ?`).all(limit)
    : d.prepare(`SELECT * FROM lint_findings WHERE resolved_at IS NULL ORDER BY ${rank}, last_seen DESC LIMIT ?`).all(limit);
  return (rows as any[]).map(mapLintRow);
}

/**
 * Pairwise near-neighbour scan for the lint duplicate checks. O(n²) in SQL,
 * which is fine for the non-taxonomy corpus (tens–hundreds of rows) and
 * acceptable for the 790-node taxonomy sweep inside a nightly job. rowid
 * ordering dedupes the symmetric pair.
 */
export function nearPairs(
  kinds: EmbeddingKind[],
  maxDistance: number,
  limit: number,
): Array<{ aKind: string; aRefId: string; bKind: string; bRefId: string; distance: number }> {
  if (!vectorsOk || kinds.length === 0) return [];
  const kindList = kinds.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT a.kind AS aKind, a.ref_id AS aRefId,
              b.kind AS bKind, b.ref_id AS bRefId,
              vector_distance_cos(a.vector, b.vector) AS distance
       FROM embeddings a
       JOIN embeddings b ON a.rowid < b.rowid
       WHERE a.kind IN (${kindList}) AND b.kind IN (${kindList})
         AND vector_distance_cos(a.vector, b.vector) < ?
       ORDER BY distance ASC
       LIMIT ?`,
    )
    .all(...kinds, ...kinds, maxDistance, limit) as any[];
}

export function countRows(table: 'taxonomy_fts' | 'taxonomy_layout'): number {
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;
  } catch {
    return -1;
  }
}

/**
 * Librarian verdict on a lint finding (the Layer-2 judgment loop):
 *   fine          -> finding resolves (judged a false positive / acceptable)
 *   duplicate     -> stays open, escalated to medium (human should merge)
 *   contradiction -> stays open, escalated to high (knowledge conflict!)
 * The verdict is preserved in data.verdict even after resolution, so a
 * re-appearing pair carries its judgment history.
 */
export function applyLintVerdict(
  findingId: string,
  verdict: 'fine' | 'duplicate' | 'contradiction',
  note: string | undefined,
  by: string,
): LintFindingRow | null {
  const d = getDb();
  const row = d.prepare('SELECT * FROM lint_findings WHERE id = ?').get(findingId) as any;
  if (!row) return null;
  const data = row.data ? JSON.parse(row.data) : {};
  data.verdict = { verdict, note: note ?? null, by, at: Math.floor(Date.now() / 1000) };
  if (verdict === 'fine') {
    d.prepare(
      "UPDATE lint_findings SET data = ?, resolved_at = strftime('%s','now') WHERE id = ?",
    ).run(JSON.stringify(data), findingId);
  } else {
    const severity = verdict === 'contradiction' ? 'high' : 'medium';
    d.prepare('UPDATE lint_findings SET data = ?, severity = ? WHERE id = ?').run(
      JSON.stringify(data), severity, findingId,
    );
  }
  return mapLintRow(d.prepare('SELECT * FROM lint_findings WHERE id = ?').get(findingId));
}

// ── Promotion proposals (server/promotions.ts) ────────────────────────────────

export interface PromotionRow {
  id: string;
  kind: 'object' | 'node' | 'desc' | 'brief';
  captureId: string;
  proposedBy: string;
  rationale?: string;
  object: any;
  status: 'proposed' | 'approved' | 'rejected';
  votes: Array<{ by: string; value: 1 | -1; at: number }>;
  decidedBy?: string;
  decidedAt?: number;
  objectId?: string;
  createdAt: number;
}

function mapPromotionRow(row: any): PromotionRow {
  return {
    id: row.id,
    kind: row.kind ?? 'object',
    captureId: row.capture_id,
    proposedBy: row.proposed_by,
    rationale: row.rationale ?? undefined,
    object: JSON.parse(row.object_json),
    status: row.status,
    votes: JSON.parse(row.votes || '[]'),
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    objectId: row.object_id ?? undefined,
    createdAt: row.created_at,
  };
}

export function upsertPromotion(p: {
  id: string;
  captureId: string;
  proposedBy: string;
  rationale?: string;
  object: any;
  kind?: 'object' | 'node' | 'desc' | 'brief';
}): void {
  getDb()
    .prepare(
      `INSERT INTO promotions (id, kind, capture_id, proposed_by, rationale, object_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rationale = excluded.rationale,
         object_json = excluded.object_json,
         proposed_by = excluded.proposed_by`,
    )
    .run(p.id, p.kind ?? 'object', p.captureId, p.proposedBy, p.rationale ?? null, JSON.stringify(p.object));
}

export function getPromotion(id: string): PromotionRow | null {
  const row = getDb().prepare('SELECT * FROM promotions WHERE id = ?').get(id) as any;
  return row ? mapPromotionRow(row) : null;
}

export function listPromotions(status?: string, limit = 200): PromotionRow[] {
  const d = getDb();
  const rows = status
    ? d.prepare('SELECT * FROM promotions WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : d.prepare('SELECT * FROM promotions ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as any[]).map(mapPromotionRow);
}

export function setPromotionVotes(id: string, votes: unknown[]): void {
  getDb().prepare('UPDATE promotions SET votes = ? WHERE id = ?').run(JSON.stringify(votes), id);
}

export function setPromotionDecision(
  id: string,
  status: 'approved' | 'rejected',
  decidedBy: string,
  objectId: string | null,
): void {
  getDb()
    .prepare(
      "UPDATE promotions SET status = ?, decided_by = ?, decided_at = strftime('%s','now'), object_id = ? WHERE id = ?",
    )
    .run(status, decidedBy, objectId, id);
}

/** Provenance back-link on the source capture: metadata.promotedTo. */
export function markCapturePromoted(captureId: string, objectId: string): void {
  const d = getDb();
  const row = d.prepare('SELECT metadata FROM api_taxonomy_metadata WHERE id = ?').get(captureId) as any;
  if (!row) return;
  const meta = row.metadata ? JSON.parse(row.metadata) : {};
  meta.promotedTo = objectId;
  d.prepare("UPDATE api_taxonomy_metadata SET metadata = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(JSON.stringify(meta), captureId);
}

// ── Dynamic taxonomy nodes (Track T) ──────────────────────────────────────────

export interface ExtNodeRow {
  id: string;
  parentId: string;
  name: string;
  description: string;
  zone: string;
  ordinal: number;
  proposedBy: string;
  approvedBy: string;
  createdAt: number;
}

export function listExtNodes(): ExtNodeRow[] {
  return (getDb().prepare('SELECT * FROM taxonomy_nodes_ext ORDER BY created_at, ordinal').all() as any[]).map(
    (r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      description: r.description,
      zone: r.zone,
      ordinal: r.ordinal,
      proposedBy: r.proposed_by,
      approvedBy: r.approved_by,
      createdAt: r.created_at,
    }),
  );
}

export function insertExtNode(n: Omit<ExtNodeRow, 'createdAt'>): void {
  getDb()
    .prepare(
      `INSERT INTO taxonomy_nodes_ext (id, parent_id, name, description, zone, ordinal, proposed_by, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(n.id, n.parentId, n.name, n.description, n.zone, n.ordinal, n.proposedBy, n.approvedBy);
}

// ── Curated node descriptions (Track K, K1) ───────────────────────────────────

export interface NodeDescriptionRow {
  nodeId: string;
  descriptionEn: string;
  descriptionCs?: string;
  proposedBy: string;
  approvedBy: string;
  updatedAt: number;
}

export function listNodeDescriptions(): NodeDescriptionRow[] {
  return (getDb().prepare('SELECT * FROM node_descriptions').all() as any[]).map((r) => ({
    nodeId: r.node_id,
    descriptionEn: r.description_en,
    descriptionCs: r.description_cs ?? undefined,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by,
    updatedAt: r.updated_at,
  }));
}

export function upsertNodeDescription(row: Omit<NodeDescriptionRow, 'updatedAt'>): void {
  getDb()
    .prepare(
      `INSERT INTO node_descriptions (node_id, description_en, description_cs, proposed_by, approved_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         description_en = excluded.description_en,
         description_cs = excluded.description_cs,
         proposed_by = excluded.proposed_by,
         approved_by = excluded.approved_by,
         updated_at = strftime('%s','now')`,
    )
    .run(row.nodeId, row.descriptionEn, row.descriptionCs ?? null, row.proposedBy, row.approvedBy);
}

/** How many ext children a parent already has — the next append ordinal. */
export function extChildCount(parentId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM taxonomy_nodes_ext WHERE parent_id = ?').get(parentId) as any).c;
}

/** Append one star to the baked layout under the CURRENT version (U1 append). */
export function appendLayoutPoint(nodeId: string, x: number, y: number, z: number): void {
  const version = getLayoutVersion() ?? 'v1:unbaked';
  getDb()
    .prepare(
      `INSERT INTO taxonomy_layout (node_id, x, y, z, layout_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z`,
    )
    .run(nodeId, x, y, z, version);
}
