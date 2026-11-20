import type { SqliteDatabase } from "./driver.ts";
import { withWriteTx } from "./tx.ts";

export interface SchemaMigration {
  readonly id: string;
  readonly up: (db: SqliteDatabase) => void;
}

const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
`;

/** Returns the ordered list of migration IDs already recorded in `schema_migrations`. */
export function appliedMigrations(db: SqliteDatabase): string[] {
  db.exec(MIGRATIONS_TABLE_SQL);
  const rows = db.prepare("SELECT id FROM schema_migrations ORDER BY applied_at ASC, rowid ASC;").all() as readonly {
    id?: unknown;
  }[];
  return rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
}

/**
 * Applies any pending migrations atomically inside individual write
 * transactions, recording each completed ID in `schema_migrations`.
 */
export function runMigrations(db: SqliteDatabase, migrations: readonly SchemaMigration[]): string[] {
  db.exec(MIGRATIONS_TABLE_SQL);
  const applied = new Set(appliedMigrations(db));
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    withWriteTx(db, () => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?);").run(migration.id, Date.now());
    });
    applied.add(migration.id);
    newlyApplied.push(migration.id);
  }

  return newlyApplied;
}
