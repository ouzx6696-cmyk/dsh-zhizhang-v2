import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture recording the Fanqie single-chapter word-count
// evidence for the author adjudication in contracts appendix C.1 item 2. v1.x
// states the number in five places with three different shapes, and only one of
// them is machine-enforced. This fixture records the divergence and the shape
// of the decision; it does not choose a value, because chapter length guidance
// belongs to the author.
//
// Recorded sources:
//   skill/forge/inspiration-forge/scripts/check_outline.py:17
//     CHAPTER_WORDS_MIN, CHAPTER_WORDS_MAX = 1500, 6000  (warn only, see :274)
//   skill/forge/novel-writer/assets/templates/chapter_outline.md:4
//     "番茄社区常见约 2000–2500 字，非官方，可改"
//   skill/forge/inspiration-forge/资产/模板/chapter_outline.md:4   (same line)
//   skill/forge/inspiration-forge/资产/规模参数.md:9
//     "作者未定单章时，番茄长篇默认可按约两千字估算并标'默认，可改'"
//   skill/forge/novel-writer/references/fanqie_platform.md:37 and
//   skill/forge/inspiration-forge/资产/番茄平台.md:37
//     "单章 2000 字上下"（社区经验，非官方）
//   skill/forge/inspiration-forge/资产/案例/雾港旧声铺-规划.md:110
//     "约1400—2000非空白字符（含标点）；仅本例教学预算"
//   profiles/default/platform.md:28
//     summary line naming both the 2000–2500 community range and the 1500–6000
//     check band, and stating the check only warns

const MACHINE_BAND = { min: 1500, max: 6000, source: "check_outline.py:17", enforced: "warn" };

const DOCUMENT_DEFAULTS = [
  { value: "2000–2500", source: "novel-writer/assets/templates/chapter_outline.md:4", nature: "模板默认建议" },
  { value: "2000–2500", source: "inspiration-forge/资产/模板/chapter_outline.md:4", nature: "模板默认建议（副本）" },
  { value: "约两千", source: "inspiration-forge/资产/规模参数.md:9", nature: "估算起点" },
  { value: "2000 上下", source: "novel-writer/references/fanqie_platform.md:37", nature: "社区经验" },
  { value: "2000 上下", source: "inspiration-forge/资产/番茄平台.md:37", nature: "社区经验（副本）" },
  { value: "1400–2000 非空白字符", source: "inspiration-forge/资产/案例/雾港旧声铺-规划.md:110", nature: "教学用例" },
];

// The check as recorded in check_outline.py: a missing target length is an
// error, a number outside the band is a warning, and the band ends are inside.
function checkTargetLength(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { level: "error", reason: "目标篇幅未设" };
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    return { level: "error", reason: "目标篇幅不可解析" };
  }
  if (number < MACHINE_BAND.min || number > MACHINE_BAND.max) {
    return { level: "warn", reason: `目标篇幅 ${number} 字，超出番茄单章常见区间 ${MACHINE_BAND.min}–${MACHINE_BAND.max}` };
  }
  return { level: "ok" };
}

test("A-01 the recorded word-count sources are five distinct statements across seven files", () => {
  assert.equal(DOCUMENT_DEFAULTS.length, 6);
  assert.equal(new Set(DOCUMENT_DEFAULTS.map((entry) => entry.source)).size, 6);
  assert.equal(new Set(DOCUMENT_DEFAULTS.map((entry) => entry.value)).size, 4);
  // Plus the machine band, which is the only enforced statement.
  assert.equal(MACHINE_BAND.enforced, "warn");
});

test("A-01 only the machine band is enforced, and it warns rather than rejects", () => {
  assert.deepEqual(checkTargetLength("2000"), { level: "ok" });
  assert.deepEqual(checkTargetLength("1500"), { level: "ok" });
  assert.deepEqual(checkTargetLength("6000"), { level: "ok" });
  assert.equal(checkTargetLength("800").level, "warn");
  assert.equal(checkTargetLength("7000").level, "warn");
  // A missing or unparseable target length is the only error case.
  assert.equal(checkTargetLength("").level, "error");
  assert.equal(checkTargetLength("约两千").level, "error");
  // So a chapter far outside every documented range still passes the check.
  assert.equal(checkTargetLength("9000").level, "warn");
});

test("A-01 the documented numbers disagree, and the spread between them is wide", () => {
  const bounds = {
    "2000–2500": [2000, 2500],
    "约两千": [2000, 2000],
    "2000 上下": [2000, 2000],
    "1400–2000 非空白字符": [1400, 2000],
  };
  const lower = Math.min(...Object.values(bounds).map(([min]) => min));
  const upper = Math.max(...Object.values(bounds).map(([, max]) => max));
  assert.equal(lower, 1400);
  assert.equal(upper, 2500);
  // The machine band neither contains nor sits inside the documented ranges:
  // its floor (1500) is above the teaching case's floor (1400) but below the
  // template default's floor (2000), and its ceiling (6000) is far above every
  // documented ceiling. The documents and the check do not describe one rule.
  assert.equal(MACHINE_BAND.min > lower, true);
  assert.equal(MACHINE_BAND.min < 2000, true);
  assert.equal(MACHINE_BAND.max > upper, true);
  assert.equal(upper - lower, 1100);
});

test("A-01 the unit itself is undefined in the machine source, and one document uses a different unit", () => {
  // check_outline.py parses a bare number out of the outline field, so "字" is
  // whatever the author wrote; the teaching case counts non-whitespace
  // characters including punctuation, which is a different unit.
  const machineUnit = "字（未定义：作者所填原样数字）";
  const teachingUnit = "非空白字符（含标点）";
  assert.notEqual(machineUnit, teachingUnit);
  const counted = "  老周把鸡腿过了秤。\n\n手机震了一下。  ";
  const nonWhitespace = counted.replace(/\s+/gu, "").length;
  assert.equal(nonWhitespace, counted.length - counted.replace(/\S/gu, "").length);
  assert.ok(nonWhitespace < counted.length);
});

test("A-01 the decision shape has three slots, and each slot lists its recorded candidates", () => {
  // What the author has to settle, expressed as slots so the adjudication can
  // be recorded once and referenced everywhere. Nothing here picks a value.
  const slots = {
    machineBand: { candidates: ["1500–6000（现行检查带）", "收敛到文档区间", "作者指定新区间"], decided: null },
    authorUnsetDefault: {
      candidates: ["2000–2500（模板）", "约两千（规模参数）", "2000 上下（平台经验）", "作者指定"],
      decided: null,
    },
    unit: { candidates: ["字（现行，未定义）", "非空白字符（教学用例）", "汉字数（manuscript_linter 另计）"], decided: null },
  };
  for (const [name, slot] of Object.entries(slots)) {
    assert.equal(slot.decided, null, name);
    assert.ok(slot.candidates.length >= 2, name);
  }
  // The three slots are independent: settling one does not settle the others.
  assert.equal(slots.machineBand.candidates.includes(slots.authorUnsetDefault.candidates[0]), false);
});

test("A-01 the product profile records both numbers and states that the check only warns", () => {
  // profiles/default/platform.md:28 is the only place that names both the
  // community range and the check band in one sentence, which is why it is the
  // natural anchor for the adjudicated wording once the author decides.
  const recorded = {
    communityRange: "2000–2500",
    checkBand: "1500–6000",
    checkBehaviour: "只提示不否决",
  };
  assert.equal(recorded.checkBand, `${MACHINE_BAND.min}–${MACHINE_BAND.max}`);
  assert.equal(recorded.checkBehaviour, MACHINE_BAND.enforced === "warn" ? "只提示不否决" : "unknown");
});
