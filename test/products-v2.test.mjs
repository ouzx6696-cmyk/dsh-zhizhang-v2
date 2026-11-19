import assert from "node:assert/strict";
import test from "node:test";
import { createProductLineRegistry } from "../src/application/product-line.ts";
import { createFanqieModule } from "../src/application/products/fanqie.ts";
import { createToutiaoModule } from "../src/application/products/toutiao.ts";
import {
  articleScenario,
  ARTICLE_MODES,
  CONTENT_LINES,
  DELIVERY_ENDING,
  QA_PASS_SCORE,
  QA_REFINEMENT_LIMIT,
  TITLE_MAX,
} from "../src/domain/toutiao/index.ts";
import { assertThrowsContract, createTestWorkspace } from "../support/v2-harness.mjs";

test("createProductLineRegistry enforces unique product IDs, actions, and read models and checks locked states", (t) => {
  const fanqie = createFanqieModule();
  const toutiao = createToutiaoModule();
  const registry = createProductLineRegistry([fanqie, toutiao]);

  assert.equal(registry.all().length, 2);
  assert.equal(registry.get("fanqie")?.id, "fanqie");
  assert.equal(registry.get("unknown"), undefined);
  assert.throws(() => registry.require("unknown"), /Unknown product line/);

  assert.equal(registry.isLockedState("fanqie", "final"), true);
  assert.equal(registry.isLockedState("fanqie", "reviewed"), false);
  assert.equal(registry.isLockedState("toutiao", "已验收"), true);
  assert.equal(registry.isLockedState("toutiao", "已交稿"), true);
  assert.equal(registry.isLockedState("toutiao", "待验收"), false);
  assert.equal(registry.isLockedState("unknown", "final"), false);

  assert.throws(() => createProductLineRegistry([fanqie, fanqie]), /Duplicate product line module: fanqie/);

  const dupActionModule = {
    ...toutiao,
    id: "custom-a",
    actions: { "chapter.review": fanqie.actions["chapter.review"] },
    readModels: {},
  };
  assert.throws(() => createProductLineRegistry([fanqie, dupActionModule]), /Duplicate product action: chapter\.review/);

  const dupReadModule = {
    ...toutiao,
    id: "custom-b",
    actions: {},
    readModels: { evidence: fanqie.readModels.evidence },
  };
  assert.throws(() => createProductLineRegistry([fanqie, dupReadModule]), /Duplicate read model factory: evidence/);

  const ws = createTestWorkspace(t);
  assertThrowsContract(() => ws.app.mutation("project.create", { product: "missing", name: "x" }), "input.invalid", {
    field: "product",
    reason: "unknown-product",
  });
  const doc = ws.createFanqieChapter();
  assertThrowsContract(() => ws.app.mutation("unknown.action", { documentId: doc.documentId }), "input.invalid", {
    field: "action",
    reason: "unknown-action",
  });
});

test("Fanqie chapter outline warnings, continuity proposals, agreement filter, locked facts, and 50-entry pagination", (t) => {
  const ws = createTestWorkspace(t);
  const ch1 = ws.createFanqieChapter({ title: "第一章", body: "首段。\n林拿起信封。\n尾段。" });
  const ch2Id = ws.app.mutation("document.create", { projectId: ch1.projectId, title: "第二章" }).id;

  // Empty chapter title rejected
  assertThrowsContract(
    () => ws.app.mutation("document.create", { projectId: ch1.projectId, title: "   " }),
    "input.invalid",
    { field: "title", reason: "required" },
  );

  // Outline target=0 rejected, warnings outside [1500, 6000], clear inside [1500, 6000], and cross-product rejected
  const outlineBase = {
    viewpoint: "林",
    lockedFacts: "信未拆",
    knowledge: "林不知写信人",
    剧情梗概: "林收信",
    核心冲突与看点: "是否当场拆开",
    情节推进节点: "第二段决定留到夜里",
    章末落点: "门外传来脚步声",
  };
  assertThrowsContract(
    () => ws.app.mutation("chapter.outline", { documentId: ch1.documentId, ...outlineBase, target: 0 }),
    "input.invalid",
    { field: "target", reason: "positive-length-required" },
  );
  assert.equal(ws.app.mutation("chapter.outline", { documentId: ch1.documentId, ...outlineBase, target: 1499 }).warnings.length, 1);
  assert.equal(ws.app.mutation("chapter.outline", { documentId: ch1.documentId, ...outlineBase, target: 6001 }).warnings.length, 1);
  assert.deepEqual(ws.app.mutation("chapter.outline", { documentId: ch1.documentId, ...outlineBase, target: 1500 }).warnings, []);
  assert.deepEqual(ws.app.mutation("chapter.outline", { documentId: ch1.documentId, ...outlineBase, target: 6000 }).warnings, []);

  // Multi-person setting proposal validation guards
  assertThrowsContract(
    () =>
      ws.app.mutation("setting.propose", {
        projectId: ch1.projectId,
        documentId: ch1.documentId,
        factId: "bad-people",
        note: "重复人物",
        source: "笔记",
        from: { chapterId: ch1.documentId, point: 1 },
        people: [
          { character: "林", at: { chapterId: ch1.documentId, point: 1 } },
          { character: "林", at: { chapterId: ch2Id, point: 1 } },
        ],
      }),
    "input.invalid",
    { field: "people", reason: "duplicate-character" },
  );
  assertThrowsContract(
    () =>
      ws.app.mutation("setting.propose", {
        projectId: ch1.projectId,
        documentId: ch1.documentId,
        factId: "bad-interval",
        note: "失效早于生效",
        source: "笔记",
        from: { chapterId: ch2Id, point: 2 },
        to: { chapterId: ch2Id, point: 2 },
      }),
    "input.invalid",
    { field: "to", reason: "empty-validity-interval" },
  );
  assertThrowsContract(
    () =>
      ws.app.mutation("setting.propose", {
        projectId: ch1.projectId,
        documentId: ch1.documentId,
        factId: "bad-anchor",
        note: "未知章节",
        source: "笔记",
        from: { chapterId: "no-such-chapter", point: 1 },
      }),
    "input.invalid",
    { field: "from", reason: "unknown-chapter-or-point" },
  );

  // Agreement proposals can be decided, but stay excluded from settings.read (author/character facts only).
  const agreement = ws.app.mutation("setting.propose", {
    projectId: ch1.projectId,
    documentId: ch1.documentId,
    factId: "tone-rule",
    kind: "agreement",
    note: "全书克制白描",
    source: "作者约定",
    from: { chapterId: ch1.documentId, point: 1 },
    people: [{ character: "林" }],
  });
  ws.app.mutation("setting.decide", {
    projectId: ch1.projectId,
    documentId: ch1.documentId,
    proposalId: agreement.id,
    accept: true,
  });
  assert.equal(
    ws.app.mutation("settings.read", {
      projectId: ch1.projectId,
      character: "林",
      at: { chapterId: ch1.documentId, point: 1 },
    }).entries.length,
    0,
  );

  // Already-decided proposal cannot be decided twice; locked approved setting blocks future proposals on same factId.
  assertThrowsContract(
    () =>
      ws.app.mutation("setting.decide", {
        projectId: ch1.projectId,
        documentId: ch1.documentId,
        proposalId: agreement.id,
        accept: false,
      }),
    "gate.denied",
    { reason: "decision-already-recorded" },
  );

  const lockedProp = ws.app.mutation("setting.propose", {
    projectId: ch1.projectId,
    documentId: ch1.documentId,
    factId: "heirloom",
    note: "怀表刻字",
    source: "设定集",
    locked: true,
    from: { chapterId: ch1.documentId, point: 1 },
    people: [{ character: "乔" }, { character: "林", at: { chapterId: ch2Id, point: 2 } }],
    to: { chapterId: ch2Id, point: 5 },
  });
  ws.app.mutation("setting.decide", {
    projectId: ch1.projectId,
    documentId: ch1.documentId,
    proposalId: lockedProp.id,
    accept: true,
  });
  // Before ch2 point 2, Lin does not know yet; Qiao already knows at ch1 point 1.
  assert.equal(
    ws.app.mutation("settings.read", { projectId: ch1.projectId, character: "乔", at: { chapterId: ch1.documentId, point: 1 } }).entries.length,
    1,
  );
  assert.equal(
    ws.app.mutation("settings.read", { projectId: ch1.projectId, character: "林", at: { chapterId: ch2Id, point: 1 } }).entries.length,
    0,
  );
  assert.equal(
    ws.app.mutation("settings.read", { projectId: ch1.projectId, character: "林", at: { chapterId: ch2Id, point: 2 } }).entries.length,
    1,
  );
  // Half-open [effectiveFrom, effectiveTo): expired at to point 5.
  assert.equal(
    ws.app.mutation("settings.read", { projectId: ch1.projectId, character: "林", at: { chapterId: ch2Id, point: 5 } }).entries.length,
    0,
  );

  // Swapping chapter order detects both "设定有效期" and "林知晓" flips.
  const reorderPlan = ws.app.mutation("reorder.impact", { projectId: ch1.projectId, chapterIds: [ch2Id, ch1.documentId] });
  const heirloomImpact = reorderPlan.impact.find((entry) => entry.id === "heirloom");
  assert.ok(heirloomImpact);
  assert.deepEqual(heirloomImpact.relations.map((r) => r.label).sort(), ["林知晓", "设定有效期"]);

  // Proposing a second setting for locked factId "heirloom" cannot be approved.
  const conflictProp = ws.app.mutation("setting.propose", {
    projectId: ch1.projectId,
    documentId: ch1.documentId,
    factId: "heirloom",
    note: "改写怀表",
    source: "新想法",
    from: { chapterId: ch1.documentId, point: 1 },
  });
  assertThrowsContract(
    () =>
      ws.app.mutation("setting.decide", {
        projectId: ch1.projectId,
        documentId: ch1.documentId,
        proposalId: conflictProp.id,
        accept: true,
      }),
    "gate.denied",
    { reason: "setting-is-locked" },
  );

  // Pagination: create 52 more proposals (total 55) -> first snapshot holds 50, settings.history returns last 5.
  for (let i = 0; i < 52; i++) {
    ws.app.mutation("setting.propose", {
      projectId: ch1.projectId,
      documentId: ch1.documentId,
      factId: `item-${i}`,
      note: `设定-${i}`,
      source: "批次",
      from: { chapterId: ch1.documentId, point: 1 },
    });
  }
  const snap = ws.app.snapshot(ch1.projectId, ch1.documentId);
  assert.equal(snap.settings.length, 50);
  assert.ok(snap.settingsCursor !== null);
  const page2 = ws.app.mutation("settings.history", { projectId: ch1.projectId, before: snap.settingsCursor });
  assert.equal(page2.entries.length, 5);
  assert.equal(page2.cursor, null);
});

test("Fanqie evidence matching, reorder validation, cross-product isolation, and finalization locks", (t) => {
  const ws = createTestWorkspace(t);
  const fanqie = ws.createFanqieChapter({ title: "第一章", body: "重复词在这里。\n第二行唯一句：银色怀表。\n重复词在这里。" });
  const ch2 = ws.app.mutation("document.create", { projectId: fanqie.projectId, title: "第二章" }).id;
  const toutiao = ws.createToutiaoArticle({ title: "头条稿" });

  // Evidence must match exactly once on saved revision
  assertThrowsContract(
    () =>
      ws.app.mutation("evidence.record", {
        documentId: fanqie.documentId,
        baseRevisionId: fanqie.revisionId,
        factId: "f1",
        quote: "不存在的句子",
      }),
    "input.invalid",
    { field: "quote", reason: "quote-must-match-exactly-once" },
  );
  assertThrowsContract(
    () =>
      ws.app.mutation("evidence.record", {
        documentId: fanqie.documentId,
        baseRevisionId: fanqie.revisionId,
        factId: "f1",
        quote: "重复词",
      }),
    "input.invalid",
    { field: "quote", reason: "quote-must-match-exactly-once" },
  );
  const ev = ws.app.mutation("evidence.record", {
    documentId: fanqie.documentId,
    baseRevisionId: fanqie.revisionId,
    factId: "f1",
    quote: "银色怀表",
  });
  assert.equal(ev.anchor.point, "2");
  const detail = ws.app.mutation("evidence.detail", { documentId: fanqie.documentId, factId: "f1" });
  assert.equal(detail.value.snapshotId, ev.snapshotId);

  // Invalid reorder chapter sets & cross-product isolation
  assertThrowsContract(
    () => ws.app.mutation("reorder.impact", { projectId: fanqie.projectId, chapterIds: [fanqie.documentId] }),
    "input.invalid",
    { field: "chapterIds", reason: "order-must-contain-every-chapter-once" },
  );
  assertThrowsContract(
    () => ws.app.mutation("reorder.impact", { projectId: fanqie.projectId, chapterIds: [fanqie.documentId, fanqie.documentId] }),
    "input.invalid",
    { field: "chapterIds", reason: "order-must-contain-every-chapter-once" },
  );
  assertThrowsContract(
    () => ws.app.mutation("reorder.impact", { projectId: toutiao.projectId, chapterIds: [toutiao.documentId] }),
    "input.invalid",
    { field: "projectId", reason: "novel-required" },
  );
  assertThrowsContract(
    () => ws.app.mutation("chapter.review", { documentId: toutiao.documentId, baseRevisionId: toutiao.revisionId, accept: true }),
    "gate.denied",
    { action: "chapter.review", reason: "chapter-not-reviewable" },
  );
  assertThrowsContract(
    () => ws.app.mutation("evidence.record", { documentId: toutiao.documentId, baseRevisionId: toutiao.revisionId, factId: "x", quote: "短" }),
    "input.invalid",
    { field: "documentId", reason: "chapter-required" },
  );
  assertThrowsContract(
    () => ws.app.mutation("setting.propose", { projectId: fanqie.projectId, documentId: ch2, factId: "x", note: "   ", source: "x", from: { chapterId: ch2, point: 1 } }),
    "input.invalid",
    { field: "note", reason: "required" },
  );
});

test("Fanqie finalized chapters refuse further reviews and runs", (t) => {
  const ws = createTestWorkspace(t);
  const fanqie = ws.createFanqieChapter({ title: "终章", body: "完结正文" });
  ws.app.mutation("chapter.review", { documentId: fanqie.documentId, baseRevisionId: fanqie.revisionId, accept: true });
  ws.app.mutation("draft.finalize", { documentId: fanqie.documentId, baseRevisionId: fanqie.revisionId });

  assertThrowsContract(
    () => ws.app.mutation("chapter.review", { documentId: fanqie.documentId, baseRevisionId: fanqie.revisionId, accept: true }),
    "gate.denied",
    { reason: "chapter-not-reviewable" },
  );
  assertThrowsContract(
    () => ws.app.mutation("run.start", { documentId: fanqie.documentId, baseRevisionId: fanqie.revisionId, instruction: "改", tokenLimit: 8000 }),
    "gate.denied",
    { action: "run.start", reason: "revision-locked" },
  );
});

test("Toutiao validates all 6 scenario cells, micro rules, article.plan title matrix, and rename revision reset", (t) => {
  const ws = createTestWorkspace(t);
  const projId = ws.app.mutation("project.create", { product: "toutiao", name: "头条矩阵" }).id;

  // All 6 cells (long/short/micro × 资讯线/故事线) create cleanly and return exact scenario specs.
  for (const mode of Object.keys(ARTICLE_MODES)) {
    for (const line of Object.keys(CONTENT_LINES)) {
      const expected = articleScenario(mode, line);
      const docId = ws.app.mutation("document.create", {
        projectId: projId,
        title: mode === "micro" ? "" : `${mode}-${line}`,
        mode,
        line,
      }).id;
      const snap = ws.app.snapshot(projId, docId);
      assert.deepEqual(snap.scenario, expected);
    }
  }

  // Invalid mode or line refused
  assertThrowsContract(
    () => ws.app.mutation("document.create", { projectId: projId, title: "坏", mode: "deep", line: "资讯线" }),
    "input.invalid",
    { field: "mode", reason: "unknown-article-mode" },
  );
  assertThrowsContract(
    () => ws.app.mutation("document.create", { projectId: projId, title: "坏", mode: "short", line: "杂谈线" }),
    "input.invalid",
    { field: "line", reason: "unknown-content-line" },
  );

  // Micro rules: no title on create, rename refused, markdown heading + length hard gates on QA
  assertThrowsContract(
    () => ws.app.mutation("document.create", { projectId: projId, title: "微头条不应有标题", mode: "micro", line: "故事线" }),
    "input.invalid",
    { field: "title", reason: "micro-has-no-title" },
  );
  const microId = ws.app.mutation("document.create", { projectId: projId, title: "", mode: "micro", line: "故事线" }).id;
  const microRev = ws.app.mutation("draft.save", {
    documentId: microId,
    baseRevisionId: null,
    body: "## 小标题不允许\n" + "微".repeat(250),
  }).revisionId;
  assertThrowsContract(
    () => ws.app.mutation("article.rename", { documentId: microId, baseRevisionId: microRev, title: "强加标题" }),
    "gate.denied",
    { action: "article.rename", reason: "title-not-editable" },
  );
  const microQa = ws.app.mutation("article.qa", {
    documentId: microId,
    baseRevisionId: microRev,
    score: 90,
    passed: true,
    fails: [],
  });
  assert.ok(microQa.hardGates.includes("微头条不设小标题"));
  assert.ok(microQa.hardGates.some((g) => g.includes("300–1000")));
  assert.equal(ws.app.snapshot(projId, microId).active.state, "初稿待改");

  // article.plan: driver/opening/ending line checks + title matrix (>=5 unique <=34 code points, >=3 motifs)
  const shortId = ws.app.mutation("document.create", { projectId: projId, title: "原题", mode: "short", line: "故事线" }).id;
  // Rename pre-draft returns revisionId: null and keeps pre-draft state
  const preDraftRename = ws.app.mutation("article.rename", { documentId: shortId, baseRevisionId: null, title: "前改标题" });
  assert.deepEqual(preDraftRename, { revisionId: null });

  assertThrowsContract(
    () =>
      ws.app.mutation("article.plan", {
        documentId: shortId,
        driver: "账本型", // only in 资讯线, unavailable in 故事线
        opening: "定格画面",
        ending: "画面留白",
      }),
    "input.invalid",
    { field: "driver", reason: "driver-unavailable-in-line" },
  );
  assertThrowsContract(
    () =>
      ws.app.mutation("article.plan", {
        documentId: shortId,
        driver: "故事型",
        opening: "定格画面",
        ending: "画面留白",
        titles: "无竖线格式",
      }),
    "input.invalid",
    { field: "titles", reason: "expected-title-pipe-motif" },
  );
  assertThrowsContract(
    () =>
      ws.app.mutation("article.plan", {
        documentId: shortId,
        driver: "故事型",
        opening: "定格画面",
        ending: "画面留白",
        titles: [
          "标题一 | 母题甲",
          "标题一 | 母题甲", // duplicate
          "标题二 | 母题乙",
          "标题三 | 母题丙",
          `${"𠮷".repeat(TITLE_MAX + 1)} | 母题甲`, // exceeds 34 code points
        ].join("\n"),
      }),
    "input.invalid",
    { field: "titles", reason: "five-titles-three-motifs-required" },
  );

  const goodPlan = ws.app.mutation("article.plan", {
    documentId: shortId,
    driver: "故事型",
    opening: "定格画面",
    ending: "画面留白",
    titles: [
      `${"𠮷".repeat(33)}1 | 母题甲`,
      "标题二 | 母题乙",
      "标题三 | 母题丙",
      "标题四 | 母题甲",
      "标题五 | 母题乙",
    ].join("\n"),
  });
  assert.equal(goodPlan.titleMatrix.passed, true);
  assert.equal(goodPlan.titleMatrix.valid.length, 5);
  assert.equal(goodPlan.titleMatrix.motifCount, 3);

  // Rename after QA passes resets state to 初稿待改 on a new revisionId and clears current revision's report
  let rev = ws.app.mutation("draft.save", { documentId: shortId, baseRevisionId: null, body: "短".repeat(1200) }).revisionId;
  ws.app.mutation("article.qa", { documentId: shortId, baseRevisionId: rev, score: QA_PASS_SCORE, passed: true, fails: [] });
  assert.equal(ws.app.snapshot(projId, shortId).active.state, "待验收");

  // Over-length title rejected using Unicode code-point count
  assertThrowsContract(
    () => ws.app.mutation("article.rename", { documentId: shortId, baseRevisionId: rev, title: "𠮷".repeat(TITLE_MAX + 1) }),
    "input.invalid",
    { field: "title", reason: "title-limit" },
  );
  // Same title is a no-op returning current revisionId without changing state
  assert.deepEqual(
    ws.app.mutation("article.rename", { documentId: shortId, baseRevisionId: rev, title: "前改标题" }),
    { revisionId: rev },
  );
  assert.equal(ws.app.snapshot(projId, shortId).active.state, "待验收");

  const renamed = ws.app.mutation("article.rename", {
    documentId: shortId,
    baseRevisionId: rev,
    title: "𠮷".repeat(TITLE_MAX),
  });
  assert.notEqual(renamed.revisionId, rev);
  const afterRename = ws.app.snapshot(projId, shortId);
  assert.equal(afterRename.active.state, "初稿待改");
  assert.equal(afterRename.report, null);
});

test("Toutiao QA boundaries (83 vs 84), 2-round manual refine limit, rejection reports, approval, and delivery formatting", (t) => {
  const ws = createTestWorkspace(t, { allowExport: true });
  const article = ws.createToutiaoArticle({ mode: "micro", line: "资讯线", body: "微".repeat(400) + `\n\n${DELIVERY_ENDING}` });
  let rev = article.revisionId;

  // Score 83 (< 84) stays 初稿待改; score 84 with passed:false or hardGates stays 初稿待改; score 101 invalid
  assertThrowsContract(
    () => ws.app.mutation("article.qa", { documentId: article.documentId, baseRevisionId: rev, score: 101, passed: true, fails: [] }),
    "input.invalid",
    { field: "score", reason: "out-of-range" },
  );
  ws.app.mutation("article.qa", { documentId: article.documentId, baseRevisionId: rev, score: QA_PASS_SCORE - 1, passed: true, fails: [] });
  assert.equal(ws.app.snapshot(article.projectId, article.documentId).active.state, "初稿待改");
  ws.app.mutation("article.qa", { documentId: article.documentId, baseRevisionId: rev, score: QA_PASS_SCORE, passed: false, fails: [] });
  assert.equal(ws.app.snapshot(article.projectId, article.documentId).active.state, "初稿待改");
  ws.app.mutation("article.qa", { documentId: article.documentId, baseRevisionId: rev, score: QA_PASS_SCORE, passed: true, fails: [], hardGates: ["人为硬门"] });
  assert.equal(ws.app.snapshot(article.projectId, article.documentId).active.state, "初稿待改");

  // Manual refinement capped strictly at QA_REFINEMENT_LIMIT (2) rounds
  for (let i = 1; i <= QA_REFINEMENT_LIMIT; i++) {
    rev = ws.app.mutation("article.refine", {
      documentId: article.documentId,
      baseRevisionId: rev,
      body: "微".repeat(400 + i) + `\n\n${DELIVERY_ENDING}`,
    }).revisionId;
  }
  assert.equal(ws.app.snapshot(article.projectId, article.documentId).active.qaRounds, 2);
  assertThrowsContract(
    () => ws.app.mutation("article.refine", { documentId: article.documentId, baseRevisionId: rev, body: "微".repeat(410) }),
    "gate.denied",
    { action: "article.refine", reason: "qa-refinement-unavailable" },
  );

  // Pass QA at exact boundary 84 -> reject -> re-QA -> accept -> approve (idempotent) -> deliver without duplicate ending & no micro H1
  ws.app.mutation("article.qa", { documentId: article.documentId, baseRevisionId: rev, score: QA_PASS_SCORE, passed: true, fails: [] });
  assert.equal(ws.app.snapshot(article.projectId, article.documentId).active.state, "待验收");

  ws.app.mutation("article.accept", { documentId: article.documentId, baseRevisionId: rev, accept: false, reason: "补一条数据出处" });
  const rejectedSnap = ws.app.snapshot(article.projectId, article.documentId);
  assert.equal(rejectedSnap.active.state, "验收退回");
  assert.equal(rejectedSnap.report.reason, "补一条数据出处");

  ws.app.mutation("article.qa", { documentId: article.documentId, baseRevisionId: rev, score: 89, passed: true, fails: [] });
  ws.app.mutation("article.accept", { documentId: article.documentId, baseRevisionId: rev, accept: true });
  assertThrowsContract(
    () => ws.app.mutation("draft.save", { documentId: article.documentId, baseRevisionId: rev, body: "改锁定稿" }),
    "gate.denied",
    { action: "draft.save", reason: "revision-locked" },
  );

  assertThrowsContract(
    () => ws.app.mutation("approval.decide", { documentId: article.documentId, baseRevisionId: rev, confirmed: false }),
    "gate.denied",
    { action: "approval.decide", reason: "explicit-confirmation-required" },
  );
  assert.deepEqual(
    ws.app.mutation("approval.decide", { documentId: article.documentId, baseRevisionId: rev, confirmed: true }),
    { approved: true },
  );
  assert.deepEqual(
    ws.app.mutation("approval.decide", { documentId: article.documentId, baseRevisionId: rev, confirmed: true }),
    { approved: true },
  );
  assertThrowsContract(
    () => ws.app.mutation("article.deliver", { documentId: article.documentId, baseRevisionId: rev }),
    "input.invalid",
    { field: "idempotencyKey" },
  );

  const delivered = ws.app.mutation("article.deliver", { documentId: article.documentId, baseRevisionId: rev, key: "micro-deliv" });
  assert.equal(delivered.state, "exported");
  assert.equal(ws.writes[0].data.startsWith("# "), false);
  // Fixed delivery ending appears exactly once even though the saved draft ended with it too.
  assert.equal(ws.writes[0].data.split(DELIVERY_ENDING).length - 1, 1);
  assert.ok(ws.writes[0].data.endsWith(`${DELIVERY_ENDING}\n`));
});

test("shared run service validates preview, start budget, document ownership, reconcile, and refinement guards", (t) => {
  const ws = createTestWorkspace(t);
  const fanqie = ws.createFanqieChapter({ body: "第一章原稿。" });
  const ch2 = ws.app.mutation("document.create", { projectId: fanqie.projectId, title: "第二章" }).id;

  const preview = ws.app.mutation("run.preview", {
    documentId: fanqie.documentId,
    baseRevisionId: fanqie.revisionId,
    instruction: "扩写这一段",
  });
  assert.ok(preview.inputReserve > 128);
  assert.ok(preview.recommended >= 8000);

  assertThrowsContract(
    () => ws.app.mutation("run.start", { documentId: fanqie.documentId, baseRevisionId: fanqie.revisionId, instruction: "写", tokenLimit: 0 }),
    "input.invalid",
    { field: "tokenLimit", reason: "positive-budget-required" },
  );

  const runId = ws.app.mutation("run.start", {
    documentId: fanqie.documentId,
    baseRevisionId: fanqie.revisionId,
    instruction: "写",
    tokenLimit: 8000,
  }).id;

  assertThrowsContract(
    () => ws.app.mutation("run.detail", { documentId: ch2, runId }),
    "input.invalid",
    { field: "runId", reason: "document-mismatch" },
  );
  assertThrowsContract(
    () => ws.app.mutation("run.reconcile", { documentId: fanqie.documentId, runId, attemptId: "non-existent", tokens: 10 }),
    "gate.denied",
    { action: "run.reconcile", reason: "no-uncertain-attempt" },
  );
  assertThrowsContract(
    () => ws.app.reserveRefinement(runId),
    "gate.denied",
    { action: "run.generate", reason: "refinement-unsupported" },
  );
});
