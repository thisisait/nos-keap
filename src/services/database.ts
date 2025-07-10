import initSqlJs from 'sql.js';

export interface UserProgress {
  id: string;
  taxonomyId: string;
  progress: number;
  completedItems: string;
  totalXP: number;
  level: number;
  lastSync: string;
}

export interface CompletedItem {
  id: string;
  itemId: string;
  completedAt: string;
}

export interface TaxonomyMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  links: string;
  translations: string;
}

export interface ApiTaxonomyMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  taxonomyId?: string;
  links: any;
  translations: any;
  createdAt?: string;
  updatedAt?: string;
}

export interface HomepageTile {
  id: string;
  type: string;
  title: string;
  enabled: boolean;
  position: number;
  config: string;
}

export interface AppMetadata {
  id: string;
  version: string;
  lastUpdate: string;
  migrations: string;
}

export interface AppSettings {
  id: string;
  key: string;
  value: string;
}

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
}

class DatabaseService {
  private db: any = null;
  private SQL: any = null;

  async forceReinitialize() {
    // Clear existing database
    localStorage.removeItem('iiab-database');
    this.db = null;
    await this.initialize();
  }

  async initialize() {
    if (!this.SQL) {
      // Use local WASM file from node_modules
      this.SQL = await initSqlJs({
        locateFile: (file: string) => `/node_modules/sql.js/dist/${file}`
      });
    }

    // Try to load existing database from localStorage
    const savedDb = localStorage.getItem('iiab-database');
    if (savedDb) {
      const data = new Uint8Array(JSON.parse(savedDb));
      this.db = new this.SQL.Database(data);
    } else {
      this.db = new this.SQL.Database();
      await this.createTables();
    }

    // Ensure all required tables exist
    await this.ensureTablesExist();
  }

  private async createTables() {
    // User progress table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_progress (
        id TEXT PRIMARY KEY,
        taxonomy_id TEXT,
        progress INTEGER DEFAULT 0,
        completed_items TEXT DEFAULT '[]',
        total_xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        last_sync TEXT
      );
    `);

    // Completed items table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS completed_items (
        id TEXT PRIMARY KEY,
        item_id TEXT,
        completed_at TEXT
      );
    `);

    // Course progress table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS course_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER,
        title TEXT,
        category TEXT,
        progress INTEGER DEFAULT 0,
        completed BOOLEAN DEFAULT FALSE,
        duration TEXT,
        points INTEGER,
        chapters INTEGER,
        completed_chapters INTEGER DEFAULT 0
      );
    `);

    // Taxonomy metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS taxonomy_metadata (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        icon TEXT,
        taxonomy_id TEXT,
        links TEXT DEFAULT '{}',
        translations TEXT DEFAULT '{}'
      );
    `);

    // Homepage tiles configuration
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS homepage_tiles (
        id TEXT PRIMARY KEY,
        type TEXT,
        title TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        position INTEGER,
        config TEXT DEFAULT '{}'
      );
    `);

    // Recent activity tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recent_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT,
        item_type TEXT,
        visited_at TEXT
      );
    `);

    // App metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_metadata (
        id TEXT PRIMARY KEY,
        version TEXT,
        last_update TEXT,
        migrations TEXT DEFAULT '[]'
      );
    `);

    // App settings table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE,
        value TEXT
      );
    `);

    // Todo items table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        text TEXT,
        completed BOOLEAN DEFAULT FALSE,
        created_at TEXT
      );
    `);

    // Insert sample data
    this.insertSampleData();
    this.initializeAppMetadata();
    this.save();
  }

  private async ensureTablesExist() {
    const tables = [
      'user_progress',
      'completed_items', 
      'course_progress',
      'taxonomy_metadata',
      'homepage_tiles',
      'recent_activity',
      'app_metadata',
      'app_settings',
      'todos'
    ];

    for (const table of tables) {
      try {
        // Try to query the table
        this.db.exec(`SELECT 1 FROM ${table} LIMIT 1`);
      } catch (error) {
        // Table doesn't exist, recreate all tables
        console.log(`Table ${table} missing, recreating database...`);
        await this.createTables();
        break;
      }
    }
  }

  private insertSampleData() {
    const courses = [
      {
        id: 1,
        title: "Základy informatiky",
        category: "Technologie",
        progress: 85,
        completed: false,
        duration: "4.5 hodin",
        points: 50,
        chapters: 12,
        completed_chapters: 10
      },
      {
        id: 2,
        title: "Matematika pro všechny",
        category: "Matematika",
        progress: 100,
        completed: true,
        duration: "6 hodin",
        points: 75,
        chapters: 15,
        completed_chapters: 15
      },
      {
        id: 3,
        title: "Historie světa",
        category: "Historie",
        progress: 34,
        completed: false,
        duration: "8 hodin",
        points: 100,
        chapters: 20,
        completed_chapters: 7
      },
      {
        id: 4,
        title: "Přírodní vědy",
        category: "Věda",
        progress: 67,
        completed: false,
        duration: "5.5 hodin",
        points: 80,
        chapters: 14,
        completed_chapters: 9
      }
    ];

    courses.forEach(course => {
      this.db.exec(`
        INSERT OR REPLACE INTO course_progress 
        (course_id, title, category, progress, completed, duration, points, chapters, completed_chapters)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        course.id,
        course.title,
        course.category,
        course.progress,
        course.completed,
        course.duration,
        course.points,
        course.chapters,
        course.completed_chapters
      ]);
    });
  }

  save() {
    if (this.db) {
      const data = this.db.export();
      const buffer = JSON.stringify(Array.from(data));
      localStorage.setItem('iiab-database', buffer);
    }
  }

  getAllCourses() {
    if (!this.db) return [];
    
    const stmt = this.db.prepare('SELECT * FROM course_progress ORDER BY course_id');
    const courses = [];
    
    while (stmt.step()) {
      const row = stmt.getAsObject();
      courses.push({
        id: row.course_id,
        title: row.title,
        category: row.category,
        progress: row.progress,
        completed: Boolean(row.completed),
        duration: row.duration,
        points: row.points,
        chapters: row.chapters,
        completedChapters: row.completed_chapters
      });
    }
    
    stmt.free();
    return courses;
  }

  updateCourseProgress(courseId: number, progress: number, completedChapters: number) {
    if (!this.db) return;
    
    const completed = progress >= 100;
    this.db.exec(`
      UPDATE course_progress 
      SET progress = ?, completed_chapters = ?, completed = ?
      WHERE course_id = ?
    `, [progress, completedChapters, completed, courseId]);
    
    this.save();
  }

  getUserStats() {
    if (!this.db) return {
      totalProgress: 0,
      completedCourses: 0,
      totalCourses: 0,
      totalPoints: 0,
      totalHours: 0
    };

    const stmt = this.db.prepare(`
      SELECT 
        AVG(progress) as avg_progress,
        COUNT(*) as total_courses,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed_courses,
        SUM(points) as total_points
      FROM course_progress
    `);
    
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();

    return {
      totalProgress: Math.round(row.avg_progress || 0),
      completedCourses: row.completed_courses || 0,
      totalCourses: row.total_courses || 0,
      totalPoints: row.total_points || 0,
      totalHours: 47 // Static for now
    };
  }

  addCompletedItem(itemId: string) {
    if (!this.db) return;
    
    const id = `${itemId}_${Date.now()}`;
    this.db.exec(`
      INSERT OR REPLACE INTO completed_items (id, item_id, completed_at)
      VALUES (?, ?, ?)
    `, [id, itemId, new Date().toISOString()]);
    
    this.save();
  }

  removeCompletedItem(itemId: string) {
    if (!this.db) return;
    
    this.db.exec(`DELETE FROM completed_items WHERE item_id = ?`, [itemId]);
    this.save();
  }

  getCompletedItems(): string[] {
    if (!this.db) return [];
    
    const stmt = this.db.prepare('SELECT item_id FROM completed_items');
    const items = [];
    
    while (stmt.step()) {
      const row = stmt.getAsObject();
      items.push(row.item_id);
    }
    
    stmt.free();
    return items;
  }

  // Taxonomy metadata methods
  saveTaxonomyMetadata(metadata: TaxonomyMetadata) {
    if (!this.db) return;
    
    this.db.exec(`
      INSERT OR REPLACE INTO taxonomy_metadata 
      (id, name, description, icon, taxonomy_id, links, translations)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      metadata.id,
      metadata.name,
      metadata.description || '',
      metadata.icon || '',
      (metadata as any).taxonomy_id || null,
      metadata.links || '{}',
      metadata.translations || '{}'
    ]);
    
    this.save();
  }

  getTaxonomyMetadata(id?: string): TaxonomyMetadata | TaxonomyMetadata[] {
    if (!this.db) return id ? {} as TaxonomyMetadata : [];
    
    if (id) {
      const stmt = this.db.prepare('SELECT * FROM taxonomy_metadata WHERE id = ?');
      stmt.bind([id]);
      
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          icon: row.icon,
          links: row.links,
          translations: row.translations
        };
      }
      stmt.free();
      return {} as TaxonomyMetadata;
    } else {
      const stmt = this.db.prepare('SELECT * FROM taxonomy_metadata ORDER BY id');
      const items = [];
      
      while (stmt.step()) {
        const row = stmt.getAsObject();
        items.push({
          id: row.id,
          name: row.name,
          description: row.description,
          icon: row.icon,
          links: row.links,
          translations: row.translations
        });
      }
      
      stmt.free();
      return items;
    }
  }

  deleteTaxonomyMetadata(id: string) {
    if (!this.db) return;
    
    this.db.exec('DELETE FROM taxonomy_metadata WHERE id = ?', [id]);
    this.save();
  }

  // API-compatible methods
  getAllMetadataApi(): ApiTaxonomyMetadata[] {
    const metadata = this.getTaxonomyMetadata() as any[];
    return metadata.map(item => ({
      ...item,
      taxonomyId: item.taxonomy_id,
      links: typeof item.links === 'string' ? JSON.parse(item.links || '{}') : item.links,
      translations: typeof item.translations === 'string' ? JSON.parse(item.translations || '{}') : item.translations,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  getMetadataByDomainApi(domain: string): ApiTaxonomyMetadata[] {
    const allMetadata = this.getAllMetadataApi();
    return allMetadata.filter(item => {
      const links = item.links || {};
      return links.domain === domain || (links.url && new URL(links.url).hostname === domain);
    });
  }

  saveMetadataApi(metadata: Omit<ApiTaxonomyMetadata, 'id' | 'createdAt' | 'updatedAt'>): ApiTaxonomyMetadata {
    const id = `api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newMetadata = {
      id,
      name: metadata.name,
      description: metadata.description,
      icon: metadata.icon,
      taxonomy_id: (metadata as any).taxonomyId || null,
      links: JSON.stringify(metadata.links || {}),
      translations: JSON.stringify(metadata.translations || {})
    };
    
    this.saveTaxonomyMetadata(newMetadata);
    
    return {
      ...newMetadata,
      taxonomyId: (metadata as any).taxonomyId,
      links: metadata.links || {},
      translations: metadata.translations || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  // Homepage tiles methods
  saveHomepageTiles(tiles: HomepageTile[]) {
    if (!this.db) return;
    
    // Clear existing tiles
    this.db.exec('DELETE FROM homepage_tiles');
    
    // Insert new tiles
    tiles.forEach(tile => {
      this.db.exec(`
        INSERT INTO homepage_tiles (id, type, title, enabled, position, config)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        tile.id,
        tile.type,
        tile.title,
        tile.enabled,
        tile.position,
        tile.config
      ]);
    });
    
    this.save();
  }

  getHomepageTiles(): HomepageTile[] {
    if (!this.db) return [];
    
    const stmt = this.db.prepare('SELECT * FROM homepage_tiles ORDER BY position');
    const tiles = [];
    
    while (stmt.step()) {
      const row = stmt.getAsObject();
      tiles.push({
        id: row.id,
        type: row.type,
        title: row.title,
        enabled: Boolean(row.enabled),
        position: row.position,
        config: row.config
      });
    }
    
    stmt.free();
    return tiles;
  }

  // Activity tracking
  trackActivity(itemId: string, itemType: string) {
    if (!this.db) return;
    
    this.db.exec(`
      INSERT INTO recent_activity (item_id, item_type, visited_at)
      VALUES (?, ?, ?)
    `, [itemId, itemType, new Date().toISOString()]);
    
    // Keep only last 50 activities
    this.db.exec(`
      DELETE FROM recent_activity 
      WHERE id NOT IN (
        SELECT id FROM recent_activity 
        ORDER BY visited_at DESC 
        LIMIT 50
      )
    `);
    
    this.save();
  }

  getRecentActivity(type?: string, limit: number = 10): any[] {
    if (!this.db) return [];
    
    let query = 'SELECT * FROM recent_activity';
    const params = [];
    
    if (type) {
      query += ' WHERE item_type = ?';
      params.push(type);
    }
    
    query += ' ORDER BY visited_at DESC LIMIT ?';
    params.push(limit);
    
    const stmt = this.db.prepare(query);
    stmt.bind(params);
    
    const activities = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      activities.push({
        id: row.id,
        itemId: row.item_id,
        itemType: row.item_type,
        visitedAt: row.visited_at
      });
    }
    
    stmt.free();
    return activities;
  }

  // App metadata methods
  initializeAppMetadata() {
    if (!this.db) return;
    
    this.db.exec(`
      INSERT OR REPLACE INTO app_metadata (id, version, last_update, migrations)
      VALUES (?, ?, ?, ?)
    `, ['main', '1.0.0', new Date().toISOString(), JSON.stringify([])]);
    
    this.save();
  }

  getAppMetadata(): AppMetadata | null {
    if (!this.db) return null;
    
    const stmt = this.db.prepare('SELECT * FROM app_metadata WHERE id = ?');
    stmt.bind(['main']);
    
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return {
        id: row.id,
        version: row.version,
        lastUpdate: row.last_update,
        migrations: row.migrations
      };
    }
    stmt.free();
    return null;
  }

  // App settings methods
  saveSetting(key: string, value: string) {
    if (!this.db) return;
    
    this.db.exec(`
      INSERT OR REPLACE INTO app_settings (id, key, value)
      VALUES (?, ?, ?)
    `, [`setting_${key}`, key, value]);
    
    this.save();
  }

  getSetting(key: string): string | null {
    if (!this.db) return null;
    
    const stmt = this.db.prepare('SELECT value FROM app_settings WHERE key = ?');
    stmt.bind([key]);
    
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row.value;
    }
    stmt.free();
    return null;
  }

  // Todo methods
  saveTodo(todo: TodoItem) {
    if (!this.db) return;
    
    this.db.exec(`
      INSERT OR REPLACE INTO todos (id, text, completed, created_at)
      VALUES (?, ?, ?, ?)
    `, [todo.id, todo.text, todo.completed, todo.createdAt]);
    
    this.save();
  }

  getTodos(): TodoItem[] {
    if (!this.db) return [];
    
    const stmt = this.db.prepare('SELECT * FROM todos ORDER BY created_at DESC');
    const todos = [];
    
    while (stmt.step()) {
      const row = stmt.getAsObject();
      todos.push({
        id: row.id,
        text: row.text,
        completed: Boolean(row.completed),
        createdAt: row.created_at
      });
    }
    
    stmt.free();
    return todos;
  }

  deleteTodo(id: string) {
    if (!this.db) return;
    
    this.db.exec('DELETE FROM todos WHERE id = ?', [id]);
    this.save();
  }
}

export const databaseService = new DatabaseService();