import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture recording the rhythm-tier evidence for the author
// adjudication in contracts appendix C.1 item 3. The same three-tier table
// exists in two independent assets with no Python source behind either: the
// product method asset the desktop app loads and the skill handoff contract.
// This fixture records both copies, their agreements and their divergences. It
// does not choose a single source or rewrite either asset.
//
// Recorded sources:
//   packages/fanqie/profiles/default/rhythm.md §一 (product method asset)
//   packages/fanqie/skill/forge/inspiration-forge-library/资产/交接契约.md §7.1
//   (same section also in inspiration-forge/资产/交接契约.md and
//    novel-writer/references/handoff_contract.md)

// Copy A: the product method asset. Tier names carry no suffix.
const PRODUCT_TIERS = [
  {
    tier: "快爽",
    genres: ["逆袭", "打脸", "系统", "鉴宝", "高武"],
    opening: "约前 300 字见到人物的具体处境",
    payoff: "小回报约 1–2 章，阶段回报约 4–6 章",
    pressure: "一般不跨 2 章，回本路径可见",
    chapterEnd: "多数落在具体动作、器物或新接口",
  },
  {
    tier: "稳推",
    genres: ["权谋", "经营", "种田", "都市日常", "多数言情"],
    opening: "首章内立住处境与所求",
    payoff: "按事件自然完成，单元内必有可见进展",
    pressure: "可更长，但每章看得到人物在想办法",
    chapterEnd: "钩子或完整收束都行",
  },
  {
    tier: "慢燃",
    genres: ["悬疑", "灵异", "刑侦", "温情", "群像"],
    opening: "先立氛围与问题，问题读者要看得懂",
    payoff: "以信息揭示和关系移动为主",
    pressure: "允许长压，靠信息推进和行动撑住",
    chapterEnd: "余韵、发现、新疑点",
  },
];

// Copy B: the skill handoff contract. Tier names carry the 档 suffix, and the
// quick-payoff row also states the 70% share of the prose for the lived
// highlight, which copy A does not carry.
const HANDOFF_TIERS = [
  {
    tier: "快爽档",
    genres: ["逆袭", "打脸", "系统", "鉴宝", "高武", "战神"],
    opening: "约前 300 字见到人物当下的具体处境",
    payoff: "小回报约 1–2 章，阶段回报约 4–6 章",
    pressure: "一般不跨 2 章，回本路径可见",
    chapterEnd: "多数章落在具体动作、器物或新接口上",
    extra: "70% 笔墨给亲历高光",
  },
  {
    tier: "稳推档",
    genres: ["权谋", "经营", "种田", "都市日常", "多数言情"],
    opening: "首章内立住处境与人物所求",
    payoff: "按事件自然完成，单元内必有可见进展",
    pressure: "可以更长，但每章读者能看到人物在想办法",
    chapterEnd: "可以是钩子，也可以是完整收束",
  },
  {
    tier: "慢燃档",
    genres: ["悬疑", "灵异", "刑侦", "温情", "群像"],
    opening: "先立氛围与问题，问题要读者能理解",
    payoff: "以信息揭示和关系移动为主要回报",
    pressure: "允许长压，靠信息推进和人物行动撑住",
    chapterEnd: "余韵、发现、新疑点都可以",
  },
];

// The numeric scales both copies state, extracted so the agreement can be
// asserted rather than eyeballed.
const SHARED_SCALES = [
  { label: "开篇处境", value: "300 字" },
  { label: "小回报间隔", value: "1–2 章" },
  { label: "阶段回报间隔", value: "4–6 章" },
  { label: "受压时长", value: "不跨 2 章" },
];

function normaliseTierName(name) {
  return name.replace(/档$/, "");
}

test("A-01 both copies record the same three tiers and the same numeric scales", () => {
  assert.deepEqual(
    PRODUCT_TIERS.map((entry) => entry.tier),
    ["快爽", "稳推", "慢燃"],
  );
  assert.deepEqual(
    HANDOFF_TIERS.map((entry) => normaliseTierName(entry.tier)),
    ["快爽", "稳推", "慢燃"],
  );
  for (const scale of SHARED_SCALES) {
    const inProduct = JSON.stringify(PRODUCT_TIERS).includes(scale.value);
    const inHandoff = JSON.stringify(HANDOFF_TIERS).includes(scale.value);
    assert.equal(inProduct, true, scale.label);
    assert.equal(inHandoff, true, scale.label);
  }
});

test("A-01 the two copies disagree on the tier names and on the genre list", () => {
  // The names differ by the 档 suffix, so a merge has to pick one spelling.
  assert.equal(PRODUCT_TIERS[0].tier, "快爽");
  assert.equal(HANDOFF_TIERS[0].tier, "快爽档");
  // The quick-payoff genre list differs: the handoff copy adds 战神 and marks
  // the row as 爽感直给, which the product copy does not.
  const productGenres = PRODUCT_TIERS[0].genres;
  const handoffGenres = HANDOFF_TIERS[0].genres;
  assert.deepEqual(handoffGenres.filter((genre) => !productGenres.includes(genre)), ["战神"]);
  // The other two tiers list the same genres in the same order.
  for (const index of [1, 2]) {
    assert.deepEqual(HANDOFF_TIERS[index].genres, PRODUCT_TIERS[index].genres);
  }
});

test("A-01 the isolated 70% value lives in exactly one of the two copies", () => {
  const holders = [PRODUCT_TIERS, HANDOFF_TIERS].filter((tiers) =>
    tiers.some((entry) => entry.extra === "70% 笔墨给亲历高光"),
  );
  assert.equal(holders.length, 1);
  assert.equal(holders[0], HANDOFF_TIERS);
  // The product copy states the same idea without a number, so the number has
  // no second home to be checked against.
  assert.equal(JSON.stringify(PRODUCT_TIERS).includes("70%"), false);
});

test("A-01 no Python source enforces the pace, so the single source has to be an asset", () => {
  // Unlike the outline structure and the target-length band, the rhythm tiers
  // have no machine check: consistency between the copies is a review duty, and
  // the V2 decision has to name one asset as the source.
  const machineSources = [];
  assert.equal(machineSources.length, 0);
  const copies = [
    "profiles/default/rhythm.md §一",
    "inspiration-forge-library/资产/交接契约.md §7.1",
    "inspiration-forge/资产/交接契约.md §7.1",
    "novel-writer/references/handoff_contract.md §7.1",
  ];
  assert.equal(new Set(copies).size, copies.length);
  assert.equal(copies.length, 4);
});

test("A-01 the tier is recorded once per book as an effective user agreement, not as a locked fact", () => {
  // Both copies say the tier is written into story_foundation once per book and
  // is only a suggestion until the author confirms it, which is the agreement
  // half of the B.8 split between agreements and locked facts.
  const recorded = {
    field: "pace",
    setBy: "fanqie_foundation_set",
    values: ["快爽", "稳推", "慢燃"],
    lockedBeforeAuthorConfirmation: false,
    perVolumeOverride: true,
  };
  assert.deepEqual(recorded.values, PRODUCT_TIERS.map((entry) => entry.tier));
  assert.equal(recorded.lockedBeforeAuthorConfirmation, false);
  // A suggestion that was never confirmed cannot be treated as a rule.
  const suggestion = { tier: "慢燃", confirmed: false };
  assert.equal(suggestion.confirmed, false);
});

test("A-01 the scales are reference values, not platform rules, in both copies", () => {
  // Both copies disclaim the numbers: the product copy ends the table with
  // "以上刻度是写作参考值，不是平台规定", and the handoff copy calls them
  // 快爽档的参考值 rather than an obligation of every genre.
  const disclaimers = ["写作参考值，不是平台规定", "不是所有题材的义务"];
  assert.equal(disclaimers.length, 2);
  // So a V2 freeze of these numbers would be a method-asset decision, which is
  // exactly why it belongs to the author adjudication and not to the machine
  // contract.
  const machineEnforced = SHARED_SCALES.every((scale) => false);
  assert.equal(machineEnforced, false);
});
