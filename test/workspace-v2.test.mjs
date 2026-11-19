import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openAuthorWorkspace } from "../src/host/index.ts";
import {
  appendEvent,
  createCommandSchema,
  createDeliverySchema,
  createEventLogSchema,
  openDatabase,
} from "../src/storage/index.ts";
import { DELIVERY_ENDING, articleScenario, validateTitleMatrix } from "../src/domain/toutiao/index.ts";

function withWorkspace(t) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const writes = [];
  let externalAvailable = false;
  const writer = (id, data) => {
    if (!externalAvailable) throw new Error("export temporarily unavailable");
    writes.push({ id, data });
  };
  const app = openAuthorWorkspace(db, writer);
  return { app, writer, writes, db, allowExport() { externalAvailable = true; } };
}

function setup(app, product) {
  const { id: projectId } = app.mutation("project.create", { name: "作品", product });
  const { id: documentId } = app.mutation("document.create", { projectId, title: "正文", mode: "short", line: "资讯线" });
  const { revisionId } = app.mutation("draft.save", {
    documentId, baseRevisionId: null, body: product === "toutiao" ? "甲".repeat(1100) : "作者原稿",
  });
  return { projectId, documentId, revisionId, baseRevisionId: revisionId };
}

test("the Fanqie workbench freezes run input, checks budget and revisions, and keeps finalization with the author", (t) => {
  const { app, db, writer } = withWorkspace(t);
  const context = setup(app, "fanqie");
  const { documentId, projectId } = context;
  const { id: runId } = app.mutation("run.start", { ...context, instruction: "改写一段", tokenLimit: 500 });
  const restored = openAuthorWorkspace(db, writer);
  assert.equal(JSON.parse(restored.generationInput({ runId, provider: "mock", model: "test" }).frozenInput).text, "作者原稿");
  restored.mutation("run.complete", { runId, body: "候选正文", tokens: 80 });
  const overview = restored.snapshot(projectId, documentId);
  assert.equal(overview.active.body, "作者原稿");
  assert.deepEqual(overview.documents.map((row) => ({ ...row })), [{ id: documentId, title: "正文" }]);
  assert.throws(() => restored.mutation("candidate.adopt", { ...context, runId }), { code: "input.invalid" });
  const adopted = restored.mutation("candidate.adopt", { ...context, runId, key: "adopt" });
  assert.deepEqual(restored.mutation("candidate.adopt", { ...context, runId, key: "adopt" }), adopted);
  const onAdopted = { documentId, baseRevisionId: adopted.revisionId };
  assert.equal(restored.snapshot(projectId, documentId).active.finalRevisionId, null);
  assert.throws(() => restored.mutation("draft.finalize", onAdopted), { code: "gate.denied" });
  for (let index = 0; index < 2; index++) restored.mutation("chapter.review", { ...onAdopted, accept: false });
  assert.throws(() => restored.mutation("chapter.review", { ...onAdopted, accept: false }), { code: "gate.denied" });
  restored.mutation("chapter.review", { ...onAdopted, accept: true });
  restored.mutation("draft.finalize", onAdopted);
  assert.equal(restored.snapshot(projectId, documentId).active.finalRevisionId, adopted.revisionId);
  assert.throws(() => restored.mutation("draft.save", { ...onAdopted, body: "另一个版本" }), { code: "gate.denied" });
});

test("a cancelled run records usage without a candidate and over-budget results never become candidates", (t) => {
  const { app } = withWorkspace(t);
  const context = setup(app, "fanqie");
  const start = () => app.mutation("run.start", { ...context, tokenLimit: 400, instruction: "试写" }).id;
  const cancelled = start();
  app.mutation("run.cancel", { runId: cancelled });
  app.mutation("run.complete", { runId: cancelled, body: "迟到的结果", tokens: 30 });
  app.mutation("run.complete", { runId: cancelled, body: "重复结果", tokens: 30 });
  const failed = start();
  app.mutation("run.complete", { runId: failed, body: "超预算", tokens: 401 });
  const runs = app.snapshot(context.projectId, context.documentId).runs;
  assert.equal(runs[0].state, "failed");
  assert.equal(runs[1].state, "cancelled");
  assert.equal(runs[1].settled, 30);
  const replayed = app.mutation("read.model", { projectId: context.projectId, model: "run", runId: cancelled });
  assert.equal(replayed.value.budget.settled, 30);
  assert.ok(runs.every((run) => run.candidateBody === null));
});

test("the Toutiao workbench separates QA, acceptance, version approval and retryable Markdown delivery", (t) => {
  const { app, db, writer, writes, allowExport } = withWorkspace(t);
  const context = setup(app, "toutiao");
  const { documentId, projectId } = context;
  assert.throws(() => app.mutation("article.accept", { ...context, accept: true }), { code: "gate.denied" });
  app.mutation("article.qa", { ...context, score: 84, passed: true, fails: ["待核实"] });
  assert.equal(app.snapshot(projectId, documentId).active.state, "初稿待改");
  app.mutation("article.qa", { ...context, score: 84, passed: true, fails: [] });
  app.mutation("article.accept", { ...context, accept: true });
  const delivery = { ...context, key: "approved-version" };
  assert.throws(() => app.mutation("article.deliver", delivery), { code: "gate.denied" });
  app.mutation("approval.decide", { ...context, confirmed: true });
  assert.throws(() => app.mutation("article.deliver", { ...delivery, baseRevisionId: "old-version" }), { code: "gate.denied" });
  assert.equal(app.mutation("article.deliver", delivery).state, "failed");
  assert.equal(app.snapshot(projectId, documentId).active.state, "已交稿");
  allowExport();
  const reopened = openAuthorWorkspace(db, writer);
  reopened.resumeExports();
  assert.equal(app.mutation("article.deliver", delivery).wrote, false);
  assert.equal(reopened.snapshot(projectId, documentId).exportStatus.state, "exported");
  assert.equal(reopened.snapshot(projectId, documentId).exportStatus.revisionId, context.revisionId);
  assert.equal(reopened.snapshot(projectId, documentId).delivery, writes[0].data);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].data.startsWith("# 正文\n\n"));
  assert.ok(writes[0].data.endsWith(DELIVERY_ENDING + "\n"));
});

test("chapter reordering requires a current reviewed impact and setting proposals stay out of the known facts until adopted", (t) => {
  const { app } = withWorkspace(t);
  const context = setup(app, "fanqie");
  const { projectId, documentId } = context;
  const { id: second } = app.mutation("document.create", { projectId, title: "第二章" });
  const from = { chapterId: documentId, point: 1 };
  const at = { chapterId: second, point: 1 };
  const proposal = app.mutation("setting.propose", {
    ...context, factId: "secret", note: "知情时点", source: "作者笔记", from, knownAt: at, character: "林", locked: true,
  });
  const query = { projectId, at, character: "林" };
  assert.equal(app.mutation("settings.read", query).entries.length, 0);
  app.mutation("setting.decide", { ...context, proposalId: proposal.id, accept: true });
  assert.equal(app.mutation("settings.read", { ...query, at: from }).entries.length, 0);
  assert.equal(app.mutation("settings.read", query).entries.length, 1);
  const order = { projectId, chapterIds: [second, documentId] };
  const plan = app.mutation("reorder.impact", order);
  assert.equal(plan.impact.length, 1);
  assert.throws(() => app.mutation("reorder.commit", { ...order, asOfSeq: plan.asOfSeq }), { code: "gate.denied" });
  app.mutation("reorder.commit", { ...order, asOfSeq: plan.asOfSeq, confirmed: true });
  assert.throws(() => app.mutation("reorder.commit", { ...order, asOfSeq: plan.asOfSeq, confirmed: true }), { code: "version.conflict" });
  assert.deepEqual(app.snapshot(projectId, documentId).documents.map(({ id }) => id), order.chapterIds);
  assert.equal(app.mutation("settings.read", query).entries.length, 0);
});

test("the supported Toutiao scenario matrix has six cells and title counts use Unicode code points", () => {
  for (const mode of ["long", "short", "micro"]) {
    for (const line of ["资讯线", "故事线"]) assert.ok(articleScenario(mode, line).drivers.length);
  }
  assert.throws(() => articleScenario("deep", "资讯线"), { code: "input.invalid" });
  const titles = [1, 2, 3, 4, 5].map((n) => ({ text: "𠮷".repeat(33) + n, motif: String(n % 3) }));
  assert.equal(validateTitleMatrix([...titles, { text: "𠮷".repeat(35), motif: "ignored" }]).valid.length, 5);
  assert.equal(validateTitleMatrix(titles).passed, true);
});

test("automatic Toutiao QA reruns assessment after each refinement, with a strict two-round maximum", async () => {
  const { refineArticle } = await import("../src/domain/toutiao/refinement.ts");
  const examined = [];
  const result = await refineArticle("初稿", async (body) => {
    examined.push(body);
    return { overall: 90, passed: true, fails: ["缺证据"], hardGates: [] };
  }, async (body) => body + "改");
  assert.deepEqual(examined, ["初稿", "初稿改", "初稿改改"]);
  assert.equal(result.rounds, 2);
  assert.equal(result.body, "初稿改改");
  assert.equal(result.qa.passed, true);
  assert.equal(result.qa.fails.length, 1);
});

test("approved delivery allows only positive approval records for the matching version", async () => {
  const { checkApprovalGate } = await import("../src/contracts/approval.ts");
  const request = { actor: "author", action: "article.deliver", target: "article", targetVersion: "r1" };
  assert.equal(checkApprovalGate({ ...request, record: { ...request, decision: "rejected", at: "now" } })?.code, "gate.denied");
  assert.equal(checkApprovalGate({ ...request, record: { ...request, decision: "approved", at: "now" } }), null);
});

test("the six author reads replay real project events and share the committed watermark", (t) => {
  const { app } = withWorkspace(t);
  const context = setup(app, "fanqie");
  const { projectId, documentId } = context;
  const read = (model, fields = {}) => app.mutation("read.model", { projectId, model, ...fields });
  const at = { chapterId: documentId, point: 1 };
  const proposal = app.mutation("setting.propose", {
    ...context, factId: "opening", source: "正稿", note: "场景已建立", character: "林", from: at,
  });
  app.mutation("setting.decide", { ...context, proposalId: proposal.id, accept: true });
  const evidence = app.mutation("evidence.record", { ...context, quote: "原稿", factId: "opening" });
  const runId = app.mutation("run.start", { ...context, instruction: "补一段", tokenLimit: 400 }).id;
  const candidate = app.mutation("run.complete", { runId, body: "候选", tokens: 42 }).candidateId;
  const reads = [
    read("navigation"),
    read("revision-candidate", { documentId }),
    read("settings-view", { asOfChapter: documentId, characterId: "林" }),
    read("evidence", { factId: "opening" }),
    read("run", { runId }),
    read("approval-history"),
  ];
  assert.equal(new Set(reads.map(({ asOfSeq }) => asOfSeq)).size, 1);
  assert.deepEqual(reads[0].value.volumes[0].chapters[0], {
    chapterId: documentId, title: "正文", businessState: "drafting", order: 1,
  });
  assert.equal(reads[1].value.candidateId, candidate);
  assert.equal(reads[2].value.entries[0].factId, "opening");
  assert.equal(reads[3].value.snapshotId, evidence.snapshotId);
  assert.deepEqual(reads[3].value.quoteRange, { start: 2, end: 4 });
  assert.equal(reads[4].value.checkpoints[0].outputRef, candidate);
  assert.equal(reads[4].value.budget.settled, 42);
  assert.deepEqual(reads[5].value.entries, []);
  reads[0].value.volumes[0].chapters[0].title = "local mutation";
  const unchanged = read("navigation");
  assert.equal(unchanged.folded, 0);
  assert.equal(unchanged.value.volumes[0].chapters[0].title, "正文");
  const extra = app.mutation("document.create", { projectId, title: "下章" });
  const advanced = read("navigation");
  assert.equal(advanced.folded, 1);
  assert.equal(advanced.asOfSeq, unchanged.asOfSeq + 1);
  assert.equal(advanced.value.volumes[0].chapters[1].chapterId, extra.id);

  const article = setup(app, "toutiao");
  app.mutation("article.qa", { ...article, score: 84, passed: true, fails: [] });
  app.mutation("article.accept", { ...article, accept: true });
  app.mutation("approval.decide", { ...article, confirmed: true });
  const [approval] = app.mutation("read.model", { projectId: article.projectId, model: "approval-history" }).value.entries;
  assert.equal(approval.target, article.documentId);
  assert.ok(Number.isSafeInteger(approval.targetVersion));
  assert.deepEqual(read("approval-history").value.entries, []);
});

test("the automatic refinement limit survives failure, retry and reopening of the workspace", (t) => {
  const { app, db, writer } = withWorkspace(t);
  const context = setup(app, "toutiao");
  const runId = app.mutation("run.start", { ...context, instruction: "写稿", tokenLimit: 9000 }).id;
  app.reserveRefinement(runId);
  app.failGeneration(runId, 1100);
  const restored = openAuthorWorkspace(db, writer);
  assert.equal(restored.generationInput({ runId, provider: "fixture", model: "test", autoQa: true }).reserved, 7900);
  restored.reserveRefinement(runId);
  assert.throws(() => restored.reserveRefinement(runId), { code: "gate.denied" });
});

test("approved settings agree across reversed decisions, narrative points, replay and frozen input", (t) => {
  const { app, db, writer } = withWorkspace(t);
  const context = setup(app, "fanqie");
  const { projectId, documentId } = context;
  const fields = { ...context, factId: "secret", source: "笔记", character: "林" };
  const propose = (note, point) => app.mutation("setting.propose", {
    ...fields, note, from: { chapterId: documentId, point },
  }).id;
  const earlier = propose("早期", 1);
  const first = propose("最后确认", 3);
  const second = propose("先确认", 3);
  for (const proposalId of [second, first, earlier]) app.mutation("setting.decide", { ...fields, proposalId, accept: true });
  const reopened = openAuthorWorkspace(db, writer);
  for (const [point, note] of [[1, "早期"], [3, "最后确认"]]) {
    assert.equal(reopened.mutation("settings.read", { projectId, character: "林", at: { chapterId: documentId, point } }).entries[0].note, note);
    assert.equal(reopened.mutation("read.model", { projectId, model: "settings-view", asOfChapter: documentId, characterId: "林", point }).value.entries[0].note, note);
  }
  app.mutation("chapter.outline", { ...context, viewpoint: "林", lockedFacts: "甲", knowledge: "乙", target: 2000,
    剧情梗概: "甲", 核心冲突与看点: "乙", 情节推进节点: "丙", 章末落点: "丁" });
  const { id: runId } = app.mutation("run.start", { ...context, point: 3, instruction: "补稿", tokenLimit: 8000 });
  assert.equal(JSON.parse(app.generationInput({ runId, provider: "fixture", model: "test" }).frozenInput).knownFacts[0].note, "最后确认");
  assert.throws(() => reopened.mutation("run.start", { ...context, instruction: "重复", tokenLimit: 8000 }), { code: "gate.denied" });
});

test("host generation survives restart without guessing unreturned usage", (t) => {
  const { app, db, writer } = withWorkspace(t);
  const context = setup(app, "fanqie");
  const { id: runId } = app.mutation("run.start", { ...context, instruction: "写", tokenLimit: 8000 });
  const input = { runId, provider: "fixture", model: "model" };
  const { attemptId } = app.generationInput(input, true);
  const write = app.beginGenerationCall(attemptId, "write", 512, 2000);
  app.recordGenerationReceipt(attemptId, write, [20, 10, 0, 3]);
  app.beginGenerationCall(attemptId, "qa", 512, 1200);
  const reopened = openAuthorWorkspace(db, writer);
  reopened.recoverGenerations();
  reopened.recoverGenerations();
  assert.throws(() => reopened.generationInput(input, true), { code: "gate.denied" });
  assert.equal(reopened.mutation("run.detail", { ...context, runId }).settled, 33);
  reopened.mutation("run.reconcile", { ...context, runId, attemptId, tokens: 7 });
  assert.throws(() => reopened.mutation("run.reconcile", { ...context, runId, attemptId, tokens: 7 }), { code: "gate.denied" });
  const projected = reopened.mutation("read.model", { projectId: context.projectId, model: "run", runId });
  assert.equal(projected.value.budget.settled, 40);
  const retry = reopened.generationInput(input, true);
  const qa = reopened.beginGenerationCall(retry.attemptId, "qa", 512, 1200);
  reopened.recordGenerationReceipt(retry.attemptId, qa, [3, 1, 0, 0]);
  const secondQa = reopened.beginGenerationCall(retry.attemptId, "qa", 512, 1200);
  reopened.recordGenerationReceipt(retry.attemptId, qa, [90, 8, 0, 0]);
  reopened.recordGenerationReceipt(retry.attemptId, secondQa, [2, 1, 0, 0]);
  reopened.finishGeneration(retry.attemptId, { body: "候选" }, null);
  reopened.finishGeneration(retry.attemptId, { body: "重复" }, null);
  const detail = reopened.mutation("run.detail", { ...context, runId });
  assert.equal(detail.settled, 47);
  assert.deepEqual(detail.calls.map((call) => call.usage && JSON.parse(call.usage)), [
    [3, 1, 0, 0], [2, 1, 0, 0], [20, 10, 0, 3], null,
  ]);
});

test("claiming an old failed run cannot bypass a newer active run across SQLite connections", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zhizhang-run-"));
  const filename = join(directory, "workspace.sqlite");
  const first = openDatabase(filename);
  const second = openDatabase(filename);
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  const app = openAuthorWorkspace(first, () => {});
  const otherTab = openAuthorWorkspace(second, () => {});
  const context = setup(app, "fanqie");
  const runInput = { ...context, instruction: "补一段", tokenLimit: 8000 };
  const claim = (workspace, runId) => workspace.generationInput({ runId, provider: "fixture", model: "test" }, true);
  const a = app.mutation("run.start", runInput).id;
  app.finishGeneration(claim(app, a).attemptId, null, "generation.failed");
  const b = otherTab.mutation("run.start", runInput).id;
  const attempt = claim(otherTab, b);
  assert.throws(() => claim(app, a), { code: "gate.denied", details: { action: "run.generate", reason: "generation-in-progress" } });
  assert.deepEqual(app.mutation("run.history", context).map((run) => run.state), ["running", "failed"]);
  otherTab.mutation("run.cancel", { runId: b });
  assert.throws(() => claim(app, a), { code: "gate.denied" });
  otherTab.finishGeneration(attempt.attemptId, null, "cancelled");
  assert.ok(claim(app, a).attemptId);
});

test("long candidate history stays out of the first response and supports detail and pagination", (t) => {
  const { app } = withWorkspace(t);
  const context = setup(app, "fanqie");
  const body = "千".repeat(10_000);
  context.baseRevisionId = app.mutation("draft.save", { ...context, body }).revisionId;
  for (let i = 0; i < 100; i++) {
    const { id: runId } = app.mutation("run.start", { ...context, instruction: "改", tokenLimit: 8000 });
    app.mutation("run.complete", { runId, body, tokens: 40 });
    app.mutation("run.discard", { runId });
  }
  assert.ok(Buffer.byteLength(JSON.stringify(app.snapshot(context.projectId, context.documentId))) < 150 * 1024);
  const page = app.mutation("run.history", context);
  assert.equal(page.length, 25);
  const next = app.mutation("run.history", { ...context, before: page.at(-1).cursor });
  assert.ok(next[0].cursor < page.at(-1).cursor);
  assert.equal(app.mutation("run.detail", { ...context, runId: next[0].id }).candidate.body, body);
});

test("legacy 2.0.0 databases upgrade idempotently without index collisions or duplicate late usage", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  createCommandSchema(db);
  createEventLogSchema(db);
  createDeliverySchema(db);
  db.exec(`
    CREATE TABLE author_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT NOT NULL);
    CREATE TABLE author_documents (
      id TEXT PRIMARY KEY REFERENCES documents(document_id),
      project_id TEXT NOT NULL REFERENCES author_projects(id), title TEXT NOT NULL,
      state TEXT NOT NULL, mode TEXT, line TEXT, final_revision_id TEXT,
      editorial_rejections INTEGER NOT NULL DEFAULT 0, qa_rounds INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE author_runs (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES author_documents(id),
      state TEXT NOT NULL, base_revision_id TEXT NOT NULL, frozen_input TEXT NOT NULL,
      reserved INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, candidate_id TEXT
    );
    CREATE TABLE author_planning (document_id TEXT PRIMARY KEY REFERENCES author_documents(id), value TEXT NOT NULL);
    CREATE TABLE author_run_refinement_claims (run_id TEXT PRIMARY KEY REFERENCES author_runs(id), rounds INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE author_candidate_qa (candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id), report TEXT NOT NULL, rounds INTEGER NOT NULL);
    CREATE TABLE author_approvals (document_id TEXT NOT NULL REFERENCES author_documents(id), revision_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (document_id, revision_id));
    CREATE TABLE author_chapter_order (project_id TEXT PRIMARY KEY REFERENCES author_projects(id), chapter_ids TEXT NOT NULL);
    CREATE TABLE author_settings (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES author_projects(id), fact_id TEXT NOT NULL,
      value TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX author_article_reports ON event_log(project_id, json_extract(payload, '$.revisionId'), seq)
      WHERE kind IN ('article.qa','article.rejected');
  `);

  db.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p-novel', '旧番茄', 'fanqie');").run();
  db.prepare("INSERT INTO documents (document_id, current_revision_id) VALUES ('c1', 'rev1');").run();
  db.prepare("INSERT INTO revisions (revision_id, document_id, body, created_at) VALUES ('rev1', 'c1', '旧正文', 1);").run();
  db.prepare("INSERT INTO author_documents (id, project_id, title, state) VALUES ('c1', 'p-novel', '第一章', 'drafted');").run();

  const fact1 = { id: "secret", note: "后批胜出", source: "旧笔记", kind: "fact", locked: false, effectiveFrom: { chapterId: "c1", point: 1 }, knownFrom: { 林: { chapterId: "c1", point: 1 } } };
  const fact2 = { ...fact1, note: "先批被覆" };
  db.prepare("INSERT INTO author_settings (sequence, id, project_id, fact_id, value, decision) VALUES (1, 'prop1', 'p-novel', 'secret', ?, 'approved');").run(JSON.stringify(fact1));
  db.prepare("INSERT INTO author_settings (sequence, id, project_id, fact_id, value, decision) VALUES (2, 'prop2', 'p-novel', 'secret', ?, 'approved');").run(JSON.stringify(fact2));
  appendEvent(db, { projectId: "p-novel", eventId: "e1", kind: "document.created", payload: { concern: "chapter", documentId: "c1", title: "第一章", state: "drafted" } });
  appendEvent(db, { projectId: "p-novel", eventId: "e2", kind: "setting.decided", payload: { concern: "setting", id: "prop2", factId: "secret", decision: "approved", fact: fact2 } });
  appendEvent(db, { projectId: "p-novel", eventId: "e3", kind: "setting.decided", payload: { concern: "setting", id: "prop1", factId: "secret", decision: "approved", fact: fact1 } });
  db.prepare("INSERT INTO author_runs (id, document_id, state, base_revision_id, frozen_input, reserved, settled, candidate_id) VALUES ('r-old', 'c1', 'cancelled', 'rev1', '{}', 500, 55, '');").run();

  db.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p-art', '旧头条', 'toutiao');").run();
  db.prepare("INSERT INTO documents (document_id, current_revision_id) VALUES ('a1', 'arev1');").run();
  db.prepare("INSERT INTO revisions (revision_id, document_id, body, created_at) VALUES ('arev1', 'a1', '头条稿', 1);").run();
  db.prepare("INSERT INTO author_documents (id, project_id, title, state, mode, line) VALUES ('a1', 'p-art', '旧标题', '待验收', 'short', '资讯线');").run();
  appendEvent(db, { projectId: "p-art", eventId: "ae1", kind: "article.qa", payload: { concern: "evidence", documentId: "a1", revisionId: "arev1", overall: 86, passed: true, fails: [], hardGates: [] } });

  const app = openAuthorWorkspace(db, () => {});
  // Calling openAuthorWorkspace twice guarantees idempotency.
  const app2 = openAuthorWorkspace(db, () => {});
  assert.equal(app2.mutation("settings.read", { projectId: "p-novel", character: "林", at: { chapterId: "c1", point: 1 } }).entries[0].note, "后批胜出");
  app.mutation("run.complete", { runId: "r-old", body: "迟到结果", tokens: 30 });
  const runRow = db.prepare("SELECT settled, late_usage_settled, candidate_id FROM author_runs WHERE id = 'r-old';").get();
  assert.equal(runRow.settled, 55);
  assert.equal(runRow.late_usage_settled, 1);
  assert.equal(runRow.candidate_id, null);
  assert.equal(app.snapshot("p-art", "a1").report.overall, 86);
});

test("multi-connection WAL reads persist checkpoints without SQLITE_BUSY lock upgrade", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zhizhang-wal-"));
  const filename = join(directory, "workspace.sqlite");
  const writerConn = openDatabase(filename);
  const readerConn = openDatabase(filename);
  for (const conn of [writerConn, readerConn]) {
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec("PRAGMA busy_timeout = 5000;");
  }
  t.after(() => { writerConn.close(); readerConn.close(); rmSync(directory, { recursive: true, force: true }); });

  const writerApp = openAuthorWorkspace(writerConn, () => {});
  const readerApp = openAuthorWorkspace(readerConn, () => {});
  const { id: projectId } = writerApp.mutation("project.create", { name: "WAL并发", product: "fanqie" });
  for (let i = 1; i <= 5; i++) {
    const { id: documentId } = writerApp.mutation("document.create", { projectId, title: `第${i}章` });
    writerApp.mutation("draft.save", { documentId, baseRevisionId: null, body: `正文 ${i}` });
    const nav = readerApp.mutation("read.model", { projectId, model: "navigation" });
    assert.equal(nav.value.volumes[0].chapters.length, i);
  }
  const reopenedConn = openDatabase(filename);
  reopenedConn.exec("PRAGMA busy_timeout = 5000;");
  try {
    const reopened = openAuthorWorkspace(reopenedConn, () => {});
    const finalNav = reopened.mutation("read.model", { projectId, model: "navigation" });
    assert.equal(finalNav.folded, 0);
    assert.equal(finalNav.value.volumes[0].chapters.length, 5);
  } finally {
    reopenedConn.close();
  }
});
