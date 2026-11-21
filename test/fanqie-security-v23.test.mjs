import assert from "node:assert/strict";
import test from "node:test";
import { assertThrowsContract, createTestWorkspace } from "../support/v2-harness.mjs";

function insertLegacyProposal(db, { id, projectId, kind }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO author_ai_proposals (
      id, project_id, document_id, kind, status, source_ref, payload, origin, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, 'pending', '', '{}', 'author-ui', ?, ?);
  `).run(id, projectId, kind, now, now);
}

test("FQ-06: a library item id from another project or the global scope cannot be overwritten", (t) => {
  const ws = createTestWorkspace(t);
  const chapterA = ws.createFanqieChapter({ projectName: "甲项目", title: "甲章", body: "甲项目正文。" });
  const chapterB = ws.createFanqieChapter({ projectName: "乙项目", title: "乙章", body: "乙项目正文。" });

  const saved = ws.app.mutation("deconstruct.save", {
    scope: "project",
    projectId: chapterA.projectId,
    title: "甲项目拆解",
    excerpt: "甲项目原文摘录",
  });

  assertThrowsContract(
    () => ws.app.mutation("deconstruct.save", {
      id: saved.id,
      scope: "project",
      projectId: chapterB.projectId,
      title: "跨项目篡改",
      excerpt: "乙项目摘录",
    }),
    "input.invalid",
    { field: "id", reason: "scope-mismatch" },
  );
  assertThrowsContract(
    () => ws.app.mutation("deconstruct.save", {
      id: saved.id,
      scope: "global",
      title: "提升为全局",
      excerpt: "全局摘录",
    }),
    "input.invalid",
    { field: "id", reason: "scope-mismatch" },
  );

  const listA = ws.app.mutation("deconstruct.list", { projectId: chapterA.projectId });
  assert.equal(listA.find((row) => row.id === saved.id).title, "甲项目拆解");
  const listB = ws.app.mutation("deconstruct.list", { projectId: chapterB.projectId });
  assert.equal(listB.some((row) => row.id === saved.id), false);

  const card = ws.app.mutation("technique.save", {
    scope: "project",
    projectId: chapterA.projectId,
    title: "甲项目技法",
    executionSteps: "先写触感再揭示物件",
    priority: 70,
  });
  assertThrowsContract(
    () => ws.app.mutation("technique.save", {
      id: card.id,
      scope: "project",
      projectId: chapterB.projectId,
      title: "跨项目技法篡改",
      executionSteps: "篡改",
    }),
    "input.invalid",
    { field: "id", reason: "scope-mismatch" },
  );
});

test("FQ-06: a foreshadow upsert cannot retarget another project's row by id", (t) => {
  const ws = createTestWorkspace(t);
  const chapterA = ws.createFanqieChapter({ projectName: "甲项目", title: "甲章", body: "甲正文。" });
  const chapterB = ws.createFanqieChapter({ projectName: "乙项目", title: "乙章", body: "乙正文。" });

  const planted = ws.app.mutation("foreshadow.upsert", {
    projectId: chapterA.projectId,
    title: "甲项目伏笔",
    plantedChapterId: chapterA.documentId,
  });

  assertThrowsContract(
    () => ws.app.mutation("foreshadow.upsert", {
      id: planted.id,
      projectId: chapterB.projectId,
      title: "跨项目改名",
    }),
    "input.invalid",
    { field: "projectId", reason: "project-mismatch" },
  );

  const rows = ws.app.mutation("foreshadow.list", { projectId: chapterA.projectId });
  assert.equal(rows.find((row) => row.id === planted.id).title, "甲项目伏笔");
});

test("FQ-06: proposal decision pins project identity and strips reserved payload fields", (t) => {
  const ws = createTestWorkspace(t);
  const chapterA = ws.createFanqieChapter({ projectName: "甲项目", title: "甲章", body: "甲正文。" });
  const chapterB = ws.createFanqieChapter({ projectName: "乙项目", title: "乙章", body: "乙正文。" });

  const proposal = ws.app.mutation("proposal.create", {
    kind: "deconstruct",
    projectId: chapterA.projectId,
    payload: { title: "甲项目拆解", excerpt: "甲原文摘录" },
  });
  const decided = ws.app.mutation("proposal.decide", {
    proposalId: proposal.id,
    accept: true,
    projectId: chapterB.projectId,
    editedPayload: {
      title: "甲项目拆解",
      excerpt: "甲原文摘录",
      projectId: chapterB.projectId,
      scope: "global",
      id: "attacker-chosen-id",
      priority: 99,
    },
  });

  assert.equal(decided.committed.projectId, chapterA.projectId, "the row, not the caller, owns the project");
  assert.equal(decided.committed.scope, "project");
  assert.notEqual(decided.committed.id, "attacker-chosen-id");

  const stored = ws.app.mutation("proposal.list", { projectId: chapterA.projectId })
    .find((row) => row.id === proposal.id);
  assert.equal("projectId" in stored.payload, false, "reserved fields must not be persisted back");
  assert.equal("id" in stored.payload, false);

  const technique = ws.app.mutation("proposal.create", {
    kind: "technique",
    projectId: chapterA.projectId,
    payload: { title: "甲技法", executionSteps: "先抑后扬", priority: 99 },
  });
  const techDecided = ws.app.mutation("proposal.decide", { proposalId: technique.id, accept: true });
  assert.equal(techDecided.committed.priority, 50, "AI payload cannot choose its own priority");
});

test("FQ-07: chapter-bound proposals require a document at creation, generation, and decision", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ title: "第一章", body: "正文。" });

  assertThrowsContract(
    () => ws.app.mutation("proposal.create", {
      kind: "summary",
      projectId: chapter.projectId,
      payload: { summary: "摘要" },
    }),
    "input.invalid",
    { field: "documentId", reason: "chapter-required" },
  );

  assertThrowsContract(
    () => ws.app.beginProposalGeneration({
      kind: "fact_sync",
      provider: "fixture",
      model: "test-model",
      projectId: chapter.projectId,
    }),
    "input.invalid",
    { field: "documentId", reason: "chapter-required" },
  );

  insertLegacyProposal(ws.db, { id: "legacy-fact-sync", projectId: chapter.projectId, kind: "fact_sync" });
  assertThrowsContract(
    () => ws.app.mutation("proposal.decide", { proposalId: "legacy-fact-sync", accept: true }),
    "input.invalid",
    { field: "documentId", reason: "chapter-required" },
  );

  insertLegacyProposal(ws.db, { id: "legacy-setting", projectId: chapter.projectId, kind: "setting" });
  assertThrowsContract(
    () => ws.app.mutation("proposal.decide", { proposalId: "legacy-setting", accept: true }),
    "input.invalid",
    { field: "documentId", reason: "chapter-required" },
  );

  // No chapter is invented from chapterOrder: the legacy rows stay pending.
  const pending = ws.app.mutation("proposal.list", { projectId: chapter.projectId, status: "pending" });
  assert.deepEqual(
    pending.map((row) => row.id).sort(),
    ["legacy-fact-sync", "legacy-setting"],
  );
});
