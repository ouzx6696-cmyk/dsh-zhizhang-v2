// The driver seam for the authoritative store.
//
// Q-05 (which SQLite driver the shipped Bundle uses) is still an open author
// decision, so nothing in the storage layer may name a concrete driver except
// this module. Everything above it talks to `SqliteDatabase`; swapping the
// driver later means changing `openDatabase` and nothing else.
//
// The current implementation uses the Node built-in `node:sqlite`, which is
// what the only SQLite consumer inside the installed Host uses (see the host
// evidence note in the v2.0 plan). That is evidence for the route, not a
// freeze of the decision.

import { DatabaseSync } from "node:sqlite";

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
}

/** Opens (or creates) a database file through the built-in driver. */
export function openDatabase(path: string): SqliteDatabase {
  return new DatabaseSync(path);
}
