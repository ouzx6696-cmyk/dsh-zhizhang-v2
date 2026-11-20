// Backup creation, verification, restore and retention.
//
// The rules are frozen in contracts.md B.10 (2026-11-19) and pinned by
// `storage-a01.test.mjs`:
//
//   - a backup is a directory holding the store plus a manifest that records
//     every entry's sha256;
//   - a backup is usable only when every manifest entry is present and still
//     hashes to the recorded value — a missing entry or a changed byte makes
//     the whole backup unusable;
//   - restoring never silently overwrites a non-empty target;
//   - retention keeps the newest valid backups and never leaves the author
//     with zero valid backups: when pruning would delete the last one, the
//     newest valid backup is kept and the refusal is recorded.
//
// V2.3 upgrades (DB-04 / DSH-19):
//   - streaming SHA-256 hashing (bounded memory even for large databases);
//   - atomic `.tmp` + `rename` manifest writes;
//   - online hot backup via `node:sqlite` `backup()` (fallback `VACUUM INTO`);
//   - WAL checkpoint enforcement on offline `createBackup` (refuses if WAL
//     cannot be truncated rather than silently copying an incomplete file);
//   - stat-validated verification cache for `listBackups` / `listBackupDetails`;
//   - optional `exports/` bundle inclusion in backup manifests.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { openDatabase, runOnlineBackup, type SqliteDatabase } from "./driver.ts";
import { StorageError } from "./errors.ts";
import { checkpointDatabase } from "./stmt-pool.ts";
import { openStore, readSchemaId } from "./store.ts";

/** One file inside a backup, with the hash its bytes must still produce. */
export interface BackupEntry {
  readonly path: string;
  readonly sha256: string;
}

/** What a backup directory records about itself. */
export interface BackupManifest {
  readonly schema: string;
  readonly entries: readonly BackupEntry[];
  readonly createdAt?: string;
  readonly migrations?: readonly string[];
}

/** A backup as retention sees it: an identity and whether it is usable. */
export interface BackupDescriptor {
  readonly id: string;
  readonly valid: boolean;
}

/** Rich metadata returned by `listBackupDetails` for UI / diagnostics. */
export interface BackupDetailDescriptor extends BackupDescriptor {
  readonly schema?: string;
  readonly createdAt?: string;
  readonly sizeBytes?: number;
  readonly entryCount?: number;
}

/** The outcome of a retention pass. */
export interface RetentionPlan {
  readonly kept: readonly BackupDescriptor[];
  readonly deleted: readonly BackupDescriptor[];
  readonly refused: readonly string[];
}

export interface BackupOptions {
  readonly deliveriesDirectory?: string;
  readonly exportsDirectory?: string;
  readonly includeExports?: boolean;
}

const MANIFEST_NAME = "manifest.json";
const STORE_NAME = "work.db";
const WAL_SIDECARS = ["work.db-wal", "work.db-shm", "workspace.sqlite-wal", "workspace.sqlite-shm"] as const;

interface CachedBackupVerification {
  readonly manifestStamp: string;
  readonly entryStamps: ReadonlyMap<string, string>;
  readonly valid: boolean;
  readonly schema?: string;
  readonly createdAt?: string;
  readonly sizeBytes: number;
  readonly entryCount: number;
}

const MAX_VERIFY_CACHE = 128;
const verificationCache = new Map<string, CachedBackupVerification>();

/** Clears the in-memory `listBackups` verification cache. */
export function clearBackupVerificationCache(): void {
  verificationCache.clear();
}

function fileStamp(info: { readonly size?: number; readonly mtimeMs?: number; readonly ctimeMs?: number }): string {
  return `${info.size ?? -1}:${info.mtimeMs ?? -1}:${info.ctimeMs ?? -1}`;
}

/** Streaming SHA-256 hash so large databases never buffer whole files in RAM (DB-04). */
async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Writes `content` to a sibling `.tmp` file then atomically renames into place. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, content);
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup of temp manifest.
    }
    throw error;
  }
}

function isSafeExportEntryPath(entryPath: string): boolean {
  if (!entryPath.startsWith("exports/") || entryPath.includes("\\") || entryPath.includes("\0")) {
    return false;
  }
  const segments = entryPath.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === "..")) return false;
  return posix.normalize(entryPath) === entryPath;
}

function isAllowedManifestEntryPath(entryPath: string): boolean {
  if (entryPath === STORE_NAME) return true;
  if (/^deliveries\/[a-f0-9-]{36}\.md$/iu.test(entryPath)) return true;
  if (isSafeExportEntryPath(entryPath)) return true;
  return false;
}

async function copyDeliveriesToBackup(
  backupDir: string,
  deliveriesDirectory: string | undefined,
  entries: BackupEntry[],
  ignoreMissingDir = false,
): Promise<void> {
  if (!deliveriesDirectory) return;
  let items;
  try {
    items = await readdir(deliveriesDirectory, { withFileTypes: true });
  } catch (error) {
    if (ignoreMissingDir) return;
    throw error;
  }
  for (const item of items) {
    if (!item.isFile() || !/^[a-f0-9-]{36}\.md$/iu.test(item.name)) continue;
    const path = `deliveries/${item.name}`;
    const target = join(backupDir, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(deliveriesDirectory, item.name), target);
    entries.push({ path, sha256: await sha256OfFile(target) });
  }
}

async function copyExportsToBackup(
  backupDir: string,
  exportsDirectory: string | undefined,
  entries: BackupEntry[],
): Promise<void> {
  if (!exportsDirectory) return;
  async function walk(currentDiskDir: string, relPrefix: string): Promise<void> {
    let items;
    try {
      items = await readdir(currentDiskDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".") || item.name.includes(".staging-") || item.name.includes(".prev-")) {
        continue;
      }
      const diskPath = join(currentDiskDir, item.name);
      const relPath = relPrefix ? `${relPrefix}/${item.name}` : `exports/${item.name}`;
      if (item.isDirectory()) {
        await walk(diskPath, relPath);
      } else if (item.isFile() && isSafeExportEntryPath(relPath)) {
        const target = join(backupDir, relPath);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(diskPath, target);
        entries.push({ path: relPath, sha256: await sha256OfFile(target) });
      }
    }
  }
  await walk(exportsDirectory, "");
}

function readAppliedMigrationsSafe(db: SqliteDatabase): string[] | undefined {
  try {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations';")
      .get();
    if (!exists) return undefined;
    const rows = db
      .prepare("SELECT id FROM schema_migrations ORDER BY applied_at ASC, rowid ASC;")
      .all() as readonly { id?: unknown }[];
    return rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
  } catch {
    return undefined;
  }
}

async function removeWalSidecars(targetDir: string): Promise<void> {
  for (const sidecar of WAL_SIDECARS) {
    await rm(join(targetDir, sidecar), { force: true });
  }
}

function resolveBackupOptions(optionsOrDeliveries?: string | BackupOptions): BackupOptions {
  if (typeof optionsOrDeliveries === "string") {
    return { deliveriesDirectory: optionsOrDeliveries };
  }
  return optionsOrDeliveries ?? {};
}

/**
 * Ensures an offline source file has no un-checkpointed WAL frames before
 * copying. When `${sourceFile}-wal` exists and is non-empty, runs
 * `PRAGMA wal_checkpoint(TRUNCATE)`; if another connection prevents truncation,
 * refuses the backup rather than copying an incomplete database (DB-04).
 */
async function ensureOfflineWalCheckpointed(sourceFile: string): Promise<void> {
  const walFile = `${sourceFile}-wal`;
  let walSize = 0;
  try {
    const info = await stat(walFile);
    walSize = info.size ?? 0;
  } catch {
    return;
  }
  if (walSize <= 0) return;

  let handle: SqliteDatabase | undefined;
  try {
    handle = openDatabase(sourceFile, { timeout: 1000 });
    const res = checkpointDatabase(handle, "TRUNCATE");
    if (res.busy !== 0 || res.checkpointed < res.log) {
      throw new StorageError("dependency.unavailable", {
        reason: "wal-checkpoint-busy",
        busy: res.busy,
        log: res.log,
        checkpointed: res.checkpointed,
      });
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("dependency.unavailable", {
      reason: "wal-checkpoint-failed",
    });
  } finally {
    handle?.close();
  }
}

/**
 * Creates an online consistent snapshot from a live WAL connection using
 * `node:sqlite`'s `backup()` API (falling back to `VACUUM INTO`), streaming
 * SHA-256 hashing, and atomic manifest commit.
 */
export async function createHotBackup(
  db: SqliteDatabase,
  backupDir: string,
  optionsOrDeliveries?: string | BackupOptions,
): Promise<BackupManifest> {
  const opts = resolveBackupOptions(optionsOrDeliveries);
  await mkdir(backupDir, { recursive: true });
  const targetDb = join(backupDir, STORE_NAME);
  await rm(targetDb, { force: true });
  await runOnlineBackup(db, targetDb);
  const schema = readSchemaId(db);
  const migrations = readAppliedMigrationsSafe(db);
  const entries: BackupEntry[] = [{ path: STORE_NAME, sha256: await sha256OfFile(targetDb) }];
  await copyDeliveriesToBackup(backupDir, opts.deliveriesDirectory, entries, true);
  if (opts.includeExports !== false && opts.exportsDirectory) {
    await copyExportsToBackup(backupDir, opts.exportsDirectory, entries);
  }
  const manifest: BackupManifest = {
    schema,
    entries,
    createdAt: new Date().toISOString(),
    ...(migrations ? { migrations } : {}),
  };
  await writeFileAtomic(join(backupDir, MANIFEST_NAME), JSON.stringify(manifest));
  verificationCache.delete(resolve(backupDir));
  return manifest;
}

/** Copies a closed store into `backupDir` (checkpointing any WAL first) and writes its manifest atomically. */
export async function createBackup(
  sourceFile: string,
  backupDir: string,
  optionsOrDeliveries?: string | BackupOptions,
): Promise<BackupManifest> {
  const opts = resolveBackupOptions(optionsOrDeliveries);
  await ensureOfflineWalCheckpointed(sourceFile);
  await mkdir(backupDir, { recursive: true });
  const targetDb = join(backupDir, STORE_NAME);
  await copyFile(sourceFile, targetDb);
  // The manifest records the schema the copy actually holds. A backup of a
  // store outside the V2 window is still a faithful copy; the window is
  // enforced when the store is opened, not when it is copied.
  const copied = openDatabase(targetDb);
  let schema: string;
  let migrations: string[] | undefined;
  try {
    schema = readSchemaId(copied);
    migrations = readAppliedMigrationsSafe(copied);
  } finally {
    copied.close();
  }
  const entries: BackupEntry[] = [{ path: STORE_NAME, sha256: await sha256OfFile(targetDb) }];
  await copyDeliveriesToBackup(backupDir, opts.deliveriesDirectory, entries, false);
  if (opts.includeExports !== false && opts.exportsDirectory) {
    await copyExportsToBackup(backupDir, opts.exportsDirectory, entries);
  }
  const manifest: BackupManifest = {
    schema,
    entries,
    createdAt: new Date().toISOString(),
    ...(migrations ? { migrations } : {}),
  };
  await writeFileAtomic(join(backupDir, MANIFEST_NAME), JSON.stringify(manifest));
  verificationCache.delete(resolve(backupDir));
  return manifest;
}

/** Verifies a backup: every entry present, every hash still matching via streaming SHA-256. */
export async function verifyBackup(backupDir: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await readFile(join(backupDir, MANIFEST_NAME), "utf8");
  } catch {
    throw new StorageError("storage.format_unsupported", { reason: "backup-manifest-missing" });
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(raw) as BackupManifest;
  } catch {
    throw new StorageError("storage.format_unsupported", { reason: "backup-manifest-unreadable" });
  }
  if (!manifest || typeof manifest.schema !== "string" || !Array.isArray(manifest.entries) ||
      !manifest.entries.some((entry) => entry?.path === STORE_NAME) ||
      new Set(manifest.entries.map((entry) => entry?.path)).size !== manifest.entries.length ||
      manifest.entries.some((entry) => !entry || typeof entry.path !== "string" ||
        !isAllowedManifestEntryPath(entry.path) ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256))) {
    throw new StorageError("storage.format_unsupported", { reason: "backup-manifest-unreadable" });
  }
  for (const entry of manifest.entries) {
    let actualHash: string;
    try {
      const file = join(backupDir, entry.path);
      if (entry.path !== STORE_NAME && !(await lstat(dirname(file))).isDirectory()) throw new Error("invalid directory");
      if (!(await lstat(file)).isFile()) throw new Error("invalid file");
      actualHash = await sha256OfFile(file);
    } catch {
      throw new StorageError("storage.format_unsupported", {
        reason: "backup-entry-missing",
        path: entry.path,
      });
    }
    if (actualHash !== entry.sha256) {
      throw new StorageError("storage.format_unsupported", {
        reason: "backup-hash-mismatch",
        path: entry.path,
      });
    }
  }
  return manifest;
}

/** Whether a backup directory is usable, without throwing. */
export async function isBackupValid(backupDir: string): Promise<boolean> {
  try {
    await verifyBackup(backupDir);
    return true;
  } catch {
    return false;
  }
}

async function verifyBackupCachedForListing(
  backupDir: string,
  bypassCache = false,
): Promise<{
  readonly valid: boolean;
  readonly schema?: string;
  readonly createdAt?: string;
  readonly sizeBytes: number;
  readonly entryCount: number;
}> {
  const key = resolve(backupDir);
  const manifestPath = join(backupDir, MANIFEST_NAME);
  let manifestInfo;
  try {
    manifestInfo = await lstat(manifestPath);
  } catch {
    verificationCache.delete(key);
    return { valid: false, sizeBytes: 0, entryCount: 0 };
  }
  const manifestStamp = fileStamp(manifestInfo);

  if (!bypassCache) {
    const cached = verificationCache.get(key);
    if (cached && cached.manifestStamp === manifestStamp) {
      let allMatch = true;
      for (const [entryPath, expectedStamp] of cached.entryStamps) {
        try {
          const info = await lstat(join(backupDir, entryPath));
          if (!info.isFile() || fileStamp(info) !== expectedStamp) {
            allMatch = false;
            break;
          }
        } catch {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        // LRU promote
        verificationCache.delete(key);
        verificationCache.set(key, cached);
        return {
          valid: cached.valid,
          schema: cached.schema,
          createdAt: cached.createdAt,
          sizeBytes: cached.sizeBytes,
          entryCount: cached.entryCount,
        };
      }
    }
  }

  try {
    const manifest = await verifyBackup(backupDir);
    const entryStamps = new Map<string, string>();
    let totalSize = manifestInfo.size ?? 0;
    for (const entry of manifest.entries) {
      const info = await lstat(join(backupDir, entry.path));
      entryStamps.set(entry.path, fileStamp(info));
      totalSize += info.size ?? 0;
    }
    const record: CachedBackupVerification = {
      manifestStamp,
      entryStamps,
      valid: true,
      schema: manifest.schema,
      createdAt: manifest.createdAt,
      sizeBytes: totalSize,
      entryCount: manifest.entries.length,
    };
    verificationCache.delete(key);
    verificationCache.set(key, record);
    if (verificationCache.size > MAX_VERIFY_CACHE) {
      const oldest = verificationCache.keys().next().value;
      if (oldest !== undefined) verificationCache.delete(oldest);
    }
    return {
      valid: true,
      schema: record.schema,
      createdAt: record.createdAt,
      sizeBytes: record.sizeBytes,
      entryCount: record.entryCount,
    };
  } catch {
    verificationCache.delete(key);
    return { valid: false, sizeBytes: 0, entryCount: 0 };
  }
}

/** Restores a verified backup into `targetDir`, refusing a non-empty target. */
export async function restoreBackup(
  backupDir: string,
  targetDir: string,
  { overwrite = false }: { readonly overwrite?: boolean } = {},
): Promise<string> {
  const manifest = await verifyBackup(backupDir);
  let nonEmpty = false;
  try {
    const existing = await readdir(targetDir);
    nonEmpty = existing.length > 0;
  } catch {
    nonEmpty = false;
  }
  if (nonEmpty && !overwrite) {
    throw new StorageError("input.invalid", { reason: "restore-target-not-empty" });
  }
  await mkdir(targetDir, { recursive: true });
  if (overwrite) {
    await removeWalSidecars(targetDir);
  }
  for (const entry of manifest.entries) {
    const target = join(targetDir, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(backupDir, entry.path), target);
  }
  await writeFileAtomic(join(targetDir, MANIFEST_NAME), JSON.stringify(manifest));
  return targetDir;
}

/** Offline backup of the real host layout. The caller must stop the profile. */
export async function backupWorkspace(
  directory: string,
  target: string,
  options?: { readonly includeExports?: boolean },
) {
  await mkdir(target, { mode: 0o700 });
  return createBackup(join(directory, "workspace.sqlite"), target, {
    deliveriesDirectory: join(directory, "deliveries"),
    exportsDirectory: options?.includeExports ? join(directory, "exports") : undefined,
    includeExports: options?.includeExports ?? false,
  });
}

/** Restore a verified snapshot into a new host data directory. */
export async function restoreWorkspace(backup: string, target: string) {
  const manifest = await verifyBackup(backup);
  const source = openStore(join(backup, STORE_NAME), { readOnly: true });
  try {
    const integrity = source.prepare("PRAGMA quick_check;").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok" || readSchemaId(source) !== manifest.schema) {
      throw new StorageError("storage.format_unsupported", { reason: "backup-database-invalid" });
    }
  } finally {
    source.close();
  }
  await mkdir(target, { mode: 0o700 });
  await mkdir(join(target, "deliveries"), { mode: 0o700 });
  await removeWalSidecars(target);
  for (const { path } of manifest.entries) {
    const dest = join(target, path === STORE_NAME ? "workspace.sqlite" : path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(join(backup, path), dest);
  }
  return target;
}

/**
 * The pure retention policy. Backups are given newest first. The newest `keep`
 * valid backups survive; everything else is deleted — except that the newest
 * valid backup always survives, even when `keep` is zero, and that refusal is
 * reported so the caller can surface it.
 */
export function planRetention(
  backups: readonly BackupDescriptor[],
  { keep }: { readonly keep: number },
): RetentionPlan {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new StorageError("input.invalid", { reason: "invalid-retention", keep });
  }
  const kept: BackupDescriptor[] = [];
  const deleted: BackupDescriptor[] = [];
  const refused: string[] = [];
  let validKept = 0;
  for (const backup of backups) {
    if (backup.valid && validKept < keep) {
      kept.push(backup);
      validKept += 1;
      continue;
    }
    deleted.push(backup);
  }
  if (validKept === 0) {
    const newestValid = backups.find((backup) => backup.valid);
    if (newestValid) {
      const index = deleted.indexOf(newestValid);
      if (index >= 0) deleted.splice(index, 1);
      kept.push(newestValid);
      refused.push(newestValid.id);
    }
  }
  return { kept, deleted, refused };
}

/** Lists the backups under `backupsRoot`, newest first, with stat-cached validity. */
export async function listBackups(
  backupsRoot: string,
  options?: { readonly bypassCache?: boolean },
): Promise<BackupDescriptor[]> {
  const details = await listBackupDetails(backupsRoot, options);
  return details.map(({ id, valid }) => ({ id, valid }));
}

/** Lists backups under `backupsRoot` with rich metadata for UI / `/diag` / `backup.list`. */
export async function listBackupDetails(
  backupsRoot: string,
  options?: { readonly bypassCache?: boolean },
): Promise<BackupDetailDescriptor[]> {
  let names: string[];
  try {
    names = await readdir(backupsRoot);
  } catch {
    return [];
  }
  const descriptors: BackupDetailDescriptor[] = [];
  for (const name of names) {
    const dir = join(backupsRoot, name);
    const info = await verifyBackupCachedForListing(dir, options?.bypassCache === true);
    descriptors.push({
      id: name,
      valid: info.valid,
      ...(info.schema !== undefined ? { schema: info.schema } : {}),
      ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
      ...(info.valid ? { sizeBytes: info.sizeBytes, entryCount: info.entryCount } : {}),
    });
  }
  // Names are caller-chosen timestamps, so descending name order is newest
  // first. Anything not sortable that way still gets a stable order.
  descriptors.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
  return descriptors;
}

/** Runs retention against real backup directories. */
export async function pruneBackups(
  backupsRoot: string,
  { keep }: { readonly keep: number },
): Promise<RetentionPlan> {
  const plan = planRetention(await listBackups(backupsRoot), { keep });
  for (const backup of plan.deleted) {
    const dir = join(backupsRoot, backup.id);
    verificationCache.delete(resolve(dir));
    await rm(dir, { recursive: true, force: true });
  }
  return plan;
}

/**
 * Default backup retention count (confirmed in V2.3 Res#9: keep 7 backups under
 * `dataDirectory/backups`). Exported under its original name for compatibility.
 */
export const PROPOSED_BACKUP_RETENTION = 7;
