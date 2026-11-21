import test from "node:test";
import assert from "node:assert/strict";
import {
  EDITORIAL_REJECTION_LIMIT,
  assertChapterFinalizable,
  assertChapterTransition,
  assertForeshadowTransition,
  detectLoreConflicts,
  diagnoseChapterOffline,
  diagnoseGoldenThree,
  flattenNovelOrder,
  planReorder,
  rankTechniquesForChapter,
  reorderImpact,
  scanAiSlop,
  settingsAt,
} from "../src/domain/fanqie/index.ts";
import { anchor, isEffective, pointAtOffset, splitChapterParagraphs } from "../src/domain/shared/index.ts";
import { assertThrowsContract } from "../support/harness.mjs";

test("chapter editorial transitions and rejection cap 2 are strictly enforced", () => {
  assert.equal(EDITORIAL_REJECTION_LIMIT, 2);
  assertChapterTransition("planned", "drafting");
  assertChapterTransition("drafting", "drafted");
  assertChapterTransition("drafted", "reviewed");
  assertChapterTransition("reviewed", "drafted");
  assertChapterTransition("reviewed", "final");

  assertThrowsContract(() => assertChapterTransition("drafted", "drafting"), "gate.denied");
  assertThrowsContract(() => assertChapterTransition("final", "drafting"), "gate.denied");

  assertChapterFinalizable("reviewed", 0);
  assertChapterFinalizable("reviewed", 2);
  assertThrowsContract(() => assertChapterFinalizable("reviewed", 3), "gate.denied");
  assertThrowsContract(() => assertChapterFinalizable("drafted", 0), "gate.denied");
});

test("half-open validity intervals and character knownFrom visibility work across chapters", () => {
  const order = ["c1", "c2", "c3"];
  const fact = {
    id: "f1",
    note: "密信在书房暗格",
    source: "作者大纲",
    kind: "fact",
    locked: false,
    effectiveFrom: anchor("c1", 1),
    effectiveTo: anchor("c2", 4),
    knownFrom: {
      乔: anchor("c1", 1),
      林: anchor("c2", 3),
    },
  };

  assert.equal(isEffective({ effectiveFrom: fact.effectiveFrom, effectiveTo: fact.effectiveTo }, anchor("c2", 3), order), true);
  assert.equal(isEffective({ effectiveFrom: fact.effectiveFrom, effectiveTo: fact.effectiveTo }, anchor("c2", 4), order), false);

  assert.equal(settingsAt([fact], order, anchor("c2", 2), "林").length, 0);
  assert.equal(settingsAt([fact], order, anchor("c2", 3), "林").length, 1);
  assert.equal(settingsAt([fact], order, anchor("c2", 4), "林").length, 0);
  assert.equal(settingsAt([fact], order, anchor("c1", 2), "乔").length, 1);
});

test("chapter reorder detects flipped continuity relations and builds confirmation plan", () => {
  const before = ["c1", "c2", "c3"];
  const after = ["c3", "c1", "c2"];
  const entries = [
    {
      id: "f1",
      relations: [{ from: anchor("c1", 1), to: anchor("c3", 2), label: "effective-range" }],
    },
  ];
  const impacts = reorderImpact(entries, before, after);
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].id, "f1");

  const plan = planReorder(entries, before, after);
  assert.equal(plan.requiresAuthorConfirmation, true);
  assert.equal(plan.impact.length, 1);
});

test("paragraph anchors map character offsets accurately", () => {
  const body = "第一段开篇。\n\n第二段冲突升级。\n\n第三段章末钩子。";
  const paras = splitChapterParagraphs(body);
  assert.equal(paras.length, 3);
  assert.equal(pointAtOffset(body, 0), 1);
  assert.equal(pointAtOffset(body, body.indexOf("第二段")), 2);
  assert.equal(pointAtOffset(body, body.indexOf("第三段")), 3);
});

test("foreshadow lifecycle, lore conflicts, hierarchy flattening, and technique ranking", () => {
  assertForeshadowTransition("planted", "hinted");
  assertForeshadowTransition("hinted", "resolved");
  assertForeshadowTransition("resolved", "planted", { reopen: true });
  assertThrowsContract(() => assertForeshadowTransition("resolved", "planted"), "gate.denied");
  assertThrowsContract(() => assertForeshadowTransition("abandoned", "resolved"), "gate.denied");

  const order = ["c1", "c2"];
  const conflicts = detectLoreConflicts(
    [
      {
        id: "f-bad",
        note: "倒挂区间",
        source: "手记",
        kind: "fact",
        locked: false,
        effectiveFrom: anchor("c2", 2),
        effectiveTo: anchor("c1", 1),
        knownFrom: {},
      },
    ],
    order,
    [{
      id: "fs1",
      factId: null,
      title: "旧玉佩",
      status: "resolved",
      plantedChapterId: "c2",
      plantedPoint: 1,
      targetChapterId: null,
      resolvedChapterId: "c1",
    }],
    [],
  );
  assert.ok(conflicts.length >= 1);

  const flat = flattenNovelOrder(
    [{ id: "v1", sortOrder: 1 }],
    [{ id: "a1", volumeId: "v1", sortOrder: 1 }],
    [
      { id: "c2", volumeId: "v1", actId: "a1" },
      { id: "c1", volumeId: "v1", actId: "a1" },
    ],
    ["c1", "c2"],
  );
  assert.deepEqual(flat, ["c1", "c2"]);

  const ranked = rankTechniquesForChapter({
    cards: [
      {
        id: "t1",
        scope: "project",
        overrideOfId: null,
        title: "三章黄金钩",
        category: "opening",
        pacing: "快爽",
        sceneTags: ["悬念"],
        triggerWhen: "开篇",
        executionSteps: "三百字内抛危机",
        priority: 60,
        status: "approved",
      },
      {
        id: "t2",
        scope: "project",
        overrideOfId: null,
        title: "慢热日常",
        category: "character",
        pacing: "慢燃",
        sceneTags: ["生活"],
        triggerWhen: "日常",
        executionSteps: "细写烟火气",
        priority: 40,
        status: "approved",
      },
    ],
    mounts: [],
    contextIds: { projectId: "p1", volumeId: null, actId: null, chapterId: "c1" },
    pacing: "快爽",
    genreTags: ["悬念"],
    chapterIndex: 0,
  });
  assert.equal(ranked[0].card.id, "t1");
});

test("offline AI-slop scan and Golden-3 diagnostics catch cliches and weak openings", () => {
  const sloppy = "嘴角微微上扬，空气仿佛凝固了，瞳孔骤然一缩。".repeat(4);
  const slopReport = scanAiSlop(sloppy);
  assert.ok(slopReport.totalHits >= 4);
  assert.ok(slopReport.densityPer1000Chars > 0);

  const golden = diagnoseGoldenThree("今天天气不错，主角起床刷牙吃早饭。", 1);
  assert.equal(golden.isGoldenThreeChapter, true);
  assert.ok(Array.isArray(golden.dimensions));

  const full = diagnoseChapterOffline("doc-1", sloppy, { chapterIndex: 1, targetLength: 2200 });
  assert.ok(full.aiSlop.totalHits >= 4);
  assert.ok(full.aiSlop.charCount > 0);
});
