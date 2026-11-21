import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertThrowsContract, createTestWorkspace } from "../support/v2-harness.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function currentRevision(ws, documentId) {
  return ws.db.prepare("SELECT current_revision_id AS revisionId FROM documents WHERE id = ?;")
    .get(documentId).revisionId;
}

function beginFactSync(ws, chapter, extra = {}) {
  const begun = ws.app.beginProposalGeneration({
    kind: "fact_sync",
    projectId: chapter.projectId,
    documentId: chapter.documentId,
    provider: "deepseek-account",
    model: "deepseek-flash",
    ...extra,
  });
  ws.app.finishProposalGeneration(begun.id, {
    newFacts: [],
    updates: [],
    knownFromUpdates: [],
    foreshadowUpdates: [],
    summaryDraft: "",
  }, null);
  return begun.id;
}

function proposalRow(ws, proposalId) {
  return ws.db.prepare(`
    SELECT status, base_revision_id AS baseRevisionId, source_sha256 AS sourceSha256, origin
    FROM author_ai_proposals WHERE id = ?;
  `).get(proposalId);
}

test("FQ-03 generation pins the base revision and hashes the full body, not the prompt delta", (t) => {
  const ws = createTestWorkspace(t);
  const body = "第一段\n\n第二段";
  const chapter = ws.createFanqieChapter({ body });
  const proposalId = beginFactSync(ws, chapter, { sourceText: "仅这一段增量" });

  const row = proposalRow(ws, proposalId);
  assert.equal(row.baseRevisionId, chapter.revisionId);
  assert.equal(row.sourceSha256, sha256(body));
  assert.notEqual(row.sourceSha256, sha256("仅这一段增量"));
  assert.equal(row.origin, "ai-generate");
});

test("FQ-03 a chapter edit after generation refuses the decision and keeps the proposal pending", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "原稿第一段\n原稿第二段" });
  const proposalId = beginFactSync(ws, chapter);

  const moved = ws.app.mutation("draft.save", {
    documentId: chapter.documentId,
    baseRevisionId: chapter.revisionId,
    body: "改后第一段\n改后第二段",
  });

  assertThrowsContract(
    () => ws.app.mutation("proposal.decide", { proposalId, accept: true }),
    "gate.denied",
    {
      action: "proposal.decide",
      reason: "proposal-stale",
      baseRevisionId: chapter.revisionId,
      currentRevisionId: moved.revisionId,
    },
  );

  assert.equal(proposalRow(ws, proposalId).status, "pending");
  assert.equal(ws.app.snapshot(chapter.projectId, chapter.documentId).activeContext.syncStatus, "dirty");

  // The author can still reject a stale proposal instead of being locked out.
  const rejected = ws.app.mutation("proposal.decide", { proposalId, accept: false });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.staleCheck, "not-checked");
});

test("FQ-03 an unchanged chapter approves with staleCheck=fresh", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一段\n第二段" });
  const proposalId = beginFactSync(ws, chapter);

  const decided = ws.app.mutation("proposal.decide", { proposalId, accept: true });
  assert.equal(decided.status, "approved");
  assert.equal(decided.staleCheck, "fresh");
});

test("FQ-03 a no-op resave keeps the proposal fresh through the body hash", (t) => {
  const ws = createTestWorkspace(t);
  const body = "第一段\n第二段";
  const chapter = ws.createFanqieChapter({ body });
  const proposalId = beginFactSync(ws, chapter);

  const resaved = ws.app.mutation("draft.save", {
    documentId: chapter.documentId,
    baseRevisionId: chapter.revisionId,
    body,
  });
  assert.notEqual(resaved.revisionId, chapter.revisionId);

  const decided = ws.app.mutation("proposal.decide", { proposalId, accept: true });
  assert.equal(decided.status, "approved");
  assert.equal(decided.staleCheck, "fresh");
});

test("FQ-03 a legacy proposal without a base revision still refuses a moved chapter", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一段" });
  const proposalId = beginFactSync(ws, chapter);
  ws.db.prepare("UPDATE author_ai_proposals SET base_revision_id = NULL WHERE id = ?;").run(proposalId);

  ws.app.mutation("draft.save", {
    documentId: chapter.documentId,
    baseRevisionId: chapter.revisionId,
    body: "改后的第一段",
  });

  assertThrowsContract(
    () => ws.app.mutation("proposal.decide", { proposalId, accept: true }),
    "gate.denied",
    { action: "proposal.decide", reason: "proposal-stale" },
  );
  assert.equal(proposalRow(ws, proposalId).status, "pending");
  assert.equal(ws.app.snapshot(chapter.projectId, chapter.documentId).activeContext.syncStatus, "dirty");
});

test("FQ-03 a truly unpinned legacy decision stays dirty instead of cleaning unread text", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一段" });
  const proposalId = beginFactSync(ws, chapter);
  // Pre-2.3.0 rows have origin='ai-generate' (migration default) and an empty
  // body hash, so there is nothing to compare the moved text against.
  ws.db.prepare(`
    UPDATE author_ai_proposals SET base_revision_id = NULL, source_sha256 = '' WHERE id = ?;
  `).run(proposalId);

  ws.app.mutation("draft.save", {
    documentId: chapter.documentId,
    baseRevisionId: chapter.revisionId,
    body: "改后的第一段",
  });

  const decided = ws.app.mutation("proposal.decide", { proposalId, accept: true });
  assert.equal(decided.status, "approved");
  assert.equal(decided.staleCheck, "unpinned");
  assert.equal(
    ws.app.snapshot(chapter.projectId, chapter.documentId).activeContext.syncStatus,
    "dirty",
    "an unverified commit must never mark edited text as synced",
  );
  const event = ws.db.prepare(
    "SELECT payload FROM event_log WHERE kind = 'proposal.decide.unpinned' ORDER BY seq DESC LIMIT 1;",
  ).get();
  assert.ok(event, "unpinned decisions must leave an audit event");
});

test("FQ-03 manual proposals record origin=author-ui and are exempt from the drift gate", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一段" });
  const created = ws.app.mutation("proposal.create", {
    kind: "fact_sync",
    projectId: chapter.projectId,
    documentId: chapter.documentId,
    payload: { foreshadowUpdates: [{ title: "信物", status: "planted", note: "登记" }] },
  });

  const row = proposalRow(ws, created.id);
  assert.equal(row.origin, "author-ui");
  assert.equal(row.baseRevisionId, chapter.revisionId);
  assert.equal(row.sourceSha256, sha256("第一段"));

  ws.app.mutation("draft.save", {
    documentId: chapter.documentId,
    baseRevisionId: chapter.revisionId,
    body: "改后的第一段",
  });

  const decided = ws.app.mutation("proposal.decide", { proposalId: created.id, accept: true });
  assert.equal(decided.status, "approved");
  assert.equal(decided.staleCheck, "not-bound");
});

test("B2-5 FQ-07: a fact_sync decision cannot redirect the commit to another chapter", (t) => {
  const ws = createTestWorkspace(t);
  const chapterA = ws.createFanqieChapter({ title: "A 章", body: "A 章正文" });
  const chapterB = ws.app.mutation("document.create", { projectId: chapterA.projectId, title: "B 章" }).id;
  ws.app.mutation("draft.save", { documentId: chapterB, baseRevisionId: null, body: "B 章正文" });
  const proposalId = beginFactSync(ws, chapterA);

  const decided = ws.app.mutation("proposal.decide", {
    proposalId,
    accept: true,
    documentId: chapterB,
    editedPayload: {
      newFacts: [],
      updates: [],
      knownFromUpdates: [],
      foreshadowUpdates: [],
      summaryDraft: "只允许写进 A 章",
    },
  });
  assert.equal(decided.status, "approved");
  assert.equal(decided.staleCheck, "fresh");

  const summaries = new Map(
    ws.db.prepare("SELECT id, summary FROM author_documents WHERE project_id = ?;")
      .all(chapterA.projectId).map((row) => [row.id, row.summary]),
  );
  assert.equal(summaries.get(chapterA.documentId), "只允许写进 A 章");
  assert.equal(summaries.get(chapterB) ?? "", "", "a caller-supplied documentId must never become the write target");
  const syncedB = ws.db.prepare(
    "SELECT sync_status AS syncStatus FROM author_chapter_memory_sync WHERE document_id = ?;",
  ).get(chapterB);
  assert.equal(syncedB?.syncStatus ?? "dirty", "dirty");
});

test("B2-5 FQ-07: a caller-supplied chapter cannot bypass the drift gate", (t) => {
  const ws = createTestWorkspace(t);
  const chapterA = ws.createFanqieChapter({ title: "A 章", body: "A 章正文" });
  const chapterB = ws.app.mutation("document.create", { projectId: chapterA.projectId, title: "B 章" }).id;
  ws.app.mutation("draft.save", { documentId: chapterB, baseRevisionId: null, body: "B 章正文" });
  const proposalId = beginFactSync(ws, chapterA);

  ws.app.mutation("draft.save", {
    documentId: chapterA.documentId,
    baseRevisionId: chapterA.revisionId,
    body: "A 章改稿",
  });

  assertThrowsContract(
    () => ws.app.mutation("proposal.decide", { proposalId, accept: true, documentId: chapterB }),
    "gate.denied",
    { action: "proposal.decide", reason: "proposal-stale" },
  );
  assert.equal(proposalRow(ws, proposalId).status, "pending");
});
