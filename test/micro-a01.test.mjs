import assert from "node:assert/strict";
import test from "node:test";
import { RecordedError } from "../support/a01.mjs";

// A-01 supporting fixture recording the micro-headline evidence for the author
// adjudication in contracts appendix C.1 item 1. v1.x applies the 34-character
// title cap to every mode except micro, and in micro mode it scores the first
// sentence against an 8-30 band instead. The documents say micro has no title
// at all. This fixture mirrors the machine rules and records the divergence
// between the two numbers; it does not decide the V2 rule, and the 34 cap for
// the other modes is a protected rule this file never touches.
//
// Recorded sources:
//   skill/scripts/qa_check.py:244   title_too_long = (not micro) and len(title) > TITLE_MAX
//   skill/scripts/qa_check.py:111-120  title_score length branch, micro band 8~30
//   skill/scripts/qa_check.py:1010-1011 missing title is an input error unless micro
//   skill/scripts/qa_check.py:457   the QA item is reported as 首句N字 in micro
//   skill/scripts/rules.py:87       BANDS = {long: 2600-3400, short: 1100-2200, micro: 300-1000}
//   references/s6-qa.md:44 (and profiles/default/s6-qa.md:20)  标题超 34 字（微头条不查）
//   references/s5-editing.md:111 (and profiles copy)  微头条首句 ≤30 字
//   references/s4-micro.md:5 (and profiles copy)  没有标题、没有小标题，第一句就是标题

const TITLE_MAX = 34;
const BANDS = { long: [2600, 3400], short: [1100, 2200], micro: [300, 1000] };

// The length branch of title_score, mirrored so the bands can be asserted.
function lengthPoints(text, micro) {
  if (micro) {
    if (text.length >= 8 && text.length <= 30) return 20;
    if (text.length <= 45) return 10;
    return 0;
  }
  if (text.length >= 18 && text.length <= 28) return 20;
  if (text.length >= 14) return 10;
  return 0;
}

// The title-length gate, mirrored from qa_check.py:244.
function titleTooLong(title, micro) {
  return !micro && title.length > TITLE_MAX;
}

// The missing-title rule, mirrored from qa_check.py:1010-1011.
function requireTitle(title, micro) {
  if (!title && !micro) {
    throw new RecordedError("input.invalid", {
      reason: "missing-title",
      hint: "微头条请加 --mode micro",
    });
  }
  return { title, scoredAs: micro ? "首句" : "标题" };
}

// The scored object: the first sentence in micro mode, the title otherwise.
function scoredObject({ title, firstSentence }, micro) {
  return micro ? firstSentence : title;
}

test("A-01 the 34-character cap does not apply to micro, and the machine says so in one condition", () => {
  assert.equal(titleTooLong("短标题", false), false);
  assert.equal(titleTooLong("标".repeat(34), false), false);
  assert.equal(titleTooLong("标".repeat(35), false), true);
  // In micro mode the same 35-character text is not a title-too-long failure.
  assert.equal(titleTooLong("标".repeat(35), true), false);
  assert.equal(titleTooLong("标".repeat(60), true), false);
  // The cap for the other modes is untouched by this fixture.
  assert.equal(TITLE_MAX, 34);
});

test("A-01 in micro mode the scored object is the first sentence, against an 8-30 band", () => {
  // Full marks: 8 to 30 characters. Partial: everything up to 45, including a
  // first sentence that is too short — the branch has no lower penalty, which
  // is recorded v1.x behaviour rather than a proposal.
  assert.equal(lengthPoints("楼下修鞋的老钟今天没出摊", true), 20);
  assert.equal(lengthPoints("七个字的首句", true), 10);
  assert.equal(lengthPoints("三".repeat(30), true), 20);
  assert.equal(lengthPoints("四".repeat(31), true), 10);
  assert.equal(lengthPoints("五".repeat(45), true), 10);
  assert.equal(lengthPoints("六".repeat(46), true), 0);
  assert.equal(lengthPoints("", true), 10);
  // The other modes keep their own band, which is a different rule entirely:
  // full marks need 18 to 28 characters, and 14 is already only partial.
  assert.equal(lengthPoints("标".repeat(20), false), 20);
  assert.equal(lengthPoints("这是一个不算短的标准标题长度", false), 10);
  assert.equal(lengthPoints("短", false), 0);
});

test("A-01 a missing title is an input error outside micro and acceptable inside it", () => {
  assert.throws(
    () => requireTitle("", false),
    (error) => error instanceof RecordedError && error.details.reason === "missing-title",
  );
  const micro = requireTitle("", true);
  assert.equal(micro.scoredAs, "首句");
  const long = requireTitle("楼下修鞋的老钟今天没出摊", false);
  assert.equal(long.scoredAs, "标题");
});

test("A-01 the documents record three different statements about micro headlines", () => {
  // Recorded wordings, so the divergence is asserted rather than paraphrased.
  const statements = [
    { source: "s4-micro.md:5（两份副本）", text: "没有标题、没有小标题，第一句就是标题。存稿时不写“# ”行，直接从首句开始" },
    { source: "s6-qa.md:44（两份副本）", text: "标题超 34 字（微头条不查）" },
    { source: "s5-editing.md:111（两份副本）", text: "首段 ≤80 字（微头条首句 ≤30 字）" },
  ];
  assert.equal(statements.length, 3);
  // The three statements name three different objects: the title, the cap and
  // the first sentence. They do not contradict each other, but they do not add
  // up to one rule either.
  const objects = ["标题", "34 字上限", "首句"];
  assert.equal(objects.length, 3);
  // The editing checklist states 30 as a limit, while the machine treats 30 as
  // the top of a scoring band and still gives partial credit up to 45.
  assert.equal(lengthPoints("七".repeat(30), true), 20);
  assert.equal(lengthPoints("八".repeat(45), true), 10);
});

test("A-01 the machine skips the cap entirely rather than applying a second cap", () => {
  // If micro had its own hard cap, the gate would still fire above it. It does
  // not: only the scoring band exists, and a very long first sentence merely
  // scores zero on the length points.
  const long = "九".repeat(120);
  assert.equal(titleTooLong(long, true), false);
  assert.equal(lengthPoints(long, true), 0);
  // So "micro 不适用 34" is true, and "micro 没有长度约束" is false.
  const hasLengthRule = lengthPoints(long, true) === 0 && lengthPoints("楼下修鞋的老钟今天没出摊", true) === 20;
  assert.equal(hasLengthRule, true);
});

test("A-01 micro also has its own length band and structure rules, so it is a separate mode throughout", () => {
  assert.deepEqual(BANDS.micro, [300, 1000]);
  assert.deepEqual(BANDS.long, [2600, 3400]);
  assert.deepEqual(BANDS.short, [1100, 2200]);
  // The QA item is reported as 首句N字 in micro and 标题N字 otherwise, and the
  // structure item looks at paragraphs and images instead of subheadings.
  const report = (text, micro) => (micro ? `首句${text.length}字` : `${text.length}字`);
  assert.equal(report("楼下修鞋的老钟今天没出摊", true), "首句12字");
  assert.equal(report("楼下修鞋的老钟今天没出摊", false), "12字");
});

test("A-01 the decision shape keeps the protected cap and settles only the micro first-sentence rule", () => {
  // The 34 cap for the non-micro modes is protected and out of scope here. What
  // the author settles is what micro's first sentence is measured against.
  const decision = {
    nonMicroCap: { value: TITLE_MAX, protected: true, decided: true },
    microCap: { value: null, protected: false, decided: null },
    microScoringBand: { value: "8–30（满分）／≤45（部分）", decided: null },
    microEditingLimit: { value: "≤30（s5-editing 清单）", decided: null },
  };
  assert.equal(decision.nonMicroCap.protected, true);
  assert.equal(decision.nonMicroCap.decided, true);
  assert.equal(decision.microCap.decided, null);
  // The two micro candidates differ: a hard 30 limit would refuse a 40-character
  // first sentence that the machine currently scores at partial points.
  assert.equal(lengthPoints("十".repeat(40), true), 10);
  const hardLimitWouldRefuse = 40 > 30;
  assert.equal(hardLimitWouldRefuse, true);
});
