import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  anchor,
  pointAtOffset,
  resolveAnchor,
  splitChapterParagraphs,
} from "../src/domain/shared/anchors.ts";
import * as sharedDomain from "../src/domain/shared/index.ts";
import {
  AI_SLOP_CATEGORY_WEIGHTS,
  CHAPTER_LENGTH_WARNING_BAND,
  CHAPTER_STATES,
  CHAPTER_TRANSITIONS,
  DEFAULT_CHAPTER_LENGTH,
  EDITORIAL_REJECTION_LIMIT,
  FORESHADOW_STATUSES,
  FORESHADOW_TRANSITIONS,
  TECHNIQUE_CATEGORIES,
  assertChapterFinalizable,
  assertChapterTransition,
  assertForeshadowTransition,
  countEntityMentionsWithAliases,
  detectLoreConflicts,
  diagnoseChapterOffline,
  diagnoseGoldenThree,
  flattenNovelOrder,
  isTechniqueCategory,
  mergeFactVersion,
  normalizeTechniqueCategory,
  rankRelatedChapters,
  rankTechniquesForChapter,
  revokeKnownCharacter,
  scanAiSlop,
  settingsAt,
  validateTechniqueCategory,
} from "../src/domain/fanqie/index.ts";
import {
  ARTICLE_TRANSITIONS,
  DELIVERY_ENDING,
  QA_PASS_SCORE,
  QA_REFINEMENT_LIMIT,
  TITLE_MAX,
} from "../src/domain/toutiao/index.ts";

test("FQ-02: splitChapterParagraphs, pointAtOffset, and resolveAnchor share one non-empty paragraph source of truth", () => {
  // Smoke surface invariant: shared/index.ts keeps its exact 5 frozen runtime keys.
  assert.deepEqual(Object.keys(sharedDomain).sort(), [
    "anchor",
    "isEffective",
    "orderIndex",
    "precedes",
    "resolveAnchor",
  ]);

  // Empty and whitespace-only inputs
  assert.deepEqual(splitChapterParagraphs(""), []);
  assert.deepEqual(splitChapterParagraphs("   \r\n\t\n\u3000\r"), []);
  assert.equal(pointAtOffset("", 0), 1);
  assert.equal(pointAtOffset("\n\n   \r\n", 4), 1);

  // Mixed CRLF/LF/CR, blank lines, leading indentation, astral Unicode glyphs
  const body = "\r\n　　第一段：林砚推开门。\r\n\r\n   \n第二段🔥：桌上放着五味杂陈的匿名信。\r\n\r\n第三段：门外传来脚步声。";
  const spans = splitChapterParagraphs(body);
  assert.equal(spans.length, 3);
  assert.deepEqual(
    spans.map((s) => s.index),
    [1, 2, 3],
  );
  for (const span of spans) {
    assert.equal(body.slice(span.start, span.end), span.text);
    assert.ok(span.text.trim().length > 0);
    assert.equal(pointAtOffset(body, span.start), span.index);
    assert.equal(pointAtOffset(body, span.end), span.index);
  }

  // Clamping & monotonicity property across every UTF-16 offset
  assert.equal(pointAtOffset(body, -10), 1);
  assert.equal(pointAtOffset(body, Number.NaN), 1);
  assert.equal(pointAtOffset(body, body.length + 100), 3);
  let prevPoint = 1;
  for (let offset = 0; offset <= body.length; offset += 1) {
    const pt = pointAtOffset(body, offset);
    assert.ok(pt >= 1 && pt <= 3);
    assert.ok(pt >= prevPoint, `pointAtOffset must be monotonic at offset ${offset}: ${pt} < ${prevPoint}`);
    prevPoint = pt;
  }

  // Exact quote offset consistency across blank lines
  const quote = "匿名信";
  const quoteStart = body.indexOf(quote);
  assert.equal(pointAtOffset(body, quoteStart), 2);

  // resolveAnchor agrees on both raw body string and paragraphs array with empty lines
  const fromBody = resolveAnchor(anchor("ch1", 2), body);
  assert.deepEqual(fromBody, {
    paragraphIndex: 1,
    start: spans[1].start,
    text: spans[1].text,
  });
  assert.equal(pointAtOffset(body, fromBody.start), 2);

  const fromArray = resolveAnchor(anchor("ch1", 2), { paragraphs: ["第一段", "", "   ", "第二段"] });
  assert.deepEqual(fromArray, {
    paragraphIndex: 1,
    start: 9,
    text: "第二段",
  });

  // Cross-module consistency: scanAiSlop & diagnoseGoldenThree use exact same non-empty paragraph index & UTF-16 offsets
  const slop = scanAiSlop(body);
  const hit = slop.hits.find((h) => h.phrase === "五味杂陈");
  assert.ok(hit);
  assert.equal(hit.paragraphIndex, 2);
  assert.equal(body.slice(hit.start, hit.end), "五味杂陈");
  assert.equal(pointAtOffset(body, hit.start), hit.paragraphIndex);

  const longWallBody = ["第一段简短开场。", "", "", "第三行其实是第二段：" + "长".repeat(180)].join("\r\n");
  const g3 = diagnoseGoldenThree(longWallBody, { chapterIndex: 0 });
  const rhythm = g3.dimensions.find((d) => d.id === "paragraphRhythm");
  assert.ok(rhythm);
  assert.deepEqual(rhythm.problemParagraphs, [2]);
});

test("FQ-01 & Res#13 & FQ-20: mergeFactVersion preserves earlier knownFrom, effectiveFrom/To, aliases, and supports explicit revocation", () => {
  const order = ["ch1", "ch2", "ch3", "ch4", "ch5", "ch10", "ch15"];
  const v1 = {
    id: "secret-key",
    note: "铜钥匙藏在书房夹层",
    source: "第三章",
    kind: "fact",
    locked: false,
    effectiveFrom: anchor("ch3", 2),
    knownFrom: { 林: anchor("ch3", 2) },
    aliases: ["铜钥", "书房钥匙"],
  };

  // Regression: ch3 林 knows -> ch10 update mentions 林 at ch10 and adds 苏 at ch10
  const incomingCh10 = {
    id: "secret-key",
    note: "铜钥匙可开启地窖暗门",
    source: "第十章同步",
    kind: "fact",
    locked: false,
    effectiveFrom: anchor("ch10", 1),
    knownFrom: { 林: anchor("ch10", 3), 苏: anchor("ch10", 1) },
    aliases: ["地窖钥匙", "铜钥"],
  };
  const v2 = mergeFactVersion(v1, incomingCh10, order);

  assert.deepEqual(v2.effectiveFrom, anchor("ch3", 2), "effectiveFrom must default to prev.effectiveFrom");
  assert.deepEqual(v2.knownFrom["林"], anchor("ch3", 2), "林's earlier knowledge anchor must NEVER be pushed later");
  assert.deepEqual(v2.knownFrom["苏"], anchor("ch10", 1), "new character 苏 gains ch10 anchor");
  assert.deepEqual(v2.aliases, ["铜钥", "书房钥匙", "地窖钥匙"]);
  assert.equal(v2.note, "铜钥匙可开启地窖暗门");

  // settingsAt(ch5, 林) STILL sees the fact while settingsAt(ch5, 苏) does NOT!
  const linAtCh5 = settingsAt([v1, v2], order, anchor("ch5", 1), "林");
  assert.equal(linAtCh5.length, 1);
  assert.equal(linAtCh5[0].note, "铜钥匙可开启地窖暗门");
  const suAtCh5 = settingsAt([v1, v2], order, anchor("ch5", 1), "苏");
  assert.equal(suAtCh5.length, 0);

  // Incoming omitting 林 still preserves 林's knowledge and earlier incoming anchor moves earlier
  const v3 = mergeFactVersion(
    v2,
    {
      ...v2,
      note: "",
      knownFrom: { 苏: anchor("ch4", 1) },
      aliases: undefined,
    },
    order,
  );
  assert.deepEqual(v3.knownFrom["林"], anchor("ch3", 2));
  assert.deepEqual(v3.knownFrom["苏"], anchor("ch4", 1), "earlier incoming anchor replaces later anchor");
  assert.deepEqual(v3.aliases, ["铜钥", "书房钥匙", "地窖钥匙"]);
  assert.equal(v3.note, "铜钥匙可开启地窖暗门");

  // overrideEffectiveFrom & FQ-20 effectiveTo retirement
  const retired = mergeFactVersion(
    v3,
    { ...v3, effectiveFrom: anchor("ch4", 1), effectiveTo: anchor("ch10", 5), knownFrom: {} },
    order,
    { overrideEffectiveFrom: true },
  );
  assert.deepEqual(retired.effectiveFrom, anchor("ch4", 1));
  assert.deepEqual(retired.effectiveTo, anchor("ch10", 5));
  assert.equal(settingsAt([retired], order, anchor("ch10", 5), "林").length, 0, "half-open effectiveTo excludes endpoint");

  // Subsequent merge without effectiveTo preserves retirement unless clearEffectiveTo: true
  const preservedRetirement = mergeFactVersion(retired, { ...v3, effectiveTo: undefined }, order);
  assert.deepEqual(preservedRetirement.effectiveTo, anchor("ch10", 5));
  const unretired = mergeFactVersion(retired, { ...v3, effectiveTo: undefined }, order, { clearEffectiveTo: true });
  assert.equal(unretired.effectiveTo, undefined);

  // Explicit amnesia / knowledge revocation (Res#13)
  const revoked = revokeKnownCharacter(v2, "林");
  assert.equal(Object.hasOwn(revoked.knownFrom, "林"), false);
  assert.deepEqual(revoked.knownFrom["苏"], anchor("ch10", 1));
  assert.deepEqual(v2.knownFrom["林"], anchor("ch3", 2), "revokeKnownCharacter must be immutable");
  assert.throws(
    () => revokeKnownCharacter(v2, "   "),
    (err) => err.code === "input.invalid" && err.details.field === "character",
  );

  // Re-learning after explicit revocation sets the new later anchor cleanly
  const relearned = mergeFactVersion(
    revoked,
    { ...revoked, knownFrom: { 林: anchor("ch15", 1) } },
    order,
  );
  assert.deepEqual(relearned.knownFrom["林"], anchor("ch15", 1));

  // Res#13: known-before-effective severity downgraded from error to warning
  const conflicts = detectLoreConflicts(
    [
      {
        id: "prophecy",
        note: "预言将在第十章应验",
        source: "设定",
        kind: "fact",
        locked: false,
        effectiveFrom: anchor("ch10", 1),
        knownFrom: { 林: anchor("ch2", 1) },
      },
    ],
    [],
    order,
    [],
  );
  const kbe = conflicts.find((c) => c.kind === "known-before-effective");
  assert.ok(kbe);
  assert.equal(kbe.severity, "warning");
});

test("FQ-08: FORESHADOW_TRANSITIONS and assertForeshadowTransition enforce the complete 5x5 lifecycle matrix", () => {
  const expectedNormal = {
    proposed: new Set(["planted", "abandoned"]),
    planted: new Set(["hinted", "resolved", "abandoned"]),
    hinted: new Set(["hinted", "resolved", "abandoned"]),
    resolved: new Set([]),
    abandoned: new Set([]),
  };

  for (const from of FORESHADOW_STATUSES) {
    assert.deepEqual(new Set(FORESHADOW_TRANSITIONS[from]), expectedNormal[from]);
    for (const to of FORESHADOW_STATUSES) {
      const allowedNormal = expectedNormal[from].has(to);
      if (allowedNormal) {
        assert.doesNotThrow(() => assertForeshadowTransition(from, to));
      } else {
        assert.throws(
          () => assertForeshadowTransition(from, to),
          (err) => err.code === "gate.denied" && err.details.action === "foreshadow.transition",
          `Expected ${from} -> ${to} without reopen to be denied`,
        );
      }

      const allowedWithReopen = allowedNormal || ((from === "resolved" || from === "abandoned") && to === "planted");
      if (allowedWithReopen) {
        assert.doesNotThrow(() => assertForeshadowTransition(from, to, { reopen: true }));
      } else {
        assert.throws(
          () => assertForeshadowTransition(from, to, { reopen: true }),
          (err) => err.code === "gate.denied",
          `Expected ${from} -> ${to} with reopen:true to be denied`,
        );
      }
    }
  }

  // Specific reason check for reopen-required
  assert.throws(
    () => assertForeshadowTransition("resolved", "planted"),
    (err) => err.code === "gate.denied" && err.details.reason === "reopen-required",
  );
  assert.throws(
    () => assertForeshadowTransition("abandoned", "planted"),
    (err) => err.code === "gate.denied" && err.details.reason === "reopen-required",
  );
  assert.throws(
    () => assertForeshadowTransition("unknown", "planted"),
    (err) => err.code === "input.invalid",
  );
});

test("FQ-25 & Res#1: CHAPTER_TRANSITIONS locks docs/02 verbatim across all 5x5 pairs and protected rules stay unchanged", () => {
  // Exact verbatim transition graph from docs/02-domain-rules.md lines 15-26
  const expected = {
    planned: new Set(["drafting"]),
    drafting: new Set(["drafting", "drafted", "reviewed"]),
    drafted: new Set(["drafted", "reviewed"]),
    reviewed: new Set(["drafted", "final"]),
    final: new Set([]),
  };

  assert.deepEqual(Object.keys(CHAPTER_TRANSITIONS), [...CHAPTER_STATES]);
  for (const from of CHAPTER_STATES) {
    assert.deepEqual(new Set(CHAPTER_TRANSITIONS[from]), expected[from]);
    for (const to of CHAPTER_STATES) {
      if (expected[from].has(to)) {
        assert.doesNotThrow(() => assertChapterTransition(from, to), `Expected ${from} -> ${to} allowed`);
      } else {
        assert.throws(
          () => assertChapterTransition(from, to),
          (err) => err.code === "gate.denied" && err.details.action === "chapter.transition",
          `Expected ${from} -> ${to} denied`,
        );
      }
    }
  }

  assert.throws(
    () => assertChapterTransition("bogus", "drafting"),
    (err) => err.code === "input.invalid" && err.details.reason === "unknown-chapter-state",
  );
  assert.throws(
    () => assertChapterTransition("planned", "bogus"),
    (err) => err.code === "input.invalid" && err.details.reason === "unknown-chapter-state",
  );

  // Guard all author-protected business semantics remain untouched
  assert.deepEqual(CHAPTER_STATES, ["planned", "drafting", "drafted", "reviewed", "final"]);
  assert.equal(EDITORIAL_REJECTION_LIMIT, 2);
  assert.deepEqual(DEFAULT_CHAPTER_LENGTH, [2000, 2500]);
  assert.deepEqual(CHAPTER_LENGTH_WARNING_BAND, [1500, 6000]);
  assert.doesNotThrow(() => assertChapterFinalizable("reviewed", 2));
  assert.throws(() => assertChapterFinalizable("reviewed", 3), { code: "gate.denied" });
  assert.equal(TITLE_MAX, 34);
  assert.equal(QA_PASS_SCORE, 84);
  assert.equal(QA_REFINEMENT_LIMIT, 2);
  assert.equal(DELIVERY_ENDING, "——AI 到此止步。是否采用、何时发布由你决定。");
  assert.deepEqual(Object.keys(ARTICLE_TRANSITIONS), ["初稿待改", "待验收", "已验收", "验收退回", "已交稿"]);
});

test("FE-32 & Res#20: technique category validation includes atmosphere and rankTechniquesForChapter honors genreTags", () => {
  assert.ok(TECHNIQUE_CATEGORIES.includes("atmosphere"));
  assert.equal(isTechniqueCategory("atmosphere"), true);
  assert.equal(isTechniqueCategory(" Atmosphere "), true);
  assert.equal(isTechniqueCategory("made_up"), false);

  assert.equal(validateTechniqueCategory("atmosphere"), "atmosphere");
  assert.equal(validateTechniqueCategory("  DIALOGUE "), "dialogue");
  assert.equal(validateTechniqueCategory(undefined), "narrative");
  assert.equal(validateTechniqueCategory(""), "narrative");
  assert.throws(
    () => validateTechniqueCategory(123),
    (err) => err.code === "input.invalid" && err.details.reason === "string-required",
  );
  assert.throws(
    () => validateTechniqueCategory("not-a-category"),
    (err) => err.code === "input.invalid" && err.details.reason === "unknown-technique-category",
  );
  assert.equal(normalizeTechniqueCategory("not-a-category"), "narrative");
  assert.equal(normalizeTechniqueCategory("atmosphere"), "atmosphere");

  const ranked = rankTechniquesForChapter({
    cards: [
      {
        id: "c-mystery",
        scope: "global",
        overrideOfId: null,
        title: "密室氛围营造",
        category: "atmosphere",
        pacing: "慢燃",
        sceneTags: ["悬疑", "密室"],
        triggerWhen: "",
        executionSteps: "细节压迫",
        constraints: "",
        antiPatterns: "",
        priority: 50,
        status: "approved",
      },
      {
        id: "c-plain",
        scope: "global",
        overrideOfId: null,
        title: "普通白描",
        category: "narrative",
        pacing: "慢燃",
        sceneTags: ["日常"],
        triggerWhen: "",
        executionSteps: "白描",
        constraints: "",
        antiPatterns: "",
        priority: 50,
        status: "approved",
      },
    ],
    mounts: [],
    contextIds: { projectId: "p1", volumeId: null, actId: null, chapterId: "ch1" },
    pacing: "慢燃",
    genreTags: ["悬疑"],
    chapterIndex: 0,
  });
  assert.equal(ranked[0].card.id, "c-mystery");
  assert.ok(ranked[0].score > ranked[1].score);
});

test("FQ-15 & FQ-14: Golden-3 diagnostics enforce target±25%, multi-char pacing/genre tables, full quotes, deduplicated long walls, and ch4+ slim output", () => {
  // 1. No single-char false positives ("死板", "却说", "滚烫")
  const flatNoConflict = "这位先生性格非常死板，平日里却说不出半句重话，只是捧着一杯滚烫的清茶看着窗外的云朵缓缓飘过。";
  const flatReport = diagnoseGoldenThree(flatNoConflict, { chapterIndex: 0, pacingTier: "快爽" });
  assert.equal(flatReport.dimensions.find((d) => d.id === "openingHook").score, 48);
  assert.equal(flatReport.dimensions.find((d) => d.id === "earlyConflict").score, 45);

  // 2. Suspense pacingTier + genreTags scores high on suspense opening with 『』 quotes
  const suspenseOpening = [
    "『门锁是从里面反锁的，可尸体不见了！』",
    "林砚盯着监控画面里的异常黑影，冷声指出证词中的疑点与撒谎破绽。",
  ].join("\n\n");
  const suspenseReport = diagnoseGoldenThree(suspenseOpening, {
    chapterIndex: 0,
    pacingTier: "慢燃",
    genreTags: ["悬疑"],
  });
  assert.ok(suspenseReport.dimensions.find((d) => d.id === "openingHook").score >= 95);
  assert.ok(suspenseReport.dimensions.find((d) => d.id === "earlyConflict").score >= 85);
  assert.equal(suspenseReport.dimensions.find((d) => d.id === "dialogueRatio").status, "pass");

  // 3. Full quote recognition: 『』 and ‘’ count cleanly as dialogue
  const singleQuoteBody = "‘别回头，往前跑。’\n『前面没有路了。』\n林砚拉住她的手冲进巷口。";
  const singleQuoteDiag = diagnoseGoldenThree(singleQuoteBody, { chapterIndex: 0 });
  assert.equal(singleQuoteDiag.dimensions.find((d) => d.id === "dialogueRatio").status, "pass");

  // 4. Deduplicated long-paragraph penalty: 280-char exposition wall is flagged ONLY in infoDump, NOT paragraphRhythm
  const expositionWall = "世界分为九大境界，自古宗门体系森严，法则与秩序早已写进历史传闻。" + "修真规矩森严无比。".repeat(30);
  const actionWall = "“快撤！”林砚挥剑挡开飞矢，沿着屋檐急奔三丈，踩碎青瓦跃入窄巷，" + "身形接连闪转腾挪避开暗箭追击。".repeat(12);
  const dedupBody = ["开场一句。", "", expositionWall, "", actionWall].join("\n");
  const dedupDiag = diagnoseGoldenThree(dedupBody, { chapterIndex: 0 });
  const infoDim = dedupDiag.dimensions.find((d) => d.id === "infoDump");
  const rhythmDim = dedupDiag.dimensions.find((d) => d.id === "paragraphRhythm");
  assert.deepEqual(infoDim.problemParagraphs, [2]);
  assert.deepEqual(rhythmDim.problemParagraphs, [3], "paragraph 2 already penalized in infoDump must not be double-counted in paragraphRhythm");

  // 5. Target word-count band centers on targetLength ± 25%
  const body3600 = "正".repeat(3600);
  const body2100 = "正".repeat(2100);
  const onTarget = diagnoseGoldenThree(body3600, { chapterIndex: 0, targetLength: 4000 });
  assert.equal(onTarget.dimensions.find((d) => d.id === "wordCountBand").score, 95);
  assert.equal(onTarget.dimensions.find((d) => d.id === "wordCountBand").status, "pass");

  const underTarget = diagnoseGoldenThree(body2100, { chapterIndex: 0, targetLength: 4000 });
  assert.equal(underTarget.dimensions.find((d) => d.id === "wordCountBand").status, "warn");

  // Without explicit targetLength: 2000-2500 recommended gets top score 95
  const defaultBand = diagnoseGoldenThree(body2100, { chapterIndex: 0 });
  assert.equal(defaultBand.dimensions.find((d) => d.id === "wordCountBand").score, 95);

  // 6. Non-golden chapter (chapterIndex >= 3) outputs ONLY paragraphRhythm & wordCountBand
  const ch4Report = diagnoseGoldenThree("平缓的第四章过渡段。", { chapterIndex: 3, targetLength: 2000 });
  assert.equal(ch4Report.isGoldenThreeChapter, false);
  assert.deepEqual(
    ch4Report.dimensions.map((d) => d.id),
    ["paragraphRhythm", "wordCountBand"],
  );
  assert.equal(ch4Report.warnings.some((w) => w.includes("开场钩子") || w.includes("前300字")), false);
});

test("FQ-16: scanAiSlop performs non-overlapping longest match, category weighting, dialogue exclusion, and rhythm CV/monotone detection", () => {
  assert.equal(AI_SLOP_CATEGORY_WEIGHTS.summary_connector, 0.5);
  assert.equal(AI_SLOP_CATEGORY_WEIGHTS.cliche_emotion, 1.0);
  assert.equal(AI_SLOP_CATEGORY_WEIGHTS.cliche_action, 1.0);
  assert.equal(AI_SLOP_CATEGORY_WEIGHTS.custom, 1.0);

  // 1. Overlapping phrases never double-count
  const overlapText = "那一刻，仿佛命运的齿轮开始转动，他眼中闪过一丝不易察觉的冷意。";
  const overlapReport = scanAiSlop(overlapText);
  assert.deepEqual(
    overlapReport.hits.map((h) => h.phrase),
    ["仿佛命运的齿轮开始转动", "一丝不易察觉的"],
  );
  assert.equal(overlapReport.totalHits, 2);

  // 2. Category weighting: 2 summary_connectors = 1.0 weighted hit vs 2 cliche_emotion = 2.0 weighted hits
  const connectorOnly = "事实上，这件事没有那么简单。与此同时，街角驶过一辆黑车。" + "普通叙述内容。".repeat(140);
  const connectorReport = scanAiSlop(connectorOnly);
  assert.equal(connectorReport.totalHits, 2);
  assert.equal(connectorReport.weightedHits, 1);
  assert.ok(connectorReport.weightedDensityPer1000Chars <= 1.05);
  assert.equal(connectorReport.severity, "clean");

  // 3. excludeDialogue skips hits inside quotes while still catching narration hits on the same line
  const mixedDialogue = "林冷哼道：“总而言之，我五味杂陈。”『命运的齿轮在转。』他深吸了一口气。";
  const withDialogue = scanAiSlop(mixedDialogue, { excludeDialogue: false });
  assert.equal(withDialogue.totalHits, 4);
  const withoutDialogue = scanAiSlop(mixedDialogue, { excludeDialogue: true });
  assert.deepEqual(
    withoutDialogue.hits.map((h) => h.phrase),
    ["深吸了一口气"],
  );

  // 4. Sentence length CV & monotoneRuns distinguish robotic uniform prose from varied prose
  const monotoneProse = [
    "林砚推开沉重的木门走进漆黑的走廊里面。",
    "墙角那盏老旧的煤油灯发出了微弱的光芒。",
    "潮湿的空气带着一股陈年木头腐朽的味道。",
    "他放轻脚步沿着楼梯缓缓向着二楼走上去。",
    "栏杆上的灰尘在手电筒光束下面清晰可见。",
    "尽头那间书房的门缝底下透出一缕细微光线。",
    "他屏住呼吸伸出右手轻轻按在了冰凉门把上。",
    "屋子里面隐约传来一阵翻动纸张的细碎响声。",
  ].join("\n");
  const monoReport = scanAiSlop(monotoneProse);
  assert.ok(monoReport.sentenceLengthCV < 0.2, `Expected low CV for monotone prose, got ${monoReport.sentenceLengthCV}`);
  assert.ok(monoReport.monotoneRuns >= 1);
  assert.equal(monoReport.rhythmMonotone, true);

  const variedProse = [
    "门开了。",
    "一阵夹杂着铁锈和雨水的冷风瞬间灌进狭窄的门厅，把墙上那张发黄的值班表吹得哗啦作响。",
    "“谁？”",
    "没人回答。",
    "林砚把铜钥匙塞回外套内袋，反手反锁铁门，踩着积水一步步靠近楼梯拐角那道半掩的暗门。",
    "吱呀。",
    "楼上传来椅子拖动的声响，紧接着归于沉寂，连窗外的雨点声都显得格外刺耳。",
    "他拔出手电。",
  ].join("\n");
  const variedReport = scanAiSlop(variedProse);
  assert.ok(variedReport.sentenceLengthCV > 0.4, `Expected high CV for varied prose, got ${variedReport.sentenceLengthCV}`);
  assert.equal(variedReport.monotoneRuns, 0);
  assert.equal(variedReport.rhythmMonotone, false);

  // 5. Three clean human prose baselines (1000+ chars each) stay <= 1.0 weighted hits / 1000 chars
  const humanBaselines = [
    // Suspense baseline
    ("雨点砸在铁皮雨棚上，噼啪乱响。林砚蹲在档案柜前，借着手机微光翻找三年前的值班日志。".repeat(12) +
      "“钥匙不在抽屉里。”老周把沾满泥点的雨伞靠在门框边，拧干袖口的水。\n" +
      "事实上，借阅登记本的最后一页被人整齐撕掉了。林砚摸了摸装订线残留的毛边，起身走向楼梯间。\n" +
      "走廊尽头的小窗半开着，窗台上有半枚模糊的胶鞋印，鞋纹很新。".repeat(14)),
    // Urban / slice-of-life baseline
    ("清晨六点半，菜市场的铁卷门陆续拉起，鱼摊老板拎着红桶往水泥地上泼水。".repeat(12) +
      "陈明把三轮车停在巷口电线杆旁，从保温箱里取出两笼刚蒸好的鲜肉包。\n" +
      "与此同时，对面早餐铺的阿姨已经支好了油锅，热油滋滋作响，面团丢进去立刻鼓起金黄的泡。\n" +
      "“今天多拿两笼？”熟客扫码付款，顺手接过豆浆，笑着往公交站小跑过去。".repeat(14)),
    // Fantasy baseline
    ("山风卷着松针掠过青石台阶，演武场四周的铁灯笼在暮色里摇晃不止。".repeat(12) +
      "顾沉收剑归鞘，指腹擦过剑脊上那道浅浅的豁口，抬头望向藏书阁飞檐上的铜铃。\n" +
      "“外门大比改在三日后。”执事弟子把木牌按在石桌上，声音干脆利落。\n" +
      "他没有多问，转身沿着石阶下山，袖中那枚温热的玉简微微发烫。".repeat(14)),
  ];
  for (const [idx, sample] of humanBaselines.entries()) {
    const rep = diagnoseChapterOffline(`human-${idx}`, sample, { chapterIndex: 4 });
    assert.ok(rep.aiSlop.charCount >= 800);
    assert.ok(
      rep.aiSlop.weightedDensityPer1000Chars <= 1.0,
      `Baseline #${idx} false positive density too high: ${rep.aiSlop.weightedDensityPer1000Chars}`,
    );
    assert.equal(rep.aiSlop.severity, "clean");
  }
});

test("FQ-21: detectLoreConflicts supports configurable staleGap, referenceChapterIndex, and targetChapterId overdue", () => {
  const order = Array.from({ length: 40 }, (_, i) => `ch-${i + 1}`);
  const foreshadows = [
    {
      id: "fs-gap",
      factId: null,
      title: "失踪的玉佩",
      plantedChapterId: "ch-2",
      plantedPoint: 1,
      targetChapterId: null,
      resolvedChapterId: null,
      status: "planted",
    },
    {
      id: "fs-target",
      factId: null,
      title: "拍卖会暗线",
      plantedChapterId: "ch-3",
      plantedPoint: 1,
      targetChapterId: "ch-10",
      resolvedChapterId: null,
      status: "hinted",
    },
    {
      id: "fs-flipped-target",
      factId: null,
      title: "倒置预定章",
      plantedChapterId: "ch-8",
      plantedPoint: 1,
      targetChapterId: "ch-4",
      resolvedChapterId: null,
      status: "planted",
    },
  ];

  // Writing frontier at ch-10 (index 9): fs-gap span=8 (< 20), fs-target not yet past ch-10 -> ONLY fs-flipped-target flips!
  const atCh10 = detectLoreConflicts([], foreshadows, order, [], { referenceChapterIndex: 9 });
  assert.equal(atCh10.some((c) => c.targetId === "fs-gap"), false);
  assert.equal(atCh10.some((c) => c.targetId === "fs-target"), false);
  assert.ok(atCh10.some((c) => c.targetId === "fs-flipped-target" && c.kind === "foreshadow-order-flip" && c.severity === "error"));

  // Frontier moves to ch-11 (referenceChapterId: "ch-11"): fs-target is now overdue by 1 chapter!
  const atCh11 = detectLoreConflicts([], foreshadows, order, [], { referenceChapterId: "ch-11" });
  assert.ok(atCh11.some((c) => c.targetId === "fs-target" && c.kind === "stale-foreshadow"));
  assert.equal(atCh11.some((c) => c.targetId === "fs-gap"), false);

  // Configurable staleGap = 9 at ch-11 (span = 10 - 1 = 9 >= 9) flags fs-gap!
  const customGap = detectLoreConflicts([], foreshadows, order, [], { referenceChapterId: "ch-11", staleGap: 9 });
  assert.ok(customGap.some((c) => c.targetId === "fs-gap" && c.kind === "stale-foreshadow"));

  // Default staleGap = 20: at ch-21 (idx 20, span 19) clean; at ch-22 (idx 21, span 20) stale!
  const atSpan19 = detectLoreConflicts([], [foreshadows[0]], order, [], { referenceChapterIndex: 20 });
  assert.equal(atSpan19.length, 0);
  const atSpan20 = detectLoreConflicts([], [foreshadows[0]], order, [], { referenceChapterIndex: 21 });
  assert.equal(atSpan20.length, 1);
  assert.equal(atSpan20[0].kind, "stale-foreshadow");
});

test("FQ-19: countEntityMentionsWithAliases uses non-overlapping longest match and prevents substring false matches", () => {
  const entities = [
    { factId: "f-li4", entityName: "李四", aliases: ["老李", "李兄"], category: "character" },
    { factId: "f-li4hai", entityName: "李四海", aliases: ["四海爷"], category: "character" },
    { factId: "f-lin", entityName: "林远", aliases: ["师父"], category: "character" },
    { factId: "f-linshan", entityName: "林远山", aliases: [], category: "character" },
    { factId: "f-code", entityName: "Lin", aliases: ["L-01"], category: "character" },
  ];

  const body = "李四海与林远山坐在堂前，四海爷端起茶盏问李四：“老李，你师父林远去了何处？”Lincoln 留下纸条：Lin 与 L-01 汇合。";
  const counts = countEntityMentionsWithAliases(body, entities);
  const byId = new Map(counts.map((c) => [c.factId, c]));

  // 李四海 claimed [0..3) so 李四 is NOT double-counted there; 李四 only matched once + 老李 once = 2
  assert.equal(byId.get("f-li4hai")?.count, 2);
  assert.deepEqual(byId.get("f-li4hai")?.matchedTerms, { 李四海: 1, 四海爷: 1 });
  assert.equal(byId.get("f-li4")?.count, 2);
  assert.deepEqual(byId.get("f-li4")?.matchedTerms, { 李四: 1, 老李: 1 });

  // 林远山 claimed its span so 林远 only counts explicit 林远 (1) + 师父 (1) = 2
  assert.equal(byId.get("f-linshan")?.count, 1);
  assert.equal(byId.get("f-lin")?.count, 2);
  assert.deepEqual(byId.get("f-lin")?.matchedTerms, { 林远: 1, 师父: 1 });

  // ASCII word boundary: "Lin" matches standalone "Lin" + "L-01", NOT inside "Lincoln"
  assert.equal(byId.get("f-code")?.count, 2);
  assert.deepEqual(byId.get("f-code")?.matchedTerms, { Lin: 1, "L-01": 1 });

  // When only 林远山 appears, 林远 gets 0 and is omitted
  const onlyLong = countEntityMentionsWithAliases("林远山独自下山。", entities);
  assert.deepEqual(
    onlyLong.map((r) => r.factId),
    ["f-linshan"],
  );

  // Alias-aware outline recall in rankRelatedChapters
  const order = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
  const recalled = rankRelatedChapters({
    currentChapterId: "c8",
    chapterOrder: order,
    chapters: order.map((id) => ({ chapterId: id, title: id, summary: "" })),
    foreshadows: [],
    facts: [],
    entityMentions: [{ documentId: "c1", entityName: "林远", mentionCount: 3 }],
    currentOutlineText: "本章师父再度现身指点迷津。",
    entityAliases: { 林远: ["师父"] },
  });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].chapterId, "c1");
});

test("FQ-18: O(N) performance on 5,000 chapters and 3,000 facts stays well within interactive budgets", () => {
  const chapterCount = 5000;
  const factCount = 3000;
  const order = Array.from({ length: chapterCount }, (_, i) => `ch-${i + 1}`);
  const chapters = order.map((id, i) => ({ chapterId: id, title: `第${i + 1}章`, summary: `摘要${i + 1}` }));

  const facts = Array.from({ length: factCount }, (_, i) => ({
    id: `fact-${i + 1}`,
    note: `设定说明-${i + 1}`,
    source: "设定集",
    kind: "fact",
    locked: i % 5 === 0,
    effectiveFrom: anchor(order[i % 4000], 1),
    ...(i % 10 === 0 ? { effectiveTo: anchor(order[(i % 4000) + 10], 1) } : {}),
    knownFrom: i % 3 === 0 ? { 林砚: anchor(order[i % 4000], 1) } : {},
  }));

  const outlines = order.map((chapterId, i) => ({
    chapterId,
    lockedFacts: i === 4500 ? "使用 fact-1 破局，不含 fact-10" : `常规推进 fact-${(i % 50) + 2}`,
  }));

  const t0 = performance.now();
  const related = rankRelatedChapters({
    currentChapterId: order[chapterCount - 1],
    chapterOrder: order,
    chapters,
    foreshadows: [
      {
        title: "终局伏笔",
        plantedChapterId: order[12],
        targetChapterId: order[chapterCount - 1],
        status: "planted",
      },
    ],
    facts,
    entityMentions: [
      { documentId: order[12], entityName: "林砚", mentionCount: 5 },
      { documentId: order[100], entityName: "林砚", mentionCount: 2 },
    ],
    viewpoint: "林砚",
    topK: 5,
  });
  const rankMs = performance.now() - t0;
  assert.ok(related.length > 0);
  assert.equal(related[0].chapterId, order[12]);
  assert.ok(rankMs < 300, `rankRelatedChapters(5000ch x 3000facts) took ${rankMs.toFixed(1)}ms (>300ms)`);

  const t1 = performance.now();
  const conflicts = detectLoreConflicts(facts, [], order, outlines, { referenceChapterIndex: 4999 });
  const conflictMs = performance.now() - t1;
  // fact-1 expired at ch-11, so ch-4501 referencing fact-1 triggers outline-fact-mismatch, while fact-10 must not false-match fact-1
  assert.ok(conflicts.some((c) => c.kind === "outline-fact-mismatch" && c.chapterId === order[4500] && c.targetId === "fact-1"));
  assert.ok(conflictMs < 300, `detectLoreConflicts(5000outlines x 3000facts) took ${conflictMs.toFixed(1)}ms (>300ms)`);

  // flattenNovelOrder at 50 volumes x 5 acts x 5000 chapters
  const volumes = Array.from({ length: 50 }, (_, v) => ({ id: `v-${v}`, sortOrder: v }));
  const acts = [];
  for (let v = 0; v < 50; v += 1) {
    for (let a = 0; a < 5; a += 1) {
      acts.push({ id: `a-${v}-${a}`, volumeId: `v-${v}`, sortOrder: a });
    }
  }
  const hierChapters = order.map((id, idx) => {
    const v = Math.floor(idx / 100);
    const a = Math.floor((idx % 100) / 20);
    return { id, volumeId: `v-${v}`, actId: `a-${v}-${a}` };
  });
  const t2 = performance.now();
  const flat = flattenNovelOrder(volumes, acts, hierChapters, order);
  const flatMs = performance.now() - t2;
  assert.equal(flat.length, chapterCount);
  assert.deepEqual(flat.slice(0, 5), order.slice(0, 5));
  assert.ok(flatMs < 150, `flattenNovelOrder(5000ch) took ${flatMs.toFixed(1)}ms (>150ms)`);
});
