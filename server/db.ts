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
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db: Database.Database | null = null;

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

export async function initDb(): Promise<void> {
  if (db) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  for (const stmt of SCHEMA) db.exec(stmt);
  initializeAppMetadata();
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialised — call initDb() first');
  return db;
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
