import assert from "node:assert/strict";
import test from "node:test";
import { openAuthorWorkspace } from "../src/host/index.ts";
import { openDatabase } from "../src/storage/index.ts";
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
  assert.ok(runs.every((run) => run.candidateBody === null));
});

test("the Toutiao workbench separates QA, acceptance, version approval and retryable Markdown delivery", (t) => {
  const { app, writes, allowExport } = withWorkspace(t);
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
  assert.equal(app.mutation("article.deliver", delivery).state, "failed");
  assert.equal(app.snapshot(projectId, documentId).active.state, "已交稿");
  allowExport();
  assert.equal(app.mutation("article.deliver", delivery).state, "exported");
  assert.equal(app.mutation("article.deliver", delivery).wrote, false);
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
