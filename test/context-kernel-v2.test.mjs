import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkbench } from "../src/host/plugin.ts";
import { assembleContextBundle } from "../src/workflow/context-slots.ts";
import { estimateTokenCount, estimateWritingInput } from "../src/workflow/writing-budget.ts";
import {
  createMockDsHHost,
  createScriptedLlm,
  createTestWorkspace,
  withTempDir,
} from "../support/v2-harness.mjs";

test("calibrated token estimator and priority context assembler keep Prefix stable and trim lower-priority slots", () => {
  const cjkSample = "这是一段纯中文长篇小说正文测试内容。".repeat(100); // 1,800 Chinese chars
  const estimated = estimateTokenCount(cjkSample);
  const rawBytes = Buffer.byteLength(cjkSample);
  assert.ok(estimated > cjkSample.length && estimated < rawBytes, `Expected calibrated tokens (${estimated}) < raw UTF-8 bytes (${rawBytes})`);
  assert.ok(estimateWritingInput("SYS", cjkSample) > estimated + 128);

  const slots = [
    { id: "agreements", label: "约定", group: "prefix", priority: "high", content: "第一人称克制白描。" },
    { id: "techniques", label: "技法", group: "prefix", priority: "medium", content: "每章末尾设小钩子。" },
    { id: "outline", label: "章纲", group: "dynamic", priority: "critical", content: "本章核心冲突：拆信。" },
    {
      id: "rollingSummaries",
      label: "前文摘要",
      group: "dynamic",
      priority: "optional",
      content: "前章摘要内容。".repeat(150),
      trimMode: "head",
    },
    { id: "activeDraft", label: "正文", group: "dynamic", priority: "critical", content: "林缓缓拆开信封。" },
  ];

  const tight = assembleContextBundle({ slots, maxInputTokens: 320 });
  assert.ok(tight.stablePrefix.includes("第一人称克制白描"));
  assert.ok(tight.dynamicTail.includes("林缓缓拆开信封"));
  assert.ok(tight.dynamicTail.includes("本章核心冲突：拆信"));
  const summaryReport = tight.report.slots.find((s) => s.id === "rollingSummaries");
  assert.ok(summaryReport.status === "dropped" || summaryReport.status === "truncated");
  assert.equal(tight.report.slots.find((s) => s.id === "activeDraft").status, "included");
});

test("Fanqie context.preview and run.start freeze rolling summaries, prev tail, active foreshadows, and Prefix techniques", (t) => {
  const ws = createTestWorkspace(t);
  const ch1 = ws.createFanqieChapter({ title: "第一章", body: "前情提要。\n" + "尾段衔接密文。".repeat(20) });
  const projectId = ch1.projectId;
  ws.app.mutation("chapter.summary.save", { documentId: ch1.documentId, summary: "第一章林得到密信。" });

  const ch2Id = ws.app.mutation("document.create", { projectId, title: "第二章" }).id;
  const ch2Rev = ws.app.mutation("draft.save", { documentId: ch2Id, baseRevisionId: null, body: "第二章开头草稿。" }).revisionId;
  ws.app.mutation("chapter.outline", {
    documentId: ch2Id,
    viewpoint: "林",
    target: 2200,
    lockedFacts: "密信在身",
    knowledge: "知晓密信内容",
    剧情梗概: "林深夜研究密信",
    核心冲突与看点: "线索指向老宅",
    情节推进节点: "对比笔迹",
    章末落点: "窗外有黑影",
  });

  const agree = ws.app.mutation("setting.propose", {
    projectId,
    documentId: ch1.documentId,
    factId: "style-rule",
    kind: "agreement",
    note: "保持悬疑冷峻文风",
    source: "作者约定",
    from: { chapterId: ch1.documentId, point: 1 },
  });
  ws.app.mutation("setting.decide", { projectId, documentId: ch1.documentId, proposalId: agree.id, accept: true });

  ws.app.mutation("foreshadow.upsert", {
    projectId,
    title: "火漆印记",
    plantedChapterId: ch1.documentId,
    status: "planted",
    note: "印记形似双蛇",
  });

  const tech = ws.app.mutation("technique.save", {
    scope: "project",
    projectId,
    title: "环境压迫渲染",
    category: "atmosphere",
    executionSteps: "通过雨声与烛火摇曳衬托危机",
  });
  ws.app.mutation("library.mount", {
    projectId,
    targetType: "chapter",
    targetId: ch2Id,
    itemKind: "technique",
    itemId: tech.id,
    mode: "pin",
  });

  const preview = ws.app.mutation("context.preview", {
    documentId: ch2Id,
    instruction: "续写夜探老宅",
    tokenLimit: 12_000,
  });
  assert.ok(preview.report.activeTechniqueIds.includes(tech.id));
  assert.ok(preview.report.slots.find((s) => s.id === "agreements").includedTokens > 0);
  assert.ok(preview.report.slots.find((s) => s.id === "rollingSummaries").includedTokens > 0);
  assert.ok(preview.report.slots.find((s) => s.id === "prevTail").includedTokens > 0);
  assert.ok(preview.report.slots.find((s) => s.id === "foreshadows").includedTokens > 0);

  const runId = ws.app.mutation("run.start", {
    documentId: ch2Id,
    baseRevisionId: ch2Rev,
    instruction: "续写夜探老宅",
    tokenLimit: 12_000,
  }).id;
  const { frozenInput } = ws.app.mutation("run.detail", { documentId: ch2Id, runId });
  const parsed = JSON.parse(frozenInput);
  assert.equal(parsed.text, "第二章开头草稿。");
  assert.ok(parsed.contextBundle.stablePrefix.includes("环境压迫渲染"));
  assert.ok(parsed.contextBundle.dynamicTail.includes("第一章林得到密信"));
  assert.ok(parsed.contextBundle.dynamicTail.includes("火漆印记"));
});

test("host proposal.generate runs single-shot zero-tools LLM and keeps proposals pending until explicit author confirmation", async () => {
  await withTempDir("zhizhang-proposal-gen-", async (dataDirectory) => {
    const llm = createScriptedLlm([
      {
        text: JSON.stringify({
          settings: [
            {
              factId: "silver-dagger",
              category: "item",
              entityName: "银匕首",
              note: "林在暗格中拾获刻有家徽的银匕首",
              point: 1,
              people: ["林"],
            },
          ],
          foreshadows: [{ title: "家徽缺角之谜", factId: "silver-dagger", status: "planted", note: "缺了一角" }],
        }),
        usage: { inputTokens: 120, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 0 },
      },
      {
        text: "```json\n{\"summary\":\"林在暗格发现缺角银匕首，决定连夜查清来源。\"}\n```",
        usage: { inputTokens: 90, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);

    const host = createMockDsHHost({ llm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const projectId = (await host.mutate("project.create", { name: "主权提案测试", product: "fanqie" })).body.result.id;
      const docId = (await host.mutate("document.create", { projectId, title: "第一章" })).body.result.id;
      await host.mutate("draft.save", { documentId: docId, baseRevisionId: null, body: "林打开暗格，拿出一柄银匕首。" });

      // 1. Trigger setting extraction proposal via async 202 route
      const genSetting = await host.mutate("proposal.generate", {
        kind: "setting",
        documentId: docId,
        provider: "fixture",
        model: "test",
        tokenLimit: 8000,
      });
      assert.equal(genSetting.status, 202);
      assert.equal(genSetting.body.result.generating, true);

      const settingProp = await host.waitFor(async () => {
        const list = (await host.mutate("proposal.list", { projectId, kind: "setting", status: "pending" })).body.result;
        return list.find((p) => p.id === genSetting.body.result.id) ?? null;
      });
      assert.equal(settingProp.settled, 220);
      assert.equal(llm.calls[0].options.tools, undefined);

      // Before confirmation: authoritative lore and foreshadow tables remain empty!
      assert.equal((await host.mutate("lore.list", { projectId })).body.result.entries.length, 0);
      assert.equal((await host.mutate("foreshadow.list", { projectId })).body.result.length, 0);

      // Author explicitly confirms -> enters authoritative lore & foreshadows
      const decided = await host.mutate("proposal.decide", { proposalId: settingProp.id, accept: true });
      assert.equal(decided.status, 200);
      assert.equal((await host.mutate("lore.list", { projectId })).body.result.entries.length, 1);
      assert.equal((await host.mutate("foreshadow.list", { projectId })).body.result.length, 1);

      // 2. Summary draft proposal (fenced JSON) also stays pending until author confirms
      const genSummary = await host.mutate("proposal.generate", {
        kind: "summary",
        documentId: docId,
        provider: "fixture",
        model: "test",
      });
      assert.equal(genSummary.status, 202);
      const summaryProp = await host.waitFor(async () => {
        const list = (await host.mutate("proposal.list", { projectId, kind: "summary", status: "pending" })).body.result;
        return list.find((p) => p.id === genSummary.body.result.id) ?? null;
      });
      assert.equal((await host.readState({ projectId, documentId: docId })).body.result.activeContext.summary, "");

      await host.mutate("proposal.decide", { proposalId: summaryProp.id, accept: true });
      assert.equal(
        (await host.readState({ projectId, documentId: docId })).body.result.activeContext.summary,
        "林在暗格发现缺角银匕首，决定连夜查清来源。",
      );
    } finally {
      await host.close();
    }
  });
});
