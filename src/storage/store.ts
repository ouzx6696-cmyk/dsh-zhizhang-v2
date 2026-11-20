// Opening and creating the authoritative store.
//
// The rules come from contracts.md B.10 (frozen 2026-11-19) and are pinned by
// `storage-a01.test.mjs` and `sqlite-d01.test.mjs`:
//
//   - a store that cannot be read at all is refused, not half-served;
//   - a store whose bytes are not a database is refused the same way;
//   - a store with no schema row is refused;
//   - a store whose schema id is outside the V2 window is refused, with the
//     offending id and the supported window in the details.
//
// None of these ever migrate, repair or guess. The caller gets one refusal.

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDatabase } from "./driver.ts";
import type { SqliteDatabase } from "./driver.ts";
import { StorageError } from "./errors.ts";
import { assertSupportedSchema, SCHEMA_ID, SCHEMA_USER_VERSION } from "./schema.ts";
import { configureStorePragmas } from "./stmt-pool.ts";

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

/**
 * Creates a new store at `path`, recording the current schema id, a unique
 * `db_uuid`, and `PRAGMA user_version`. File-backed stores are initialized via
 * a temp file and atomic rename to prevent partially-initialized databases on
 * concurrent startup (DSH-23).
 */
export function createStore(path: string, schemaId: string = SCHEMA_ID): void {
  assertSupportedSchema(schemaId);
  const atomicTemp = !isMemoryPath(path) && !path.startsWith("file:");
  const targetPath = atomicTemp ? `${path}.tmp-${randomUUID()}` : path;
  if (atomicTemp) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = openDatabase(targetPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?);").run(schemaId);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('db_uuid', ?);").run(randomUUID());
    db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION};`);
  } catch (error) {
    db.close();
    if (atomicTemp) {
      try {
        rmSync(targetPath, { force: true });
      } catch {
        // Best-effort cleanup of temp store.
      }
    }
    throw error;
  }
  db.close();
  if (atomicTemp) {
    try {
      renameSync(targetPath, path);
    } catch (error) {
      try {
        rmSync(targetPath, { force: true });
      } catch {
        // Best-effort cleanup.
      }
      throw error;
    }
  }
}

/** Reads the schema id a store records, or refuses the store. */
export function readSchemaId(db: SqliteDatabase): string {
  let row: unknown;
  try {
    row = db.prepare("SELECT value FROM meta WHERE key = 'schema';").get();
  } catch {
    throw new StorageError("storage.format_unsupported", { reason: "schema-unreadable" });
  }
  if (row === null || row === undefined) {
    throw new StorageError("storage.format_unsupported", { reason: "schema-missing" });
  }
  const value = (row as { value?: unknown }).value;
  if (typeof value !== "string") {
    throw new StorageError("storage.format_unsupported", { reason: "schema-missing" });
  }
  return value;
}

/** Reads the store's persistent `db_uuid` from `meta`, or `""` if absent. */
export function readDatabaseUuid(db: SqliteDatabase): string {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'db_uuid';").get() as
      | { value?: unknown }
      | undefined;
    return typeof row?.value === "string" ? row.value : "";
  } catch {
    return "";
  }
}

/**
 * Opens an existing store, refusing anything unreadable, corrupt or outside
 * the V2 schema window. The returned handle stays open; the caller closes it.
 */
export function openStore(path: string, options?: { readonly readOnly?: boolean }): SqliteDatabase {
  let db: SqliteDatabase | undefined;
  try {
    db = openDatabase(path, options?.readOnly ? { readOnly: true } : undefined);
    const schemaId = readSchemaId(db);
    assertSupportedSchema(schemaId);
    if (options?.readOnly) {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA busy_timeout = 5000;");
    } else {
      configureStorePragmas(db, isMemoryPath(path));
    }
    return db;
  } catch (error) {
    if (error instanceof StorageError) {
      // A refused store must not be left open behind the refusal.
      db?.close();
      throw error;
    }
    db?.close();
    throw new StorageError("storage.format_unsupported", { reason: "unreadable" });
  }
}

/** Convenience for tests and tools: a fresh store inside a directory. */
export function createStoreIn(dir: string, name = "work.db", schemaId: string = SCHEMA_ID): string {
  const path = join(dir, name);
  createStore(path, schemaId);
  return path;
}
