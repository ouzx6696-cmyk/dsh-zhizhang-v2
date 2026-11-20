// Storage-layer ambient augmentations for Node 24 built-in APIs used by V2.3
// (`node:sqlite` online backup / isTransaction, streaming fs reads, atomic rename).

declare module "node:fs" {
  export interface ReadStream extends AsyncIterable<Uint8Array> {
    destroy(): void;
  }
  export function createReadStream(path: string | URL): ReadStream;
}

declare module "node:fs/promises" {
  export interface FileInfo {
    readonly size?: number;
    readonly mtimeMs?: number;
    readonly ctimeMs?: number;
  }
  export function stat(path: string): Promise<FileInfo>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
}

declare module "node:sqlite" {
  export interface DatabaseSync {
    readonly isTransaction?: boolean;
  }
  export function backup(
    sourceDb: DatabaseSync,
    path: string,
    options?: {
      readonly source?: string;
      readonly target?: string;
      readonly rate?: number;
      readonly progress?: (info: { readonly totalPages: number; readonly remainingPages: number }) => void;
    },
  ): Promise<number>;
}
