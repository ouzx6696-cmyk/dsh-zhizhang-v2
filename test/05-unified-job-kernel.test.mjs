import test from "node:test";
import assert from "node:assert/strict";
import { applyWorkbench } from "../src/host/plugin.ts";
import {
  assertThrowsContract,
  createMockDsHHost,
  createScriptedLlm,
  createTestWorkspace,
  withTempDir,
} from "../support/harness.mjs";

test("unified author_jobs ledger tracks all 3 job kinds, late usage receipts, and consistency", (t) => {
  const ws = createTestWorkspace(t);
  const { projectId, documentId, baseRevisionId } = ws.createFanqieChapter({
    title: "第一章",
    body: "第一段旧正文。\n\n第二段需要扩写。",
  });

  // 1. Draft generation job
  const run = ws.app.mutation("run.start", {
    documentId,
    baseRevisionId,
    instruction: "写候选稿",
    tokenLimit: 12000,
  });
  const gen = ws.app.generationInput({ runId: run.id, provider: "deepseek", model: "deepseek-chat" }, true);
  const callId = ws.app.beginJobCall(gen.jobId, "write", 500, 1200);
  ws.app.recordJobReceipt(gen.jobId, callId, [480, 320, 20, 10]);
  ws.app.finishGeneration(gen.jobId, { body: "新候选稿正文", tokens: 830, qa: null }, null);

  // 2. Selection rewrite job + late usage receipt after premature close
  const rewriteReq = ws.app.buildSelectionRewriteInput({
    documentId,
    mode: "polish",
    selectedText: "第二段需要扩写。",
    provider: "deepseek",
    model: "deepseek-chat",
  });
  const rwJob = ws.app.beginSelectionRewrite(rewriteReq);
  const rwCallId = ws.app.beginJobCall(rwJob.id, "selectionRewrite", 200, 500);
  ws.app.finishSelectionRewrite(rwJob.id, true, "cancelled");
  // Late receipt arrives AFTER job was closed — must persist into late_usage and stay consistent!
  ws.app.recordJobReceipt(rwJob.id, rwCallId, [190, 95, 0, 0]);

  const microStats = ws.app.microUsage(documentId);
  assert.equal(microStats.calls, 1);
  assert.equal(microStats.settled, 285);

  const jobs = ws.app.listJobs({ projectId });
  assert.equal(jobs.length, 2);
  assert.deepEqual(ws.app.verifyUsageConsistency(), []);
});

test("unified concurrency lock blocks duplicate open draft_generation and uncertain reconciliation clears gate", (t) => {
  const ws = createTestWorkspace(t);
  const { documentId, baseRevisionId } = ws.createFanqieChapter();
  const run = ws.app.mutation("run.start", { documentId, baseRevisionId, instruction: "写", tokenLimit: 12000 });
  const gen = ws.app.generationInput({ runId: run.id, provider: "deepseek", model: "deepseek-chat" }, true);
  ws.app.beginJobCall(gen.jobId, "write", 400, 800);

  // Second open generation for same run is blocked
  assertThrowsContract(
    () => ws.app.generationInput({ runId: run.id, provider: "deepseek", model: "deepseek-chat" }, true),
    "gate.denied",
  );

  // Simulate crash -> startup recovery marks inflight job as uncertain
  ws.app.recoverJobs();
  const job = ws.app.listJobs({ documentId })[0];
  assert.equal(job.state, "uncertain");

  // Unreconciled uncertain job blocks new run on same document until reconciled
  assertThrowsContract(
    () => ws.app.generationInput({ runId: run.id, provider: "deepseek", model: "deepseek-chat" }, true),
    "gate.denied",
  );
  ws.app.mutation("run.reconcile", { documentId, runId: run.id, attemptId: gen.jobId, tokens: 400 });
  assert.equal(ws.app.listJobs({ documentId })[0].state, "reconciled");
});

test("HostJobEngine executes all 3 job kinds over /jobs/* and drains cleanly on unload", async () => {
  const gate = Promise.withResolvers();
  const llm = createScriptedLlm([
    // 1. Draft generation
    {
      text: "由统一作业引擎生成的新正文。",
      usage: { inputTokens: 300, outputTokens: 150, cacheReadTokens: 20, cacheWriteTokens: 0 },
    },
    // 2. Proposal extraction (technique)
    {
      text: JSON.stringify({
        title: "反差转折法",
        category: "pacing",
        executionSteps: "先平铺生活细节，再用冷锋消息打破平衡。",
      }),
      usage: { inputTokens: 220, outputTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    // 3. Selection rewrite (sync)
    {
      text: "润色后的精炼句段。",
      usage: { inputTokens: 150, outputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 0 },
    },
    // 4. In-flight generation interrupted during plugin unload
    {
      chunks: [{ type: "text-delta", index: 0, text: "未完正文" }],
      gate: gate.promise,
    },
  ]);

  await withTempDir("zhizhang-engine-", async (dataDirectory) => {
    const host = createMockDsHHost({ llm });
    applyWorkbench(host.ctx, { dataDirectory, shutdownDrainMs: 250 }, { readAsset: host.readAsset });

    const { body: projRes } = await host.command("project.create", { product: "fanqie", name: "作业引擎测试" });
    const projectId = projRes.result.id;
    const { body: docRes } = await host.command("document.create", { projectId, title: "第一章" });
    const documentId = docRes.result.id;
    const { body: saveRes } = await host.command("draft.save", {
      documentId,
      baseRevisionId: null,
      body: "需要被改写的原句。后续情节。",
    });
    const baseRevisionId = saveRes.result.revisionId;

    // Preview zero-token budget
    const preview = await host.previewJob({ documentId, baseRevisionId, instruction: "展开冲突", tokenLimit: 12000 });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.ok, true);

    // Job 1: draft_generation
    const runStart = await host.command("run.start", {
      documentId,
      baseRevisionId,
      instruction: "展开冲突",
      tokenLimit: 12000,
    });
    const runId = runStart.body.result.id;
    const started = await host.startJob("draft_generation", {
      runId,
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.equal(started.status, 202);
    assert.equal(started.body.result.kind, "draft_generation");

    await host.waitFor(async () => {
      const st = await host.getState({ projectId, documentId });
      return st.body.result.runs[0]?.state === "awaiting-author";
    });

    // Job 2: proposal_extraction
    const propStart = await host.startJob("proposal_extraction", {
      proposalKind: "technique",
      projectId,
      documentId,
      provider: "deepseek",
      model: "deepseek-chat",
      instruction: "提炼本章转折技法",
    });
    assert.equal(propStart.status, 202);
    await host.waitFor(async () => {
      const jobs = await host.getJobs({ projectId, kind: "proposal_extraction" });
      return jobs.body.result[0]?.state === "completed";
    });

    // Job 3: selection_rewrite (synchronous)
    const rwRes = await host.startJob("selection_rewrite", {
      documentId,
      mode: "polish",
      selectedText: "需要被改写的原句。",
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.equal(rwRes.status, 200);
    assert.equal(rwRes.body.result.rewrittenText, "润色后的精炼句段。");

    // Verify unified /jobs feed contains all 3 kinds and /diag reports 0 usage consistency issues
    const allJobs = await host.getJobs({ projectId });
    const kinds = new Set(allJobs.body.result.map((j) => j.kind));
    assert.deepEqual(kinds, new Set(["draft_generation", "proposal_extraction", "selection_rewrite"]));

    const diag = await host.getDiag();
    assert.equal(diag.body.result.usageConsistencyIssues, 0);
    assert.equal(diag.body.result.version, "3.0.0");

    // Job 4: start another generation and unload plugin cleanly
    await host.command("run.discard", { runId });
    const run2 = (await host.command("run.start", {
      documentId,
      baseRevisionId,
      instruction: "中断测试",
      tokenLimit: 12000,
    })).body.result.id;
    await host.startJob("draft_generation", { runId: run2, provider: "deepseek", model: "deepseek-chat" });
    await host.waitFor(() => llm.calls.length === 4);
    await host.close();
    assert.ok(host.disposedPaths.length > 0);
  });
});

test("unknown job kind on /jobs/start returns 400 input.invalid", async () => {
  await withTempDir("zhizhang-badkind-", async (dataDirectory) => {
    const host = createMockDsHHost();
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const res = await host.startJob("bogus_kind", {});
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "input.invalid");
    } finally {
      await host.close();
    }
  });
});
