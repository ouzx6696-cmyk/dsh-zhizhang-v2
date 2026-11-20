import assert from "node:assert/strict";
import test from "node:test";
import { assertThrowsContract, createTestWorkspace } from "../support/v2-harness.mjs";

test("dynamic lore materializes categories, tracks foreshadows, and detects cross-chapter conflicts", (t) => {
  const ws = createTestWorkspace(t);
  const ch1 = ws.createFanqieChapter({ title: "第一章", body: "林拿到一枚生锈的铜钥匙。" });
  const projectId = ch1.projectId;
  const ch2 = ws.app.mutation("document.create", { projectId, title: "第二章" }).id;

  const prop = ws.app.mutation("setting.propose", {
    projectId,
    documentId: ch1.documentId,
    factId: "bronze-key",
    category: "item",
    entityName: "生锈铜钥匙",
    note: "开启北院地窖的唯一钥匙",
    source: "第一章草稿",
    locked: true,
    from: { chapterId: ch1.documentId, point: 1 },
    to: { chapterId: ch2, point: 1 },
    people: [{ character: "林", at: { chapterId: ch2, point: 2 } }], // known AFTER expiry!
  });
  ws.app.mutation("setting.decide", { projectId, documentId: ch1.documentId, proposalId: prop.id, accept: true });

  const loreList = ws.app.mutation("lore.list", { projectId, category: "item", entityName: "铜钥匙" });
  assert.equal(loreList.entries.length, 1);
  assert.equal(loreList.entries[0].locked, true);
  assert.equal(loreList.entries[0].entityName, "生锈铜钥匙");

  // Foreshadow planted after resolved chapter triggers conflict
  ws.app.mutation("foreshadow.upsert", {
    projectId,
    title: "钥匙来源之谜",
    factId: "bronze-key",
    plantedChapterId: ch2,
    resolvedChapterId: ch1.documentId,
    status: "resolved",
    note: "时间倒错伏笔测试",
  });

  // Outline referencing expired/inactive setting at ch2 triggers warning
  ws.app.mutation("chapter.outline", {
    documentId: ch2,
    viewpoint: "林",
    target: 2200,
    lockedFacts: "使用 bronze-key 开门",
    knowledge: "林刚拿到钥匙",
    剧情梗概: "进地窖",
    核心冲突与看点: "门后机关",
    情节推进节点: "开锁",
    章末落点: "黑影现身",
  });

  const conflicts = ws.app.mutation("lore.conflicts", { projectId });
  assert.ok(conflicts.some((c) => c.kind === "expiry-before-known"));
  assert.ok(conflicts.some((c) => c.kind === "foreshadow-order-flip"));
  assert.ok(conflicts.some((c) => c.kind === "outline-fact-mismatch"));
});

test("global + project-override library scoping, 4-level mounts, deterministic recommendations, and FTS5 trigram/short search", (t) => {
  const ws = createTestWorkspace(t);
  const ch1 = ws.createFanqieChapter({ title: "退婚夜", body: "宾客哄笑，林却缓缓亮出一枚皇家紫金令。" });
  const projectId = ch1.projectId;
  const vol = ws.app.mutation("volume.create", { projectId, title: "第一卷" });
  const act = ws.app.mutation("act.create", { projectId, volumeId: vol.id, title: "退婚幕" });
  ws.app.mutation("chapter.move", { documentId: ch1.documentId, targetVolumeId: vol.id, targetActId: act.id });

  ws.app.mutation("chapter.outline", {
    documentId: ch1.documentId,
    viewpoint: "林",
    target: 2200,
    lockedFacts: "紫金令在身",
    knowledge: "林知晓反杀底牌",
    剧情梗概: "退婚现场反打脸",
    核心冲突与看点: "打脸退婚与反转",
    情节推进节点: "亮出底牌",
    章末落点: "全场震惊",
  });

  // 1. Global technique cards & deconstruction sample
  const techGlobal = ws.app.mutation("technique.save", {
    scope: "global",
    title: "三段式打脸反转",
    category: "opening",
    pacing: "快爽",
    sceneTags: ["打脸", "反转"],
    triggerWhen: "主角在众人嘲讽下亮底牌",
    executionSteps: "1.蓄势嘲讽 2.亮出信物 3.切配角震惊反应",
    priority: 70,
  });
  const techExcluded = ws.app.mutation("technique.save", {
    scope: "global",
    title: "慢燃心理留白",
    category: "atmosphere",
    pacing: "慢燃",
    executionSteps: "三页心理独白",
    priority: 95,
  });
  const decGlobal = ws.app.mutation("deconstruct.save", {
    scope: "global",
    title: "经典退婚流拆解",
    sourceBook: "范本甲",
    pacing: "快爽",
    tags: ["退婚", "打脸"],
    excerpt: "三十年河东，莫欺少年穷。",
    hookAnalysis: "开篇直接抛退婚屈辱冲突",
  });

  // 2. Project override shadows global card without mutating original global card
  const techOverride = ws.app.mutation("technique.save", {
    scope: "project",
    projectId,
    overrideOfId: techGlobal.id,
    title: "三段式打脸反转（本书冷峻版）",
    category: "opening",
    pacing: "快爽",
    sceneTags: ["打脸", "反转"],
    triggerWhen: "退婚或对峙",
    executionSteps: "克制描写，只用三句对话完成反转",
    priority: 90,
  });
  assert.equal(ws.app.mutation("technique.list", { scope: "global" }).find((c) => c.id === techGlobal.id).title, "三段式打脸反转");
  const scopedList = ws.app.mutation("technique.list", { projectId });
  assert.equal(scopedList.some((c) => c.id === techGlobal.id), false);
  assert.equal(scopedList.some((c) => c.id === techOverride.id), true);

  // 3. 4-level mounting: mount techExcluded at project level, then exclude at chapter level!
  ws.app.mutation("library.mount", {
    projectId,
    targetType: "project",
    targetId: projectId,
    itemKind: "technique",
    itemId: techExcluded.id,
    mode: "include",
  });
  ws.app.mutation("library.mount", {
    projectId,
    targetType: "chapter",
    targetId: ch1.documentId,
    itemKind: "technique",
    itemId: techExcluded.id,
    mode: "exclude",
  });
  ws.app.mutation("library.mount", {
    projectId,
    targetType: "act",
    targetId: act.id,
    itemKind: "deconstruction",
    itemId: decGlobal.id,
    mode: "pin",
  });

  const recs = ws.app.mutation("technique.recommend", { documentId: ch1.documentId, pacing: "快爽" });
  assert.equal(recs.some((r) => r.card.id === techExcluded.id), false);
  assert.equal(recs[0].card.id, techOverride.id);
  assert.ok(recs[0].reasons.length >= 2);

  // 4. FTS5 trigram (>= 3 chars) and <3-char fallback searches across all scopes
  const ftsLong = ws.app.mutation("workspace.search", { projectId, query: "紫金令" });
  assert.ok(ftsLong.some((h) => h.scope === "chapter" && h.id === ch1.documentId));

  const ftsTech = ws.app.mutation("workspace.search", { projectId, query: "冷峻版" });
  assert.ok(ftsTech.some((h) => h.scope === "technique" && h.id === techOverride.id));

  const shortFallback = ws.app.mutation("workspace.search", { projectId, query: "退婚" });
  assert.ok(shortFallback.some((h) => h.scope === "chapter"));
  assert.ok(shortFallback.some((h) => h.scope === "deconstruction"));

  // Unknown pacing tier refused cleanly
  assertThrowsContract(
    () => ws.app.mutation("technique.save", { scope: "global", title: "坏卡", executionSteps: "x", pacing: "乱写" }),
    "input.invalid",
    { field: "pacing", reason: "unknown-pacing-tier" },
  );
});
