import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture recording the Toutiao scenario matrix for the author
// adjudication in contracts appendix C.1 item 8. The matrix has exactly two
// dimensions — genre (mode) and content line — and v1.x varies rules along
// both. This fixture records the matrix, its single machine source and the
// legacy aliases V2 must not inherit. It does not freeze any business rule.
//
// Recorded sources (all in packages/toutiao):
//   skill/scripts/rules.py:87-99     BANDS, MODE_ALIAS, MODE_NAME, GENRE_MODE,
//                                    LONG_SPLIT, EXT_OVERLAP_*, LONG_BUDGET_SCALE
//   skill/scripts/rules.py:125-135   DRIVERS with per-driver number budgets
//   skill/scripts/rules.py:140-172   LINES, DEFAULT_LINE, OPENINGS, ENDINGS,
//                                    EXT_WAYS, ADAPT_WAYS, MOTIFS,
//                                    STORY_REPEAT_DAYS, STORY_FACT_RE, STORY_KIN_RE
//   skill/scripts/rules.py:194-199   line_of fallback
//   skill/scripts/qa_check.py:244    the 34-character cap skipped in micro
//   skill/scripts/qa_check.py:111-120  micro first-sentence band
//   skill/scripts/qa_check.py:816-833  story-only card fields and opening/ending tables
//   skill/scripts/qa_check.py:937     compliance exception for the story line

// Dimension 1: genre. Three modes plus two 3.x aliases.
const MODES = {
  long: { name: "长图文", band: [2600, 3400], split: { main: [1700, 2300], ext: [800, 1300] } },
  short: { name: "短图文", band: [1100, 2200], split: null },
  micro: { name: "微头条", band: [300, 1000], split: null, noTitle: true, noSubheadings: true },
};
const MODE_ALIAS = { quick: "short", deep: "short" };
const GENRE_MODE = { 长图文: "long", 短图文: "short", 微头条: "micro", 快图文: "short", 深图文: "short" };

// Dimension 2: content line.
const LINES = {
  资讯线: { defaultDriver: null, drivers: ["账本型", "处境型", "冲突型", "信息型", "情感型"] },
  故事线: { defaultDriver: "故事型", drivers: ["故事型"] },
};
const DEFAULT_LINE = "资讯线";
const OPENINGS = {
  资讯线: ["现场动作", "跑腿卡点", "原话顶门", "时间死线", "直球亮底牌", "账单暴击"],
  故事线: ["定格画面", "原典一句", "反常结局", "配角开口", "直球亮底牌"],
};
const ENDINGS = {
  资讯线: ["经历共鸣", "两难选择", "潜台词追问", "帮亲友问计", "观点碰撞", "晒坐标"],
  故事线: ["画面留白", "两难选择", "经历共鸣", "观点碰撞", "古今对照"],
};
const EXT_WAYS = {
  资讯线: ["下一步", "另一面", "往深一层"],
  故事线: ["别国同母题", "原典与流行说法", "今天的痕迹"],
};
const ADAPT_WAYS = ["原典重述", "视角改写", "母题对照"];
const MOTIFS = ["大洪水", "射日", "盗火", "冥府寻人", "变形", "创世", "屠龙斩怪", "天鹅处女", "逐日", "不死药与奔月", "徒劳与坚持"];
const STORY_REPEAT_DAYS = 30;

// The per-driver number budgets, recorded because they scale with the genre.
const DRIVERS = {
  账本型: { numbers: 18, convert: 1, dense: 2 },
  处境型: { numbers: 8, convert: 1, dense: 0 },
  冲突型: { numbers: 8, convert: 1, dense: 0 },
  信息型: { numbers: 14, convert: 1, dense: 1 },
  情感型: { numbers: 4, convert: 0, dense: 0 },
  故事型: { numbers: 6, convert: 0, dense: 0 },
};

// The matrix: one cell per mode and line. A cell's rules are the union of the
// rules of its two dimensions.
function cell(mode, line) {
  const genre = MODES[mode];
  const content = LINES[line];
  return {
    mode,
    line,
    band: genre.band,
    split: genre.split,
    noTitle: genre.noTitle === true,
    noSubheadings: genre.noSubheadings === true,
    drivers: content.drivers,
    defaultDriver: content.defaultDriver,
    openings: OPENINGS[line],
    endings: ENDINGS[line],
    extWays: EXT_WAYS[line],
    storyOnly: line === "故事线" ? { adaptWays: ADAPT_WAYS, motifs: MOTIFS, repeatDays: STORY_REPEAT_DAYS } : null,
  };
}

test("A-01 the matrix has two dimensions and six cells, each cell taking the union of its dimension rules", () => {
  const modes = Object.keys(MODES);
  const lines = Object.keys(LINES);
  assert.deepEqual(modes, ["long", "short", "micro"]);
  assert.deepEqual(lines, ["资讯线", "故事线"]);
  assert.equal(modes.length * lines.length, 6);

  const microNews = cell("micro", "资讯线");
  assert.deepEqual(microNews.band, [300, 1000]);
  assert.equal(microNews.noTitle, true);
  assert.equal(microNews.noSubheadings, true);
  assert.equal(microNews.storyOnly, null);
  assert.equal(microNews.drivers.includes("故事型"), false);

  const microStory = cell("micro", "故事线");
  assert.deepEqual(microStory.band, [300, 1000]);
  assert.equal(microStory.noTitle, true);
  assert.equal(microStory.defaultDriver, "故事型");
  assert.equal(microStory.storyOnly.repeatDays, 30);
  assert.equal(microStory.storyOnly.motifs.length, 11);

  const longNews = cell("long", "资讯线");
  assert.deepEqual(longNews.band, [2600, 3400]);
  assert.deepEqual(longNews.split, { main: [1700, 2300], ext: [800, 1300] });
  assert.equal(longNews.noTitle, false);
});

test("A-01 the genre dimension carries the length bands, the long split and the micro exceptions", () => {
  assert.deepEqual(MODES.long.band, [2600, 3400]);
  assert.deepEqual(MODES.short.band, [1100, 2200]);
  assert.deepEqual(MODES.micro.band, [300, 1000]);
  // Only the long genre is split into a main part and an extension.
  assert.deepEqual(Object.keys(MODES).filter((mode) => MODES[mode].split), ["long"]);
  // Only micro drops the title and the subheadings.
  assert.deepEqual(Object.keys(MODES).filter((mode) => MODES[mode].noTitle), ["micro"]);
  // The overlap thresholds and the budget scale belong to the long split.
  const extOverlap = { warn: 0.12, fail: 0.25, shingle: 8, budgetScale: 1.5 };
  assert.equal(extOverlap.warn < extOverlap.fail, true);
  assert.equal(extOverlap.shingle, 8);
  assert.equal(extOverlap.budgetScale, 1.5);
});

test("A-01 the line dimension carries drivers, openings, endings, extension ways and story-only fields", () => {
  assert.equal(LINES.资讯线.defaultDriver, null);
  assert.equal(LINES.故事线.defaultDriver, "故事型");
  assert.equal(LINES.资讯线.drivers.length, 5);
  assert.deepEqual(LINES.故事线.drivers, ["故事型"]);
  // The two lines share some openings and endings but not all of them.
  const sharedOpenings = OPENINGS.资讯线.filter((opening) => OPENINGS.故事线.includes(opening));
  assert.deepEqual(sharedOpenings, ["直球亮底牌"]);
  const sharedEndings = ENDINGS.资讯线.filter((ending) => ENDINGS.故事线.includes(ending));
  assert.deepEqual(sharedEndings.sort(), ["两难选择", "经历共鸣", "观点碰撞"]);
  // Extension ways are disjoint between the lines.
  assert.equal(
    EXT_WAYS.资讯线.some((way) => EXT_WAYS.故事线.includes(way)),
    false,
  );
  // Story-only fields exist in exactly one line.
  assert.deepEqual(ADAPT_WAYS, ["原典重述", "视角改写", "母题对照"]);
  assert.equal(MOTIFS.length, 11);
});

test("A-01 the per-driver budgets differ, and the story and emotion drivers get a floor instead of numbers", () => {
  for (const [driver, budget] of Object.entries(DRIVERS)) {
    assert.ok(budget.numbers >= 0, driver);
    assert.ok(budget.convert >= 0, driver);
  }
  assert.equal(DRIVERS.账本型.numbers, 18);
  assert.equal(DRIVERS.情感型.numbers, 4);
  assert.equal(DRIVERS.故事型.numbers, 6);
  // The long genre relaxes the number budgets by a scale, except for the
  // conversion and dense段 allowances.
  const relaxed = Math.round(DRIVERS.账本型.numbers * 1.5);
  assert.equal(relaxed, 27);
});

test("A-01 the 3.x aliases are legacy compatibility that V2 must not inherit", () => {
  assert.deepEqual(MODE_ALIAS, { quick: "short", deep: "short" });
  assert.equal(GENRE_MODE.快图文, "short");
  assert.equal(GENRE_MODE.深图文, "short");
  // Every alias resolves to a real mode, and the real modes stay three.
  for (const [alias, target] of Object.entries(MODE_ALIAS)) {
    assert.ok(MODES[target], `${alias}->${target}`);
  }
  // V2 keeps the three modes and drops the aliases: a v1.x card naming 快图文
  // is a migration input, not a V2 mode.
  assert.equal(Object.keys(MODES).length, 3);
});

test("A-01 a missing content line falls back to the driver, and the default line is the news line", () => {
  // rules.line_of: an absent 内容线 means the story line when the driver is
  // 故事型, and the news line otherwise.
  function lineOf(card) {
    const line = (card && card["内容线"]) || "";
    if (line in LINES) return line;
    return card && card["主驱动"] === "故事型" ? "故事线" : DEFAULT_LINE;
  }
  assert.equal(lineOf({ 内容线: "故事线" }), "故事线");
  assert.equal(lineOf({ 主驱动: "故事型" }), "故事线");
  assert.equal(lineOf({ 主驱动: "账本型" }), "资讯线");
  assert.equal(lineOf({}), "资讯线");
  // Recorded v1.x behaviour: an unrecognised line is not refused, it falls
  // through to the default. That is a silent-misread risk the V2 contract
  // should close by refusing an unknown line instead (proposal, not decided).
  assert.equal(lineOf({ 内容线: "视频线" }), "资讯线");
  const unknownRefused = false;
  assert.equal(unknownRefused, false);
});

test("A-01 the matrix has one machine source, and the document layer restates parts of it", () => {
  const machineSource = ["skill/scripts/rules.py", "skill/scripts/qa_check.py"];
  const documentLayer = [
    "skill/SKILL.md",
    "skill/references/s2-selection.md",
    "skill/references/s4-common.md",
    "skill/references/s4-micro.md",
    "skill/references/s6-qa.md",
    "skill/references/s7-delivery.md",
    "profiles/default/s6-qa.md",
  ];
  assert.equal(machineSource.length, 2);
  assert.ok(documentLayer.length >= 5);
  // The documents restate bands, modes and the micro exceptions, so the V2
  // decision is which side is the source and how the other side is generated
  // or checked — not whether the matrix exists.
  const restated = {
    bands: "s2-selection.md:78（微头条 300~1000 字）",
    modes: "SKILL.md:43（S2 → S7，S4 用 s4-micro.md，质检 --mode micro）",
    microTitle: "s6-qa.md:44（标题超 34 字（微头条不查））",
  };
  assert.equal(Object.keys(restated).length, 3);
});
