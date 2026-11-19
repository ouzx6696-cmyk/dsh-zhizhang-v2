import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RecordedError as StorageError } from "../support/a01.mjs";

// A-01 supporting fixture for the storage lifecycle. The mechanics under test
// are appendix B.10 of contracts.md: a V2-only schema version window, refusal
// of an unreadable or corrupt store instead of half-serving it, a verified
// backup manifest, a restore that never silently overwrites a target, and an
// external delivery export that lives outside the database transaction with a
// retryable, idempotent and reconcilable state machine. **Frozen on 2026-11-19
// as A-class items**: the schema id and the 2.x window, and the export-state
// closed set with its failure classification. Two parts remain open: the
// backup retention count N (B-class, author) and the driver question — host
// SQLite backend versus a Host-managed node:sqlite (Q-05). D-01 already covers
// the transactional half (cold restore, rollback, unknown format refusal).

// The window holds V2's own schema ids only; v1.x ids are never readable. The
// proposed width is the whole V2 major: any zhizhang/2.x id opens, anything
// outside that major is refused.
const SCHEMA_ID = "zhizhang/2.0";
const SUPPORTED_SCHEMAS = new Set([SCHEMA_ID]);
const SCHEMA_WINDOW = /^zhizhang\/2\.\d+$/;

function isSupportedSchema(schemaId) {
  return SUPPORTED_SCHEMAS.has(schemaId) || SCHEMA_WINDOW.test(schemaId);
}

async function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createStore(dir, schemaId = SCHEMA_ID, name = "work.db") {
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?);").run(schemaId);
  db.prepare("INSERT INTO meta (key, value) VALUES ('revision', 'draft-1');").run();
  db.close();
  return file;
}

// Opening refuses an unreadable file, a corrupt one and an unknown schema
// rather than serving a partial view.
function openStore(file) {
  let db;
  try {
    db = new DatabaseSync(file);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema';").get();
    if (!row) throw new StorageError("storage.format_unsupported", { reason: "schema-missing" });
    if (!isSupportedSchema(row.value)) {
      db.close();
      throw new StorageError("storage.format_unsupported", {
        reason: "schema-unsupported",
        schemaId: row.value,
        supported: [...SUPPORTED_SCHEMAS],
      });
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    db?.close();
    throw new StorageError("storage.format_unsupported", { reason: "unreadable" });
  }
  return db;
}

async function createBackup(sourceFile, backupDir) {
  await mkdir(backupDir, { recursive: true });
  await copyFile(sourceFile, join(backupDir, "work.db"));
  const bytes = await readFile(join(backupDir, "work.db"));
  const manifest = {
    schema: SCHEMA_ID,
    entries: [{ path: "work.db", sha256: await sha256Of(bytes) }],
  };
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

// A backup is only usable when every manifest entry is present and its bytes
// still hash to the recorded value.
async function verifyBackup(backupDir) {
  const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
  for (const entry of manifest.entries) {
    let bytes;
    try {
      bytes = await readFile(join(backupDir, entry.path));
    } catch {
      throw new StorageError("storage.format_unsupported", {
        reason: "backup-entry-missing",
        path: entry.path,
      });
    }
    if ((await sha256Of(bytes)) !== entry.sha256) {
      throw new StorageError("storage.format_unsupported", {
        reason: "backup-hash-mismatch",
        path: entry.path,
      });
    }
  }
  return manifest;
}

// Restoring into a target that already holds files is refused unless the
// caller explicitly asks for an overwrite.
async function restoreBackup(backupDir, targetDir, { overwrite = false } = {}) {
  const manifest = await verifyBackup(backupDir);
  let existing = [];
  try {
    existing = await readFile(join(targetDir, "manifest.json"), "utf8").then(
      () => ["manifest.json"],
      () => [],
    );
  } catch {
    existing = [];
  }
  const nonEmpty = existing.length > 0;
  if (nonEmpty && !overwrite) {
    throw new StorageError("input.invalid", { reason: "restore-target-not-empty" });
  }
  await mkdir(targetDir, { recursive: true });
  for (const entry of manifest.entries) {
    await copyFile(join(backupDir, entry.path), join(targetDir, entry.path));
  }
  await writeFile(join(targetDir, "manifest.json"), JSON.stringify(manifest));
  return targetDir;
}

// The delivery commits inside the transaction; the external file export is a
// separate, retryable side effect with its own state.
function createDeliverySchema(db) {
  db.exec(`
    CREATE TABLE deliveries (
      article_id TEXT PRIMARY KEY,
      final_revision_id TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      export_state TEXT NOT NULL,
      export_hash TEXT,
      export_error TEXT,
      export_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function commitDelivery(db, delivery) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO deliveries (article_id, final_revision_id, approval_id, export_state) VALUES (?, ?, ?, 'pending');",
    ).run(delivery.articleId, delivery.finalRevisionId, delivery.approvalId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function exportPayload(row) {
  return `${row.article_id}\n${row.final_revision_id}\n${row.approval_id}\n`;
}

// The export state set is closed: pending (awaiting the external write),
// exported (file written and its hash recorded) and failed (the last attempt
// failed). A failed attempt never touches the committed delivery row.
const EXPORT_STATES = new Set(["pending", "exported", "failed"]);

// A write failure carries whether it is retryable. A transient error is
// retryable; an error the author has to resolve (a conflicting file at the
// target, for instance) is not, and it surfaces instead of retrying forever.
function attemptExport(db, articleId, write) {
  const row = db
    .prepare("SELECT article_id, final_revision_id, approval_id, export_state, export_hash FROM deliveries WHERE article_id = ?;")
    .get(articleId);
  if (!row) {
    throw new StorageError("input.not_found", { objectType: "delivery", objectId: articleId });
  }
  if (!EXPORT_STATES.has(row.export_state)) {
    throw new StorageError("input.invalid", { reason: "unknown-export-state", exportState: row.export_state });
  }
  if (row.export_state === "exported") {
    return { state: "exported", hash: row.export_hash, wrote: false, retryable: null };
  }
  const payload = exportPayload(row);
  try {
    write(payload);
  } catch (error) {
    const retryable = error?.retryable !== false;
    db.prepare(
      "UPDATE deliveries SET export_state = 'failed', export_error = ?, export_attempts = export_attempts + 1 WHERE article_id = ?;",
    ).run(JSON.stringify({ code: error?.code ?? "export.write_failed", retryable }), articleId);
    return { state: "failed", wrote: false, retryable };
  }
  const hash = createHash("sha256").update(payload).digest("hex");
  db.prepare(
    "UPDATE deliveries SET export_state = 'exported', export_hash = ?, export_error = NULL, export_attempts = export_attempts + 1 WHERE article_id = ?;",
  ).run(hash, articleId);
  return { state: "exported", hash, wrote: true, retryable: null };
}

// Every delivery whose export is not done yet: pending ones plus failed ones
// that are still retryable.
function pendingExports(db) {
  return db
    .prepare("SELECT article_id FROM deliveries WHERE export_state IN ('pending', 'failed');")
    .all()
    .map((row) => row.article_id);
}

// The reconciliation report after a restart: what still needs an export, and
// what failed in a way that needs the author.
function reconcileExports(db) {
  const rows = db
    .prepare("SELECT article_id, export_state, export_error FROM deliveries WHERE export_state IN ('pending', 'failed');")
    .all();
  const pending = [];
  const needsAuthor = [];
  for (const row of rows) {
    const error = row.export_error ? JSON.parse(row.export_error) : null;
    if (row.export_state === "failed" && error?.retryable === false) {
      needsAuthor.push(row.article_id);
    } else {
      pending.push(row.article_id);
    }
  }
  return { pending, needsAuthor };
}

// Backup retention: keep the newest valid entries, and never leave the author
// without a valid backup, so a pruning mistake cannot destroy the only copy.
// Invalid backups are always deletable; they are not copies.
function pruneBackups(backups, { keep }) {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new StorageError("input.invalid", { reason: "invalid-retention", keep });
  }
  const kept = [];
  const deleted = [];
  const refused = [];
  let validKept = 0;
  for (const backup of backups) {
    if (backup.valid !== false && validKept < keep) {
      kept.push(backup);
      validKept += 1;
      continue;
    }
    deleted.push(backup);
  }
  // The floor: at least one valid backup survives, and it is the newest one.
  if (validKept === 0) {
    const newestValid = backups.find((backup) => backup.valid !== false);
    if (newestValid) {
      deleted.splice(deleted.indexOf(newestValid), 1);
      kept.push(newestValid);
      refused.push(newestValid.id);
    }
  }
  return { kept, deleted, refused };
}

test("A-01 a store outside the V2 schema window is refused, including a v1.x schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-storage-"));
  try {
    const known = await createStore(dir, SCHEMA_ID);
    const opened = openStore(known);
    assert.equal(
      opened.prepare("SELECT value FROM meta WHERE key = 'revision';").get().value,
      "draft-1",
    );
    opened.close();

    for (const [index, schemaId] of ["zhizhang/3.0", "zhizhang/1.3"].entries()) {
      const file = await createStore(dir, schemaId, `other-${index}.db`);
      assert.throws(
        () => openStore(file),
        (error) =>
          error instanceof StorageError &&
          error.code === "storage.format_unsupported" &&
          error.details.reason === "schema-unsupported" &&
          error.details.schemaId === schemaId,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A-01 the proposed schema window spans the whole V2 major and refuses everything outside it", async () => {
  assert.equal(isSupportedSchema("zhizhang/2.0"), true);
  assert.equal(isSupportedSchema("zhizhang/2.7"), true);
  for (const schemaId of ["zhizhang/1.3", "zhizhang/1.4", "zhizhang/3.0", "zhizhang/2", "zhizhang", "other/2.0"]) {
    assert.equal(isSupportedSchema(schemaId), false, schemaId);
  }
  // A newer minor inside the window still opens and keeps its own id.
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-storage-"));
  try {
    const newer = await createStore(dir, "zhizhang/2.7", "newer.db");
    const opened = openStore(newer);
    assert.equal(
      opened.prepare("SELECT value FROM meta WHERE key = 'schema';").get().value,
      "zhizhang/2.7",
    );
    opened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A-01 a corrupt store is refused instead of being served partially", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-storage-"));
  try {
    const file = await createStore(dir);
    await writeFile(file, "this is not a database at all");
    assert.throws(
      () => openStore(file),
      (error) =>
        error instanceof StorageError && error.code === "storage.format_unsupported",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A-01 a backup whose payload no longer matches its manifest is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-storage-"));
  try {
    const file = await createStore(dir);
    const backupDir = join(dir, "backup");
    await createBackup(file, backupDir);
    await verifyBackup(backupDir);

    await writeFile(join(backupDir, "work.db"), "tampered payload");
    await assert.rejects(
      () => verifyBackup(backupDir),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage.format_unsupported" &&
        error.details.reason === "backup-hash-mismatch",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A-01 a backup missing a manifest entry is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-storage-"));
  try {
    const file = await createStore(dir);
    const backupDir = join(dir, "backup");
    await createBackup(file, backupDir);
    await rm(join(backupDir, "work.db"));
    await assert.rejects(
      () => verifyBackup(backupDir),
      (error) =>
        error instanceof StorageError && error.details.reason === "backup-entry-missing",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A-01 restoring refuses a non-empty target unless the caller asks for an overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-storage-"));
  try {
    const file = await createStore(dir);
    const backupDir = join(dir, "backup");
    await createBackup(file, backupDir);
    const target = join(dir, "restored");

    await restoreBackup(backupDir, target);
    await assert.rejects(
      () => restoreBackup(backupDir, target),
      (error) =>
        error instanceof StorageError &&
        error.code === "input.invalid" &&
        error.details.reason === "restore-target-not-empty",
    );
    await restoreBackup(backupDir, target, { overwrite: true });
    const reopened = openStore(join(target, "work.db"));
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A-01 a failed export keeps the committed delivery, a retryable failure is retried and an author-required failure surfaces instead", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-storage-"));
  try {
    const file = join(dir, "work.db");
    const db = new DatabaseSync(file);
    createDeliverySchema(db);
    commitDelivery(db, {
      articleId: "article-1",
      finalRevisionId: "final-1",
      approvalId: "approval-1",
    });

    // A transient write failure moves the export to failed but leaves the
    // committed delivery row untouched, and nothing is half-written.
    const transient = Object.assign(new Error("disk full"), { retryable: true });
    const failed = attemptExport(db, "article-1", () => {
      throw transient;
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.retryable, true);
    assert.equal(
      db.prepare("SELECT final_revision_id FROM deliveries WHERE article_id = 'article-1';").get()
        .final_revision_id,
      "final-1",
    );
    // A retryable failure stays in the reconciliation list.
    assert.deepEqual(reconcileExports(db), { pending: ["article-1"], needsAuthor: [] });

    // A failure the author has to resolve is not retried forever: it leaves the
    // pending list and surfaces for the author.
    const blocking = Object.assign(new Error("target exists"), { retryable: false });
    const blocked = attemptExport(db, "article-1", () => {
      throw blocking;
    });
    assert.equal(blocked.state, "failed");
    assert.equal(blocked.retryable, false);
    assert.deepEqual(reconcileExports(db), { pending: [], needsAuthor: ["article-1"] });

    // A retry succeeds once and then reports the already-exported state
    // without writing again.
    const written = [];
    const first = attemptExport(db, "article-1", (payload) => written.push(payload));
    assert.equal(first.wrote, true);
    assert.equal(written.length, 1);
    const second = attemptExport(db, "article-1", (payload) => written.push(payload));
    assert.equal(second.wrote, false);
    assert.equal(second.hash, first.hash);
    assert.equal(written.length, 1);
    assert.equal(
      db.prepare("SELECT export_attempts FROM deliveries WHERE article_id = 'article-1';").get()
        .export_attempts,
      3,
    );

    // An unknown delivery is refused rather than silently skipped.
    assert.throws(
      () => attemptExport(db, "article-9", () => {}),
      (error) => error instanceof StorageError && error.code === "input.not_found",
    );

    // After a close and reopen the report still lists a delivery whose export
    // never succeeded.
    commitDelivery(db, {
      articleId: "article-2",
      finalRevisionId: "final-2",
      approvalId: "approval-2",
    });
    db.close();
    const reopened = new DatabaseSync(file);
    assert.deepEqual(reconcileExports(reopened), { pending: ["article-2"], needsAuthor: [] });
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A-01 backup retention prunes to the newest entries and never removes the last valid backup", () => {
  const backups = [
    { id: "b7", createdAt: 7, valid: true },
    { id: "b6", createdAt: 6, valid: true },
    { id: "b5", createdAt: 5, valid: true },
    { id: "b4", createdAt: 4, valid: true },
    { id: "b3", createdAt: 3, valid: false },
    { id: "b2", createdAt: 2, valid: true },
    { id: "b1", createdAt: 1, valid: true },
  ];

  const pruned = pruneBackups(backups, { keep: 3 });
  assert.deepEqual(
    pruned.kept.map((backup) => backup.id),
    ["b7", "b6", "b5"],
  );
  assert.deepEqual(
    pruned.deleted.map((backup) => backup.id),
    ["b4", "b3", "b2", "b1"],
  );
  assert.deepEqual(pruned.refused, []);

  // A retention of zero cannot remove every backup: the newest valid one stays.
  const none = pruneBackups(backups, { keep: 0 });
  assert.deepEqual(
    none.kept.map((backup) => backup.id),
    ["b7"],
  );
  assert.deepEqual(
    none.deleted.map((backup) => backup.id),
    ["b6", "b5", "b4", "b3", "b2", "b1"],
  );
  assert.deepEqual(none.refused, ["b7"]);

  // An invalid backup is not a copy: it is always deletable, and the newest
  // valid one is kept instead.
  const onlyValid = pruneBackups(
    [
      { id: "c1", createdAt: 1, valid: false },
      { id: "c2", createdAt: 2, valid: true },
    ],
    { keep: 1 },
  );
  assert.deepEqual(
    onlyValid.kept.map((backup) => backup.id),
    ["c2"],
  );
  assert.deepEqual(
    onlyValid.deleted.map((backup) => backup.id),
    ["c1"],
  );
  assert.deepEqual(onlyValid.refused, []);

  // A nonsensical retention is refused rather than applied.
  assert.throws(
    () => pruneBackups(backups, { keep: -1 }),
    (error) => error instanceof StorageError && error.details.reason === "invalid-retention",
  );
});
