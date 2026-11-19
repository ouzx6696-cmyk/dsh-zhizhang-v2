import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture recording the chapter-outline structure evidence for
// the author adjudication in contracts appendix C.1 item 4. v1.x states in four
// documents that the author's own outline format may be used as long as the
// content is sufficient, while the only machine check demands exactly four
// numbered headings in a fixed order plus four head-note fields. This fixture
// mirrors that check, records the severity of each rule, and records the
// divergence. It does not decide the V2 outline contract.
//
// Recorded sources:
//   skill/forge/inspiration-forge/scripts/check_outline.py
//     BLOCKS  = ('剧情梗概', '核心冲突与看点', '情节推进节点', '章末落点')      (:19)
//     FIELDS  = ('视角', '目标篇幅', '锁定事实', '人物知识边界')                (:20)
//     EXPECTED = ['1. 剧情梗概', ... '4. 章末落点']                            (:21)
//     _format_text: head-note fields, exact single headings, exact order       (:69-81)
//     inspect(mode='format') turns every check() issue into an error           (:145-147)
//     readiness mode: missing target length is an error, out-of-band a warning (:270-275)
//   Documents stating the author's own format is fine (4 copies):
//     inspiration-forge-library/资产/交接契约.md:42
//     inspiration-forge/资产/交接契约.md:42
//     novel-writer/references/handoff_contract.md:42
//     novel-writer/references/pipeline_handoff.md:26

const BLOCKS = ["剧情梗概", "核心冲突与看点", "情节推进节点", "章末落点"];
const FIELDS = ["视角", "目标篇幅", "锁定事实", "人物知识边界"];
const EXPECTED = BLOCKS.map((block, index) => `${index + 1}. ${block}`);

// The recorded document wording, so the divergence can be asserted rather than
// paraphrased.
const DOCUMENT_CLAIM = "作者自有的章纲格式只要内容充分就直接使用；确有冲突时局部适配，不为机械检查改故事。";

function mask(text) {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, (match) => "\n".repeat(match.split("\n").length));
  const lines = [];
  let fence = null;
  for (const line of withoutComments.split("\n")) {
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opening) {
      if (fence === null) fence = opening[1][0];
      else if (opening[1][0] === fence) fence = null;
      lines.push("");
    } else {
      lines.push(fence === null ? line : "");
    }
  }
  return lines.join("\n");
}

function parts(text) {
  const masked = mask(text);
  const matches = [...masked.matchAll(/^##\s+(.+?)\s*$/gm)];
  const head = matches.length > 0 ? masked.slice(0, matches[0].index) : masked;
  const sections = matches.map((match, index) => [
    match[1],
    masked.slice(match.index + match[0].length, index + 1 < matches.length ? matches[index + 1].index : masked.length),
  ]);
  return { head, headings: sections.map(([label]) => label) };
}

// The mirrored format check: returns the issue strings check_outline.py would
// produce for one outline file.
function formatIssues(text, name = "C01.md") {
  const { head, headings } = parts(text);
  const issues = [];
  for (const field of FIELDS) {
    const pattern = new RegExp(`^\\s*(?:>\\s*)?(?:[-*]\\s*)?${field}\\s*[:：]`, "m");
    if (!pattern.test(head)) issues.push(`${name} 头注缺 ${field}`);
  }
  for (const [index, block] of BLOCKS.entries()) {
    if (headings.filter((heading) => heading === EXPECTED[index]).length !== 1) {
      issues.push(`${name} 缺正文块 ${block} 或标题重复／不精确`);
    }
  }
  if (headings.join("|") !== EXPECTED.join("|")) {
    issues.push(`${name} 正文标题须按约定的四块顺序，不能用说明标题冒充`);
  }
  return issues;
}

function wellFormedOutline() {
  return `<!-- 作者备注：本章先说冷柜前的选择 -->
> 视角：老周
> 目标篇幅：2200
> 锁定事实：冷柜钥匙在老周身上
> 人物知识边界：小于不知道钥匙在谁身上

## 1. 剧情梗概
老周蹲在冷柜前，把鸡腿过了秤。

## 2. 核心冲突与看点
秤高了一两，买主不认。

## 3. 情节推进节点
小于找来，看见秤。

## 4. 章末落点
手机震了一下，老周没接。
`;
}

test("A-01 a well-formed outline passes with the four numbered blocks and the four head-note fields", () => {
  assert.deepEqual(formatIssues(wellFormedOutline()), []);
  assert.deepEqual(EXPECTED, ["1. 剧情梗概", "2. 核心冲突与看点", "3. 情节推进节点", "4. 章末落点"]);
});

test("A-01 a renamed, reordered, duplicated or missing block is an error, and in format mode that error is hard", () => {
  const base = wellFormedOutline();
  const renamed = base.replace("## 3. 情节推进节点", "## 3. 情节怎么走");
  const reordered = base.replace("## 1. 剧情梗概", "## 1. 核心冲突与看点").replace("## 2. 核心冲突与看点", "## 2. 剧情梗概");
  const duplicated = base.replace("## 4. 章末落点", "## 4. 章末落点\n\n## 4. 章末落点");
  const missing = base.replace("## 2. 核心冲突与看点\n秤高了一两，买主不认。\n", "");
  for (const [label, text] of [["renamed", renamed], ["reordered", reordered], ["duplicated", duplicated], ["missing", missing]]) {
    const issues = formatIssues(text);
    assert.ok(issues.length > 0, label);
    // check_outline.inspect(mode='format') maps every issue to severity error.
    assert.equal(issues.every((issue) => issue.includes("正文标题") || issue.includes("缺正文块")), true, label);
  }
  // A descriptive heading is refused by name: the message says a descriptive
  // heading may not impersonate a block.
  assert.ok(formatIssues(renamed).some((issue) => issue.includes("不能用说明标题冒充")));
});

test("A-01 the four notes must sit in the head note, carry a colon, and survive masking of fences and comments", () => {
  const base = wellFormedOutline();
  // A note moved into a body block no longer counts: the fields are only
  // accepted in the head note, before the first level-two heading.
  const moved = base
    .replace("> 锁定事实：冷柜钥匙在老周身上\n", "")
    .replace("## 1. 剧情梗概\n", "## 1. 剧情梗概\n锁定事实：冷柜钥匙在老周身上\n");
  assert.ok(formatIssues(moved).some((issue) => issue.includes("头注缺 锁定事实")));
  // A note without a separator does not count either.
  const noColon = base.replace("> 人物知识边界：小于不知道钥匙在谁身上", "> 人物知识边界 小于不知道钥匙在谁身上");
  assert.ok(formatIssues(noColon).some((issue) => issue.includes("头注缺 人物知识边界")));
  // A half-width colon is accepted, and so is a list marker.
  const halfWidth = base.replace("> 视角：老周", "> 视角:老周");
  assert.deepEqual(formatIssues(halfWidth), []);
  const listed = base.replace("> 视角：老周", "- 视角：老周");
  assert.deepEqual(formatIssues(listed), []);
  // Examples inside a fenced block or an HTML comment are masked out.
  const fenced = `${base}\n\`\`\`markdown\n> 视角：示例\n## 1. 剧情梗概\n\`\`\`\n`;
  assert.deepEqual(formatIssues(fenced), []);
  const commented = base.replace("<!-- 作者备注：本章先说冷柜前的选择 -->", "<!-- > 视角：注释里的示例 -->");
  assert.deepEqual(formatIssues(commented), []);
});

test("A-01 the target length is the only warning in the structure check; everything else about the shape is an error", () => {
  // Recorded severities from check_outline.inspect: format issues are errors,
  // a missing target length is an error, and an out-of-band length is a warning.
  const severities = {
    missingBlock: "error",
    wrongOrder: "error",
    missingNote: "error",
    missingTargetLength: "error",
    targetLengthOutOfBand: "warning",
  };
  assert.equal(severities.targetLengthOutOfBand, "warning");
  for (const [rule, severity] of Object.entries(severities)) {
    if (rule !== "targetLengthOutOfBand") assert.equal(severity, "error", rule);
  }
  // So an outline with the right shape but a 9000-character target still passes
  // the structure check.
  const long = wellFormedOutline().replace("> 目标篇幅：2200", "> 目标篇幅：9000");
  assert.deepEqual(formatIssues(long), []);
});

test("A-01 the documents and the machine disagree about the author's own format", () => {
  // The four document copies claim the author's own format is used directly;
  // the machine demands the exact four numbered headings in order, so the
  // claim cannot hold at the machine layer for an arbitrary layout.
  assert.equal(DOCUMENT_CLAIM.length > 0, true);
  const ownFormat = `> 视角：老周
> 目标篇幅：2200
> 锁定事实：冷柜钥匙在老周身上
> 人物知识边界：小于不知道钥匙在谁身上

## 本章讲什么
老周蹲在冷柜前。

## 冲突在哪
秤高了一两。

## 怎么推进
小于找来。

## 落到哪儿
手机震了一下。
`;
  const issues = formatIssues(ownFormat);
  assert.ok(issues.length >= 2);
  assert.ok(issues.some((issue) => issue.includes("不能用说明标题冒充")));
  // The content is sufficient; only the headings differ. That is the exact
  // point the adjudication in C.1 item 4 has to settle.
  assert.equal(issues.every((issue) => !issue.includes("头注缺")), true);
});

test("A-01 the four blocks and four notes are recorded as the machine contract, with their exact spellings", () => {
  assert.deepEqual(BLOCKS, ["剧情梗概", "核心冲突与看点", "情节推进节点", "章末落点"]);
  assert.deepEqual(FIELDS, ["视角", "目标篇幅", "锁定事实", "人物知识边界"]);
  assert.equal(BLOCKS.length, 4);
  assert.equal(FIELDS.length, 4);
  // The notes are checked in the head note only; the blocks are checked as
  // level-two headings, so the two groups live at different levels.
  const { headings } = parts(wellFormedOutline());
  assert.deepEqual(headings, EXPECTED);
});
