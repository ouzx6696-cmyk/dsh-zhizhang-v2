import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openAuthorWorkspace } from "../src/host/index.ts";
import {
  backupWorkspace,
  createBackup,
  isBackupValid,
  listBackups,
  planRetention,
  pruneBackups,
  restoreWorkspace,
  verifyBackup,
} from "../src/storage/backup.ts";
import { createStore, openStore, StorageError } from "../src/storage/index.ts";
import { withTempDir } from "../support/v2-harness.mjs";

function populateHostDir(hostDir) {
  const deliveriesDir = join(hostDir, "deliveries");
  mkdirSync(deliveriesDir, { recursive: true });
  const dbPath = join(hostDir, "workspace.sqlite");
  createStore(dbPath);
  const db = openStore(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  let deliveredPath = "";
  let deliveredBody = "";
  try {
    const app = openAuthorWorkspace(db, (id, body) => {
      deliveredPath = join(deliveriesDir, `${id}.md`);
      deliveredBody = body;
      writeFileSync(deliveredPath, body, "utf8");
    });

    // Fanqie project + draft + approved setting
    const np = app.mutation("project.create", { product: "fanqie", name: "灾备长篇" }).id;
    const nc = app.mutation("document.create", { projectId: np, title: "序章" }).id;
    app.mutation("draft.save", { documentId: nc, baseRevisionId: null, body: "番茄备份正文。" });
    const prop = app.mutation("setting.propose", {
      projectId: np,
      documentId: nc,
      factId: "secret-key",
      note: "钥匙藏在钟表里",
      source: "笔记本",
      from: { chapterId: nc, point: 1 },
      people: [{ character: "林" }],
    });
    app.mutation("setting.decide", { projectId: np, documentId: nc, proposalId: prop.id, accept: true });

    // Toutiao project + full delivery to <uuid>.md
    const tp = app.mutation("project.create", { product: "toutiao", name: "灾备头条" }).id;
    const ta = app.mutation("document.create", { projectId: tp, title: "备份短评", mode: "short", line: "资讯线" }).id;
    const tr = app.mutation("draft.save", { documentId: ta, baseRevisionId: null, body: "头条".repeat(600) }).revisionId;
    app.mutation("article.qa", { documentId: ta, baseRevisionId: tr, score: 88, passed: true, fails: [] });
    app.mutation("article.accept", { documentId: ta, baseRevisionId: tr, accept: true });
    app.mutation("approval.decide", { documentId: ta, baseRevisionId: tr, confirmed: true });
    const exportOutcome = app.mutation("article.deliver", { documentId: ta, baseRevisionId: tr, key: "bak-deliv" });
    assert.equal(exportOutcome.state, "exported");

    // Non-UUID stray file should be ignored by backup manifest.
    writeFileSync(join(deliveriesDir, "notes.txt"), "non-uuid-stray-file", "utf8");

    return { np, nc, tp, ta, deliveredPath, deliveredBody };
  } finally {
    // Closing the final WAL connection checkpoints all frames into workspace.sqlite.
    db.close();
  }
}

test("backupWorkspace and restoreWorkspace roundtrip host SQLite + UUID deliveries cleanly and verify schema + quick_check", async () => {
  await withTempDir("zhizhang-backup-rt-", async (root) => {
    const srcDir = join(root, "live");
    const backupDir = join(root, "snap-1");
    const restoreDir = join(root, "restored");

    const { np, nc, tp, ta, deliveredBody } = populateHostDir(srcDir);
    const manifest = await backupWorkspace(srcDir, backupDir);

    assert.equal(manifest.entries.length, 2);
    assert.equal(manifest.entries[0].path, "work.db");
    assert.match(manifest.entries[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.entries[1].path, `deliveries/${ta}.md`);
    assert.equal(existsSync(join(backupDir, "deliveries", "notes.txt")), false);

    assert.equal(await isBackupValid(backupDir), true);
    const verified = await verifyBackup(backupDir);
    assert.equal(verified.schema, manifest.schema);

    await restoreWorkspace(backupDir, restoreDir);
    assert.equal(readFileSync(join(restoreDir, "deliveries", `${ta}.md`), "utf8"), deliveredBody);

    const restoredDb = openStore(join(restoreDir, "workspace.sqlite"));
    try {
      const restoredApp = openAuthorWorkspace(restoredDb, () => {});
      const fanqieSnap = restoredApp.snapshot(np, nc);
      assert.equal(fanqieSnap.active.body, "番茄备份正文。");
      assert.equal(
        restoredApp.mutation("settings.read", { projectId: np, character: "林", at: { chapterId: nc, point: 1 } }).entries[0].note,
        "钥匙藏在钟表里",
      );
      const toutiaoSnap = restoredApp.snapshot(tp, ta);
      assert.equal(toutiaoSnap.active.state, "已交稿");
      assert.equal(toutiaoSnap.exportStatus.state, "exported");
      assert.equal(toutiaoSnap.delivery, deliveredBody);
    } finally {
      restoredDb.close();
    }
  });
});

test("backup verification rejects tampered work.db, tampered or missing delivery files, malformed manifests, and non-empty restore targets", async () => {
  await withTempDir("zhizhang-backup-tamper-", async (root) => {
    const srcDir = join(root, "live");
    const { ta } = populateHostDir(srcDir);

    const dbTamperDir = join(root, "bak-db-tamper");
    await backupWorkspace(srcDir, dbTamperDir);
    const dbBytes = readFileSync(join(dbTamperDir, "work.db"));
    dbBytes[0] = dbBytes[0] ^ 0xff;
    writeFileSync(join(dbTamperDir, "work.db"), dbBytes);
    await assert.rejects(
      restoreWorkspace(dbTamperDir, join(root, "restore-1")),
      (err) => err instanceof StorageError && err.code === "storage.format_unsupported" && err.details.reason === "backup-hash-mismatch",
    );

    const mdTamperDir = join(root, "bak-md-tamper");
    await backupWorkspace(srcDir, mdTamperDir);
    writeFileSync(join(mdTamperDir, "deliveries", `${ta}.md`), "被篡改的交稿内容", "utf8");
    await assert.rejects(
      restoreWorkspace(mdTamperDir, join(root, "restore-2")),
      (err) => err instanceof StorageError && err.code === "storage.format_unsupported" && err.details.reason === "backup-hash-mismatch",
    );

    const missingEntryDir = join(root, "bak-missing-md");
    await backupWorkspace(srcDir, missingEntryDir);
    rmSync(join(missingEntryDir, "deliveries", `${ta}.md`));
    await assert.rejects(
      verifyBackup(missingEntryDir),
      (err) => err instanceof StorageError && err.code === "storage.format_unsupported" && err.details.reason === "backup-entry-missing",
    );

    const badManifestDir = join(root, "bak-bad-manifest");
    await backupWorkspace(srcDir, badManifestDir);
    writeFileSync(
      join(badManifestDir, "manifest.json"),
      JSON.stringify({
        schema: "zhizhang/2.1",
        entries: [{ path: "../escape.md", sha256: "0".repeat(64) }],
      }),
      "utf8",
    );
    await assert.rejects(
      verifyBackup(badManifestDir),
      (err) => err instanceof StorageError && err.code === "storage.format_unsupported" && err.details.reason === "backup-manifest-unreadable",
    );

    const validDir = join(root, "bak-valid");
    await backupWorkspace(srcDir, validDir);
    const existingTarget = join(root, "already-exists");
    mkdirSync(existingTarget);
    await assert.rejects(backupWorkspace(srcDir, existingTarget), { code: "EEXIST" });
    await assert.rejects(restoreWorkspace(validDir, existingTarget), { code: "EEXIST" });
  });
});

test("pruneBackups deletes oldest or corrupted backups while refusing to leave zero valid backups", async () => {
  await withTempDir("zhizhang-backup-prune-", async (root) => {
    const dbFile = join(root, "source.db");
    createStore(dbFile);
    const backupsRoot = join(root, "backups");
    mkdirSync(backupsRoot);

    for (const id of ["2026-11-18", "2026-11-19", "2026-11-20"]) {
      await createBackup(dbFile, join(backupsRoot, id));
    }
    const corruptDir = join(backupsRoot, "2026-11-21");
    mkdirSync(corruptDir);
    writeFileSync(join(corruptDir, "manifest.json"), "{corrupt", "utf8");

    const initialList = await listBackups(backupsRoot);
    assert.deepEqual(initialList, [
      { id: "2026-11-21", valid: false },
      { id: "2026-11-20", valid: true },
      { id: "2026-11-19", valid: true },
      { id: "2026-11-18", valid: true },
    ]);

    const firstPass = await pruneBackups(backupsRoot, { keep: 2 });
    assert.deepEqual(firstPass.kept.map((b) => b.id), ["2026-11-20", "2026-11-19"]);
    assert.deepEqual(firstPass.deleted.map((b) => b.id), ["2026-11-21", "2026-11-18"]);
    assert.deepEqual(firstPass.refused, []);
    assert.equal(existsSync(join(backupsRoot, "2026-11-21")), false);
    assert.equal(existsSync(join(backupsRoot, "2026-11-18")), false);

    const zeroPass = await pruneBackups(backupsRoot, { keep: 0 });
    assert.deepEqual(zeroPass.kept.map((b) => b.id), ["2026-11-20"]);
    assert.deepEqual(zeroPass.deleted.map((b) => b.id), ["2026-11-19"]);
    assert.deepEqual(zeroPass.refused, ["2026-11-20"]);
    assert.equal(existsSync(join(backupsRoot, "2026-11-20")), true);
    assert.equal(existsSync(join(backupsRoot, "2026-11-19")), false);

    assert.throws(
      () => planRetention([{ id: "2026-11-20", valid: true }], { keep: -1 }),
      (err) => err instanceof StorageError && err.code === "input.invalid" && err.details.reason === "invalid-retention",
    );
  });
});
