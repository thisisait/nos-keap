import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Data model interfaces
export interface UserProgress {
  courseId: number;
  progress: number;
  completedChapters: number;
}

export interface CompletedItem {
  id: string;
  completedAt: number;
}

export interface TaxonomyMetadata {
  id: string;
  data: any;
  updatedAt: number;
}

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

export interface HomepageTile {
  id: string;
  title: string;
  type: 'progress' | 'custom-todo' | 'recent-cities' | 'recent-pages';
  position: number;
  visible: boolean;
  config?: any;
}

export interface AppMetadata {
  id: string;
  version: string;
  lastUpdated: number;
  totalItems: number;
  completedItems: number;
}

export interface AppSettings {
  key: string;
  value: string;
}

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}

class DatabaseService {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor() {
    // Create data directory if it doesn't exist
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.dbPath = path.join(dataDir, 'knowledge-explorer.db');
  }

  async initialize(): Promise<void> {
    if (!this.db) {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      await this.createTables();
      this.initializeAppMetadata();
    }
  }

  async forceReinitialize(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    
    // Delete the database file
    if (fs.existsSync(this.dbPath)) {
      fs.unlinkSync(this.dbPath);
    }
    
    await this.initialize();
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const tables = [
      `CREATE TABLE IF NOT EXISTS course_progress (
        course_id INTEGER PRIMARY KEY,
        progress INTEGER DEFAULT 0,
        completed_chapters INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS completed_items (
        id TEXT PRIMARY KEY,
        completed_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS taxonomy_metadata (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS api_taxonomy_metadata (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        url TEXT,
        domain TEXT,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS homepage_tiles (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        position INTEGER NOT NULL,
        visible INTEGER DEFAULT 1,
        config TEXT,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS recent_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS app_metadata (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        last_updated INTEGER DEFAULT (strftime('%s', 'now')),
        total_items INTEGER DEFAULT 0,
        completed_items INTEGER DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`
    ];

    for (const table of tables) {
      this.db.exec(table);
    }

    // Insert sample data if course_progress is empty
    const courseCount = this.db.prepare('SELECT COUNT(*) as count FROM course_progress').get() as { count: number };
    if (courseCount.count === 0) {
      this.insertSampleData();
    }
  }

  private insertSampleData(): void {
    if (!this.db) return;

    const insert = this.db.prepare(`
      INSERT INTO course_progress (course_id, progress, completed_chapters)
      VALUES (?, ?, ?)
    `);

    const sampleData = [
      { courseId: 1, progress: 75, completedChapters: 8 },
      { courseId: 2, progress: 40, completedChapters: 4 },
      { courseId: 3, progress: 90, completedChapters: 12 },
      { courseId: 4, progress: 20, completedChapters: 2 },
      { courseId: 5, progress: 100, completedChapters: 15 }
    ];

    for (const course of sampleData) {
      insert.run(course.courseId, course.progress, course.completedChapters);
    }
  }

  // Course Progress Methods
  getAllCourses(): UserProgress[] {
    if (!this.db) return [];
    return this.db.prepare('SELECT course_id as courseId, progress, completed_chapters as completedChapters FROM course_progress').all() as UserProgress[];
  }

  updateCourseProgress(courseId: number, progress: number, completedChapters: number): void {
    if (!this.db) return;
    
    const stmt = this.db.prepare(`
      INSERT INTO course_progress (course_id, progress, completed_chapters, updated_at)
      VALUES (?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(course_id) DO UPDATE SET
        progress = excluded.progress,
        completed_chapters = excluded.completed_chapters,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(courseId, progress, completedChapters);
  }

  getUserStats() {
    if (!this.db) return { totalCourses: 0, completedCourses: 0, averageProgress: 0 };
    
    const stats = this.db.prepare(`
      SELECT 
        COUNT(*) as totalCourses,
        SUM(CASE WHEN progress = 100 THEN 1 ELSE 0 END) as completedCourses,
        AVG(progress) as averageProgress
      FROM course_progress
    `).get() as { totalCourses: number; completedCourses: number; averageProgress: number };
    
    return stats;
  }

  // Completed Items Methods
  addCompletedItem(id: string): void {
    if (!this.db) return;
    this.db.prepare('INSERT OR REPLACE INTO completed_items (id) VALUES (?)').run(id);
  }

  removeCompletedItem(id: string): void {
    if (!this.db) return;
    this.db.prepare('DELETE FROM completed_items WHERE id = ?').run(id);
  }

  getCompletedItems(): string[] {
    if (!this.db) return [];
    return this.db.prepare('SELECT id FROM completed_items').all().map((row: any) => row.id);
  }

  // Taxonomy Metadata Methods
  saveTaxonomyMetadata(metadata: TaxonomyMetadata): void {
    if (!this.db) return;
    
    const stmt = this.db.prepare(`
      INSERT INTO taxonomy_metadata (id, data, updated_at)
      VALUES (?, ?, strftime('%s', 'now'))
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(metadata.id, JSON.stringify(metadata.data));
  }

  getTaxonomyMetadata(id?: string): TaxonomyMetadata[] | TaxonomyMetadata | null {
    if (!this.db) return id ? null : [];
    
    if (id) {
      const row = this.db.prepare('SELECT * FROM taxonomy_metadata WHERE id = ?').get(id) as any;
      if (!row) return null;
      return {
        id: row.id,
        data: JSON.parse(row.data),
        updatedAt: row.updated_at
      };
    } else {
      const rows = this.db.prepare('SELECT * FROM taxonomy_metadata').all() as any[];
      return rows.map(row => ({
        id: row.id,
        data: JSON.parse(row.data),
        updatedAt: row.updated_at
      }));
    }
  }

  deleteTaxonomyMetadata(id: string): void {
    if (!this.db) return;
    this.db.prepare('DELETE FROM taxonomy_metadata WHERE id = ?').run(id);
  }

  // API Taxonomy Metadata Methods
  getAllMetadataApi(): ApiTaxonomyMetadata[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM api_taxonomy_metadata ORDER BY updated_at DESC').all() as any[];
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      url: row.url,
      domain: row.domain,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  getMetadataByDomainApi(domain: string): ApiTaxonomyMetadata[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM api_taxonomy_metadata WHERE domain = ? ORDER BY updated_at DESC').all(domain) as any[];
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      url: row.url,
      domain: row.domain,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  saveMetadataApi(metadata: Omit<ApiTaxonomyMetadata, 'createdAt' | 'updatedAt'>): void {
    if (!this.db) return;
    
    const stmt = this.db.prepare(`
      INSERT INTO api_taxonomy_metadata (id, title, description, url, domain, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        url = excluded.url,
        domain = excluded.domain,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(
      metadata.id,
      metadata.title,
      metadata.description,
      metadata.url,
      metadata.domain,
      metadata.metadata ? JSON.stringify(metadata.metadata) : null
    );
  }

  // Homepage Tiles Methods
  saveHomepageTiles(tiles: HomepageTile[]): void {
    if (!this.db) return;
    
    // Clear existing tiles
    this.db.prepare('DELETE FROM homepage_tiles').run();
    
    // Insert new tiles
    const stmt = this.db.prepare(`
      INSERT INTO homepage_tiles (id, title, type, position, visible, config)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    for (const tile of tiles) {
      stmt.run(
        tile.id,
        tile.title,
        tile.type,
        tile.position,
        tile.visible ? 1 : 0,
        tile.config ? JSON.stringify(tile.config) : null
      );
    }
  }

  getHomepageTiles(): HomepageTile[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM homepage_tiles ORDER BY position').all() as any[];
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      type: row.type,
      position: row.position,
      visible: Boolean(row.visible),
      config: row.config ? JSON.parse(row.config) : null
    }));
  }

  // Activity Tracking Methods
  trackActivity(itemId: string, itemType: string): void {
    if (!this.db) return;
    this.db.prepare('INSERT INTO recent_activity (item_id, item_type) VALUES (?, ?)').run(itemId, itemType);
  }

  getRecentActivity(type?: string, limit: number = 10): any[] {
    if (!this.db) return [];
    
    let query = 'SELECT * FROM recent_activity';
    const params: any[] = [];
    
    if (type) {
      query += ' WHERE item_type = ?';
      params.push(type);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    
    return this.db.prepare(query).all(...params) as any[];
  }

  // App Metadata Methods
  initializeAppMetadata(): void {
    if (!this.db) return;
    
    const existing = this.db.prepare('SELECT COUNT(*) as count FROM app_metadata').get() as { count: number };
    if (existing.count === 0) {
      this.db.prepare(`
        INSERT INTO app_metadata (id, version, total_items, completed_items)
        VALUES ('main', '1.0.0', 0, 0)
      `).run();
    }
  }

  getAppMetadata(): AppMetadata | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM app_metadata WHERE id = ?').get('main') as any;
    if (!row) return null;
    
    return {
      id: row.id,
      version: row.version,
      lastUpdated: row.last_updated,
      totalItems: row.total_items,
      completedItems: row.completed_items
    };
  }

  // Settings Methods
  saveSetting(key: string, value: string): void {
    if (!this.db) return;
    
    const stmt = this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, strftime('%s', 'now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(key, value);
  }

  getSetting(key: string): string | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any;
    return row ? row.value : null;
  }

  // Todo Methods
  saveTodo(todo: TodoItem): void {
    if (!this.db) return;
    
    const stmt = this.db.prepare(`
      INSERT INTO todos (id, title, completed, created_at, updated_at)
      VALUES (?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        completed = excluded.completed,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(todo.id, todo.title, todo.completed ? 1 : 0, todo.createdAt);
  }

  getTodos(): TodoItem[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM todos ORDER BY created_at DESC').all() as any[];
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      completed: Boolean(row.completed),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  deleteTodo(id: string): void {
    if (!this.db) return;
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const databaseService = new DatabaseService();