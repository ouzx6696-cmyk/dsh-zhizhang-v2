import type { SqliteDatabase, SqliteStatement } from "./driver.ts";

const statementCache = new WeakMap<SqliteDatabase, Map<string, SqliteStatement>>();

/**
 * Returns a connection-scoped cached prepared statement so hot-path queries
 * avoid re-compiling SQLite ASTs on every call while releasing cleanly on close.
 */
export function stmt(db: SqliteDatabase, sql: string): SqliteStatement {
  let pool = statementCache.get(db);
  if (!pool) {
    pool = new Map<string, SqliteStatement>();
    statementCache.set(db, pool);
  }
  let prepared = pool.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    pool.set(sql, prepared);
  }
  return prepared;
}

/**
 * Applies production SQLite pragmas safely, distinguishing file-backed stores
 * (WAL + NORMAL sync + mmap + 16 MiB cache) from `:memory:` test stores.
 */
export function configureStorePragmas(db: SqliteDatabase, isMemory = false): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA temp_store = MEMORY;");
  if (isMemory) return;
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA cache_size = -16384;");
  db.exec("PRAGMA mmap_size = 268435456;");
}
