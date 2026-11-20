import assert from "node:assert/strict";
import test from "node:test";
import { assertThrowsContract, createTestWorkspace } from "../support/v2-harness.mjs";

test("Fanqie 3-tier volume/act/chapter hierarchy flattens deterministically, updates navigation read model, and enforces empty-delete guards", (t) => {
  const ws = createTestWorkspace(t);
  const { id: projectId } = ws.app.mutation("project.create", { product: "fanqie", name: "长风录" });

  const v1 = ws.app.mutation("volume.create", { projectId, title: "第一卷 · 山雨", goal: "立主角与悬念" });
  const v2 = ws.app.mutation("volume.create", { projectId, title: "第二卷 · 入京" });
  const a1 = ws.app.mutation("act.create", { projectId, volumeId: v1.id, title: "第一幕 · 匿名信" });
  const a2 = ws.app.mutation("act.create", { projectId, volumeId: v1.id, title: "第二幕 · 离村" });

  const c1 = ws.app.mutation("document.create", { projectId, title: "第一章 惊变", volumeId: v1.id, actId: a1.id }).id;
  const c2 = ws.app.mutation("document.create", { projectId, title: "第二章 启程", volumeId: v1.id, actId: a2.id }).id;
  const c3 = ws.app.mutation("document.create", { projectId, title: "第三章 城门", volumeId: v2.id }).id;

  const rev1 = ws.app.mutation("draft.save", { documentId: c1, baseRevisionId: null, body: "正文第一段\n第二段" }).revisionId;
  ws.app.mutation("chapter.summary.save", { documentId: c1, summary: "林在雨夜收到匿名信。" });

  const snap = ws.app.snapshot(projectId, c1);
  assert.deepEqual(
    snap.documents.map((d) => ({ ...d })),
    [
      { id: c1, title: "第一章 惊变" },
      { id: c2, title: "第二章 启程" },
      { id: c3, title: "第三章 城门" },
    ],
  );
  assert.equal(snap.activeContext.volumeTitle, "第一卷 · 山雨");
  assert.equal(snap.activeContext.actTitle, "第一幕 · 匿名信");
  assert.equal(snap.activeContext.charCount, 8);
  assert.equal(snap.activeContext.summary, "林在雨夜收到匿名信。");

  const tree = ws.app.mutation("tree.get", { projectId });
  assert.equal(tree.volumes.length, 2);
  assert.equal(tree.acts.length, 2);
  assert.equal(tree.chapters.length, 3);
  assert.equal(tree.totalChars, 8);

  // Deleting non-empty volume or act is refused
  assertThrowsContract(() => ws.app.mutation("volume.delete", { projectId, volumeId: v1.id }), "gate.denied", {
    reason: "volume-not-empty",
  });
  assertThrowsContract(() => ws.app.mutation("act.delete", { projectId, actId: a1.id }), "gate.denied", {
    reason: "act-not-empty",
  });

  // Navigation read model reflects real multi-volume structure cleanly
  const nav = ws.app.mutation("read.model", { projectId, model: "navigation" });
  assert.equal(nav.asOfSeq, snap.asOfSeq);
  assert.equal(nav.value.volumes.length, 2);
  assert.equal(nav.value.volumes[0].title, "第一卷 · 山雨");
  assert.equal(nav.value.volumes[0].chapters.length, 2);
  assert.equal(nav.value.volumes[1].chapters[0].chapterId, c3);
  assert.ok(rev1);
});

test("chapter.move enforces reorder impact preview, asOfSeq conflict checks, and updates 1D continuity order", (t) => {
  const ws = createTestWorkspace(t);
  const ch1 = ws.createFanqieChapter({ title: "第一章", body: "第一章内容" });
  const projectId = ch1.projectId;
  const v1 = ws.app.mutation("volume.create", { projectId, title: "卷一" });
  const v2 = ws.app.mutation("volume.create", { projectId, title: "卷二" });
  ws.app.mutation("chapter.move", { documentId: ch1.documentId, targetVolumeId: v1.id, targetActId: null });

  const ch2Id = ws.app.mutation("document.create", { projectId, title: "第二章", volumeId: v2.id }).id;
  const prop = ws.app.mutation("setting.propose", {
    projectId,
    documentId: ch1.documentId,
    factId: "token",
    note: "信物在第二章才被林知晓",
    source: "设定",
    from: { chapterId: ch1.documentId, point: 1 },
    people: [{ character: "林", at: { chapterId: ch2Id, point: 1 } }],
  });
  ws.app.mutation("setting.decide", { projectId, documentId: ch1.documentId, proposalId: prop.id, accept: true });

  // Preview moving ch2 before ch1 into v1 detects temporal flip
  const preview = ws.app.mutation("chapter.move", {
    documentId: ch2Id,
    targetVolumeId: v1.id,
    targetActId: null,
    beforeChapterId: ch1.documentId,
    preview: true,
  });
  assert.equal(preview.requiresAuthorConfirmation, true);
  assert.equal(preview.impact[0].id, "token");
  assert.deepEqual(preview.chapterIds, [ch2Id, ch1.documentId]);

  // Unconfirmed move is denied
  assertThrowsContract(
    () =>
      ws.app.mutation("chapter.move", {
        documentId: ch2Id,
        targetVolumeId: v1.id,
        targetActId: null,
        beforeChapterId: ch1.documentId,
        asOfSeq: preview.asOfSeq,
      }),
    "gate.denied",
    { reason: "author-confirmation-required" },
  );

  // Stale asOfSeq is refused with version.conflict
  assertThrowsContract(
    () =>
      ws.app.mutation("chapter.move", {
        documentId: ch2Id,
        targetVolumeId: v1.id,
        targetActId: null,
        beforeChapterId: ch1.documentId,
        asOfSeq: preview.asOfSeq - 1,
        confirmed: true,
      }),
    "version.conflict",
  );

  // Confirmed move updates volume, order, and deletes now-empty v2 cleanly
  ws.app.mutation("chapter.move", {
    documentId: ch2Id,
    targetVolumeId: v1.id,
    targetActId: null,
    beforeChapterId: ch1.documentId,
    asOfSeq: preview.asOfSeq,
    confirmed: true,
  });
  assert.deepEqual(
    ws.app.snapshot(projectId, ch1.documentId).documents.map((d) => d.id),
    [ch2Id, ch1.documentId],
  );
  assert.deepEqual(ws.app.mutation("volume.delete", { projectId, volumeId: v2.id }), { deleted: v2.id });
});
