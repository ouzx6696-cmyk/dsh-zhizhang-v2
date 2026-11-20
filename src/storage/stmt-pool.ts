import { sep } from "node:path";
import type { SqliteDatabase, SqliteStatement } from "./driver.ts";

/** Maximum prepared statements cached per SQLite connection (DB-08). */
export const MAX_STMT_CACHE_SIZE = 256;

const statementCache = new WeakMap<SqliteDatabase, Map<string, SqliteStatement>>();

/**
 * Returns a connection-scoped LRU-cached prepared statement (max 256 entries)
 * so hot-path queries avoid re-compiling SQLite ASTs without unbounded memory
 * growth on dynamic SQL.
 */
export function stmt(db: SqliteDatabase, sql: string): SqliteStatement {
  let pool = statementCache.get(db);
  if (!pool) {
    pool = new Map<string, SqliteStatement>();
    statementCache.set(db, pool);
  }
  const existing = pool.get(sql);
  if (existing) {
    // Refresh recency in insertion-ordered Map (O(1) LRU promotion).
    pool.delete(sql);
    pool.set(sql, existing);
    return existing;
  }
  const prepared = db.prepare(sql);
  if (pool.size >= MAX_STMT_CACHE_SIZE) {
    const oldestKey = pool.keys().next().value;
    if (oldestKey !== undefined) {
      pool.delete(oldestKey);
    }
  }
  pool.set(sql, prepared);
  return prepared;
}

/** Reports how many statements are currently cached for `db`. */
export function statementCacheSize(db: SqliteDatabase): number {
  return statementCache.get(db)?.size ?? 0;
}

/** Clears the cached prepared statements for `db`. */
export function clearStatementCache(db: SqliteDatabase): void {
  statementCache.delete(db);
}

/**
 * Applies production SQLite pragmas safely (DB-07):
 * - sets `busy_timeout` BEFORE switching to WAL to avoid startup SQLITE_BUSY;
 * - caps WAL growth via `journal_size_limit = 64 MiB`;
 * - disables `mmap_size` on Windows (`sep === '\\'`) to prevent EPERM/EBUSY
 *   file-mapping lock contention during backup/rename operations.
 */
export function configureStorePragmas(db: SqliteDatabase, isMemory = false): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA temp_store = MEMORY;");
  if (isMemory) return;
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA journal_size_limit = 67108864;");
  db.exec("PRAGMA cache_size = -16384;");
  const mmapSize = sep === "\\" ? 0 : 268435456;
  db.exec(`PRAGMA mmap_size = ${mmapSize};`);
}

/** Runs SQLite's lightweight query-planner statistics optimizer (`PRAGMA optimize`). */
export function optimizeDatabase(db: SqliteDatabase): void {
  db.exec("PRAGMA optimize;");
}

/** Executes a WAL checkpoint and returns SQLite's `{ busy, log, checkpointed }` counters. */
export function checkpointDatabase(
  db: SqliteDatabase,
  mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE",
): { readonly busy: number; readonly log: number; readonly checkpointed: number } {
  const row = db.prepare(`PRAGMA wal_checkpoint(${mode});`).get() as
    | { busy?: number; log?: number; checkpointed?: number }
    | undefined;
  return {
    busy: typeof row?.busy === "number" ? row.busy : 0,
    log: typeof row?.log === "number" ? row.log : 0,
    checkpointed: typeof row?.checkpointed === "number" ? row.checkpointed : 0,
  };
}

export interface StorePragmaSnapshot {
  readonly foreignKeys: number;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly busyTimeout: number;
  readonly journalSizeLimit: number;
  readonly cacheSize: number;
  readonly mmapSize: number;
  readonly userVersion: number;
}

/** Reads effective PRAGMA values for diagnostics (`/diag`) and tests. */
export function readStorePragmas(db: SqliteDatabase): StorePragmaSnapshot {
  const fk = db.prepare("PRAGMA foreign_keys;").get() as { foreign_keys?: number } | undefined;
  const jm = db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
  const sync = db.prepare("PRAGMA synchronous;").get() as { synchronous?: number } | undefined;
  const bt = db.prepare("PRAGMA busy_timeout;").get() as { timeout?: number; busy_timeout?: number } | undefined;
  const jsl = db.prepare("PRAGMA journal_size_limit;").get() as { journal_size_limit?: number } | undefined;
  const cs = db.prepare("PRAGMA cache_size;").get() as { cache_size?: number } | undefined;
  const mm = db.prepare("PRAGMA mmap_size;").get() as { mmap_size?: number } | undefined;
  const uv = db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
  return {
    foreignKeys: Number(fk?.foreign_keys ?? 0),
    journalMode: String(jm?.journal_mode ?? "").toLowerCase(),
    synchronous: Number(sync?.synchronous ?? 0),
    busyTimeout: Number(bt?.timeout ?? bt?.busy_timeout ?? 0),
    journalSizeLimit: Number(jsl?.journal_size_limit ?? 0),
    cacheSize: Number(cs?.cache_size ?? 0),
    mmapSize: Number(mm?.mmap_size ?? 0),
    userVersion: Number(uv?.user_version ?? 0),
  };
}
