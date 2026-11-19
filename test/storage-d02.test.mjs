import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXPORT_STATES,
  PROPOSED_BACKUP_RETENTION,
  SCHEMA_ID,
  StorageError,
  attemptExport,
  commitDelivery,
  createBackup,
  createDeliverySchema,
  createStore,
  isBackupValid,
  isSupportedSchema,
  listBackups,
  openDatabase,
  openStore,
  pendingExports,
  planRetention,
  pruneBackups,
  reconcileExports,
  restoreBackup,
  verifyBackup,
} from "../src/storage/index.ts";

// D-02 conformance: the real storage implementation against the rules that
// `storage-a01.test.mjs` records as the executable specification. The fixture
// mirrors the proposed behaviour; this file proves the implementation in
// `src/storage/` satisfies it. Both must keep passing together.

async function withTmpDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function freshStore(dir, name = "work.db", schemaId = SCHEMA_ID) {
  const path = join(dir, name);
  createStore(path, schemaId);
  return path;
}

// `createStore` refuses an id outside the V2 window, so a store carrying a
// foreign schema id is built through the driver seam. That is a test-only
// need: it produces the inputs the refusal rules are about.
function foreignStore(dir, name, schemaId) {
  const path = join(dir, name);
  const db = openDatabase(path);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?);").run(schemaId);
  db.close();
  return path;
}

test("D-02 a store inside the V2 schema window opens and a v1.x or 3.x store is refused", async () => {
  await withTmpDir(async (dir) => {
    const known = freshStore(dir);
    const opened = openStore(known);
    assert.equal(opened.prepare("SELECT value FROM meta WHERE key = 'schema';").get().value, SCHEMA_ID);
    opened.close();

    // A newer minor inside the same major still opens and keeps its own id.
    const newer = freshStore(dir, "newer.db", "zhizhang/2.7");
    const openedNewer = openStore(newer);
    assert.equal(
      openedNewer.prepare("SELECT value FROM meta WHERE key = 'schema';").get().value,
      "zhizhang/2.7",
    );
    openedNewer.close();

    for (const [index, schemaId] of ["zhizhang/3.0", "zhizhang/1.3"].entries()) {
      const outside = foreignStore(dir, `outside-${index}.db`, schemaId);
      await assert.rejects(
        async () => openStore(outside),
        (error) =>
          error instanceof StorageError &&
          error.code === "storage.format_unsupported" &&
          error.details.reason === "schema-unsupported" &&
          error.details.schemaId === schemaId &&
          Array.isArray(error.details.supported),
      );
    }
  });
});

test("D-02 the schema window boundary is exactly the V2 major", () => {
  assert.equal(isSupportedSchema("zhizhang/2.0"), true);
  assert.equal(isSupportedSchema("zhizhang/2.7"), true);
  for (const schemaId of ["zhizhang/1.3", "zhizhang/1.4", "zhizhang/3.0", "zhizhang/2", "zhizhang", "other/2.0"]) {
    assert.equal(isSupportedSchema(schemaId), false, schemaId);
  }
});

test("D-02 a store with no schema row and a corrupt store are both refused", async () => {
  await withTmpDir(async (dir) => {
    const empty = join(dir, "empty.db");
    const db = openDatabase(empty);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.close();
    assert.throws(
      () => openStore(empty),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage.format_unsupported" &&
        error.details.reason === "schema-missing",
    );

    const corrupt = join(dir, "corrupt.db");
    await writeFile(corrupt, "this is not a database at all");
    assert.throws(
      () => openStore(corrupt),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage.format_unsupported" &&
        (error.details.reason === "unreadable" || error.details.reason === "schema-unreadable"),
    );
  });
});

test("D-02 a refused store is not left open behind the refusal", async () => {
  await withTmpDir(async (dir) => {
    const outside = foreignStore(dir, "closed.db", "zhizhang/3.0");
    assert.throws(() => openStore(outside), (error) => error instanceof StorageError);
    // The file is not locked, so it can be removed: the handle was closed.
    await rm(outside, { force: true });
  });
});

test("D-02 a backup verifies, and a changed byte or a missing entry makes it unusable", async () => {
  await withTmpDir(async (dir) => {
    const source = freshStore(dir);
    const backupDir = join(dir, "backups", "b1");
    const manifest = await createBackup(source, backupDir);
    assert.equal(manifest.schema, SCHEMA_ID);
    assert.equal(manifest.entries.length, 1);
    assert.equal((await verifyBackup(backupDir)).entries[0].sha256, manifest.entries[0].sha256);
    assert.equal(await isBackupValid(backupDir), true);

    const tampered = join(dir, "backups", "b2");
    await createBackup(source, tampered);
    await writeFile(join(tampered, "work.db"), "tampered bytes");
    assert.equal(await isBackupValid(tampered), false);
    await assert.rejects(
      () => verifyBackup(tampered),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage.format_unsupported" &&
        error.details.reason === "backup-hash-mismatch",
    );

    const incomplete = join(dir, "backups", "b3");
    await createBackup(source, incomplete);
    await rm(join(incomplete, "work.db"));
    assert.equal(await isBackupValid(incomplete), false);
    await assert.rejects(
      () => verifyBackup(incomplete),
      (error) => error.details.reason === "backup-entry-missing",
    );
  });
});

test("D-02 restoring refuses a non-empty target and fills an empty one", async () => {
  await withTmpDir(async (dir) => {
    const source = freshStore(dir);
    const backupDir = join(dir, "backups", "b1");
    await createBackup(source, backupDir);

    const occupied = join(dir, "target-occupied");
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "something.txt"), "author data");
    await assert.rejects(
      () => restoreBackup(backupDir, occupied),
      (error) =>
        error instanceof StorageError &&
        error.code === "input.invalid" &&
        error.details.reason === "restore-target-not-empty",
    );

    const empty = join(dir, "target-empty");
    const restored = await restoreBackup(backupDir, empty);
    assert.equal(restored, empty);
    const reopened = openStore(join(empty, "work.db"));
    reopened.close();
  });
});

test("D-02 the delivery commits inside the transaction and the export is a separate retryable effect", async () => {
  await withTmpDir(async (dir) => {
    const path = freshStore(dir);
    const db = openStore(path);
    createDeliverySchema(db);
    commitDelivery(db, { articleId: "a-1", finalRevisionId: "rev-1", approvalId: "appr-1" });
    assert.deepEqual(pendingExports(db), ["a-1"]);

    // A successful export records the hash and counts one real attempt.
    const first = attemptExport(db, "a-1", () => {});
    assert.equal(first.state, "exported");
    assert.equal(first.wrote, true);
    assert.equal(typeof first.hash, "string");
    assert.deepEqual(pendingExports(db), []);
    const attemptsAfterFirst = db
      .prepare("SELECT export_attempts FROM deliveries WHERE article_id = 'a-1';")
      .get().export_attempts;
    assert.equal(attemptsAfterFirst, 1);

    // Re-running an exported delivery returns early and does not count again.
    const second = attemptExport(db, "a-1", () => {
      throw new Error("must not be called");
    });
    assert.equal(second.state, "exported");
    assert.equal(second.wrote, false);
    assert.equal(second.hash, first.hash);
    assert.equal(
      db.prepare("SELECT export_attempts FROM deliveries WHERE article_id = 'a-1';").get().export_attempts,
      attemptsAfterFirst,
    );

    // A retryable failure keeps it in the worklist.
    commitDelivery(db, { articleId: "a-2", finalRevisionId: "rev-2", approvalId: "appr-2" });
    const failed = attemptExport(db, "a-2", () => {
      throw Object.assign(new Error("transient io"), { retryable: true });
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.retryable, true);
    assert.deepEqual(pendingExports(db), ["a-2"]);

    // A failure the author must resolve leaves the automatic worklist.
    commitDelivery(db, { articleId: "a-3", finalRevisionId: "rev-3", approvalId: "appr-3" });
    attemptExport(db, "a-3", () => {
      throw Object.assign(new Error("target conflict"), { retryable: false });
    });
    assert.deepEqual(reconcileExports(db), { pending: ["a-2"], needsAuthor: ["a-3"] });

    // The committed delivery row survives every failure unchanged.
    const row = db.prepare("SELECT final_revision_id, approval_id FROM deliveries WHERE article_id = 'a-3';").get();
    assert.equal(row.final_revision_id, "rev-3");
    assert.equal(row.approval_id, "appr-3");
    db.close();
  });
});

test("D-02 the export state set is closed and an unknown state is refused", async () => {
  await withTmpDir(async (dir) => {
    const path = freshStore(dir);
    const db = openStore(path);
    createDeliverySchema(db);
    commitDelivery(db, { articleId: "a-1", finalRevisionId: "rev-1", approvalId: "appr-1" });
    db.prepare("UPDATE deliveries SET export_state = 'weird' WHERE article_id = 'a-1';").run();
    assert.throws(
      () => attemptExport(db, "a-1", () => {}),
      (error) =>
        error instanceof StorageError &&
        error.code === "input.invalid" &&
        error.details.reason === "unknown-export-state",
    );
    db.close();
    assert.deepEqual([...EXPORT_STATES].sort(), ["exported", "failed", "pending"]);
  });
});

test("D-02 an export for an unknown delivery is not found", async () => {
  await withTmpDir(async (dir) => {
    const path = freshStore(dir);
    const db = openStore(path);
    createDeliverySchema(db);
    assert.throws(
      () => attemptExport(db, "missing", () => {}),
      (error) =>
        error instanceof StorageError &&
        error.code === "input.not_found" &&
        error.details.objectType === "delivery" &&
        error.details.objectId === "missing",
    );
    db.close();
  });
});

test("D-02 retention keeps the newest valid backups and never leaves zero", () => {
  const newest = { id: "2026-11-19T10-00", valid: true };
  const older = { id: "2026-11-18T10-00", valid: true };
  const invalid = { id: "2026-11-17T10-00", valid: false };
  const all = [newest, older, invalid];

  const keepTwo = planRetention(all, { keep: 2 });
  assert.deepEqual(keepTwo.kept, [newest, older]);
  assert.deepEqual(keepTwo.deleted, [invalid]);
  assert.deepEqual(keepTwo.refused, []);

  const keepZero = planRetention(all, { keep: 0 });
  assert.deepEqual(keepZero.kept, [newest]);
  assert.deepEqual(keepZero.refused, [newest.id]);
  assert.deepEqual(keepZero.deleted, [older, invalid]);

  // An invalid backup is never a copy, so it never satisfies the floor.
  const onlyInvalid = planRetention([invalid], { keep: 3 });
  assert.deepEqual(onlyInvalid.kept, []);
  assert.deepEqual(onlyInvalid.refused, []);

  assert.throws(
    () => planRetention(all, { keep: -1 }),
    (error) => error instanceof StorageError && error.code === "input.invalid",
  );
  assert.throws(
    () => planRetention(all, { keep: 1.5 }),
    (error) => error instanceof StorageError && error.code === "input.invalid",
  );
});

test("D-02 pruning deletes what the plan says and reports the refused floor", async () => {
  await withTmpDir(async (dir) => {
    const source = freshStore(dir);
    const root = join(dir, "backups");
    await createBackup(source, join(root, "2026-11-19T10-00"));
    await createBackup(source, join(root, "2026-11-18T10-00"));
    await createBackup(source, join(root, "2026-11-17T10-00"));

    const listed = await listBackups(root);
    assert.equal(listed.length, 3);
    assert.equal(listed[0].id, "2026-11-19T10-00", "newest first");

    const plan = await pruneBackups(root, { keep: 2 });
    assert.deepEqual(plan.deleted.map((entry) => entry.id), ["2026-11-17T10-00"]);
    const after = await listBackups(root);
    assert.equal(after.length, 2);
    assert.equal(after.every((entry) => entry.valid), true);

    // With keep 0 the newest valid backup still survives and is reported.
    const floored = await pruneBackups(root, { keep: 0 });
    assert.deepEqual(floored.refused, ["2026-11-19T10-00"]);
    const remaining = await listBackups(root);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "2026-11-19T10-00");
    assert.equal(remaining[0].valid, true);
  });
});

test("D-02 the retention default stays a proposal until the author confirms it", () => {
  assert.equal(PROPOSED_BACKUP_RETENTION, 7);
});

test("D-02 a backup of a store outside the window is still a faithful copy", async () => {
  await withTmpDir(async (dir) => {
    const outside = foreignStore(dir, "outside.db", "zhizhang/1.3");
    const backupDir = join(dir, "backups", "old");
    const manifest = await createBackup(outside, backupDir);
    assert.equal(manifest.schema, "zhizhang/1.3");
    // The copy is faithful, but opening it is still refused.
    assert.equal(await isBackupValid(backupDir), true);
    assert.throws(() => openStore(join(backupDir, "work.db")), (error) => error instanceof StorageError);
  });
});

test("D-02 a store reopened after close keeps its contents", async () => {
  await withTmpDir(async (dir) => {
    const path = freshStore(dir);
    const writer = openStore(path);
    writer.exec("CREATE TABLE items (id TEXT PRIMARY KEY);");
    writer.prepare("INSERT INTO items (id) VALUES (?);").run("one");
    writer.close();

    const reader = openStore(path);
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM items;").get().n, 1);
    reader.close();

    // A copy taken while closed restores into an empty target.
    const backupDir = join(dir, "backups", "b1");
    await createBackup(path, backupDir);
    const target = join(dir, "restored");
    await restoreBackup(backupDir, target);
    const restored = openStore(join(target, "work.db"));
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM items;").get().n, 1);
    restored.close();
  });
});
