import test from "node:test";
import assert from "node:assert/strict";
import { applyWorkbench } from "../src/host/plugin.ts";
import { applyParagraphPatches } from "../src/application/collaboration.ts";
import {
  assertRejectsContract,
  assertThrowsContract,
  createMockDsHHost,
  createMockSystemPromptRegistrar,
  createStrictToolRegistrar,
  createTestWorkspace,
  withTempDir,
} from "../support/harness.mjs";

test("applyParagraphPatches updates only targeted 1-based paragraphs and validates bounds", () => {
  const original = "第一段原始文本。\n\n第二段原始文本。\n\n第三段原始文本。";
  const patched = applyParagraphPatches(original, [
    { paragraphIndex: 2, replacement: "第二段已由 Agent 局部精修。" },
  ]);
  assert.equal(patched, "第一段原始文本。\n\n第二段已由 Agent 局部精修。\n\n第三段原始文本。");

  assertThrowsContract(
    () => applyParagraphPatches(original, [{ paragraphIndex: 4, replacement: "越界" }]),
    "input.invalid",
  );
  assertThrowsContract(
    () => applyParagraphPatches(original, [
      { paragraphIndex: 1, replacement: "重复" },
      { paragraphIndex: 1, replacement: "再次重复" },
    ]),
    "input.invalid",
  );
});

test("progressive-disclosure systemPrompt, focus sync, and Skill catalog -> load -> mount flow", async () => {
  await withTempDir("zhizhang-cocreate-prompt-", async (dataDirectory) => {
    const toolReg = createStrictToolRegistrar();
    const promptReg = createMockSystemPromptRegistrar();
    const host = createMockDsHHost({ tools: toolReg, systemPrompt: promptReg, cordis: true });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    try {
      const projectId = (await host.command("project.create", { product: "fanqie", name: "雪夜孤舟" })).body.result.id;

      // Agent creates volume -> act -> chapter via zhizhang_create_structure
      const vol = await toolReg.invoke("zhizhang_create_structure", {
        projectId,
        kind: "volume",
        title: "第一卷 寒江起风",
        goal: "立住主角绝境反杀悬念",
      });
      assert.ok(vol.id);

      const act = await toolReg.invoke("zhizhang_create_structure", {
        projectId,
        kind: "act",
        volumeId: vol.id,
        title: "第一幕 码头惊变",
      });
      assert.ok(act.id);

      const ch = await toolReg.invoke("zhizhang_create_structure", {
        projectId,
        kind: "chapter",
        volumeId: vol.id,
        actId: act.id,
        title: "第一章 断缆",
      });
      assert.ok(ch.id);

      // Sync workspace focus and verify zhizhang_read_focus
      await host.command("focus.set", { projectId, documentId: ch.id, viewMode: "conversation", sessionId: "draft-session" });
      const focusRes = await toolReg.invoke("zhizhang_read_focus", {}, { agent: { id: "draft-session" } });
      assert.equal(focusRes.focus.projectId, projectId);
      assert.equal(focusRes.focus.documentId, ch.id);
      assert.equal(focusRes.focus.projectName, "雪夜孤舟");
      assert.equal(focusRes.focus.documentTitle, "第一章 断缆");
      assert.equal(focusRes.focus.collaborationMode, "cautious");
      assert.equal(focusRes.focus.viewMode, "conversation");
      assert.equal(focusRes.projects.length, 1);

      // Create a custom Skill card with distinct long execution steps
      const secretSteps = "执行步骤：第一步压低环境光，第二步延迟揭晓反派身份，第三步在最后五十字抛出断缆悬念。";
      const createdCard = (await host.command("technique.save", {
        scope: "project",
        projectId,
        title: "断缆悬念收尾法",
        category: "hook",
        pacing: "快爽",
        triggerWhen: "章末需要强悬念钩子时",
        executionSteps: secretSteps,
        constraints: "禁止提前剧透幕后黑手",
        antiPatterns: "禁止用第二天早上草草收场",
        conflictGroup: "ending-style",
      })).body.result;
      assert.ok(createdCard?.id);

      // Mount skill via Agent tool
      const mount = await toolReg.invoke("zhizhang_mount_skill", {
        projectId,
        action: "mount",
        targetType: "chapter",
        targetId: ch.id,
        itemKind: "technique",
        itemId: createdCard.id,
        mode: "pin",
      });
      assert.ok(mount.id);

      // Progressive disclosure check: systemPrompt lists the skill index, NOT full executionSteps
      const renderedPrompt = await promptReg.renderAll({ agent: { id: "draft-session" } });
      assert.match(renderedPrompt, /雪夜孤舟/);
      assert.match(renderedPrompt, /第一章 断缆/);
      assert.match(renderedPrompt, /审慎模式/);
      assert.match(renderedPrompt, /断缆悬念收尾法/);
      assert.match(renderedPrompt, /★置顶/);
      assert.equal(renderedPrompt.includes(secretSteps), false, "systemPrompt must not inline full Skill executionSteps");

      // Agent lists compact Skill catalog and loads full Skill body on demand
      const skillIndex = await toolReg.invoke("zhizhang_list_skills", { projectId, documentId: ch.id, limit: 10 });
      const indexed = skillIndex.find((item) => item.id === createdCard.id);
      assert.ok(indexed, "Mounted skill should appear in zhizhang_list_skills");
      assert.equal("executionSteps" in indexed, false, "zhizhang_list_skills must return lightweight index only");

      const loadedSkill = await toolReg.invoke("zhizhang_load_skill", { id: createdCard.id, kind: "technique" });
      assert.equal(loadedSkill.id, createdCard.id);
      assert.equal(loadedSkill.executionSteps, secretSteps);

      // Agent can pull 4-layer context on demand
      const contextBundle = await toolReg.invoke("zhizhang_read_context", {
        documentId: ch.id,
        instruction: "续写码头断缆高潮",
      });
      assert.equal(typeof contextBundle.stablePrefix, "string");
      assert.equal(typeof contextBundle.dynamicTail, "string");

      // Disabling agentPromptInjection suppresses systemPrompt output cleanly
      await host.command("project.collaboration.set", {
        projectId,
        agentPromptInjection: false,
      });
      const disabledPrompt = await promptReg.renderAll({ agent: { id: "draft-session" } });
      assert.equal(disabledPrompt, "");
    } finally {
      await host.close();
    }
  });
});

test("cautious mode stages Agent drafts, surgical patches, and chapter outlines for author review", async () => {
  await withTempDir("zhizhang-cautious-", async (dataDirectory) => {
    const toolReg = createStrictToolRegistrar();
    const host = createMockDsHHost({ tools: toolReg });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    try {
      const projectId = (await host.command("project.create", { product: "fanqie", name: "审慎测试书" })).body.result.id;
      const chId = (await host.command("document.create", { projectId, title: "第一章 试剑" })).body.result.id;
      const originalBody = "第一段：风雪压城，沈砚握紧木剑。\n\n第二段：门外传来铁甲碰撞声。";
      await host.command("draft.save", { documentId: chId, baseRevisionId: null, body: originalBody });

      // 1. Agent submits full draft in cautious mode -> lands in candidate area
      const firstSub = await toolReg.invoke("zhizhang_submit_draft", {
        documentId: chId,
        body: "第一段：风雪压城，沈砚按剑不动。\n\n第二段：门外铁甲声骤停，一把绣春刀劈开木门。",
        summary: "强化开场压迫感",
      });
      assert.equal(firstSub.mode, "candidate");
      assert.ok(firstSub.runId);
      assert.ok(firstSub.candidateId);
      assert.ok(firstSub.diagnosticsSummary);

      // Author body remains completely untouched until adopted
      let st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(st.active.body, originalBody);
      assert.equal(st.runs[0].candidateId, firstSub.candidateId);

      // 2. Agent iterates with surgical paragraph patch in cautious mode -> auto-replaces stale Agent candidate
      const patchSub = await toolReg.invoke("zhizhang_patch_paragraphs", {
        documentId: chId,
        patches: [{ paragraphIndex: 2, replacement: "第二段：铁甲未至，先有一枚青铜令箭钉在门框上。" }],
        summary: "精修第二段悬念",
      });
      assert.equal(patchSub.mode, "candidate");
      assert.notEqual(patchSub.candidateId, firstSub.candidateId);

      st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(st.active.body, originalBody);
      const awaitingRun = st.runs.find((r) => r.state === "awaiting-author");
      assert.ok(awaitingRun);
      assert.equal(
        awaitingRun.candidateBody,
        "第一段：风雪压城，沈砚握紧木剑。\n\n第二段：铁甲未至，先有一枚青铜令箭钉在门框上。",
      );

      // Author adopts the candidate
      const adoptRes = await host.command("candidate.adopt", {
        documentId: chId,
        baseRevisionId: patchSub.previousRevisionId,
        runId: patchSub.runId,
        key: "adopt-agent-patch-1",
      });
      assert.equal(adoptRes.status, 200);
      st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(
        st.active.body,
        "第一段：风雪压城，沈砚握紧木剑。\n\n第二段：铁甲未至，先有一枚青铜令箭钉在门框上。",
      );

      // 3. Agent plans chapter outline in cautious mode -> creates pending "outline" proposal
      const outlineRes = await toolReg.invoke("zhizhang_plan_chapter", {
        documentId: chId,
        viewpoint: "沈砚",
        target: 2800,
        sections: { hook: "令箭入木三分", climax: "雪夜拔剑退敌" },
        lockedFacts: "主角尚未习得内功",
      });
      assert.equal(outlineRes.mode, "proposal");
      assert.ok(outlineRes.proposalId);

      st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(st.pendingProposalCount, 1);

      // Author accepts outline proposal -> persisted into chapter planning
      const decideRes = await host.command("proposal.decide", { proposalId: outlineRes.proposalId, accept: true });
      assert.equal(decideRes.status, 200);
      st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(st.pendingProposalCount, 0);
      assert.equal(st.planning.viewpoint, "沈砚");
      assert.equal(st.planning.target, 2800);
      assert.equal(st.planning.lockedFacts, "主角尚未习得内功");
    } finally {
      await host.close();
    }
  });
});

test("co_create mode allows direct draft/patch/outline writes with snapshot rollback while strictly protecting finalized chapters", async () => {
  await withTempDir("zhizhang-cocreate-", async (dataDirectory) => {
    const toolReg = createStrictToolRegistrar();
    const host = createMockDsHHost({ tools: toolReg });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    try {
      const projectId = (await host.command("project.create", { product: "fanqie", name: "共创测试书" })).body.result.id;
      const chId = (await host.command("document.create", { projectId, title: "第一章 破局" })).body.result.id;
      const authorOriginal = "第一段：作者写下的开头。\n\n第二段：作者写下的中段。";
      await host.command("draft.save", { documentId: chId, baseRevisionId: null, body: authorOriginal });

      // Switch this book to co_create mode
      const collab = (await host.command("project.collaboration.set", {
        projectId,
        collaborationMode: "co_create",
      })).body.result;
      assert.equal(collab.collaborationMode, "co_create");

      // 1. Direct draft write + snapshot saved
      const directDraft = await toolReg.invoke("zhizhang_submit_draft", {
        documentId: chId,
        body: "第一段：Agent 共创重写开头。\n\n第二段：Agent 共创补全中段。",
        summary: "共创扩写全章",
      });
      assert.equal(directDraft.mode, "direct_write");
      assert.ok(directDraft.previousRevisionId);
      assert.ok(directDraft.newRevisionId);

      let st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(st.collaborationMode, "co_create");
      assert.equal(st.active.body, "第一段：Agent 共创重写开头。\n\n第二段：Agent 共创补全中段。");
      assert.equal(st.latestAgentWrite.id, directDraft.writeId);
      assert.equal(st.latestAgentWrite.previousBody, authorOriginal);
      assert.equal(st.latestAgentWrite.rolledBack, false);

      // 2. Surgical paragraph patch in co_create mode
      const directPatch = await toolReg.invoke("zhizhang_patch_paragraphs", {
        documentId: chId,
        patches: [{ paragraphIndex: 2, replacement: "第二段：局部精修后的冲突爆发。" }],
        summary: "精修第二段",
      });
      assert.equal(directPatch.mode, "direct_write");
      st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(st.active.body, "第一段：Agent 共创重写开头。\n\n第二段：局部精修后的冲突爆发。");

      // 3. Roll back the patch -> restores exact pre-patch draft verbatim
      const rollback1 = (await host.command("agent.rollback_write", { writeId: directPatch.writeId })).body.result;
      assert.equal(rollback1.writeId, directPatch.writeId);
      st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(st.active.body, "第一段：Agent 共创重写开头。\n\n第二段：Agent 共创补全中段。");
      assert.equal(st.latestAgentWrite.rolledBack, true);

      // Second rollback on same writeId is refused
      const doubleRollback = await host.command("agent.rollback_write", { writeId: directPatch.writeId });
      assert.equal(doubleRollback.status, 409);

      const obsoleteRollback = await host.command("agent.rollback_write", { writeId: directDraft.writeId });
      assert.equal(obsoleteRollback.body.code, "version.conflict");

      // 4. Direct outline write in co_create mode
      const directOutline = await toolReg.invoke("zhizhang_plan_chapter", {
        documentId: chId,
        viewpoint: "林深",
        target: 3200,
        sections: { opening: "雨夜破门" },
      });
      assert.equal(directOutline.mode, "direct_write");
      st = (await host.getState({ projectId, documentId: chId })).body.result;
      assert.equal(st.planning.viewpoint, "林深");
      assert.equal(st.planning.target, 3200);

      // 5. Hard lock enforcement: finalize chapter -> ALL Agent writes & patches & outline writes are refused even in co_create mode
      const currentRevId = st.active.revisionId;
      const reviewRes = await host.command("chapter.review", {
        documentId: chId,
        baseRevisionId: currentRevId,
        accept: true,
      });
      assert.equal(reviewRes.status, 200);
      const finalRes = await host.command("draft.finalize", {
        documentId: chId,
        baseRevisionId: currentRevId,
        key: "finalize-locked-ch",
      });
      assert.equal(finalRes.status, 200);

      await assertRejectsContract(
        () => toolReg.invoke("zhizhang_submit_draft", { documentId: chId, body: "企图篡改已定稿章节" }),
        "gate.denied",
      );
      await assertRejectsContract(
        () => toolReg.invoke("zhizhang_patch_paragraphs", {
          documentId: chId,
          patches: [{ paragraphIndex: 1, replacement: "篡改第一段" }],
        }),
        "gate.denied",
      );
      await assertRejectsContract(
        () => toolReg.invoke("zhizhang_plan_chapter", { documentId: chId, viewpoint: "篡改视角" }),
        "gate.denied",
      );
    } finally {
      await host.close();
    }
  });
});

test("Toutiao co-creation enforces protected 34-char title cap, micro no-title rule, and 已验收/已交稿 locks", async (t) => {
  await withTempDir("zhizhang-tt-cocreate-", async (dataDirectory) => {
    const toolReg = createStrictToolRegistrar();
    const promptReg = createMockSystemPromptRegistrar();
    const host = createMockDsHHost({ tools: toolReg, systemPrompt: promptReg, cordis: true });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    try {
      const projectId = (await host.command("project.create", { product: "toutiao", name: "深度观察号" })).body.result.id;
      const shortId = (await host.command("document.create", {
        projectId,
        title: "新能源汽车价格战背后的供应链真相",
        mode: "short",
        line: "资讯线",
      })).body.result.id;
      const microId = (await host.command("document.create", {
        projectId,
        title: "",
        mode: "micro",
        line: "资讯线",
      })).body.result.id;

      await host.command("focus.set", { projectId, documentId: shortId, sessionId: "article-session" });
      const ttPrompt = await promptReg.renderAll({ agent: { id: "article-session" } });
      assert.match(ttPrompt, /深度观察号/);
      assert.match(ttPrompt, /34 字/);
      assert.match(ttPrompt, /84 分/);

      // Valid 5-title / 3-motif matrix (all <= 34 chars) succeeds
      const validTitles = [
        "车企连夜官降三万，真正扛不住的其实不是经销商|价格账本",
        "半年降价18次后，新能源供应链利润率跌破红线|行业数据",
        "刚提车三个月亏掉两万，老车主为什么不敢维权|车主处境",
        "降价潮里最赚钱的竟然是做二手车检测的人|反常识视角",
        "年底买电车还要不要再等等？算清这笔账再出手|实用建议",
      ].join("\n");
      const planned = await toolReg.invoke("zhizhang_plan_toutiao_article", {
        documentId: shortId,
        driver: "账本型",
        opening: "账单暴击",
        ending: "两难选择",
        titles: validTitles,
      });
      assert.equal(planned.driver, "账本型");
      assert.equal(planned.titleMatrix.passed, true);

      // Protected 34-char title cap enforced in code (35-char title fails validation)
      const overCapTitles = [
        `${"超".repeat(35)}|价格账本`,
        "半年降价18次后，新能源供应链利润率跌破红线|行业数据",
        "刚提车三个月亏掉两万，老车主为什么不敢维权|车主处境",
        "降价潮里最赚钱的竟然是做二手车检测的人|反常识视角",
        "年底买电车还要不要再等等？算清这笔账再出手|实用建议",
      ].join("\n");
      await assertRejectsContract(
        () => toolReg.invoke("zhizhang_plan_toutiao_article", {
          documentId: shortId,
          driver: "账本型",
          opening: "账单暴击",
          ending: "两难选择",
          titles: overCapTitles,
        }),
        "input.invalid",
      );

      // Protected micro no-title rule enforced in code
      await assertRejectsContract(
        () => toolReg.invoke("zhizhang_plan_toutiao_article", {
          documentId: microId,
          driver: "账本型",
          opening: "账单暴击",
          ending: "两难选择",
          titles: validTitles,
        }),
        "gate.denied",
      );

      // Switch to co_create and let Agent draft, then accept article and verify lock
      await host.command("project.collaboration.set", { projectId, collaborationMode: "co_create" });
      const drafted = await toolReg.invoke("zhizhang_submit_draft", {
        documentId: shortId,
        body: "正".repeat(1200),
        summary: "共创首稿",
      });
      assert.equal(drafted.mode, "direct_write");
      assert.ok(drafted.diagnosticsSummary);

      // Move article through QA & acceptance to 已验收 -> locked against Agent writes
      const ws = createTestWorkspace(t);
      const { projectId: p2, documentId: lockedArt, revisionId: artRev } = ws.createToutiaoArticle({ mode: "short" });
      ws.app.mutation("project.collaboration.set", { projectId: p2, collaborationMode: "co_create" });
      ws.app.mutation("article.qa", {
        documentId: lockedArt,
        baseRevisionId: artRev,
        score: 88,
        passed: true,
        fails: [],
        hardGates: [],
      });
      ws.app.mutation("article.accept", { documentId: lockedArt, baseRevisionId: artRev, accept: true });
      assertThrowsContract(
        () => ws.app.mutation("agent.submit_draft", { documentId: lockedArt, body: "已验收后不可修改" }),
        "gate.denied",
      );
    } finally {
      await host.close();
    }
  });
});


test("bound DsH tools use the correct project and preserve the author revision on replay and rollback", async () => {
  await withTempDir("zhizhang-session-", async (dataDirectory) => {
    const tools = createStrictToolRegistrar();
    const prompt = createMockSystemPromptRegistrar();
    const host = createMockDsHHost({ tools, systemPrompt: prompt });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const exec = { agent: { id: "session-a" }, callId: "call-1" };
      const project = async (name) => (await host.command("project.create", { product: "fanqie", name })).body.result.id;
      const a = await project("甲书");
      const b = await project("乙书");
      const documentId = (await host.command("document.create", { projectId: a, title: "甲章" })).body.result.id;
      await host.command("focus.set", { sessionId: exec.agent.id, projectId: a, documentId });
      await host.command("focus.set", { sessionId: "session-b", projectId: b });
      assert.match(await prompt.renderAll(exec), /甲书/);
      assert.match(await prompt.renderAll({ agent: { id: "session-b" } }), /乙书/);
      assert.equal(await prompt.renderAll({ agent: { id: "unbound" } }), "");
      assert.equal(tools.available("zhizhang_read_focus", { id: "unbound" }), false);
      await assert.rejects(() => tools.invoke("zhizhang_read_tree", { projectId: b }, exec), { code: "gate.denied" });

      await host.command("project.collaboration.set", { projectId: a, collaborationMode: "co_create" });
      const args = { documentId, baseRevisionId: null, body: "Agent 版本" };
      const write = await tools.invoke("zhizhang_submit_draft", args, exec);
      const repeat = await tools.invoke("zhizhang_submit_draft", args, exec);
      assert.equal(repeat.writeId, write.writeId);
      await assert.rejects(() => tools.invoke("zhizhang_submit_draft", args, { ...exec, callId: "call-2" }), { code: "version.conflict" });

      const saved = await host.command("draft.save", { documentId, baseRevisionId: write.newRevisionId, body: "作者后续稿" });
      assert.equal(saved.body.ok, true);
      assert.equal((await host.command("agent.rollback_write", { writeId: write.writeId })).body.code, "version.conflict");
      const snap = (await host.getState({ projectId: a, documentId })).body.result;
      assert.equal(snap.active.body, "作者后续稿");

      const plan = await tools.invoke("zhizhang_plan_chapter", { documentId, basePlanningId: snap.planningId, viewpoint: "陆舟" }, exec);
      assert.equal(plan.mode, "direct_write");
      assert.equal((await host.command("chapter.outline.rollback", { documentId, writeId: plan.writeId })).body.ok, true);
      assert.equal((await host.getState({ projectId: a, documentId })).body.result.planning, null);

      const next = (await host.command("document.create", { projectId: a, title: "甲书第二章" })).body.result.id;
      const previousVersionId = write.newRevisionId;
      const context = await tools.invoke("zhizhang_read_context", { documentId: next, previousVersionId }, exec);
      assert.equal(context.continuationSource.id, previousVersionId);
      assert.match(context.dynamicTail, /Agent 版本/);
      assert.doesNotMatch(context.dynamicTail, /作者后续稿/);
      const continuation = await tools.invoke("zhizhang_submit_draft", {
        documentId: next, baseRevisionId: null, body: "第二章接着写。", previousVersionId, forceCandidate: true,
      }, { ...exec, callId: "continue-draft" });
      const run = await host.command("run.detail", { documentId: next, runId: continuation.runId });
      assert.equal(JSON.parse(run.body.result.frozenInput).continuationSource.id, previousVersionId);
      assert.equal(run.body.result.continuationState, "changed");
    } finally {
      await host.close();
    }
  });
});
