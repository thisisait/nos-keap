/**
 * SQLite persistence — ported from the old src/services/database.server.ts.
 *
 * Two structural changes vs the IIAB-era schema:
 *   1. Every user-scoped table gains a `user_id` column (default 'local') so
 *      per-user progress works once Authentik header-OIDC is wired. The old
 *      schema was implicitly single-tenant.
 *   2. The DB path is `KEAP_DATA_DIR` (a mounted volume in the container),
 *      not `process.cwd()/data`, so state survives container recreation.
 *
 * On nOS you may alternatively point this at the shared infra Postgres (see
 * MIGRATION_PLAN.md § Persistence) — the query layer is deliberately small so
 * swapping the driver is a contained change. SQLite-on-a-volume is the
 * recommended default: it matches the app's single-node, offline-first spirit
 * and needs no DB provisioning task.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db: Database.Database | null = null;

const DATA_DIR = process.env.KEAP_DATA_DIR ?? path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'keap.db');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS completed_items (
     user_id TEXT NOT NULL DEFAULT 'local',
     id TEXT NOT NULL,
     completed_at INTEGER DEFAULT (strftime('%s','now')),
     PRIMARY KEY (user_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS course_progress (
     user_id TEXT NOT NULL DEFAULT 'local',
     course_id INTEGER NOT NULL,
     progress INTEGER DEFAULT 0,
     completed_chapters INTEGER DEFAULT 0,
     updated_at INTEGER DEFAULT (strftime('%s','now')),
     PRIMARY KEY (user_id, course_id)
   )`,
  `CREATE TABLE IF NOT EXISTS api_taxonomy_metadata (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL DEFAULT 'local',
     title TEXT NOT NULL,
     description TEXT,
     url TEXT,
     domain TEXT,
     source TEXT,            -- nOS content service this item came from (kiwix|nextcloud|...)
     metadata TEXT,
     created_at INTEGER DEFAULT (strftime('%s','now')),
     updated_at INTEGER DEFAULT (strftime('%s','now'))
   )`,
  `CREATE TABLE IF NOT EXISTS todos (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL DEFAULT 'local',
     title TEXT NOT NULL,
     completed INTEGER DEFAULT 0,
     created_at INTEGER DEFAULT (strftime('%s','now')),
     updated_at INTEGER DEFAULT (strftime('%s','now'))
   )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     user_id TEXT NOT NULL DEFAULT 'local',
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     updated_at INTEGER DEFAULT (strftime('%s','now')),
     PRIMARY KEY (user_id, key)
   )`,
  `CREATE TABLE IF NOT EXISTS recent_activity (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL DEFAULT 'local',
     item_id TEXT NOT NULL,
     item_type TEXT NOT NULL,
     timestamp INTEGER DEFAULT (strftime('%s','now'))
   )`,
];

export async function initDb(): Promise<void> {
  if (db) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  for (const stmt of SCHEMA) db.exec(stmt);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialised — call initDb() first');
  return db;
}

// --- Example scoped accessors (the rest port mechanically from the old file) ---

export function getTodos(userId: string) {
  return getDb()
    .prepare('SELECT id, title, completed, created_at, updated_at FROM todos WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
}

export function saveTodo(userId: string, todo: { id: string; title: string; completed?: boolean; createdAt?: number }) {
  getDb()
    .prepare(
      `INSERT INTO todos (id, user_id, title, completed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, completed=excluded.completed, updated_at=excluded.updated_at`,
    )
    .run(todo.id, userId, todo.title, todo.completed ? 1 : 0, todo.createdAt ?? Math.floor(Date.now() / 1000));
}

export function toggleCompletedItem(userId: string, itemId: string) {
  const row = getDb().prepare('SELECT 1 FROM completed_items WHERE user_id = ? AND id = ?').get(userId, itemId);
  if (row) {
    getDb().prepare('DELETE FROM completed_items WHERE user_id = ? AND id = ?').run(userId, itemId);
  } else {
    getDb().prepare('INSERT INTO completed_items (user_id, id) VALUES (?, ?)').run(userId, itemId);
  }
}

export function getCompletedItems(userId: string): string[] {
  return getDb()
    .prepare('SELECT id FROM completed_items WHERE user_id = ?')
    .all(userId)
    .map((r: any) => r.id);
}
