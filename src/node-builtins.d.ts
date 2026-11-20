// Minimal ambient declarations for the Node built-ins this workspace uses.
//
// The repository intentionally keeps a zero-dependency tree (only the
// TypeScript compiler is installed), so instead of pulling in `@types/node`
// the handful of built-in modules and Web-standard globals Node 24 provides
// are declared here.

declare function structuredClone<T>(value: T): T;

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly version: string;
  exitCode?: number;
};

declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(id: unknown): void;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class URL {
  constructor(input: string, base?: string | URL);
  readonly href: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
}

declare class URLSearchParams {
  get(name: string): string | null;
  set(name: string, value: string): void;
}

declare class Headers {
  get(name: string): string | null;
}

declare class AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  static timeout(milliseconds: number): AbortSignal;
  static any(signals: readonly AbortSignal[]): AbortSignal;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare class Request {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly signal: AbortSignal;
  readonly body: AsyncIterable<Uint8Array> | null;
}

declare class Response {
  constructor(body?: string | Uint8Array | null, init?: { status?: number; headers?: Record<string, string> });
  static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }): Response;
}

declare const Buffer: {
  concat(list: readonly Uint8Array[], totalLength?: number): Uint8Array & { toString(encoding?: "utf8"): string };
  byteLength(value: string, encoding?: "utf8"): number;
};

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex" | "base64" | "utf8"): string;
  }
  export function randomUUID(): string;
  export function createHash(algorithm: string): Hash;
}

declare module "node:path" {
  export const sep: string;
  export function join(...paths: readonly string[]): string;
  export function resolve(...paths: readonly string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function isAbsolute(path: string): boolean;
  export const posix: {
    join(...paths: readonly string[]): string;
    normalize(path: string): string;
    isAbsolute(path: string): boolean;
  };
}

declare module "node:fs" {
  export function existsSync(path: string | URL): boolean;
  export function mkdirSync(path: string | URL, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function readFileSync(path: string | URL): Uint8Array;
  export function writeFileSync(
    path: string | URL,
    data: string | Uint8Array,
    options?: { mode?: number; flag?: string; flush?: boolean },
  ): void;
  export function linkSync(existingPath: string | URL, newPath: string | URL): void;
  export function unlinkSync(path: string | URL): void;
  export function renameSync(oldPath: string | URL, newPath: string | URL): void;
  export function rmSync(path: string | URL, options?: { recursive?: boolean; force?: boolean }): void;
  export function readdirSync(
    path: string | URL,
    options: { withFileTypes: true },
  ): Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
  export function readdirSync(path: string | URL): string[];
}

declare module "node:fs/promises" {
  export function readFile(path: string | URL, encoding: "utf8"): Promise<string>;
  export function readFile(path: string | URL): Promise<Uint8Array>;
  export function writeFile(path: string | URL, data: string | Uint8Array): Promise<void>;
  export function mkdir(path: string | URL, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
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

declare module "node:sqlite" {
  export type SqliteValue = null | number | bigint | string | Uint8Array;

  export interface StatementRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...parameters: readonly SqliteValue[]): StatementRunResult;
    get(...parameters: readonly SqliteValue[]): unknown;
    all(...parameters: readonly SqliteValue[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
