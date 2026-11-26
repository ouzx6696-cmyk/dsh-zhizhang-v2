import test from "node:test";
import assert from "node:assert/strict";
import { assertThrowsContract, createTestWorkspace } from "../support/harness.mjs";

test("Fanqie full author workflow: hierarchy -> draft -> continuity -> library -> run adopt -> review -> finalize", (t) => {
  const ws = createTestWorkspace(t);
  const projectId = ws.app.mutation("project.create", { product: "fanqie", name: "雪夜问剑" }).id;

  // 1. Volume -> Act -> Chapter 3-tier hierarchy
  const volumeId = ws.app.mutation("volume.create", { projectId, title: "第一卷 风起北境" }).id;
  const actId = ws.app.mutation("act.create", { projectId, volumeId, title: "第一幕 寒城初见" }).id;
  const ch1 = ws.app.mutation("document.create", { projectId, volumeId, actId, title: "第一章 雪夜来信" }).id;
  const ch2 = ws.app.mutation("document.create", { projectId, volumeId, actId, title: "第二章 暗巷伏击" }).id;

  const rev1 = ws.app.mutation("draft.save", {
    documentId: ch1,
    baseRevisionId: null,
    body: "沈砚推开柴门，雪粒扑在脸上。\n\n门缝里塞着一封没有落款的密信。",
  }).revisionId;

  ws.app.mutation("draft.save", {
    documentId: ch2,
    baseRevisionId: null,
    body: "林晚站在瓦檐阴影下，听着巷口脚步声。\n\n她还未拆开那封密信。\n\n第三段她终于看见了信纸上的印记。",
  });

  // 2. Outline + Setting proposal + Evidence anchor + Approval
  ws.app.mutation("chapter.outline", {
    documentId: ch2,
    viewpoint: "林晚",
    target: 2400,
    lockedFacts: "密信落款为青铜印",
    knowledge: "见人物设定",
    剧情梗概: "林晚在暗巷识破伏击",
    核心冲突与看点: "谁在冒充旧部",
    情节推进节点: "第三段读信识破印记",
    章末落点: "反锁巷门",
  });

  ws.app.mutation("setting.propose", {
    projectId,
    documentId: ch1,
    factId: "seal-clue",
    note: "密信落款是北境旧部的青铜印。",
    source: "第一章草稿",
    from: { chapterId: ch1, point: 2 },
    people: [
      { character: "沈砚", at: { chapterId: ch1, point: 2 } },
      { character: "林晚", at: { chapterId: ch2, point: 3 } },
    ],
  });
  const settingRow = ws.app.snapshot(projectId, ch1).settings[0];
  ws.app.mutation("setting.decide", { projectId, documentId: ch1, proposalId: settingRow.id, accept: true });

  // Anchor evidence snippet uniquely matching saved draft
  ws.app.mutation("evidence.record", {
    projectId,
    documentId: ch1,
    baseRevisionId: rev1,
    factId: "seal-clue",
    quote: "门缝里塞着一封没有落款的密信。",
  });

  // Character knowledge boundary verified via settings.read
  assert.equal(ws.app.mutation("settings.read", { projectId, character: "林晚", at: { chapterId: ch2, point: 2 } }).entries.length, 0);
  assert.equal(ws.app.mutation("settings.read", { projectId, character: "林晚", at: { chapterId: ch2, point: 3 } }).entries.length, 1);

  // 3. Foreshadow + Technique mount + Context preview
  const fsId = ws.app.mutation("foreshadow.create", {
    projectId,
    documentId: ch1,
    title: "无落款密信",
    note: "留待第二章揭晓印记",
  }).id;
  ws.app.mutation("foreshadow.patch", { projectId, id: fsId, status: "hinted", note: "暗巷呼应" });

  const techId = ws.app.mutation("technique.save", {
    projectId,
    title: "短句紧迫感",
    category: "pacing",
    executionSteps: "冲突爆发前连续使用不超过 15 字的动作短句。",
  }).id;
  ws.app.mutation("library.mount", { projectId, itemKind: "technique", itemId: techId, targetType: "project" });

  const preview = ws.app.mutation("context.preview", { documentId: ch2, instruction: "推进暗巷对峙" });
  assert.ok(preview.report.slots.length > 0);
  assert.ok(preview.report.totalEstimatedTokens > 0);

  // 4. Writing run -> manual candidate -> adopt
  const runId = ws.app.mutation("run.start", {
    documentId: ch1,
    baseRevisionId: rev1,
    instruction: "强化开篇悬念",
    tokenLimit: 12000,
  }).id;
  ws.app.mutation("run.complete", {
    runId,
    body: "沈砚推开柴门，风雪灌入堂屋。\n\n门缝里塞着一封带血的密信。",
    tokens: 320,
  });
  const adopted = ws.app.mutation("candidate.adopt", { documentId: ch1, runId, baseRevisionId: rev1, key: "adopt-1" });
  assert.ok(adopted.revisionId);
  assert.match(ws.app.snapshot(projectId, ch1).active.body, /带血的密信/);

  // 5. Editorial review: 2 rejections allowed, 3rd denied; pass -> finalize locks draft
  const revAfterAdopt = adopted.revisionId;
  ws.app.mutation("chapter.review", { documentId: ch1, baseRevisionId: revAfterAdopt, accept: false, note: "节奏偏慢" });
  ws.app.mutation("chapter.review", { documentId: ch1, baseRevisionId: revAfterAdopt, accept: false, note: "动机补足" });
  assertThrowsContract(
    () => ws.app.mutation("chapter.review", { documentId: ch1, baseRevisionId: revAfterAdopt, accept: false, note: "第三次应拒" }),
    "gate.denied",
  );
  ws.app.mutation("chapter.review", { documentId: ch1, baseRevisionId: revAfterAdopt, accept: true });
  assert.equal(ws.app.snapshot(projectId, ch1).active.state, "reviewed");

  // Re-accepting an already-reviewed chapter violates CHAPTER_TRANSITIONS (reviewed -> reviewed)
  assertThrowsContract(
    () => ws.app.mutation("chapter.review", { documentId: ch1, baseRevisionId: revAfterAdopt, accept: true }),
    "gate.denied",
  );

  ws.app.mutation("draft.finalize", { documentId: ch1, baseRevisionId: revAfterAdopt, key: "finalize-1" });
  assert.equal(ws.app.snapshot(projectId, ch1).active.state, "final");

  // Finalized chapter refuses further draft edits
  assertThrowsContract(
    () => ws.app.mutation("draft.save", { documentId: ch1, baseRevisionId: revAfterAdopt, body: "强行改动" }),
    "gate.denied",
  );
});

test("Fanqie L1 Book Bible stays byte-identical across tokenLimit/stage changes and small lore edits until cache.rebuild", (t) => {
  const ws = createTestWorkspace(t);
  const { projectId, documentId, baseRevisionId } = ws.createFanqieChapter({
    projectName: "缓存稳态长篇",
    title: "第一章 启程",
    body: "主角踏上北境官道。",
  });

  ws.app.mutation("controls.save", { projectId, authorIntent: "冷峻写实，禁止剧透。" });
  ws.app.mutation("setting.propose", {
    projectId,
    documentId,
    factId: "hero-origin",
    note: "主角曾是北境斥候。",
    source: "初稿",
    from: { chapterId: documentId, point: 1 },
  });
  const s1 = ws.app.snapshot(projectId, documentId).settings[0].id;
  ws.app.mutation("setting.decide", { projectId, documentId, proposalId: s1, accept: true });

  // Materialize initial L1 v1 snapshot via run.start
  const run1 = ws.app.mutation("run.start", {
    documentId,
    baseRevisionId,
    instruction: "初稿推进",
    tokenLimit: 12000,
  });
  ws.app.mutation("run.cancel", { runId: run1.id });

  const snap1 = ws.app.mutation("cache.snapshot", { projectId });
  assert.equal(snap1.version, 1);
  assert.equal(snap1.dirtyMutations, 0);

  // 1. Changing tokenLimit (12000 -> 24000) or stage (write -> refine) MUST NOT alter L1 SHA-256!
  const p12k = ws.app.mutation("context.preview", { documentId, instruction: "写", tokenLimit: 12000, stage: "write" });
  const p24k = ws.app.mutation("context.preview", { documentId, instruction: "精修", tokenLimit: 24000, stage: "refine" });
  assert.equal(p12k.report.prefixSha256, p24k.report.prefixSha256);
  assert.equal(p12k.report.l1Tokens, p24k.report.l1Tokens);
  assert.equal(p12k.report.l1Version, 1);

  // 2. Approving 1 new lore item (< 10 threshold) marks L1 dirty and routes new lore to L3 delta while L1 hash stays pinned!
  ws.app.mutation("setting.propose", {
    projectId,
    documentId,
    factId: "sword-name",
    note: "佩剑名为断霜。",
    source: "第一章",
    from: { chapterId: documentId, point: 1 },
  });
  const s2 = ws.app.snapshot(projectId, documentId).settings[0].id;
  ws.app.mutation("setting.decide", { projectId, documentId, proposalId: s2, accept: true });

  const afterLore = ws.app.mutation("context.preview", { documentId, instruction: "写", tokenLimit: 12000 });
  assert.equal(afterLore.report.prefixSha256, p12k.report.prefixSha256);
  assert.equal(afterLore.report.l1Version, 1);
  assert.equal(afterLore.report.l1DirtyCount, 1);
  assert.ok(afterLore.report.slots.some((slot) => slot.id === "l1DeltaPatch" && slot.status === "included"));

  // 3. Manual cache.rebuild folds delta into L1 v2, clears dirtyMutations, and updates prefixSha256
  const rebuilt = ws.app.mutation("cache.rebuild", { projectId });
  assert.equal(rebuilt.version, 2);
  assert.equal(rebuilt.dirtyMutations, 0);
  assert.notEqual(rebuilt.prefixSha256, snap1.prefixSha256);

  const afterRebuild = ws.app.mutation("context.preview", { documentId, instruction: "写", tokenLimit: 12000 });
  assert.equal(afterRebuild.report.l1Version, 2);
  assert.equal(afterRebuild.report.l1DirtyCount, 0);
  assert.equal(afterRebuild.report.slots.some((slot) => slot.id === "l1DeltaPatch"), false);
});


test("An approved memory retirement ends an unlocked fact at its selected paragraph", (t) => {
  const ws = createTestWorkspace(t);
  const { app } = ws;
  const { projectId, documentId } = ws.createFanqieChapter({ body: "仓库依旧开着。\n她抵达门口。\n守门人锁门离开。" });
  app.mutation("setting.propose", {
    projectId, documentId, factId: "warehouse-open",
    note: "仓库目前开放", source: "作者", from: { chapterId: documentId, point: 1 },
    people: [{ character: "阿简" }],
  });
  const setting = app.snapshot(projectId, documentId).settings[0];
  app.mutation("setting.decide", { projectId, documentId, proposalId: setting.id, accept: true });
  const retirement = app.mutation("proposal.create", {
    kind: "fact_sync", projectId, documentId,
    payload: { retiredFacts: [{ factId: "warehouse-open", point: 3, reason: "守门人落锁" }] },
  });
  app.mutation("proposal.decide", { proposalId: retirement.id, accept: true, selectedRetiredFactIndices: [0] });
  const stored = ws.db.prepare("SELECT value FROM author_settings WHERE fact_id = ? ORDER BY decided_seq DESC LIMIT 1")
    .get("warehouse-open");
  assert.deepEqual(JSON.parse(stored.value).effectiveTo, { chapterId: documentId, point: 3 });
});
