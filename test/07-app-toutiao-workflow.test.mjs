import test from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_ENDING } from "../src/contracts/index.ts";
import { createToutiaoGenerationRunner } from "../src/application/products/toutiao.ts";
import { executeGenerationWithRunner } from "../src/host/writing.ts";
import { assertThrowsContract, createScriptedLlm, createTestWorkspace } from "../support/harness.mjs";

test("Toutiao full workflow: plan -> title cap -> QA 84 -> accept -> approve -> deliver + resume", (t) => {
  const ws = createTestWorkspace(t, { allowExport: false });
  const { projectId, documentId, baseRevisionId } = ws.createToutiaoArticle({
    projectName: "民生评论",
    title: "旧标题",
    mode: "short",
    line: "资讯线",
    body: "正".repeat(1300),
  });

  // Title rename enforces 34 Unicode code point cap and advances revisionId
  const renamed = ws.app.mutation("article.rename", { documentId, baseRevisionId, title: "社区食堂为什么留不住年轻人" });
  const rev = renamed.revisionId ?? ws.app.snapshot(projectId, documentId).active.revisionId;
  assert.equal(ws.app.snapshot(projectId, documentId).active.title, "社区食堂为什么留不住年轻人");
  assertThrowsContract(
    () => ws.app.mutation("article.rename", { documentId, baseRevisionId: rev, title: "字".repeat(35) }),
    "input.invalid",
  );

  // Plan scenario + title matrix
  ws.app.mutation("article.plan", {
    documentId,
    driver: "账本型",
    opening: "账单暴击",
    ending: "经历共鸣",
    titles: [
      "标题一|账本",
      "标题二|处境",
      "标题三|冲突",
      "标题四|账本",
      "标题五|冲突",
    ].join("\n"),
  });

  // Failing QA (score 80 < 84) keeps article unable to accept
  ws.app.mutation("article.qa", { documentId, baseRevisionId: rev, score: 80, passed: false, fails: ["缺账单"], hardGates: [] });
  assertThrowsContract(() => ws.app.mutation("article.accept", { documentId, baseRevisionId: rev, accept: true }), "gate.denied");

  // Passing QA (>= 84) enables accept -> approve -> deliver
  ws.app.mutation("article.qa", { documentId, baseRevisionId: rev, score: 86, passed: true, fails: [], hardGates: [] });
  assert.equal(ws.app.snapshot(projectId, documentId).active.state, "待验收");

  ws.app.mutation("article.accept", { documentId, baseRevisionId: rev, accept: true });
  assert.equal(ws.app.snapshot(projectId, documentId).active.state, "已验收");

  // Delivering without explicit approval is denied
  assertThrowsContract(() => ws.app.mutation("article.deliver", { documentId, baseRevisionId: rev, key: "deliver-denied" }), "gate.denied");

  ws.app.mutation("approval.decide", { documentId, baseRevisionId: rev, confirmed: true });

  // Export temporarily blocked -> delivery is recorded pending, resumes cleanly after restart
  const pending = ws.app.mutation("article.deliver", { documentId, baseRevisionId: rev, key: "deliver-ok" });
  assert.equal(pending.wrote, false);
  assert.equal(ws.writes.length, 0);

  ws.allowExport();
  const reopened = ws.reopen();
  reopened.recoverStartup();
  assert.equal(ws.writes.length, 1);
  assert.match(ws.writes[0].data, /^# 社区食堂为什么留不住年轻人\n\n/u);
  assert.ok(ws.writes[0].data.endsWith(`${DELIVERY_ENDING}\n`));
});

test("micro Toutiao refuses title on creation and rename", (t) => {
  const ws = createTestWorkspace(t);
  const projectId = ws.app.mutation("project.create", { product: "toutiao", name: "微头条测试" }).id;
  assertThrowsContract(
    () => ws.app.mutation("document.create", { projectId, title: "非法标题", mode: "micro", line: "资讯线" }),
    "input.invalid",
  );
  const docId = ws.app.mutation("document.create", { projectId, title: "", mode: "micro", line: "资讯线" }).id;
  const revId = ws.app.mutation("draft.save", { documentId: docId, baseRevisionId: null, body: "微".repeat(400) }).revisionId;
  assertThrowsContract(
    () => ws.app.mutation("article.rename", { documentId: docId, baseRevisionId: revId, title: "强加标题" }),
    "gate.denied",
  );
});

test("Toutiao auto-QA refinement loop caps at 2 automatic rounds and settles 4-category usage", async () => {
  const body = "文".repeat(2800);
  const llm = createScriptedLlm([
    { text: body, usage: { inputTokens: 800, outputTokens: 400, cacheReadTokens: 20, cacheWriteTokens: 10 } },
    { text: JSON.stringify({ overall: 78, passed: false, fails: ["缺案例"], hardGates: [] }) },
    { text: body, usage: { inputTokens: 820, outputTokens: 420, cacheReadTokens: 20, cacheWriteTokens: 0 } },
    { text: JSON.stringify({ overall: 85, passed: true, fails: [], hardGates: [] }) },
  ]);

  const receipts = [];
  const ledger = {
    begin(phase, inputReserve, maxOutput) {
      const id = `c-${receipts.length + 1}`;
      receipts.push({ id, phase, inputReserve, maxOutput, usage: null });
      return id;
    },
    receive(id, usage) {
      const hit = receipts.find((r) => r.id === id);
      if (hit) hit.usage = usage;
    },
  };

  let refinements = 0;
  const run = {
    provider: "test",
    model: "test",
    reserved: 24_000,
    autoQa: true,
    frozenInput: JSON.stringify({
      title: "长文测试",
      mode: "long",
      scenario: {},
      instruction: "写一篇长图文",
      text: body,
    }),
  };

  const result = await executeGenerationWithRunner(
    llm,
    run,
    new AbortController().signal,
    () => { refinements += 1; },
    ledger,
    createToutiaoGenerationRunner(),
  );

  assert.equal(refinements, 1);
  assert.equal(result.qa.overall, 85);
  assert.equal(result.qa.passed, true);
  assert.deepEqual(receipts.map((r) => r.phase), ["write", "qa", "refine", "qa"]);
  assert.ok(result.tokens > 0);
});
