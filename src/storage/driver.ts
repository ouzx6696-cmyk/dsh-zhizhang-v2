// The driver seam for the authoritative store.
//
// Per V2.3 Res#4, `node:sqlite` is frozen as the runtime driver (matching
// `engines.node >= 24.15.0`). Keeping the driver behind this seam ensures
// `openDatabase` applies safe connection defaults (`timeout`, foreign keys,
// defensive mode) and exposes online backup cleanly.

import { DatabaseSync, backup } from "node:sqlite";

/** A value bound into a statement parameter. */
export type SqliteParameter = null | number | bigint | string | Uint8Array;

/** A row as the driver returns it: column names mapped to untyped values. */
export type SqliteRow = unknown;

/** A prepared statement. */
export interface SqliteStatement {
  run(...parameters: readonly SqliteParameter[]): { changes: number; lastInsertRowid: number | bigint };
  get(...parameters: readonly SqliteParameter[]): SqliteRow;
  all(...parameters: readonly SqliteParameter[]): readonly SqliteRow[];
}

/** The part of a SQLite handle the storage layer depends on. */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly isTransaction?: boolean;
}

export interface OpenDatabaseOptions {
  readonly readOnly?: boolean;
  readonly timeout?: number;
  readonly defensive?: boolean;
}

/** Opens (or creates) a database file through the built-in `node:sqlite` driver. */
export function openDatabase(path: string, options?: OpenDatabaseOptions): SqliteDatabase {
  const dbOptions: Record<string, unknown> = {
    timeout: options?.timeout ?? 5000,
    enableForeignKeyConstraints: true,
    defensive: options?.defensive ?? true,
  };
  if (options?.readOnly !== undefined) {
    dbOptions.readOnly = options.readOnly;
  }
  const DatabaseCtor = DatabaseSync as unknown as new (
    filename: string,
    opts?: Record<string, unknown>,
  ) => SqliteDatabase;
  return new DatabaseCtor(path, dbOptions);
}

/**
 * Performs an online backup using `node:sqlite`'s `backup()` API when `db` is a
 * live `DatabaseSync` handle, falling back to `VACUUM INTO` for wrapped handles.
 */
export async function runOnlineBackup(db: SqliteDatabase, destinationPath: string): Promise<void> {
  if (db instanceof DatabaseSync) {
    await backup(db, destinationPath, { rate: 100 });
    return;
  }
  db.prepare("VACUUM INTO ?;").run(destinationPath);
}
