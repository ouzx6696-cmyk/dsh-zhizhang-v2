import test from "node:test";
import assert from "node:assert/strict";
import { QA_REFINEMENT_LIMIT } from "../src/contracts/protected-rules.ts";
import {
  analyzeEndingHook,
  analyzeParagraphLeadRepetition,
  applyParagraphPatches,
  buildLocalProposedBundle,
  countCustomizedContextFields,
  DEFAULT_CONTEXT_TUNING,
  detectCrossChapterEchoes,
  detectPovLeakHeuristics,
  diagnoseQualityV2,
  isDefaultContextTuning,
  normalizeContextTuning,
  preprocessNonStandardMaterials,
  rankTechniquesForChapter,
  selectNonConflictingTechniques,
} from "../src/domain/fanqie/index.ts";
import { applyWorkbench } from "../src/host/plugin.ts";
import {
  createMockDsHHost,
  createStrictToolRegistrar,
  createTestWorkspace,
  withTempDir,
} from "../support/harness.mjs";

function makeDynamicLlm(handler) {
  const calls = [];
  return {
    calls,
    async prepareCall(request) {
      return {
        config: {},
        async *stream(options) {
          calls.push({ request, options });
          const result = await handler(options, calls.length - 1);
          yield { type: "text-delta", index: 0, text: result.text };
          yield {
            type: "usage",
            usage: result.usage ?? {
              inputTokens: 1200,
              outputTokens: 200,
              cacheReadTokens: 900,
              cacheWriteTokens: 0,
            },
          };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
    },
  };
}

function flattenOptionsText(options) {
  const sys = typeof options.system === "string"
    ? options.system
    : Array.isArray(options.system)
      ? options.system.map((b) => b.text ?? "").join("\n")
      : "";
  const msgs = (options.messages ?? [])
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  return `${sys}\n${msgs}`;
}

test("Quality v2 pure diagnostics, surgical paragraph patching, and conflict-group technique mutual exclusion", () => {
  const weakEnding = [
    "沈砚站在门槛前，听见院外马蹄声停下。",
    "沈砚转身推开堂屋的木门，看到桌上一碗凉茶。",
    "沈砚伸手摸了摸袖口里的铜钱，心里略微松了口气。",
    "一切都暂时平息了，他转身回到床上慢慢睡去。",
  ].join("\n\n");

  const hookWeak = analyzeEndingHook(weakEnding);
  assert.equal(hookWeak.endingHookStatus, "warn");
  assert.ok(hookWeak.endingHookScore < 70);

  const strongEnding = [
    "刀锋擦着门框掠过，木屑纷飞。",
    "“你以为死在苍梧山的那个人，真是你二叔？”黑衣人扯下斗笠，露出半张被火烧毁的脸！",
  ].join("\n\n");
  const hookStrong = analyzeEndingHook(strongEnding);
  assert.equal(hookStrong.endingHookStatus, "pass");
  assert.ok(hookStrong.endingHookScore >= 70);

  const leadReps = analyzeParagraphLeadRepetition(weakEnding);
  assert.ok(leadReps.length >= 1);
  assert.equal(leadReps[0].lead, "沈砚");
  assert.deepEqual(leadReps[0].paragraphs, [1, 2, 3]);

  const recentBodies = [
    "他冷笑一声，眼中闪过一丝寒芒，冷笑一声转过身去。",
    "对方冷笑一声，眼中闪过一丝寒芒，抬手拍在桌上。",
  ];
  const currentBody = "沈砚冷笑一声，眼中闪过一丝寒芒，又冷笑一声推开木门，他早已知道玄霜密令的来历。";
  const echoes = detectCrossChapterEchoes(currentBody, recentBodies);
  assert.ok(echoes.some((e) => e.phrase.includes("冷笑")));

  const leaks = detectPovLeakHeuristics(
    currentBody,
    [{ factId: "f-secret", entityName: "玄霜密令", note: "幕后黑手藏在密室里的「玄霜密令」", aliases: ["密令"] }],
    "沈砚",
  );
  assert.ok(leaks.length >= 1);
  assert.equal(leaks[0].factId, "f-secret");
  assert.equal(leaks[0].paragraphIndex, 1);

  const q2 = diagnoseQualityV2(currentBody, {
    recentChapterBodies: recentBodies,
    hiddenFacts: [{ factId: "f-secret", entityName: "玄霜密令", note: "隐藏「玄霜密令」", aliases: [] }],
    viewpoint: "沈砚",
  });
  assert.ok(q2.compositeScore >= 0 && q2.compositeScore <= 100);
  assert.equal(q2.povLeakWarnings.length, 1);

  // Surgical patch preserves untouched paragraphs verbatim
  const original = "第一段原封不动。\n\n第二段需要外科手术修改。\n\n第三段也必须一字不差。";
  const patched = applyParagraphPatches(original, [
    { paragraphIndex: 2, replacement: "第二段已替换为更具体的动作描写。" },
  ]);
  assert.equal(patched.appliedCount, 1);
  assert.equal(patched.skippedIndices.length, 0);
  assert.equal(
    patched.body,
    "第一段原封不动。\n\n第二段已替换为更具体的动作描写。\n\n第三段也必须一字不差。",
  );

  // Conflict group mutual exclusion + historical delta boost
  const cards = [
    {
      id: "t-high",
      scope: "project",
      status: "approved",
      title: "快节奏压迫对话",
      category: "dialogue",
      pacing: "快爽",
      sceneTags: ["冲突", "打脸"],
      triggerWhen: "冲突对峙",
      priority: 10,
      conflictGroup: "dialogue_style",
      appliedCount: 4,
      avgQualityDelta: 6.5,
    },
    {
      id: "t-low",
      scope: "project",
      status: "approved",
      title: "慢燃留白对话",
      category: "dialogue",
      pacing: "慢燃",
      sceneTags: ["冲突"],
      triggerWhen: "冲突对峙",
      priority: 5,
      conflictGroup: "dialogue_style",
      appliedCount: 3,
      avgQualityDelta: -2.0,
    },
    {
      id: "t-hook",
      scope: "project",
      status: "approved",
      title: "断章惊雷",
      category: "cliffhanger",
      pacing: "快爽",
      sceneTags: ["高潮"],
      triggerWhen: "章末",
      priority: 8,
    },
  ];
  const ranked = rankTechniquesForChapter({
    cards,
    mounts: [],
    contextIds: { projectId: "p1", volumeId: null, actId: null, chapterId: "c1" },
    pacing: "快爽",
    outlineText: "冲突对峙打脸高潮",
  });
  assert.equal(ranked[0].card.id, "t-high");

  const resolved = selectNonConflictingTechniques(ranked, 3);
  assert.deepEqual(
    resolved.selected.map((s) => s.card.id),
    ["t-high", "t-hook"],
  );
  assert.deepEqual(resolved.conflictSkippedIds, ["t-low"]);
});

test("Non-standard material 3-stage pipeline: preprocess, DsH tools, locked/final protection, atomic commit & L1 rebuild", async () => {
  const rawMixed = `\uFEFF# 全书大纲与核心设定\n\n<script>alert(1)</script>\n沈砚：寒门庶子，佩带青铜玉玦，性格隐忍。\n伏笔：青铜玉玦背后隐藏着三年前灭门案的真凶。\n\n第一卷 苍梧初雨\n\n第1章 雨夜登门\n雨水顺着青瓦砸在阶前，沈砚推开破败的侧门，手里紧握那半枚冰凉的青铜玉玦。院中灯火忽明忽暗，老管家低声道：“二少爷，老爷让你立刻去祠堂。”\n\n第2章 祠堂对峙\n[待补：祠堂内三叔发难的细节]\n沈砚冷冷看着案上的族谱，没有退后半步。`;

  const parsed = preprocessNonStandardMaterials([{ path: "杂乱设定与手稿.md", content: rawMixed }], []);
  assert.ok(parsed.chunks.length >= 3);
  assert.ok(parsed.cleaningWarnings.some((w) => w.includes("BOM") || w.includes("HTML") || w.includes("脚本")));
  assert.ok(parsed.chunks.some((c) => c.role === "completed_chapter" || c.role === "rough_draft"));
  assert.ok(parsed.chunks.some((c) => c.role === "lore_note" || c.role === "outline_note"));

  const localBundle = buildLocalProposedBundle(parsed.chunks, [], []);
  assert.ok(localBundle.chapters.length >= 2);
  assert.ok(localBundle.lore.length >= 1);

  await withTempDir("zhizhang-ingest-", async (dataDirectory) => {
    const toolReg = createStrictToolRegistrar();
    const mockLlm = makeDynamicLlm(() => ({
      text: JSON.stringify({
        authorIntent: "寒门庶子借青铜玉玦步步反杀世家",
        currentFocus: "第一卷祠堂立威",
        pacingTier: "快爽",
        genreTags: ["权谋", "逆袭"],
        chapters: [
          {
            volumeTitle: "第一卷 苍梧初雨",
            actTitle: "第一幕",
            title: "第1章 雨夜登门",
            state: "drafted",
            summary: "沈砚雨夜归家，受命前往祠堂。",
            body: "雨水顺着青瓦砸在阶前，沈砚推开破败的侧门，握紧青铜玉玦。",
            viewpoint: "沈砚",
          },
          {
            volumeTitle: "第一卷 苍梧初雨",
            actTitle: "第一幕",
            title: "第2章 祠堂对峙",
            state: "drafting",
            summary: "三叔在祠堂发难，沈砚亮出线索。",
            body: "沈砚冷冷看着案上的族谱，没有退后半步。",
            viewpoint: "沈砚",
          },
          {
            volumeTitle: "第一卷 苍梧初雨",
            actTitle: "第一幕",
            title: "已定稿铁章",
            state: "drafted",
            summary: "尝试覆盖定稿章应被拦截",
            body: "试图篡改已定稿正文。",
          },
        ],
        lore: [
          {
            factId: "locked-core",
            category: "world_rule",
            entityName: "天道禁律",
            note: "试图篡改的锁定设定",
            aliases: [],
            lockedSuggested: true,
            knownBy: [],
          },
          {
            factId: "char-shenyan",
            category: "character",
            entityName: "沈砚",
            note: "寒门庶子，随身佩带青铜玉玦，隐忍果决。",
            aliases: ["二少爷"],
            lockedSuggested: true,
            knownBy: [{ character: "沈砚" }],
          },
        ],
        foreshadows: [
          {
            title: "青铜玉玦灭门案线索",
            status: "planted",
            plantedChapterTitle: "第1章 雨夜登门",
            targetChapterTitle: "第2章 祠堂对峙",
            note: "玉玦缺口对应真凶佩刀。",
          },
        ],
        warnings: [],
      }),
    }));

    const host = createMockDsHHost({ tools: toolReg, llm: mockLlm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    try {
      const projId = (await host.command("project.create", { product: "fanqie", name: "重写入测试书" })).body.result.id;

      // Create a finalized chapter and a locked lore fact to verify strict protection
      const finalChId = (await host.command("document.create", { projectId: projId, title: "已定稿铁章" })).body.result.id;
      const saved = (await host.command("draft.save", { documentId: finalChId, baseRevisionId: null, body: "已定稿神圣不可侵犯。" })).body.result;
      const revRes = await host.command("chapter.review", { documentId: finalChId, baseRevisionId: saved.revisionId, accept: true });
      assert.equal(revRes.status, 200);
      const finRes = await host.command("draft.finalize", { documentId: finalChId, baseRevisionId: saved.revisionId });
      assert.equal(finRes.status, 200);

      const lockedProp = (await host.command("setting.propose", {
        projectId: projId,
        documentId: finalChId,
        factId: "locked-core",
        note: "铁律原文不可覆盖",
        source: "作者手写",
        from: { chapterId: finalChId, point: 1 },
        people: [{ character: "沈砚" }],
        locked: true,
      })).body.result;
      await host.command("setting.decide", {
        projectId: projId,
        documentId: finalChId,
        proposalId: lockedProp.id,
        accept: true,
      });

      // Stage 1: preprocess via command
      const pre = (await host.command("material.preprocess", {
        projectId: projId,
        files: [{ path: "杂乱设定与手稿.md", content: rawMixed }],
      })).body.result;
      assert.equal(pre.status, "chunked");
      assert.ok(pre.chunks.length >= 3);

      // Partial chunk update preserves original content
      const updatedPre = (await host.command("material.update_chunks", {
        sessionId: pre.id,
        chunks: pre.chunks.map((c) => ({ id: c.id, role: c.role, title: c.title })),
      })).body.result;
      assert.ok(updatedPre.chunks.every((c) => c.content.length > 0));

      // DsH read-only preview tool
      const previewToolOut = await toolReg.invoke("zhizhang_ingest_preview", {
        projectId: projId,
        sessionId: pre.id,
      });
      assert.equal(previewToolOut.id, pre.id);

      // Stage 2a: AI extraction via unified /jobs/start (material_normalize)
      const startRes = await host.startJob("material_normalize", {
        sessionId: pre.id,
        provider: "deepseek",
        model: "deepseek-chat",
      });
      assert.equal(startRes.status, 202);

      const readySession = await host.waitFor(async () => {
        const s = (await host.command("material.get", { sessionId: pre.id })).body.result;
        return s.status === "ready_for_review" ? s : null;
      });
      assert.equal(mockLlm.calls.length, 1);
      // Verify L0 shared kernel was reused
      assert.ok(flattenOptionsText(mockLlm.calls[0].options).includes("织章"));

      // Verify conflict detection marked finalized chapter and locked lore as skip
      const skippedFinal = readySession.proposedBundle.chapters.find((c) => c.title === "已定稿铁章");
      assert.equal(skippedFinal.conflictStatus, "skip_locked_final");
      assert.equal(skippedFinal.selected, false);
      const skippedLocked = readySession.proposedBundle.lore.find((l) => l.factId === "locked-core");
      assert.equal(skippedLocked.conflictStatus, "skip_locked");
      assert.equal(skippedLocked.selected, false);

      // Stage 3: Atomic commit
      const commitRes = (await host.command("material.commit", {
        sessionId: pre.id,
      })).body.result;
      assert.equal(commitRes.chaptersCreated, 2);
      assert.equal(commitRes.chaptersSkippedLocked, 1);
      assert.equal(commitRes.loreCommitted, 1);
      assert.equal(commitRes.loreSkippedLocked, 1);
      assert.equal(commitRes.foreshadowsCommitted, 1);
      assert.equal(commitRes.controlsUpdated, true);
      assert.ok(commitRes.l1SnapshotVersion >= 1);

      // Verify finalized chapter and locked lore were untouched!
      const finalState = (await host.getState({ projectId: projId, documentId: finalChId })).body.result;
      assert.equal(finalState.active.body, "已定稿神圣不可侵犯。");
      const lockedFact = finalState.settings.find((s) => s.fact.id === "locked-core");
      assert.equal(lockedFact.fact.note, "铁律原文不可覆盖");

      // Also test DsH Agent pushing a fresh material bundle via zhizhang_propose_material_bundle
      const agentSession = await toolReg.invoke("zhizhang_propose_material_bundle", {
        projectId: projId,
        bundle: {
          chapters: [
            { volumeTitle: "第二卷", actTitle: "第一幕", title: "第3章 暗潮涌动", state: "drafting", summary: "新卷开启", body: "暗流在夜色中涌动。" },
          ],
          lore: [],
          foreshadows: [],
          warnings: [],
        },
      });
      assert.equal(agentSession.sourceOrigin, "dsh_agent");
      assert.equal(agentSession.status, "ready_for_review");
    } finally {
      await host.close();
    }
  });
});

test("Tiered Autopilot: 5-step pipeline, byte-identical L0+L1+L2 prefix reuse, gate pause/resume, technique telemetry & rollback", async () => {
  await withTempDir("zhizhang-autopilot-", async (dataDirectory) => {
    let refineCallCount = 0;

    const mockLlm = makeDynamicLlm((options) => {
      const promptText = flattenOptionsText(options);
      if (promptText.includes("节拍规划") || promptText.includes("beats")) {
        return {
          text: JSON.stringify({
            chapterGoal: "祠堂亮出证据反杀三叔",
            povCharacter: "沈砚",
            beats: [
              { index: 1, summary: "三叔当众发难", conflict: "争夺家产", emotionTurn: "压抑转冷厉", targetChars: 600 },
              { index: 2, summary: "沈砚亮出玉玦与旧账", conflict: "翻盘打脸", emotionTurn: "爽感爆发", targetChars: 800 },
            ],
            endingHook: "祠堂外突然响起官兵破门声，指名拿人！",
          }),
        };
      }
      if (promptText.includes("外科手术式段落精修") || promptText.includes("带段落编号的正文")) {
        refineCallCount += 1;
        return {
          text: JSON.stringify({
            patches: [
              {
                paragraphIndex: 2,
                reason: "替换平淡结尾，拉升章末断章钩子张力",
                replacement: "“官府的人已经在门外了，三叔猜猜，他们今天要拿的是谁？”祠堂大门轰然被撞开！",
              },
            ],
          }),
        };
      }
      if (promptText.includes("待审章节") || promptText.includes("定性审稿")) {
        const obs =
          refineCallCount === 0
            ? [{ dimension: "continuity", severity: "error", quote: "他转身回去睡了", suggestion: "与祠堂对峙连贯性断裂且结尾钩子偏弱，需补悬念动作" }]
            : [];
        return { text: JSON.stringify({ observations: obs }) };
      }
      if (promptText.includes("foreshadowUpdates") || promptText.includes("事实同步")) {
        return {
          text: JSON.stringify({
            summary: "沈砚在祠堂亮出铁证反击三叔，门外官兵破门而入。",
            factProposals: [],
            foreshadowUpdates: [],
          }),
        };
      }
      // Draft write: weak ending on first write so surgical_refine triggers & improves score
      return {
        text: "祠堂里灯火摇曳，三叔猛地一拍供桌，冷声喝道：“这本旧账你从哪偷来的？”沈砚抬眼一笑，将青铜玉玦压在账册之上。\n\n一切都暂时平息了，他转身回去睡了。",
      };
    });

    const host = createMockDsHHost({ llm: mockLlm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    try {
      const projId = (await host.command("project.create", { product: "fanqie", name: "自治测试长篇" })).body.result.id;
      const ch1 = (await host.command("document.create", { projectId: projId, title: "第1章 祠堂立威" })).body.result.id;
      const ch2 = (await host.command("document.create", { projectId: projId, title: "第2章 官兵破门" })).body.result.id;

      await host.command("draft.save", { documentId: ch1, baseRevisionId: null, body: "作者手写初始第一稿。" });

      const tech = (await host.command("technique.save", {
        scope: "project",
        projectId: projId,
        title: "祠堂反杀断章术",
        category: "cliffhanger",
        pacing: "快爽",
        sceneTags: ["祠堂", "打脸"],
        executionSteps: "先放对手拍桌叫嚣，再亮实证，尾句留破门悬念。",
        conflictGroup: "hook_style",
        positiveExample: "门外忽然传来重甲踏阶之声！",
        negativeExample: "一切都暂时平息了。",
      })).body.result;
      await host.command("library.mount", {
        projectId: projId,
        targetType: "project",
        targetId: projId,
        itemKind: "technique",
        itemId: tech.id,
        mode: "include",
      });

      const startRes = await host.startJob("autopilot_pipeline", {
        projectId: projId,
        scope: "multi_chapter",
        chapterIds: [ch1, ch2],
        autonomyMode: "chapter_gate",
        adoptionPolicy: "working_draft_snapshot",
        tokenBudget: 80000,
        provider: "deepseek",
        model: "deepseek-chat",
      });
      assert.equal(startRes.status, 202);
      const batchId = startRes.body.result.batchId;

      const pausedBatch = await host.waitFor(async () => {
        const b = (await host.command("autopilot.get", { batchId })).body.result;
        return b.status === "paused_gate" || b.status === "paused_redline" || b.status === "completed" || b.status === "failed" ? b : null;
      });
      assert.equal(pausedBatch.status, "paused_gate", `unexpected status ${pausedBatch.status}: ${JSON.stringify(pausedBatch.pauseReason)}`);
      assert.equal(pausedBatch.pauseReason.kind, "chapter_gate_checkpoint");

      assert.ok(refineCallCount >= 1 && refineCallCount <= QA_REFINEMENT_LIMIT);
      const ch1State = (await host.getState({ projectId: projId, documentId: ch1 })).body.result;
      assert.ok(ch1State.active.body.includes("祠堂里灯火摇曳"));
      assert.ok(ch1State.active.body.includes("祠堂大门轰然被撞开！"));

      // Verify byte-identical L0 system prompt across all LLM calls in the chapter
      assert.ok(mockLlm.calls.length >= 4);
      const firstSys = JSON.stringify(mockLlm.calls[0].options.system);
      for (const call of mockLlm.calls) {
        assert.equal(JSON.stringify(call.options.system), firstSys, "L0 system kernel must be byte-identical across all autopilot phases");
      }

      // Verify technique effectiveness telemetry updated
      const techsAfter = (await host.command("technique.list", { projectId: projId, scope: "project" })).body.result;
      const updatedTech = techsAfter.find((t) => t.id === tech.id);
      assert.ok(updatedTech.appliedCount >= 1);

      // Resume batch for ch2 with overrideRedLine
      const resumeRes = await host.startJob("autopilot_pipeline", {
        batchId,
        overrideRedLine: true,
        provider: "deepseek",
        model: "deepseek-chat",
      });
      assert.equal(resumeRes.status, 202);

      const doneBatch = await host.waitFor(async () => {
        const b = (await host.command("autopilot.get", { batchId })).body.result;
        return b.status === "completed" || b.status === "paused_redline" || b.status === "failed" ? b : null;
      });
      assert.equal(doneBatch.status, "completed", `unexpected status ${doneBatch.status}: ${JSON.stringify(doneBatch.pauseReason)}`);

      // Test one-click non-destructive rollback of ch1 to pre-batch snapshot
      const rolled = (await host.command("autopilot.rollback_chapter", {
        batchId,
        documentId: ch1,
      })).body.result;
      assert.ok(rolled.restoredRevisionId);
      assert.equal(rolled.documentId, ch1);
      const afterRollback = (await host.getState({ projectId: projId, documentId: ch1 })).body.result;
      assert.equal(afterRollback.active.body, "作者手写初始第一稿。");
    } finally {
      await host.close();
    }
  });
});

test("Autopilot persists refined candidates across the chapter gate and reopens the selected upstream text", async (t) => {
  const workspace = createTestWorkspace(t, { mode: "file", wal: true });
  let { app } = workspace;
  const first = workspace.createFanqieChapter({ body: "作者现有正文。上章原本在柴房收尾。" });
  const { projectId } = first;
  const second = app.mutation("document.create", { projectId, title: "第二章" }).id;
  const secondRevision = app.mutation("draft.save", {
    documentId: second, baseRevisionId: null, body: "作者第二章原稿。",
  }).revisionId;
  const generated = "赵婵把书放回架上。\n\n她很快就回屋了。";
  const ending = "一封赤蜡封口的密信从书架上掉下来。门外响起一声：“别拆！”";
  const seenWrites = [];
  const model = {
    usedTokens: () => 0,
    async complete({ phase, prompt }) {
      switch (phase) {
        case "beatPlan":
          return JSON.stringify({
            openingHook: "密信落地",
            beats: [{ index: 1, scene: "书架", conflict: "有人守着门", turn: "发现密信", targetChars: 600 }],
            endingHook: "门外发出警告",
          });
        case "write":
          seenWrites.push(prompt);
          return generated;
        case "chapterReview":
          return JSON.stringify({
            observations: [{ dimension: "continuity", severity: "error", quote: "她很快就回屋了", suggestion: "明确她为何停下" }],
          });
        case "surgicalPatch":
          return JSON.stringify({ patches: [{ paragraphIndex: 2, replacement: ending, reason: "让动作导向悬念" }] });
        default:
          assert.fail(`candidate-only should not call ${phase}`);
      }
    },
  };
  const { id: batchId } = app.mutation("autopilot.start", {
    projectId, scope: "multi_chapter", chapterIds: [first.documentId, second],
    autonomyMode: "chapter_gate", adoptionPolicy: "candidate_only",
  });
  const runBatch = (overrideRedLine = true) => app.runAutopilotJob({
    projectId, batchId, overrideRedLine, caller: model, signal: new AbortController().signal,
  });
  const paused = await runBatch();
  assert.equal(paused.status, "paused_gate");
  assert.equal(paused.candidates.length, 1);
  const firstCandidate = paused.candidates[0];
  assert.equal(firstCandidate.state, "awaiting-author");
  app = workspace.reopen();
  const firstState = app.snapshot(projectId, first.documentId);
  assert.equal(firstState.active.revisionId, first.revisionId);
  assert.equal(firstState.runs[0].candidateId, firstCandidate.candidateId);
  assert.match(firstState.runs[0].candidateBody, /赤蜡封口/);
  assert.doesNotMatch(firstState.runs[0].candidateBody, /她很快就回屋/);

  const context = (previousVersionId) => app.mutation("context.preview", {
    documentId: second, previousVersionId, includeText: true,
  });
  assert.match(context().dynamicTail, /在柴房收尾/);
  assert.match(context(firstCandidate.candidateId).dynamicTail, /赤蜡封口/);
  assert.doesNotMatch(context(firstCandidate.candidateId).dynamicTail, /在柴房收尾/);
  assert.throws(() => context(secondRevision), { code: "input.invalid" });
  const another = workspace.createFanqieChapter({ projectName: "另一本书" });
  assert.throws(() => context(another.revisionId), { code: "input.invalid" });
  assert.ok(app.snapshot(projectId, second).previousChapterVersions.some((v) => v.id === firstCandidate.candidateId));

  const done = await runBatch();
  assert.equal(done.status, "completed");
  assert.equal(done.candidates.length, 2);
  assert.equal(seenWrites.length, 2);
  assert.match(seenWrites[1], /赤蜡封口/);
  assert.doesNotMatch(seenWrites[1], /在柴房收尾/);
  assert.equal(done.steps.filter((step) => step.stepKind === "fact_sync" && step.status === "skipped").length, 2);
  assert.equal(app.snapshot(projectId, second).pendingProposalCount, 0);
  const secondCandidate = done.candidates.find((candidate) => candidate.documentId === second);
  const run = app.mutation("run.detail", { documentId: second, runId: secondCandidate.runId });
  assert.equal(JSON.parse(run.frozenInput).continuationSource.id, firstCandidate.candidateId);
  assert.equal(run.continuationState, "pending");
  assert.equal(app.snapshot(projectId, second).active.revisionId, secondRevision);
  app.mutation("candidate.adopt", {
    documentId: second, runId: secondCandidate.runId, baseRevisionId: secondRevision, key: "adopt-second",
  });
  assert.match(app.snapshot(projectId, second).active.body, /赤蜡封口/);
  const firstAdopted = app.mutation("candidate.adopt", {
    documentId: first.documentId, runId: firstCandidate.runId, baseRevisionId: first.revisionId, key: "adopt-first",
  });
  const details = () => app.mutation("run.detail", { documentId: second, runId: secondCandidate.runId });
  assert.equal(details().continuationState, "aligned");
  app.mutation("draft.save", { documentId: first.documentId, baseRevisionId: firstAdopted.revisionId, body: "作者删掉了上一章的密信。" });
  assert.equal(details().continuationState, "changed");
  assert.equal((await runBatch()).candidates.length, 2);
  assert.throws(() => app.mutation("autopilot.rollback_chapter", {
    batchId, documentId: first.documentId,
  }), { code: "gate.denied" });

  const secondWorking = app.snapshot(projectId, second).active.revisionId;
  const { id: manualRun } = app.mutation("run.start", {
    documentId: second, baseRevisionId: secondWorking, key: "continue-from-first-old-revision",
    instruction: "沿上章旧稿续写", tokenLimit: 12000, previousVersionId: first.revisionId,
  });
  const manualDetail = app.mutation("run.detail", { documentId: second, runId: manualRun });
  assert.equal(JSON.parse(manualDetail.frozenInput).continuationSource.id, first.revisionId);
  assert.match(JSON.parse(manualDetail.frozenInput).contextBundle.dynamicTail, /在柴房收尾/);

  const third = app.mutation("document.create", { projectId, title: "第三章" }).id;
  const redlineBatch = app.mutation("autopilot.start", { projectId, documentId: third, adoptionPolicy: "candidate_only" });
  const redlineCaller = {
    ...model,
    complete(input) {
      if (input.phase === "surgicalPatch") return JSON.stringify({ patches: [] });
      return model.complete(input);
    },
  };
  const attempt = (overrideRedLine) => app.runAutopilotJob({
    projectId, batchId: redlineBatch.id, overrideRedLine, caller: redlineCaller, signal: new AbortController().signal,
  });
  const stopped = await attempt(false);
  assert.equal(stopped.status, "paused_redline");
  assert.equal(stopped.candidates.length, 1);
  const newChapter = app.snapshot(projectId, third);
  assert.equal(newChapter.active.body, "");
  assert.equal(newChapter.runs[0].candidateBody, generated);
  const callsBeforeResume = seenWrites.length;
  assert.equal((await attempt(false)).status, "paused_redline");
  const resumed = await attempt(true);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.candidates[0].candidateId, stopped.candidates[0].candidateId);
  assert.equal(seenWrites.length, callsBeforeResume);
});

test("User-tunable ContextTuningConfig: bounds clamping, slot toggles, reading windows & one-click reset to defaults", async () => {
  // 1. Pure domain defaults, clamping, and diff counting
  assert.equal(isDefaultContextTuning(DEFAULT_CONTEXT_TUNING), true);
  assert.equal(countCustomizedContextFields(DEFAULT_CONTEXT_TUNING), 0);

  const clamped = normalizeContextTuning({
    defaultTokenLimit: 999999,
    inputBudgetRatio: 0.12,
    l1BudgetTokens: 200,
    l1DirtyThreshold: 0,
    l2MilestoneChunkSize: 99,
    prevTailChars: -50,
    rollingSummaryCount: 100,
    relatedHistoryTopK: -3,
    relatedHistoryRecentExclude: 99,
    antiEchoWindow: 40,
    staleForeshadowGap: 2,
    maxActiveTechniques: 99,
    maxActiveDeconstructions: -2,
    techniqueExampleChars: 50,
    deconstructionExcerptChars: 99999,
    includeL1BookBible: false,
  });
  assert.equal(clamped.defaultTokenLimit, 128000);
  assert.equal(clamped.inputBudgetRatio, 0.5);
  assert.equal(clamped.l1BudgetTokens, 1024);
  assert.equal(clamped.l1DirtyThreshold, 1);
  assert.equal(clamped.l2MilestoneChunkSize, 30);
  assert.equal(clamped.prevTailChars, 0);
  assert.equal(clamped.rollingSummaryCount, 30);
  assert.equal(clamped.relatedHistoryTopK, 0);
  assert.equal(clamped.relatedHistoryRecentExclude, 20);
  assert.equal(clamped.antiEchoWindow, 10);
  assert.equal(clamped.staleForeshadowGap, 5);
  assert.equal(clamped.maxActiveTechniques, 10);
  assert.equal(clamped.maxActiveDeconstructions, 0);
  assert.equal(clamped.techniqueExampleChars, 100);
  assert.equal(clamped.deconstructionExcerptChars, 2000);
  assert.equal(clamped.includeL1BookBible, false);
  assert.equal(isDefaultContextTuning(clamped), false);
  assert.equal(countCustomizedContextFields(clamped), 16);

  // 2. End-to-end workbench persistence, context.preview effects & one-click reset
  await withTempDir("zhizhang-ctx-tuning-", async (dataDirectory) => {
    const host = createMockDsHHost();
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    try {
      const projId = (await host.command("project.create", { product: "fanqie", name: "上下文调试测试书" })).body.result.id;
      const ch1 = (await host.command("document.create", { projectId: projId, title: "第1章 缘起" })).body.result.id;
      const ch2 = (await host.command("document.create", { projectId: projId, title: "第2章 暗局" })).body.result.id;

      await host.command("draft.save", {
        documentId: ch1,
        baseRevisionId: null,
        body: "青铜玉玦在雨夜里微微发烫，沈砚推开了祠堂侧门，看见三叔冷笑着坐在太师椅上。",
      });
      await host.command("draft.save", {
        documentId: ch2,
        baseRevisionId: null,
        body: "祠堂烛火忽明忽暗，沈砚将旧账轻轻按在供桌上。",
      });

      const factProp = (await host.command("setting.propose", {
        projectId: projId,
        documentId: ch1,
        factId: "jade-key",
        note: "青铜玉玦藏有灭门案密匙。",
        source: "设定集",
        from: { chapterId: ch1, point: 1 },
        people: [{ character: "沈砚" }],
        locked: true,
      })).body.result;
      await host.command("setting.decide", {
        projectId: projId,
        documentId: ch1,
        proposalId: factProp.id,
        accept: true,
      });

      const tech = (await host.command("technique.save", {
        scope: "project",
        projectId: projId,
        title: "祠堂暗讽技",
        category: "dialogue",
        pacing: "快爽",
        sceneTags: ["祠堂"],
        executionSteps: "用反问压缩对手话语权。",
      })).body.result;
      await host.command("library.mount", {
        projectId: projId,
        targetType: "project",
        targetId: projId,
        itemKind: "technique",
        itemId: tech.id,
        mode: "include",
      });

      // Default preview
      const defaultPreview = (await host.command("context.preview", { documentId: ch2 })).body.result;
      assert.equal(defaultPreview.customizedCount, 0);
      assert.equal(defaultPreview.contextTuning.defaultTokenLimit, DEFAULT_CONTEXT_TUNING.defaultTokenLimit);
      assert.equal(
        defaultPreview.report.maxInputTokens,
        Math.floor(DEFAULT_CONTEXT_TUNING.defaultTokenLimit * DEFAULT_CONTEXT_TUNING.inputBudgetRatio),
      );
      assert.equal(defaultPreview.report.l1DirtyThreshold, DEFAULT_CONTEXT_TUNING.l1DirtyThreshold);
      assert.ok(defaultPreview.report.l1Tokens > 0);
      assert.equal(
        defaultPreview.report.slots.find((s) => s.id === "prevTail").status,
        "included",
      );
      assert.ok(defaultPreview.report.activeTechniqueIds.includes(tech.id));

      // Save customized tuning (toggles + reading windows + caps + budget)
      const savedControls = (await host.command("controls.save", {
        projectId: projId,
        authorIntent: "测试长篇节奏可控",
        currentFocus: "祠堂对峙",
        pacingTier: "快爽",
        genreTags: ["权谋"],
        dailyTarget: 6000,
        contextTuning: {
          defaultTokenLimit: 24000,
          l1DirtyThreshold: 15,
          prevTailChars: 0,
          maxActiveTechniques: 0,
          staleForeshadowGap: 35,
          includeL1BookBible: false,
          includePrevTail: false,
          includeRelatedHistory: false,
        },
      })).body.result;

      assert.equal(savedControls.isDefaultContextTuning, false);
      assert.equal(savedControls.pacingTier, "快爽");
      assert.equal(savedControls.dailyTarget, 6000);
      assert.equal(savedControls.staleForeshadowGap, 35);
      assert.equal(savedControls.contextTuning.defaultTokenLimit, 24000);
      assert.equal(savedControls.contextTuning.staleForeshadowGap, 35);

      const customPreview = (await host.command("context.preview", { documentId: ch2 })).body.result;
      assert.equal(customPreview.customizedCount, 8);
      assert.equal(
        customPreview.report.maxInputTokens,
        Math.floor(24000 * DEFAULT_CONTEXT_TUNING.inputBudgetRatio),
      );
      assert.equal(customPreview.report.l1Tokens, 0);
      assert.equal(customPreview.report.l1DirtyThreshold, 15);
      assert.equal(customPreview.report.contextCustomizedCount, 8);
      assert.equal(
        customPreview.report.slots.find((s) => s.id === "l1BookBible").status,
        "disabled",
      );
      assert.equal(
        customPreview.report.slots.find((s) => s.id === "prevTail").status,
        "disabled",
      );
      assert.equal(
        customPreview.report.slots.find((s) => s.id === "relatedHistory").status,
        "disabled",
      );
      assert.equal(
        customPreview.report.slots.find((s) => s.id === "chapterTechniques").status,
        "disabled",
      );
      assert.deepEqual(customPreview.report.activeTechniqueIds, []);

      // One-click Reset to Defaults restores exact baseline without losing authorIntent/dailyTarget
      const resetControls = (await host.command("controls.reset_context", {
        projectId: projId,
      })).body.result;
      assert.equal(resetControls.isDefaultContextTuning, true);
      assert.deepEqual(resetControls.contextTuning, DEFAULT_CONTEXT_TUNING);
      assert.equal(resetControls.authorIntent, "测试长篇节奏可控");
      assert.equal(resetControls.dailyTarget, 6000);
      assert.equal(resetControls.staleForeshadowGap, DEFAULT_CONTEXT_TUNING.staleForeshadowGap);

      const restoredPreview = (await host.command("context.preview", { documentId: ch2 })).body.result;
      assert.equal(restoredPreview.customizedCount, 0);
      assert.equal(
        restoredPreview.report.maxInputTokens,
        Math.floor(DEFAULT_CONTEXT_TUNING.defaultTokenLimit * DEFAULT_CONTEXT_TUNING.inputBudgetRatio),
      );
      assert.ok(restoredPreview.report.l1Tokens > 0);
      assert.equal(
        restoredPreview.report.slots.find((s) => s.id === "prevTail").status,
        "included",
      );
      assert.ok(restoredPreview.report.activeTechniqueIds.includes(tech.id));
    } finally {
      await host.close();
    }
  });
});

