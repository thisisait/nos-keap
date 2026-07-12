import Database from 'libsql';

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: '001-extension-foundation',
    sql: `
      CREATE TABLE IF NOT EXISTS extension_pairings (
        id TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        device_secret_hash TEXT NOT NULL,
        client_name TEXT NOT NULL,
        requested_scopes TEXT NOT NULL,
        approved_scopes TEXT,
        user_id TEXT,
        username TEXT,
        name TEXT,
        email TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at INTEGER NOT NULL,
        approved_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS extension_pairings_expires_idx ON extension_pairings(expires_at);

      CREATE TABLE IF NOT EXISTS extension_credentials (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        name TEXT,
        email TEXT,
        client_name TEXT NOT NULL,
        scopes TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS extension_credentials_user_idx ON extension_credentials(user_id, status);

      CREATE TABLE IF NOT EXISTS extension_drafts (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS extension_drafts_owner_idx ON extension_drafts(owner_id, expires_at);

      CREATE TABLE IF NOT EXISTS object_type_definitions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        schema_json TEXT NOT NULL DEFAULT '{}',
        ui_json TEXT NOT NULL DEFAULT '{}',
        connector_key TEXT,
        target_ref TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS object_type_definitions_user_idx ON object_type_definitions(user_id, status);

      CREATE TABLE IF NOT EXISTS extension_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id TEXT,
        user_id TEXT,
        action TEXT NOT NULL,
        resource_kind TEXT,
        resource_id TEXT,
        detail TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS extension_audit_user_idx ON extension_audit_events(user_id, created_at);
    `,
  },
  {
    // Data tables (Track R2′): registry + rows + append-only history for the
    // libsql driver. Rows are one JSON blob per row — the schema lives in the
    // registry (shared/contracts/table.ts), aggregation reads via
    // json_extract. Other drivers (rustfs/postgres/grist) keep their data
    // elsewhere and only register here.
    id: '002-data-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS data_tables (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        driver TEXT NOT NULL DEFAULT 'libsql',
        schema_json TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private',
        row_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS data_tables_user_idx ON data_tables(user_id);

      CREATE TABLE IF NOT EXISTS table_rows (
        table_id TEXT NOT NULL,
        row_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now')),
        updated_by TEXT NOT NULL,
        PRIMARY KEY (table_id, row_id)
      );

      CREATE TABLE IF NOT EXISTS table_row_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id TEXT NOT NULL,
        row_id TEXT NOT NULL,
        op TEXT NOT NULL,
        data TEXT,
        actor TEXT NOT NULL,
        at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS table_row_history_idx ON table_row_history(table_id, row_id, at);
    `,
  },
  {
    // The K1/brief dup-guards read open proposals through listPromotions'
    // default LIMIT 200 — beyond 200 open rows the guard went blind and
    // re-proposals landed as duplicate rows instead of superseding. The
    // guards now read uncapped (db.openPromotions); this clears the rows
    // the blind window let in, keeping the newest proposal per node.
    id: '003-dedupe-open-desc-brief-promotions',
    sql: `
      DELETE FROM promotions WHERE status = 'proposed' AND kind IN ('desc','brief') AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY kind, json_extract(object_json, '$.nodeId')
            ORDER BY created_at DESC, id DESC
          ) AS rn
          FROM promotions WHERE status = 'proposed' AND kind IN ('desc','brief')
        ) WHERE rn = 1
      );
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((row) => row.id),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
    });
    apply();
  }
}
