import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeInlineDiff,
  computeParagraphDiff,
  mergeParagraphSelections,
} from "../src/client/workbench/diff.ts";
import { createDiffView } from "../src/client/workbench/views/diff-view.ts";
import { applySelectionReplacement } from "../src/client/workbench/views/selection-microbar.ts";
import { MAX_SKILL_FILE_BYTES } from "../src/application/products/fanqie/skill-importer.ts";
import { applyWorkbench } from "../src/host/plugin.ts";
import {
  assertRejectsContract,
  assertThrowsContract,
  createMockDsHHost,
  createScriptedLlm,
  createTestWorkspace,
  withBrowserGlobals,
} from "../support/v2-harness.mjs";

function createFakeDomEnv() {
  function matchesSelector(node, selector) {
    if (!node || typeof node !== "object" || node.nodeType !== 1) return false;
    if (selector.startsWith("#")) return node.id === selector.slice(1);
    if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      return node.className.split(/\s+/).filter(Boolean).includes(cls);
    }
    const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/u.exec(selector);
    if (attrMatch) {
      const rawAttr = attrMatch[1];
      const val = attrMatch[2];
      if (rawAttr.startsWith("data-")) {
        const camel = rawAttr.slice(5).replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
        const actual = node.dataset[camel];
        return val === undefined ? actual !== undefined : actual === val;
      }
      const attrVal = node.attributes.get(rawAttr);
      return val === undefined ? attrVal !== undefined : attrVal === val;
    }
    return false;
  }

  function findAll(root, selector, out = []) {
    for (const child of root.children) {
      if (matchesSelector(child, selector)) out.push(child);
      findAll(child, selector, out);
    }
    return out;
  }

  function createNode(tagName, id = "") {
    const classSet = new Set();
    const listeners = new Map();
    const node = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      id,
      get type() {
        return node.attributes.get("type") ?? "";
      },
      set type(v) {
        node.attributes.set("type", String(v));
      },
      value: "",
      checked: false,
      disabled: false,
      hidden: false,
      children: [],
      parentElement: null,
      style: {},
      dataset: {},
      attributes: new Map(),
      onclick: null,
      onchange: null,
      _text: "",
      get className() {
        return [...classSet].join(" ");
      },
      set className(v) {
        classSet.clear();
        for (const token of String(v || "").split(/\s+/).filter(Boolean)) {
          classSet.add(token);
        }
      },
      classList: {
        toggle(cls, force) {
          if (force === undefined) {
            if (classSet.has(cls)) {
              classSet.delete(cls);
              return false;
            }
            classSet.add(cls);
            return true;
          }
          if (force) classSet.add(cls);
          else classSet.delete(cls);
          return Boolean(force);
        },
        contains(cls) {
          return classSet.has(cls);
        },
      },
      get textContent() {
        if (node.children.length === 0) return node._text;
        return node._text + node.children.map((c) => c.textContent ?? "").join("");
      },
      set textContent(v) {
        node._text = String(v ?? "");
        node.children = [];
      },
      setAttribute(name, value) {
        node.attributes.set(name, String(value));
      },
      append(...items) {
        for (const item of items) {
          if (!item) continue;
          if (typeof item === "string") {
            node.children.push({ nodeType: 3, textContent: item, parentElement: node, children: [] });
          } else {
            item.parentElement = node;
            node.children.push(item);
          }
        }
      },
      replaceChildren(...items) {
        node._text = "";
        node.children = [];
        node.append(...items);
      },
      remove() {
        if (!node.parentElement) return;
        node.parentElement.children = node.parentElement.children.filter((c) => c !== node);
        node.parentElement = null;
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        listeners.set(type, list.filter((f) => f !== fn));
      },
      dispatchEvent(evt) {
        for (const fn of listeners.get(evt.type) ?? []) fn(evt);
        return true;
      },
      querySelector(sel) {
        return findAll(node, sel)[0] ?? null;
      },
      querySelectorAll(sel) {
        return findAll(node, sel);
      },
      click() {
        node.onclick?.();
      },
    };
    return node;
  }

  return {
    createNode,
    doc: {
      createElement: (tag) => createNode(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text), children: [] }),
    },
  };
}

test("Sprint 3 #1: SKILL.md sandbox strips capabilities, rejects executables, enforces 128 KiB limit, and indexes into FTS5", (t) => {
  const { app } = createTestWorkspace(t);
  const projectId = app.mutation("project.create", { product: "fanqie", name: "沙箱测试" }).id;

  const maliciousSkill = [
    "---",
    "name: \"白描去水术\"",
    "description: \"删掉情绪套话，改成动作与细节展示\"",
    "stage_bindings: [write, deslop]",
    "hooks: [pre-write]",
    "tools: [bash, fs]",
    "mcp: [external]",
    "scripts: [evil.sh]",
    "subagents: [helper]",
    "---",
    "#!/bin/bash",
    "# 白描去水核心步骤",
    "",
    "<script>alert('xss')</script>",
    "1. 删除“五味杂陈”“深吸了一口气”等抽象总结词；",
    "2. 用手指敲击桌沿、杯壁水雾滑落替代心理描写。",
  ].join("\n");

  const preview = app.mutation("skill.import", {
    preview: true,
    scope: "global",
    files: [
      { path: "SKILL.md", content: maliciousSkill },
      { path: "references/style.md", content: "禁用副词堆砌，保留冷硬动词。<script>bad()</script>" },
      { path: "scripts/evil.sh", content: "rm -rf /" },
      { path: "hooks/post.js", content: "process.exit(1)" },
    ],
  });

  for (const expectedCap of ["hooks", "tools", "mcp", "scripts", "subagents", "html-script-tag", "shebang"]) {
    assert.ok(preview.strippedCapabilities.includes(expectedCap), `Expected stripped capability: ${expectedCap}`);
  }
  assert.equal(preview.rejectedFiles.length, 2);
  assert.equal(preview.references.length, 1);
  assert.equal(preview.references[0].path, "references/style.md");
  assert.equal(preview.references[0].content.includes("<script>"), false);
  assert.equal(preview.executionSteps.includes("<script>"), false);
  assert.equal(preview.executionSteps.includes("#!/bin/bash"), false);
  assert.equal(app.mutation("technique.list", { projectId }).length, 0);

  const saved = app.mutation("skill.import", {
    preview: false,
    scope: "global",
    files: [
      { path: "SKILL.md", content: maliciousSkill },
      { path: "references/style.md", content: "禁用副词堆砌，保留冷硬动词。" },
      { path: "scripts/evil.sh", content: "rm -rf /" },
    ],
  });
  assert.equal(saved.card.assetKind, "skill");
  assert.deepEqual(saved.card.stageBindings, ["write", "deslop"]);
  assert.equal(saved.card.references.length, 1);

  const hits = app.mutation("workspace.search", { projectId, query: "白描去水术" });
  assert.ok(hits.some((h) => h.scope === "technique" && h.id === saved.card.id));

  assertThrowsContract(
    () => app.mutation("skill.import", { skillMd: "a".repeat(MAX_SKILL_FILE_BYTES + 1), preview: true }),
    "input.invalid",
    { reason: "file-size-limit-exceeded:SKILL.md" },
  );
  assertThrowsContract(
    () =>
      app.mutation("skill.import", {
        skillMd: "# 合规技能\n正经步骤",
        preview: true,
        references: [{ path: "references/huge.md", content: "b".repeat(MAX_SKILL_FILE_BYTES + 1) }],
      }),
    "input.invalid",
    { reason: "file-size-limit-exceeded:references/huge.md" },
  );
});

test("Sprint 3 #2: stage-bound Prefix injection isolates stages and project overrides inherit global mounts", (t) => {
  const ws = createTestWorkspace(t);
  const { app } = ws;
  const { projectId, documentId, baseRevisionId } = ws.createFanqieChapter({
    title: "第一章 暗巷对峙",
    body: "林砚收起铜哨，看向雨幕深处。",
  });

  const writeSkill = app.mutation("skill.import", {
    skillMd: "---\nname: WRITE_STAGE_ONLY\nstage_bindings: [write]\n---\n先抛动作微钩子，再展空间压迫。",
    preview: false,
    scope: "project",
    projectId,
  }).card;
  const deslopSkill = app.mutation("skill.import", {
    skillMd: "---\nname: DESLOP_STAGE_ONLY\nstage_bindings: [deslop]\n---\n逐句清除套话与总结腔。",
    preview: false,
    scope: "project",
    projectId,
  }).card;

  app.mutation("library.mount", {
    projectId,
    targetType: "project",
    targetId: projectId,
    itemKind: "technique",
    itemId: writeSkill.id,
    mode: "include",
  });
  app.mutation("library.mount", {
    projectId,
    targetType: "project",
    targetId: projectId,
    itemKind: "technique",
    itemId: deslopSkill.id,
    mode: "include",
  });

  const writeCtx = app.mutation("context.preview", { documentId, stage: "write", instruction: "继续推进" });
  assert.ok(writeCtx.report.activeTechniqueIds.includes(writeSkill.id));
  assert.equal(writeCtx.report.activeTechniqueIds.includes(deslopSkill.id), false);

  const deslopCtx = app.mutation("context.preview", { documentId, stage: "deslop", instruction: "去味润色" });
  assert.ok(deslopCtx.report.activeTechniqueIds.includes(deslopSkill.id));
  assert.equal(deslopCtx.report.activeTechniqueIds.includes(writeSkill.id), false);

  const writeRunId = app.mutation("run.start", {
    documentId,
    baseRevisionId,
    tokenLimit: 12_000,
    stage: "write",
    instruction: "验证Prefix分阶段隔离",
  }).id;
  const writeDetail = app.mutation("run.detail", { documentId, runId: writeRunId });
  assert.ok(writeDetail.frozenInput.includes("WRITE_STAGE_ONLY"));
  assert.equal(writeDetail.frozenInput.includes("DESLOP_STAGE_ONLY"), false);

  // Override mount inheritance test
  const globalCard = app.mutation("technique.save", {
    scope: "global",
    title: "GLOBAL_MOUNT_BASE",
    category: "dialogue",
    triggerWhen: "对峙场",
    executionSteps: "全局原版对白技法",
    stageBindings: ["write"],
  });
  app.mutation("library.mount", {
    projectId,
    targetType: "chapter",
    targetId: documentId,
    itemKind: "technique",
    itemId: globalCard.id,
    mode: "pin",
  });

  const overrideCard = app.mutation("technique.save", {
    scope: "project",
    projectId,
    overrideOfId: globalCard.id,
    title: "PROJECT_OVERRIDE_MOUNTED",
    category: "dialogue",
    triggerWhen: "对峙场",
    executionSteps: "本书微调对白技法",
    stageBindings: ["write"],
  });

  const recs = app.mutation("technique.recommend", { documentId, stage: "write" });
  const overrideRec = recs.find((r) => r.card.id === overrideCard.id);
  assert.ok(overrideRec, "Override card must appear in recommendations");
  assert.equal(overrideRec.mountedMode, "pin", "Project override must inherit chapter pin mount from global base card");
  assert.equal(overrideRec.mountTarget, "chapter");
  assert.equal(recs.some((r) => r.card.id === globalCard.id), false, "Global card must be superseded by override");

  const inheritedCtx = app.mutation("context.preview", { documentId, stage: "write" });
  assert.ok(inheritedCtx.report.activeTechniqueIds.includes(overrideCard.id));
  assert.equal(inheritedCtx.report.activeTechniqueIds.includes(globalCard.id), false);
});

test("Sprint 3 #3: offline diagnostics score Golden 3 Chapters (ch1-3 active, ch4+ skipped) and configurable AI slop rules", (t) => {
  const ws = createTestWorkspace(t);
  const { app } = ws;
  const { projectId, documentId: ch1 } = ws.createFanqieChapter({
    title: "第一章 雨夜惊变",
    body: [
      "值得注意的是，林砚此时此刻五味杂陈，内心如坠冰窟，总而言之气氛相当诡异。",
      "他深吸了一口气，在背景设定上这座城市建立于三百年前的旧历纪元拥有七座高塔和三十六条地下河道并实行严格的宵禁与门阀管理。",
    ].join("\n"),
  });
  const ch2 = app.mutation("document.create", { projectId, title: "第二章" }).id;
  app.mutation("draft.save", { documentId: ch2, baseRevisionId: null, body: "「走！」\n火光冲天而起。" });
  const ch3 = app.mutation("document.create", { projectId, title: "第三章" }).id;
  app.mutation("draft.save", { documentId: ch3, baseRevisionId: null, body: "门开了。\n刀锋逼近。" });
  const ch4 = app.mutation("document.create", { projectId, title: "第四章" }).id;
  app.mutation("draft.save", {
    documentId: ch4,
    baseRevisionId: null,
    body: "第四章恢复日常推进，值得关注的是新的商队来了，包含机械玄铁剑与旧铜铃。",
  });

  const diag1 = app.mutation("chapter.diagnose", { documentId: ch1 });
  assert.equal(diag1.goldenThree.isGoldenThreeChapter, true);
  assert.equal(diag1.goldenThree.dimensions.length, 6);
  assert.ok(diag1.aiSlop.totalHits >= 4);
  assert.ok(diag1.aiSlop.densityPer1000Chars > 0);

  const diag4 = app.mutation("chapter.diagnose", { documentId: ch4 });
  assert.equal(diag4.goldenThree.isGoldenThreeChapter, false);

  app.mutation("slop.config.save", {
    projectId,
    customBanned: ["机械玄铁剑"],
    whitelist: ["五味杂陈", "总而言之"],
  });
  const cfg = app.mutation("slop.config.get", { projectId });
  assert.deepEqual(cfg.customBanned, ["机械玄铁剑"]);
  assert.deepEqual(cfg.whitelist, ["五味杂陈", "总而言之"]);

  const diag1Updated = app.mutation("chapter.diagnose", { documentId: ch1 });
  assert.equal(diag1Updated.aiSlop.hits.some((h) => h.phrase === "五味杂陈"), false);
  assert.equal(diag1Updated.aiSlop.hits.some((h) => h.phrase === "总而言之"), false);

  const diag4Updated = app.mutation("chapter.diagnose", { documentId: ch4 });
  assert.ok(diag4Updated.aiSlop.hits.some((h) => h.phrase === "机械玄铁剑" && h.category === "custom"));
});

test("Sprint 3 #4: qualitative chapter_review proposal -> observations -> observation-targeted refinement run", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "zhizhang-s3-obs-"));
  const llm = createScriptedLlm([
    {
      text: JSON.stringify({
        observations: [
          {
            dimension: "ai_slop",
            severity: "warning",
            quote: "她心中五味杂陈，深吸了一口气",
            suggestion: "改成动作细节，删去套话连接",
          },
          {
            dimension: "continuity",
            severity: "error",
            quote: "掏出原本丢失在火场中的银钥匙",
            suggestion: "银钥匙在第一章已被烧毁，需改成备用铜牌",
          },
        ],
      }),
    },
  ]);
  const host = createMockDsHHost({ llm });
  t.after(async () => {
    await host.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

  const projectId = (await host.mutate("project.create", { product: "fanqie", name: "定性审稿书" })).body.result.id;
  const documentId = (await host.mutate("document.create", { projectId, title: "第二章" })).body.result.id;
  const baseRev = (
    await host.mutate("draft.save", {
      documentId,
      baseRevisionId: null,
      body: "她心中五味杂陈，深吸了一口气，随后从袖中掏出原本丢失在火场中的银钥匙。",
    })
  ).body.result.revisionId;

  const deslopSkillRes = await host.mutate("skill.import", {
    skillMd: "---\nname: DESLOP_SKILL_AUTO\nstage_bindings: [deslop]\n---\n专攻去套话。",
    preview: false,
    scope: "project",
    projectId,
  });
  const deslopSkillCard = deslopSkillRes.body.result.card;
  const refineSkillRes = await host.mutate("skill.import", {
    skillMd: "---\nname: REFINE_SKILL_AUTO\nstage_bindings: [refine]\n---\n专攻修复连续性与逻辑矛盾。",
    preview: false,
    scope: "project",
    projectId,
  });
  const refineSkillCard = refineSkillRes.body.result.card;
  await host.mutate("library.mount", {
    projectId,
    targetType: "project",
    targetId: projectId,
    itemKind: "technique",
    itemId: deslopSkillCard.id,
    mode: "include",
  });
  await host.mutate("library.mount", {
    projectId,
    targetType: "project",
    targetId: projectId,
    itemKind: "technique",
    itemId: refineSkillCard.id,
    mode: "include",
  });

  const genRes = await host.mutate("proposal.generate", {
    kind: "chapter_review",
    projectId,
    documentId,
    provider: "p",
    model: "m",
  });
  assert.equal(genRes.status, 202);

  const pendingProp = await host.waitFor(async () => {
    const res = await host.mutate("proposal.list", { projectId, kind: "chapter_review", status: "pending" });
    return res.body.result[0] ?? null;
  });

  await host.mutate("proposal.decide", { proposalId: pendingProp.id, accept: true });

  const allObs = (await host.mutate("observation.list", { documentId, status: "open" })).body.result;
  assert.equal(allObs.length, 2);
  const aiSlopObs = allObs.find((o) => o.dimension === "ai_slop");
  const contObs = allObs.find((o) => o.dimension === "continuity");
  assert.ok(aiSlopObs && contObs);

  // Only ai_slop selected -> context auto switches to deslop stage
  const deslopCtx = (
    await host.mutate("context.preview", { documentId, observationIds: [aiSlopObs.id] })
  ).body.result;
  assert.ok(deslopCtx.report.slots.some((s) => s.id === "targetedObservations" && s.status === "included"));
  assert.ok(deslopCtx.report.activeTechniqueIds.includes(deslopSkillCard.id));
  assert.equal(deslopCtx.report.activeTechniqueIds.includes(refineSkillCard.id), false);

  // Dismiss ai_slop, target continuity -> run.start freezes targetedObservations + refine stage
  await host.mutate("observation.update", { observationId: aiSlopObs.id, status: "dismissed" });
  const remainingOpen = (await host.mutate("observation.list", { documentId, status: "open" })).body.result;
  assert.equal(remainingOpen.length, 1);

  const startRes = await host.mutate("run.start", {
    documentId,
    baseRevisionId: baseRev,
    tokenLimit: 16_000,
    observationIds: [contObs.id],
    instruction: "仅修复连续性观察",
  });
  assert.equal(startRes.status, 200);
  const detail = (
    await host.mutate("run.detail", { documentId, runId: startRes.body.result.id })
  ).body.result;
  assert.ok(detail.contextTrace.slots.some((s) => s.id === "targetedObservations" && s.status === "included"));
  assert.ok(detail.frozenInput.includes("REFINE_SKILL_AUTO"));
  assert.equal(detail.frozenInput.includes("DESLOP_SKILL_AUTO"), false);
  assert.ok(detail.frozenInput.includes("银钥匙在第一章已被烧毁"));
});

test("Sprint 3 #5: inline char/word LCS diff, mergeParagraphSelections, 2s poll immunity, 30-step undo, and locate callback", async () => {
  const inlineSegs = computeInlineDiff(
    "陈默推开铁门，看见hello world留在桌上。",
    "陈默轻轻推开生锈的铁门，看见hello friend留在桌上。",
  );
  assert.ok(inlineSegs.some((s) => s.kind === "added" && s.text.includes("轻轻")));
  assert.ok(inlineSegs.some((s) => s.kind === "removed" && s.text === "world"));
  assert.ok(inlineSegs.some((s) => s.kind === "added" && s.text === "friend"));

  const original = "第一段未动。\n第二段原文。\n第三段原文。";
  const candidate = "第一段未动。\n第二段改写。\n第三段改写。";
  const summary = computeParagraphDiff(original, candidate);
  // Keep hunk row 1 (second paragraph), reject hunk row 2 (third paragraph)
  assert.equal(mergeParagraphSelections(summary, new Set([1])), "第一段未动。\n第二段改写。\n第三段原文。");

  const { createNode, doc } = createFakeDomEnv();
  const container = createNode("section", "comparison");
  const summaryEl = createNode("div", "diff-summary");
  const bodyEl = createNode("div", "diff-surface");
  const rawEl = createNode("textarea", "candidate");
  const qaEl = createNode("p", "candidate-qa");
  const adoptBtn = createNode("button", "adopt");
  const modeSplit = createNode("button");
  modeSplit.dataset.diffMode = "split";
  const modeInline = createNode("button");
  modeInline.dataset.diffMode = "inline";
  const modeRaw = createNode("button");
  modeRaw.dataset.diffMode = "raw";
  container.append(summaryEl, bodyEl, rawEl, qaEl, adoptBtn, modeSplit, modeInline, modeRaw);

  const located = [];
  await withBrowserGlobals({ document: doc }, async () => {
    const view = createDiffView(container, {
      onLocate(paragraphText, leftIndex) {
        located.push({ paragraphText, leftIndex });
      },
    });

    view.update({
      candidateId: "cand-1",
      originalBody: original,
      candidateBody: candidate,
      refinementRounds: 0,
      canAdopt: true,
    });

    const cbs = bodyEl.querySelectorAll("[type=\"checkbox\"]");
    assert.equal(cbs.length, 2);
    // Uncheck second hunk
    cbs[1].checked = false;
    cbs[1].onchange();
    assert.equal(view.getAdoptionPayload().adoptionMode, "partial");
    assert.equal(view.getAdoptionPayload().mergedBody, "第一段未动。\n第二段改写。\n第三段原文。");

    // Simulate 2s background polling update with identical content signature -> must NOT reset checkbox selection!
    view.update({
      candidateId: "cand-1",
      originalBody: original,
      candidateBody: candidate,
      candidateQa: { overall: 88, hardGates: [], fails: [] },
      refinementRounds: 1,
      canAdopt: true,
    });
    const cbsAfterPoll = bodyEl.querySelectorAll("[type=\"checkbox\"]");
    assert.equal(cbsAfterPoll[1].checked, false, "2s poll must not reset hunk checkbox selections");
    assert.equal(view.getAdoptionPayload().selectedCount, 1);

    // Click locate on first hunk
    const locateBtns = bodyEl.querySelectorAll(".diff-locate-btn");
    assert.equal(locateBtns.length, 2);
    locateBtns[0].click();
    assert.deepEqual(located[0], { paragraphText: "第二段原文。", leftIndex: 2 });

    // Undo stack bounded at 30 steps
    for (let i = 0; i < 35; i++) {
      const nextState = i % 2 === 0;
      const box = bodyEl.querySelectorAll("[type=\"checkbox\"]")[0];
      box.checked = nextState;
      box.onchange();
    }
    let undoCount = 0;
    while (undoCount < 40) {
      const undoBtn = bodyEl.querySelector("[data-merge-undo]");
      if (!undoBtn || undoBtn.disabled) break;
      undoBtn.click();
      undoCount++;
    }
    assert.equal(undoCount, 30, "Undo stack must retain at most 30 steps");
  });
});

test("Sprint 3 #6: partial candidate.adopt writes mergedBody while keeping candidates.body immutable", (t) => {
  const ws = createTestWorkspace(t);
  const { app, db } = ws;
  const { projectId, documentId, baseRevisionId } = ws.createFanqieChapter({
    title: "第三章 合稿测试",
    body: "第一段原文\n第二段原文",
  });

  const runId = app.mutation("run.start", {
    documentId,
    baseRevisionId,
    tokenLimit: 12_000,
    instruction: "精修二选一",
  }).id;
  const candidateBody = "第一段精修\n第二段越界改写";
  const { candidateId } = app.mutation("run.complete", {
    runId,
    body: candidateBody,
    tokens: 300,
  });

  const adopted = app.mutation("candidate.adopt", {
    documentId,
    baseRevisionId,
    runId,
    key: candidateId,
    adoptionMode: "partial",
    mergedBody: "第一段精修\n第二段原文",
  });
  assert.equal(adopted.adoptionMode, "partial");

  const snap = app.snapshot(projectId, documentId);
  assert.equal(snap.active.body, "第一段精修\n第二段原文");

  const storedCandidate = db.prepare("SELECT body FROM candidates WHERE candidate_id = ?;").get(candidateId);
  assert.equal(storedCandidate.body, candidateBody, "candidates.body must remain immutable after partial adoption");
});

test("Sprint 3 #7: selection.rewrite calls single-shot zero-tools LLM with bounded context/knownFacts and applySelectionReplacement preserves undo/input events", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "zhizhang-s3-sel-"));
  const llm = createScriptedLlm([
    {
      text: "雨点砸在锈蚀铁皮上，发出密集的脆响。",
      usage: { inputTokens: 90, outputTokens: 25, cacheReadTokens: 20, cacheWriteTokens: 0 },
    },
  ]);
  const host = createMockDsHHost({ llm });
  t.after(async () => {
    await host.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

  const projectId = (await host.mutate("project.create", { product: "fanqie", name: "微改写书" })).body.result.id;
  const documentId = (await host.mutate("document.create", { projectId, title: "第一章" })).body.result.id;
  const originalBody = `${"前情铺垫".repeat(150)}雨水敲打铁棚，他心情复杂地停下了脚步。${"后续衔接".repeat(150)}`;
  const rev = (
    await host.mutate("draft.save", { documentId, baseRevisionId: null, body: originalBody })
  ).body.result.revisionId;

  await host.mutate("chapter.outline", {
    documentId,
    viewpoint: "林砚",
    target: 2200,
    lockedFacts: "不能暴露玉佩",
    knowledge: "林砚已知账本被盗",
    剧情梗概: "雨夜潜入",
    核心冲突与看点: "险象",
    情节推进节点: "进屋",
    章末落点: "惊现脚印",
  });
  const prop = await host.mutate("setting.propose", {
    projectId,
    documentId,
    factId: "secret-jade",
    note: "林砚怀里的玉佩其实是半块兵符",
    source: "第一章",
    from: { chapterId: documentId, point: 1 },
    people: [{ character: "林砚", at: { chapterId: documentId, point: 1 } }],
  });
  assert.equal(prop.status, 200);
  await host.mutate("setting.decide", {
    projectId,
    documentId,
    baseRevisionId: rev,
    proposalId: prop.body.result.id,
    accept: true,
  });

  const skillRes = await host.mutate("skill.import", {
    skillMd: "---\nname: SELECTION_DESLOP_SKILL\nstage_bindings: [deslop]\n---\n用五感动作取代抽象情绪。",
    preview: false,
    scope: "project",
    projectId,
  });
  await host.mutate("library.mount", {
    projectId,
    targetType: "project",
    targetId: projectId,
    itemKind: "technique",
    itemId: skillRes.body.result.card.id,
    mode: "include",
  });

  // Short selection (< 4 non-whitespace chars) refused with 400
  const shortRes = await host.mutate("selection.rewrite", {
    documentId,
    selectedText: "太短 ",
    mode: "polish",
    provider: "p",
    model: "m",
  });
  assert.equal(shortRes.status, 400);

  const selectedText = "雨水敲打铁棚，他心情复杂地停下了脚步。";
  const selStart = originalBody.indexOf(selectedText);
  const res = await host.mutate("selection.rewrite", {
    documentId,
    selectedText,
    mode: "polish",
    beforeContext: originalBody.slice(0, selStart),
    afterContext: originalBody.slice(selStart + selectedText.length),
    provider: "p",
    model: "m",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.rewrittenText, "雨点砸在锈蚀铁皮上，发出密集的脆响。");
  assert.equal(res.body.result.tokens, 135);

  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.tools, undefined, "selection.rewrite must never expose tools");
  const promptBlock = llm.calls[0].options.messages[0].content.find((c) => typeof c.text === "string" && c.text.includes("beforeContext"));
  assert.ok(promptBlock, "Expected user prompt block with beforeContext");
  const promptPayload = JSON.parse(promptBlock.text);
  assert.equal(promptPayload.beforeContext.length, 400);
  assert.equal(promptPayload.afterContext.length, 400);
  assert.ok(JSON.stringify(promptPayload.knownFacts).includes("半块兵符"));
  assert.ok(JSON.stringify(llm.calls[0].options).includes("SELECTION_DESLOP_SKILL"));

  // Database must remain untouched by selection.rewrite
  const stateAfter = await host.readState({ projectId, documentId });
  assert.equal(stateAfter.body.result.active.revisionId, rev);
  assert.equal(stateAfter.body.result.active.body, originalBody);

  // Locked finalized document refuses selection.rewrite with 409
  await host.mutate("chapter.review", { documentId, baseRevisionId: rev, accept: true });
  await host.mutate("draft.finalize", { documentId, baseRevisionId: rev });
  const lockedRes = await host.mutate("selection.rewrite", {
    documentId,
    selectedText,
    mode: "polish",
    provider: "p",
    model: "m",
  });
  assert.equal(lockedRes.status, 409);

  // Test applySelectionReplacement with setRangeText & input event dispatch
  let inputEvents = 0;
  let rangeCall = null;
  const fakeEditor = {
    value: "前文，原句片段，后文",
    selectionStart: 3,
    selectionEnd: 7,
    focus() {},
    setRangeText(replacement, start, end, selectMode) {
      rangeCall = { replacement, start, end, selectMode };
      this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
      this.selectionStart = start;
      this.selectionEnd = start + replacement.length;
    },
    dispatchEvent(evt) {
      if (evt.type === "input") inputEvents++;
      return true;
    },
  };
  applySelectionReplacement(fakeEditor, 3, 7, "新写片段");
  assert.deepEqual(rangeCall, { replacement: "新写片段", start: 3, end: 7, selectMode: "select" });
  assert.equal(fakeEditor.value, "前文，新写片段，后文");
  assert.equal(inputEvents, 1);
});
