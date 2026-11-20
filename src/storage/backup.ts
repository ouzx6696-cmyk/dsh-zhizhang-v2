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
// Retention is split in two: `planRetention` is the pure policy (no IO, so it
// is directly comparable with the fixture) and `pruneBackups` adds the disk
// side around it.

import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { StorageError } from "./errors.ts";
import { openDatabase, type SqliteDatabase } from "./driver.ts";
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
}

/** A backup as retention sees it: an identity and whether it is usable. */
export interface BackupDescriptor {
  readonly id: string;
  readonly valid: boolean;
}

/** The outcome of a retention pass. */
export interface RetentionPlan {
  readonly kept: readonly BackupDescriptor[];
  readonly deleted: readonly BackupDescriptor[];
  readonly refused: readonly string[];
}

const MANIFEST_NAME = "manifest.json";
const STORE_NAME = "work.db";
const WAL_SIDECARS = ["work.db-wal", "work.db-shm", "workspace.sqlite-wal", "workspace.sqlite-shm"] as const;

async function sha256OfFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
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

async function removeWalSidecars(targetDir: string): Promise<void> {
  for (const sidecar of WAL_SIDECARS) {
    await rm(join(targetDir, sidecar), { force: true });
  }
}

/** Creates an online consistent snapshot from a live WAL connection via `VACUUM INTO`. */
export async function createHotBackup(
  db: SqliteDatabase,
  backupDir: string,
  deliveriesDirectory?: string,
): Promise<BackupManifest> {
  await mkdir(backupDir, { recursive: true });
  const targetDb = join(backupDir, STORE_NAME);
  await rm(targetDb, { force: true });
  db.prepare("VACUUM INTO ?;").run(targetDb);
  const schema = readSchemaId(db);
  const entries: BackupEntry[] = [{ path: STORE_NAME, sha256: await sha256OfFile(targetDb) }];
  await copyDeliveriesToBackup(backupDir, deliveriesDirectory, entries, true);
  const manifest: BackupManifest = { schema, entries };
  await writeFile(join(backupDir, MANIFEST_NAME), JSON.stringify(manifest));
  return manifest;
}

/** Copies a closed store into `backupDir` and writes its manifest. */
export async function createBackup(
  sourceFile: string,
  backupDir: string,
  deliveriesDirectory?: string,
): Promise<BackupManifest> {
  await mkdir(backupDir, { recursive: true });
  await copyFile(sourceFile, join(backupDir, STORE_NAME));
  // The manifest records the schema the copy actually holds. A backup of a
  // store outside the V2 window is still a faithful copy; the window is
  // enforced when the store is opened, not when it is copied.
  const copied = openDatabase(join(backupDir, STORE_NAME));
  let schema: string;
  try {
    schema = readSchemaId(copied);
  } finally {
    copied.close();
  }
  const entries: BackupEntry[] = [{ path: STORE_NAME, sha256: await sha256OfFile(join(backupDir, STORE_NAME)) }];
  await copyDeliveriesToBackup(backupDir, deliveriesDirectory, entries, false);
  const manifest: BackupManifest = { schema, entries };
  await writeFile(join(backupDir, MANIFEST_NAME), JSON.stringify(manifest));
  return manifest;
}

/** Verifies a backup: every entry present, every hash still matching. */
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
        (entry.path !== STORE_NAME && !/^deliveries\/[a-f0-9-]{36}\.md$/iu.test(entry.path)) ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256))) {
    throw new StorageError("storage.format_unsupported", { reason: "backup-manifest-unreadable" });
  }
  for (const entry of manifest.entries) {
    let bytes: Uint8Array;
    try {
      const file = join(backupDir, entry.path);
      if (entry.path !== STORE_NAME && !(await lstat(dirname(file))).isDirectory()) throw new Error("invalid directory");
      if (!(await lstat(file)).isFile()) throw new Error("invalid file");
      bytes = await readFile(file);
    } catch {
      throw new StorageError("storage.format_unsupported", {
        reason: "backup-entry-missing",
        path: entry.path,
      });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
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
  await writeFile(join(targetDir, MANIFEST_NAME), JSON.stringify(manifest));
  return targetDir;
}

/** Offline backup of the real host layout. The caller must stop the profile. */
export async function backupWorkspace(directory: string, target: string) {
  await mkdir(target, { mode: 0o700 });
  return createBackup(join(directory, "workspace.sqlite"), target, join(directory, "deliveries"));
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
    await copyFile(join(backup, path), join(target, path === STORE_NAME ? "workspace.sqlite" : path));
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

/** Lists the backups under `backupsRoot`, newest first, with validity. */
export async function listBackups(backupsRoot: string): Promise<BackupDescriptor[]> {
  let names: string[];
  try {
    names = await readdir(backupsRoot);
  } catch {
    return [];
  }
  const descriptors: BackupDescriptor[] = [];
  for (const name of names) {
    const dir = join(backupsRoot, name);
    descriptors.push({ id: name, valid: await isBackupValid(dir) });
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
    await rm(join(backupsRoot, backup.id), { recursive: true, force: true });
  }
  return plan;
}

/**
 * The retention default is a proposal until the author confirms it.
 *
 * The count and the trigger (per delivery / daily / manual) are a light
 * B-class confirmation, recorded as row 21 of the C.5 freeze audit in
 * `contracts.md`; `PROPOSED_` marks it as not frozen, so a caller configures
 * the value rather than inheriting a decision the author has not made.
 */
export const PROPOSED_BACKUP_RETENTION = 7;
