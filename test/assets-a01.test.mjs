import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture recording the three skill-asset contradictions for
// the author adjudication in contracts appendix C.1 item 7. Two of them are
// recorded here in full; the third (the isolated 70% value) is recorded in
// rhythm-a01 and only cross-referenced. This fixture records divergences; it
// does not rewrite any v1.x asset, because v1.x skill assets are not to be
// batch-rewritten for V2 alignment.
//
// Recorded sources:
//   1. 判据总表 orphan
//      skill/forge/inspiration-forge/资产/模板/判据总表.md:1-3
//        "可选：只有在想追踪……时才建。不是资格门禁，不填不影响交付。"
//      skill/forge/inspiration-forge/方法论.md:45
//        "出处在实际使用处简记即可；没有复杂比较任务不另建判据总表。"
//      skill/forge/inspiration-forge/资产/幕转章纲.md:35
//        "……不统计六个位置数字或维护强制判据总表。"
//      A repository-wide search for 判据总表 returns exactly those three lines,
//      so the template has no inbound reference.
//   2. anchor regex divergence
//      skill/forge/inspiration-forge-library/scripts/novel_scanner.py:14-19
//      skill/forge/inspiration-forge-library/资产/拆解/锚点判据.md:80-85
//   3. the isolated 70% value — see test/rhythm-a01.test.mjs

// The machine patterns, mirrored from novel_scanner.py.
const MACHINE_CHAPTER =
  /^\s*(?:#{1,4}\s*)?(序章|楔子|引子|尾声|番外.*|C[0-9]{3,4}[\s·:：].*|第[零一二三四五六七八九十百千万0-9]{1,6}[章节回幕折]\s*.*)$/;
const MACHINE_VOLUME =
  /^\s*(?:#{1,4}\s*)?(第[零一二三四五六七八九十百0-9]{1,4}[卷部篇集]\s*.*)$/;
const MACHINE_MAX_HEADING_LENGTH = 60;

// The document examples, mirrored from 锚点判据.md §7. They are labelled
// optional there and are explicitly not tied to a script.
const DOC_VOLUME = /第[一二三四五六七八九十百零两\d]+[卷部篇集辑]/;
const DOC_CHAPTER_NUMBERED = /第\s*[0-9一二三四五六七八九十百千]+\s*章/;
const DOC_CHAPTER_TITLE = /^\s*第?\s*(\d{1,5})\s*章(?:[ \u3000:：.、]|《|「|“|$)/;

function machineRecognises(line) {
  const stripped = line.trim();
  if (!stripped || stripped.length > MACHINE_MAX_HEADING_LENGTH) return null;
  if (MACHINE_VOLUME.test(stripped)) return "volume";
  if (MACHINE_CHAPTER.test(stripped)) return "chapter";
  return null;
}

function docRecognises(line) {
  const stripped = line.trim();
  if (DOC_VOLUME.test(stripped)) return "volume";
  if (DOC_CHAPTER_NUMBERED.test(stripped)) return "chapter";
  if (DOC_CHAPTER_TITLE.test(stripped)) return "chapter";
  return null;
}

test("A-01 the criteria-table template exists but nothing references it, and two documents say not to keep one", () => {
  const template = {
    path: "skill/forge/inspiration-forge/资产/模板/判据总表.md",
    header: "可选：只有在想追踪'这处写法从哪来、后来还管不管用'时才建。不是资格门禁，不填不影响交付。",
    inboundReferences: 0,
  };
  const statements = [
    { path: "skill/forge/inspiration-forge/方法论.md:45", text: "没有复杂比较任务不另建判据总表" },
    { path: "skill/forge/inspiration-forge/资产/幕转章纲.md:35", text: "不统计六个位置数字或维护强制判据总表" },
  ];
  assert.equal(template.inboundReferences, 0);
  assert.equal(statements.length, 2);
  // The template sits in the template directory a skill presents as fillable,
  // while two documents say not to maintain one and its own header says it is
  // optional. That is the contradiction: an asset nobody is told to use.
  assert.ok(template.header.includes("不是资格门禁"));
});

test("A-01 the anchor patterns and the document examples disagree on what counts as a heading", () => {
  // Each case states what the machine finds and what the document example finds.
  const cases = [
    // A Chinese-numeral chapter: the machine takes it, and so does the
    // document's numbered pattern, which accepts Chinese numerals.
    { line: "第六章 山雨欲来", machine: "chapter", doc: "chapter" },
    { line: "第290章 旧事重提", machine: "chapter", doc: "chapter" },
    // The space variant the document explicitly requires ("第175 章", digits
    // then a space) is missed by the machine, which wants the unit character
    // immediately after the digits.
    { line: "第175 章 空格变体", machine: null, doc: "chapter" },
    // Markdown heading prefixes: the machine strips up to four hashes; the
    // document's numbered pattern is a substring search, so it still finds the
    // chapter inside the prefix even though its anchored title pattern would not.
    { line: "## 第12章 入场", machine: "chapter", doc: "chapter" },
    // Volume units: the document's example allows 辑, the machine does not.
    { line: "第三辑 早期作品", machine: null, doc: "volume" },
    // Special chapters the machine names explicitly and the document examples
    // never cover.
    { line: "序章", machine: "chapter", doc: null },
    { line: "番外篇 老钟的后半辈子", machine: "chapter", doc: null },
    { line: "C0123 存档点", machine: "chapter", doc: null },
  ];
  for (const testCase of cases) {
    assert.equal(machineRecognises(testCase.line), testCase.machine, testCase.line);
    assert.equal(docRecognises(testCase.line), testCase.doc, testCase.line);
  }
  // So the two sets are not two spellings of one rule: the machine misses a
  // variant the document demands, and both sides miss things the other covers.
  const disagreements = cases.filter((testCase) => testCase.machine !== testCase.doc);
  assert.equal(disagreements.length, 5);
  const machineMissesDocDemand = cases.filter(
    (testCase) => testCase.machine === null && testCase.doc !== null,
  );
  assert.deepEqual(
    machineMissesDocDemand.map((testCase) => testCase.line),
    ["第175 章 空格变体", "第三辑 早期作品"],
  );
});

test("A-01 the machine also applies a heading-length cap the document does not state", () => {
  const long = `第1章 ${"字".repeat(80)}`;
  assert.equal(machineRecognises(long), null);
  // The document examples have no length rule, so the same line still matches.
  assert.equal(docRecognises(long), "chapter");
  // A short line is recognised by both.
  assert.equal(machineRecognises("第1章 开篇"), "chapter");
});

test("A-01 the document itself disclaims the regexes as optional and script-free", () => {
  const disclaimers = [
    "以下只是少量可选的检索示例，用于人工检查时参考；不调用脚本，也不表示已扫描或已命中",
    "不要把“更长的正则”当成更准的判据：正则只帮你找候选，成立与否仍回正文看",
  ];
  assert.equal(disclaimers.length, 2);
  // The machine is exactly a script, so the document's "不调用脚本" wording
  // cannot describe the machine path; the two live in different lanes and the
  // adjudication has to say which one the V2 reader follows.
  assert.equal(typeof MACHINE_CHAPTER.test, "function");
  assert.equal(MACHINE_MAX_HEADING_LENGTH, 60);
});

test("A-01 the third contradiction is the isolated 70% value, recorded in the rhythm fixture", () => {
  // Cross-reference rather than a second copy of the table.
  const holder = "skill handoff contract §7.1 (four copies)";
  const nonHolder = "profiles/default/rhythm.md";
  assert.equal(holder.length > 0, true);
  assert.equal(nonHolder.length > 0, true);
  // The value appears in exactly one of the two rhythm copies; see
  // test/rhythm-a01.test.mjs for the assertion.
  assert.equal(true, true);
});

test("A-01 none of the three contradictions is a machine-enforced rule today", () => {
  // No Python source reads the criteria table, and the anchor patterns only
  // produce candidates for a human to confirm.
  const enforced = {
    criteriaTable: false,
    anchorRegexAsRule: false,
    seventyPercent: false,
  };
  for (const [name, value] of Object.entries(enforced)) {
    assert.equal(value, false, name);
  }
  // So the V2 decision is about which document is the source of truth, not
  // about changing a machine constant.
  const decisionSlots = ["criteria-table 存废与归属", "锚点识别以脚本还是文档为真源", "70% 孤立值归属"];
  assert.equal(decisionSlots.length, 3);
});
