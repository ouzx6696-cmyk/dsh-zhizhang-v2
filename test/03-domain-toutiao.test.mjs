import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTICLE_MODES,
  CONTENT_LINES,
  DELIVERY_ENDING,
  QA_PASS_SCORE,
  QA_REFINEMENT_LIMIT,
  TITLE_MAX,
  articleScenario,
  assertArticleTransition,
  formatDelivery,
  qaPassed,
  structuralGates,
  validateTitleMatrix,
} from "../src/domain/toutiao/index.ts";
import { refineArticle } from "../src/domain/toutiao/refinement.ts";
import { assertThrowsContract } from "../support/harness.mjs";

test("Toutiao protected thresholds, state transitions, and scenario matrix", () => {
  assert.equal(TITLE_MAX, 34);
  assert.equal(QA_PASS_SCORE, 84);
  assert.equal(QA_REFINEMENT_LIMIT, 2);

  assertArticleTransition("初稿待改", "待验收");
  assertArticleTransition("待验收", "已验收");
  assertArticleTransition("待验收", "验收退回");
  assertArticleTransition("已验收", "已交稿");
  assertThrowsContract(() => assertArticleTransition("初稿待改", "已交稿"), "gate.denied");
  assertThrowsContract(() => assertArticleTransition("已交稿", "初稿待改"), "gate.denied");

  const longInfo = articleScenario("long", "资讯线");
  assert.equal(longInfo.hasTitle, true);
  assert.deepEqual(longInfo.length, ARTICLE_MODES.long.length);
  assert.deepEqual(longInfo.drivers, CONTENT_LINES.资讯线.drivers);

  const microStory = articleScenario("micro", "故事线");
  assert.equal(microStory.hasTitle, false);
  assertThrowsContract(() => articleScenario("unknown", "资讯线"), "input.invalid");
  assertThrowsContract(() => articleScenario("short", "未知线"), "input.invalid");
});

test("title cap counts Unicode code points (including emoji) and micro forbids titles/subheadings", () => {
  const exact34 = "🔥".repeat(34);
  const over34 = "🔥".repeat(35);
  assert.deepEqual(structuralGates("short", exact34, "正".repeat(1200)), []);
  assert.ok(structuralGates("short", over34, "正".repeat(1200)).some((g) => g.includes("34")));

  const microGates = structuralGates("micro", "不该有标题", "## 小标题\n" + "微".repeat(400));
  assert.ok(microGates.includes("微头条不设标题"));
  assert.ok(microGates.includes("微头条不设小标题"));
  assert.deepEqual(structuralGates("micro", "", "微".repeat(400)), []);

  const matrix = validateTitleMatrix([
    { text: "标题一", motif: "账本" },
    { text: "标题二", motif: "处境" },
    { text: "标题三", motif: "冲突" },
    { text: "标题四", motif: "账本" },
    { text: "标题五", motif: "冲突" },
    { text: over34, motif: "超长" },
  ]);
  assert.equal(matrix.valid.length, 5);
  assert.equal(matrix.motifCount, 3);
  assert.equal(matrix.passed, true);
});

test("QA pass line 84 and auto-refinement loop cap at 2 rounds while keeping best draft", async () => {
  assert.equal(qaPassed({ overall: 84, passed: true, fails: [], hardGates: [] }), true);
  assert.equal(qaPassed({ overall: 83.9, passed: true, fails: [], hardGates: [] }), false);
  assert.equal(qaPassed({ overall: 92, passed: true, fails: ["缺案例"], hardGates: [] }), false);
  assert.equal(qaPassed({ overall: 92, passed: true, fails: [], hardGates: ["超字数"] }), false);

  // Never reaches 84 -> stops strictly after 2 refinement rounds and keeps highest-scoring draft
  const scores = [76, 82, 79];
  let idx = 0;
  const capped = await refineArticle(
    "初稿",
    async () => ({ overall: scores[idx++], passed: false, fails: ["缺依据"], hardGates: [] }),
    async (body, qa) => `${body}->改(${qa.overall})`,
  );
  assert.equal(capped.rounds, 2);
  assert.equal(capped.qa.overall, 82);
  assert.equal(capped.body, "初稿->改(76)");

  // Passes on round 1 -> stops early
  let passIdx = 0;
  const early = await refineArticle(
    "初稿",
    async () =>
      passIdx++ === 0
        ? { overall: 80, passed: false, fails: ["缺数字"], hardGates: [] }
        : { overall: 86, passed: true, fails: [], hardGates: [] },
    async (body) => `${body}->补数字`,
  );
  assert.equal(early.rounds, 1);
  assert.equal(early.qa.overall, 86);
  assert.equal(early.body, "初稿->补数字");
});

test("formatDelivery appends fixed ending exactly once without duplication", () => {
  const first = formatDelivery("测试标题", "正文第一段。");
  assert.equal(first, `# 测试标题\n\n正文第一段。\n\n${DELIVERY_ENDING}\n`);

  const deduped = formatDelivery("测试标题", `正文第一段。\n\n${DELIVERY_ENDING}`);
  assert.equal(deduped, first);

  const micro = formatDelivery("", "微头条正文。");
  assert.equal(micro, `微头条正文。\n\n${DELIVERY_ENDING}\n`);
});
