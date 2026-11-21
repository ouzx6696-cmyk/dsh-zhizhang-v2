import assert from "node:assert/strict";
import test from "node:test";
import { assertThrowsContract, createTestWorkspace } from "../support/v2-harness.mjs";

function secondChapter(ws, projectId) {
  return ws.app.mutation("document.create", { projectId, title: "第二章" }).id;
}

function readForeshadow(ws, projectId, id) {
  return ws.app.mutation("foreshadow.list", { projectId }).find((row) => row.id === id);
}

test("FQ-08 foreshadow.patch enforces the lifecycle matrix on a live row", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  const ch2 = secondChapter(ws, chapter.projectId);

  const created = ws.app.mutation("foreshadow.create", {
    projectId: chapter.projectId,
    title: "银色怀表",
    status: "planted",
    plantedChapterId: chapter.documentId,
    plantedPoint: 3,
    targetChapterId: ch2,
  });

  const resolved = ws.app.mutation("foreshadow.patch", {
    projectId: chapter.projectId,
    id: created.id,
    status: "resolved",
    resolvedChapterId: ch2,
  });
  assert.equal(resolved.status, "resolved");

  assertThrowsContract(
    () => ws.app.mutation("foreshadow.patch", { projectId: chapter.projectId, id: created.id, status: "planted" }),
    "gate.denied",
    { action: "foreshadow.transition", from: "resolved", to: "planted", reason: "reopen-required" },
  );

  const reopened = ws.app.mutation("foreshadow.patch", {
    projectId: chapter.projectId,
    id: created.id,
    status: "planted",
    reopen: true,
  });
  assert.equal(reopened.status, "planted");

  assertThrowsContract(
    () => ws.app.mutation("foreshadow.patch", { projectId: chapter.projectId, id: created.id, status: "proposed" }),
    "gate.denied",
    { action: "foreshadow.transition", from: "planted", to: "proposed", reason: "planted → proposed" },
  );
});

test("FQ-08 a resolve keeps the target chapter and planted point intact", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  const ch2 = secondChapter(ws, chapter.projectId);
  const created = ws.app.mutation("foreshadow.create", {
    projectId: chapter.projectId,
    title: "刻字",
    status: "planted",
    plantedChapterId: chapter.documentId,
    plantedPoint: 3,
    targetChapterId: ch2,
  });

  ws.app.mutation("foreshadow.patch", {
    projectId: chapter.projectId,
    id: created.id,
    status: "resolved",
    resolvedChapterId: ch2,
  });

  const resolved = readForeshadow(ws, chapter.projectId, created.id);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.targetChapterId, ch2);
  assert.equal(resolved.plantedPoint, 3);
  assert.equal(resolved.resolvedChapterId, ch2);

  const noted = ws.app.mutation("foreshadow.patch", {
    projectId: chapter.projectId,
    id: created.id,
    note: "回收后再补一句说明",
  });
  assert.equal(noted.status, "resolved");
  assert.equal(noted.note, "回收后再补一句说明");
});

test("FQ-08 upsert without a status keeps the current state instead of resetting to planted", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  const created = ws.app.mutation("foreshadow.create", {
    projectId: chapter.projectId,
    title: "旧钥匙",
    status: "planted",
    plantedChapterId: chapter.documentId,
    plantedPoint: 2,
  });

  ws.app.mutation("foreshadow.patch", { projectId: chapter.projectId, id: created.id, status: "hinted" });
  const updated = ws.app.mutation("foreshadow.upsert", {
    projectId: chapter.projectId,
    id: created.id,
    note: "只补备注",
  });
  assert.equal(updated.status, "hinted");
  assert.equal(updated.plantedPoint, 2);
});

test("FQ-08 fact_sync foreshadowUpdates rejects unknown words and illegal transitions", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  ws.app.mutation("foreshadow.create", {
    projectId: chapter.projectId,
    title: "既有伏笔",
    status: "planted",
    plantedChapterId: chapter.documentId,
  });

  const badWord = ws.app.mutation("proposal.create", {
    kind: "fact_sync",
    projectId: chapter.projectId,
    documentId: chapter.documentId,
    payload: { foreshadowUpdates: [{ title: "既有伏笔", status: "bogus" }] },
  });
  assertThrowsContract(
    () => ws.app.mutation("proposal.decide", { proposalId: badWord.id, accept: true }),
    "input.invalid",
    { field: "status", reason: "unknown-foreshadow-status" },
  );

  const illegal = ws.app.mutation("proposal.create", {
    kind: "fact_sync",
    projectId: chapter.projectId,
    documentId: chapter.documentId,
    payload: { foreshadowUpdates: [{ title: "既有伏笔", status: "proposed" }] },
  });
  assertThrowsContract(
    () => ws.app.mutation("proposal.decide", { proposalId: illegal.id, accept: true }),
    "gate.denied",
    { action: "foreshadow.transition", from: "planted", to: "proposed" },
  );
});

test("FQ-08 patch refuses a foreshadow id owned by another project", (t) => {
  const first = createTestWorkspace(t);
  const chapter = first.createFanqieChapter({ body: "甲项目正文" });
  const other = first.createFanqieChapter({ projectName: "乙项目", body: "乙项目正文" });
  const created = first.app.mutation("foreshadow.create", {
    projectId: chapter.projectId,
    title: "甲项目的伏笔",
    status: "planted",
    plantedChapterId: chapter.documentId,
  });

  assertThrowsContract(
    () => first.app.mutation("foreshadow.patch", { projectId: other.projectId, id: created.id, note: "越权" }),
    "input.invalid",
    { field: "projectId", reason: "project-mismatch" },
  );
});
