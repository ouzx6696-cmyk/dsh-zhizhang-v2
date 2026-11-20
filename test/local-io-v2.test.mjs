import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyWorkbench } from "../src/host/plugin.ts";
import { assertThrowsContract, createMockDsHHost, createTestWorkspace, withTempDir } from "../support/v2-harness.mjs";

test("local bundle export/import roundtrips 3-tier Markdown tree, protects final chapters and locked lore, and blocks traversal", (t) => {
  const ws = createTestWorkspace(t);
  const { id: srcProjId } = ws.app.mutation("project.create", { product: "fanqie", name: "原书工程" });
  const v1 = ws.app.mutation("volume.create", { projectId: srcProjId, title: "第一卷" });
  const a1 = ws.app.mutation("act.create", { projectId: srcProjId, volumeId: v1.id, title: "第一幕" });
  const ch1 = ws.app.mutation("document.create", { projectId: srcProjId, title: "楔子", volumeId: v1.id, actId: a1.id }).id;
  const ch2 = ws.app.mutation("document.create", { projectId: srcProjId, title: "第一章", volumeId: v1.id, actId: a1.id }).id;

  const r1 = ws.app.mutation("draft.save", { documentId: ch1, baseRevisionId: null, body: "楔子定稿正文。" }).revisionId;
  ws.app.mutation("chapter.review", { documentId: ch1, baseRevisionId: r1, accept: true });
  ws.app.mutation("draft.finalize", { documentId: ch1, baseRevisionId: r1 });

  ws.app.mutation("draft.save", { documentId: ch2, baseRevisionId: null, body: "第一章原初稿。" });
  ws.app.mutation("chapter.summary.save", { documentId: ch2, summary: "第一章简介" });

  const prop = ws.app.mutation("setting.propose", {
    projectId: srcProjId,
    documentId: ch1,
    factId: "locked-rule",
    category: "world_rule",
    note: "不可改写的世界法则",
    source: "设定集",
    locked: true,
    from: { chapterId: ch1, point: 1 },
  });
  ws.app.mutation("setting.decide", { projectId: srcProjId, documentId: ch1, proposalId: prop.id, accept: true });

  const tech = ws.app.mutation("technique.save", {
    scope: "global",
    title: "导出测试技法",
    executionSteps: "保持节拍",
  });
  ws.app.mutation("library.mount", {
    projectId: srcProjId,
    targetType: "project",
    targetId: srcProjId,
    itemKind: "technique",
    itemId: tech.id,
  });

  // 1. Export full bundle
  const bundle = ws.app.mutation("project.export_bundle", { projectId: srcProjId });
  assert.ok(bundle.files.some((f) => f.path === "zhizhang-project.json"));
  assert.ok(bundle.files.some((f) => f.path.startsWith("01_第一卷/01_第一幕/") && f.path.endsWith(".md")));
  assert.ok(bundle.files.some((f) => f.path === "_worldbook/settings.md"));
  assert.ok(bundle.files.some((f) => f.path === "_library/techniques.md"));

  // 2. Import into existing project with modified files -> final ch1 skipped, ch2 updated, locked lore not overwritten
  const modifiedFiles = bundle.files.map((f) => {
    if (f.path.includes("楔子")) return { path: f.path, content: f.content.replace("楔子定稿正文。", "企图篡改定稿") };
    if (f.path.includes("第一章")) return { path: f.path, content: f.content.replace("第一章原初稿。", "第一章本地修订稿。") };
    return { path: f.path, content: f.content };
  });
  const mergeSummary = ws.app.mutation("project.import_bundle", { projectId: srcProjId, files: modifiedFiles });
  assert.deepEqual(mergeSummary.chaptersSkippedLocked, [ch1]);
  assert.equal(mergeSummary.chaptersUpdated, 1);
  assert.equal(ws.app.snapshot(srcProjId, ch1).active.body, "楔子定稿正文。");
  assert.equal(ws.app.snapshot(srcProjId, ch2).active.body, "第一章本地修订稿。");

  // 3. Import into a brand new project -> preserves tree, bodies, and leaves lore as pending proposals
  const freshSummary = ws.app.mutation("project.import_bundle", { projectName: "克隆新书", files: bundle.files });
  assert.notEqual(freshSummary.projectId, srcProjId);
  assert.equal(freshSummary.volumesCreated, 1);
  assert.equal(freshSummary.actsCreated, 1);
  assert.equal(freshSummary.chaptersCreated, 2);
  assert.equal(freshSummary.loreProposed, 1);
  const newTree = ws.app.mutation("tree.get", { projectId: freshSummary.projectId });
  assert.equal(newTree.chapters.length, 2);

  // 4. Reject path traversal attempts
  for (const evilPath of ["../escape.md", "/etc/passwd", "C:\\Windows\\win.ini", "vol/../secret.md", "bad\0.md"]) {
    assertThrowsContract(
      () => ws.app.mutation("project.import_bundle", { files: [{ path: evilPath, content: "x" }] }),
      "input.invalid",
    );
  }
});

test("host plugin writes local Markdown bundle atomically under authorized exports directory", async () => {
  await withTempDir("zhizhang-export-bundle-", async (dataDirectory) => {
    const host = createMockDsHHost();
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const projectId = (await host.mutate("project.create", { name: "盘上工程", product: "fanqie" })).body.result.id;
      const docId = (await host.mutate("document.create", { projectId, title: "首章" })).body.result.id;
      await host.mutate("draft.save", { documentId: docId, baseRevisionId: null, body: "硬盘落盘正文。" });

      const res = (await host.mutate("project.export_bundle", { projectId, writeToDisk: true })).body.result;
      assert.ok(res.writtenDirectory);
      assert.equal(existsSync(join(res.writtenDirectory, "zhizhang-project.json")), true);
      assert.equal(existsSync(join(res.writtenDirectory, "export-manifest.json")), true);
      const mdEntry = res.files.find((f) => f.path.endsWith(".md") && !f.path.startsWith("_"));
      assert.ok(readFileSync(join(res.writtenDirectory, mdEntry.path), "utf8").includes("硬盘落盘正文。"));
    } finally {
      await host.close();
    }
  });
});
