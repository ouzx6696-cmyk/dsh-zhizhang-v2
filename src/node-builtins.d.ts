// Minimal ambient declarations for the Node built-ins this workspace uses.
//
// The repository intentionally keeps a zero-dependency tree (only the
// TypeScript compiler is installed), so instead of pulling in `@types/node`
// the handful of built-in modules the code touches are declared here. Extend
// this file when the code needs more of a built-in surface; do not add a
// runtime dependency for types alone.
//
// Every declaration here mirrors the Node 24 shape the offline test fixtures
// already exercise.

// `structuredClone` is a genuine Node global (Node 17+), so it is declared as
// one. `randomUUID` is NOT a global: it lives in `node:crypto`, declared as a
// module below, and must be imported. Do not add a global declaration for it —
// that would type-check code that does not run.
declare function structuredClone<T>(value: T): T;

declare module "node:crypto" {
  /** A hash handle. */
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex" | "base64" | "utf8"): string;
  }
  export function randomUUID(): string;
  export function createHash(algorithm: string): Hash;
}
declare module "node:path" {
  export function join(...paths: readonly string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  interface FileInfo {
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function lstat(path: string): Promise<FileInfo>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<(FileInfo & { name: string })[]>;
  export function copyFile(source: string, destination: string): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

// The synchronous SQLite driver (see src/storage/driver.ts for the seam that
// keeps the concrete driver out of the rest of the storage layer).
declare module "node:sqlite" {
  /** A value the built-in driver accepts as a bound parameter. */
  export type SqliteValue = null | number | bigint | string | Uint8Array;

  /** The result of a statement that writes. */
  export interface StatementRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  /** A prepared statement. Rows come back as untyped records. */
  export class StatementSync {
    run(...parameters: readonly SqliteValue[]): StatementRunResult;
    get(...parameters: readonly SqliteValue[]): unknown;
    all(...parameters: readonly SqliteValue[]): unknown[];
  }

  /** A synchronous SQLite database handle. */
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
