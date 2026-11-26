import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractError } from "../src/contracts/index.ts";
import { applyWorkbench } from "../src/host/plugin.ts";
import { writeDeliveryFile } from "../src/host/delivery-io.ts";
import {
  createBackup,
  createHotBackup,
  isBackupValid,
  planRetention,
  pruneBackups,
  restoreBackup,
  verifyBackup,
} from "../src/storage/index.ts";
import { assertRejectsContract, createMockDsHHost, createTestWorkspace, withTempDir } from "../support/harness.mjs";

test("offline & online backups verify SHA-256 integrity, detect tampering, and guard non-empty restore targets", async (t) => {
  const ws = createTestWorkspace(t, { mode: "file", wal: true });
  ws.createFanqieChapter({ projectName: "备份验证书", title: "第一章", body: "必须完整留存的正文。" });

  await withTempDir("zhizhang-backup-", async (backupRoot) => {
    const hotDir = join(backupRoot, "hot-1");
    await createHotBackup(ws.db, hotDir);
    const manifest = await verifyBackup(hotDir);
    assert.equal(manifest.schema, "zhizhang/3.0");
    assert.equal(await isBackupValid(hotDir), true);

    // Restore into a fresh directory succeeds
    const restoreDir = join(backupRoot, "restored");
    await restoreBackup(hotDir, restoreDir);

    // Non-empty restore target is refused
    await assertRejectsContract(() => restoreBackup(hotDir, restoreDir), "input.invalid");

    // Tampering with backed-up store invalidates SHA-256 manifest
    writeFileSync(join(hotDir, "work.db"), "corrupted-bytes");
    assert.equal(await isBackupValid(hotDir), false);
  });
});

test("retention planner and pruneBackups never delete the last valid backup", async (t) => {
  const ws = createTestWorkspace(t, { mode: "file", wal: false });
  ws.createFanqieChapter({ title: "第一章", body: "归档测试" });
  const sourceDb = ws.dbFile;
  ws.db.close();

  await withTempDir("zhizhang-prune-", async (backupRoot) => {
    const b1 = join(backupRoot, "backup-2026-01-01");
    const b2 = join(backupRoot, "backup-2026-01-02");
    await createBackup(sourceDb, b1);
    await createBackup(sourceDb, b2);

    const plan = planRetention(
      [
        { id: "backup-2026-01-02", valid: true },
        { id: "backup-2026-01-01", valid: true },
      ],
      { keep: 1 },
    );
    assert.equal(plan.kept.length, 1);
    assert.equal(plan.deleted.length, 1);

    const pruned = await pruneBackups(backupRoot, { keep: 0 });
    assert.equal(pruned.kept.length, 1);
    assert.equal(pruned.refused.length, 1);
    assert.equal(await isBackupValid(b2), true);
  });
});

test("Fanqie project bundle export/import and Markdown skill importer round-trip cleanly", (t) => {
  const ws = createTestWorkspace(t);
  const { projectId, documentId } = ws.createFanqieChapter({
    projectName: "导出回环书",
    title: "第一章 初遇",
    body: "导出回环正文内容。",
  });
  ws.app.mutation("setting.propose", {
    projectId,
    documentId,
    factId: "world-rule",
    note: "北境冬夜长于夏昼。",
    source: "设定集",
    from: { chapterId: documentId, point: 1 },
    people: [],
  });
  const setting = ws.app.snapshot(projectId, documentId).settings[0];
  ws.app.mutation("setting.decide", { projectId, documentId, proposalId: setting.id, accept: true });

  // Export bundle (in-memory files payload)
  const exported = ws.app.mutation("project.export_bundle", { projectId });
  assert.ok(Array.isArray(exported.files));
  assert.ok(exported.files.length >= 2);

  // Import bundle into a fresh project
  const imported = ws.app.mutation("project.import_bundle", {
    name: "导入副本书",
    files: exported.files,
  });
  assert.ok(imported.projectId);
  assert.notEqual(imported.projectId, projectId);
  const importedTree = ws.app.mutation("tree.get", { projectId: imported.projectId });
  assert.equal(importedTree.chapters.length, 1);

  // Import Markdown skill card
  const skill = ws.app.mutation("skill.import", {
    projectId: imported.projectId,
    skillMd: `---\ntitle: 黄金三章钩子\ncategory: opening\npacing: 快爽\n---\n前 300 字必须抛出主角核心危机。`,
  });
  assert.ok(skill.card.id);
  assert.equal(skill.preview.title, "黄金三章钩子");
});

test("writeDeliveryFile enforces strict directory confinement and atomic publish semantics", async () => {
  await withTempDir("zhizhang-delivery-", async (dir) => {
    writeDeliveryFile(dir, "deliv-2026_01", "# 定稿正文\n");
    assert.equal(readFileSync(join(dir, "deliv-2026_01.md"), "utf8"), "# 定稿正文\n");
    // Idempotent rewrite with identical contents succeeds
    writeDeliveryFile(dir, "deliv-2026_01", "# 定稿正文\n");
    // Conflicting overwrite throws export.conflict
    assert.throws(
      () => writeDeliveryFile(dir, "deliv-2026_01", "# 篡改正文\n"),
      (err) => err?.code === "export.conflict",
    );
    // Path-escaping or malformed IDs are rejected before touching disk
    for (const badId of ["../escape", "nested/file", "a\\b", ".hidden", "", "a..b"]) {
      assert.throws(
        () => writeDeliveryFile(dir, badId, "escape"),
        (err) => err instanceof ContractError && err.code === "input.invalid",
      );
    }
    assert.equal(existsSync(join(dir, "..", "escape.md")), false);
  });
});

test("Large projects import atomically and export finalized text in chapter order", async () => {
  await withTempDir("zhizhang-chunked-import-", async (dataDirectory) => {
    const host = createMockDsHHost();
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const files = Array.from({ length: 300 }, (_, i) => ({
        path: `卷一/${String(i + 1).padStart(3, "0")}_第${i + 1}章.md`,
        content: "窗外雨声。".repeat(500),
      }));
      const payload = JSON.stringify({ projectName: "长篇样本", files });
      assert.ok(Buffer.byteLength(payload) > 2 * 1024 * 1024);
      const chunks = payload.match(/[\s\S]{1,192000}/gu);
      const uploadId = randomUUID();
      const send = (chunkIndex, chunk = chunks[chunkIndex]) => host.command("project.import_bundle", {
        uploadId, chunkIndex, chunkCount: chunks.length, chunk,
      });
      const commit = () => host.command("project.import_bundle", { uploadId, commit: true });

      assert.equal((await send(0)).status, 200);
      assert.equal((await send(0)).status, 200);
      assert.equal((await send(0, "改变重传内容")).body.details.reason, "import-upload-mismatch");
      assert.equal((await commit()).body.details.reason, "import-upload-incomplete");
      assert.equal((await host.getState()).body.result.projects.length, 0);
      for (let i = 1; i < chunks.length; i++) assert.equal((await send(i)).status, 200);

      const imported = await commit();
      assert.equal(imported.status, 200);
      assert.equal(imported.body.result.chaptersCreated, 300);
      assert.deepEqual((await commit()).body.result, imported.body.result);
      const { projectId } = imported.body.result;
      const { chapters } = (await host.command("tree.get", { projectId })).body.result;
      assert.deepEqual([chapters[0].title, chapters.at(-1).title], ["第1章", "第300章"]);
      assert.equal((await host.getState()).body.result.projects.length, 1);

      const exportFinal = () => host.command("project.export_bundle", { projectId, format: "final_text" });
      assert.equal((await exportFinal()).body.details.reason, "no-final-chapters");
      for (const chapter of [chapters.at(-1), chapters[0]]) {
        const { revisionId } = (await host.getState({ projectId, documentId: chapter.id })).body.result.active;
        const input = { documentId: chapter.id, baseRevisionId: revisionId };
        assert.equal((await host.command("chapter.review", { ...input, accept: true })).status, 200);
        assert.equal((await host.command("draft.finalize", { ...input, key: chapter.id })).status, 200);
      }
      const [{ content }] = (await exportFinal()).body.result.files;
      assert.match(content, /^第1章\n/);
      assert.match(content, /\n第300章\n/);
      assert.doesNotMatch(content, /\n第2章\n/);
    } finally {
      await host.close();
    }
  });
});
