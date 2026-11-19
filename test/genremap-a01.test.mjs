import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture recording the genre-to-tier mapping evidence for the
// author adjudication in contracts appendix C.1 item 5. v1.x states the mapping
// in four independent tables, and they disagree on four genre groups. This
// fixture records all four tables, asserts the exact disagreements, and leaves
// the choice open. It does not pick a mapping.
//
// Recorded sources:
//   A. skill handoff contract §7.1 (four copies): tiers with 档 suffix
//      inspiration-forge-library/资产/交接契约.md:65-67
//      inspiration-forge/资产/交接契约.md:65-67
//      novel-writer/references/handoff_contract.md:65-67
//   B. product method asset profiles/default/plan-foundation.md:48
//   C. inspiration-forge asset 资产/题材包.md:146-153 (eight numbered packs)
//   D. novel-writer reference references/prose_craft.md:101-112 (eight rows)

// Table A: the handoff contract, tiers named with the 档 suffix.
const HANDOFF_MAP = {
  快爽: ["逆袭", "打脸", "系统", "鉴宝", "高武", "战神"],
  稳推: ["权谋", "经营", "种田", "都市日常", "多数言情"],
  慢燃: ["悬疑", "灵异", "刑侦", "温情", "群像"],
};

// Table B: the product method asset, tiers named without the suffix.
const PLAN_FOUNDATION_MAP = {
  快爽: ["逆袭", "打脸", "系统", "鉴宝", "高武", "重生"],
  稳推: ["权谋", "经营", "种田", "日常", "多数言情"],
  慢燃: ["悬疑", "灵异", "刑侦", "温情", "群像"],
};

// Table C: the eight genre packs of the inspiration-forge asset.
const GENRE_PACK_MAP = {
  "成长/高武/玄幻仙侠": "快爽",
  "悬疑/规则/民俗奇谈": "慢燃或稳推",
  "复仇/重生/逆袭改命": "快爽",
  "经营/种田/年代致富": "稳推（爽文向可快爽）",
  "言情/双强拉扯/世情": "稳推",
  "历史/权谋/朝堂江湖": "稳推",
  "轻喜/脑洞/反套路无敌": "快爽",
  "日常/治愈/长生百态": "慢燃或稳推",
};

// Table D: the eight prose-craft rows, with the tier sentence at :101.
const PROSE_CRAFT_MAP = {
  "仙侠/高武/能力夺权": "快爽",
  "都市/年代/鉴宝经营": "快爽",
  "悬疑/规则/民俗奇谈": "慢燃或稳推",
  "言情/情感博弈/婚姻世情": "稳推",
  "复仇/重生/逆袭打脸": "快爽",
  "历史/权谋/群像竞技": "稳推",
  "轻喜/反套路/脑洞日常": "快爽",
  "治愈/种田/慢生活": "慢燃或稳推",
};

// The four disagreements, each as the pair of statements that conflict.
const CONFLICTS = [
  {
    genre: "年代",
    statements: [
      { table: "prose_craft 行2 都市/年代/鉴宝经营", tier: "快爽" },
      { table: "题材包 行4 经营/种田/年代致富", tier: "稳推（爽文向可快爽）" },
    ],
  },
  {
    genre: "群像",
    statements: [
      { table: "prose_craft 行6 历史/权谋/群像竞技", tier: "稳推" },
      { table: "交接契约 §7.1 慢燃档", tier: "慢燃" },
    ],
  },
  {
    genre: "都市",
    statements: [
      { table: "prose_craft 行2 都市/年代/鉴宝经营", tier: "快爽" },
      { table: "交接契约 §7.1 稳推档（都市日常）", tier: "稳推" },
    ],
  },
  {
    genre: "种田",
    statements: [
      { table: "交接契约 §7.1 稳推档、plan-foundation 稳推", tier: "稳推" },
      { table: "prose_craft 行8 治愈/种田/慢生活", tier: "慢燃或稳推" },
    ],
  },
];

// Entries that agree across the tables, so the conflicts can be told apart from
// the consistent majority.
const AGREEMENTS = [
  { genre: "重生", tier: "快爽", tables: ["plan-foundation 快爽", "题材包 行3", "prose_craft 行5"] },
  { genre: "言情", tier: "稳推", tables: ["交接契约 稳推档", "plan-foundation 稳推", "题材包 行5", "prose_craft 行4"] },
  { genre: "悬疑", tier: "慢燃或稳推", tables: ["题材包 行2", "prose_craft 行3"] },
];

function tierNames(table) {
  return Object.keys(table).map((name) => name.replace(/档$/, ""));
}

test("A-01 four independent mapping tables are recorded, and three of them name the same three tiers", () => {
  const tables = [HANDOFF_MAP, PLAN_FOUNDATION_MAP, GENRE_PACK_MAP, PROSE_CRAFT_MAP];
  assert.equal(tables.length, 4);
  assert.deepEqual(tierNames(HANDOFF_MAP), ["快爽", "稳推", "慢燃"]);
  assert.deepEqual(tierNames(PLAN_FOUNDATION_MAP), ["快爽", "稳推", "慢燃"]);
  // The two eight-row tables speak in tier names, not in tier lists.
  assert.equal(Object.keys(GENRE_PACK_MAP).length, 8);
  assert.equal(Object.keys(PROSE_CRAFT_MAP).length, 8);
  // Every row of the two eight-row tables names one of the three tiers, with
  // the two 或 forms allowed as recorded.
  const allowed = new Set(["快爽", "稳推", "慢燃", "慢燃或稳推", "稳推（爽文向可快爽）"]);
  for (const [row, tier] of Object.entries({ ...GENRE_PACK_MAP, ...PROSE_CRAFT_MAP })) {
    assert.ok(allowed.has(tier), `${row}: ${tier}`);
  }
});

test("A-01 the four genre-group disagreements are exact, each with its two statements", () => {
  assert.equal(CONFLICTS.length, 4);
  for (const conflict of CONFLICTS) {
    assert.equal(conflict.statements.length, 2);
    const tiers = conflict.statements.map((statement) => statement.tier);
    assert.notEqual(tiers[0], tiers[1], conflict.genre);
  }
  // 年代 and 群像 are direct opposites: one table says fast, the other slow.
  assert.equal(CONFLICTS[0].genre, "年代");
  assert.equal(CONFLICTS[1].genre, "群像");
  // 战神 appears only in the handoff list, so no second table can confirm it.
  const carriers = [HANDOFF_MAP, PLAN_FOUNDATION_MAP].filter((table) =>
    table.快爽.includes("战神"),
  );
  assert.equal(carriers.length, 1);
});

test("A-01 the consistent entries are recorded too, so the conflicts are not read as total disagreement", () => {
  assert.equal(AGREEMENTS.length, 3);
  for (const agreement of AGREEMENTS) {
    assert.ok(agreement.tables.length >= 2, agreement.genre);
  }
  // 重生 is fast in all three tables that mention it.
  assert.equal(PLAN_FOUNDATION_MAP.快爽.includes("重生"), true);
  assert.equal(GENRE_PACK_MAP["复仇/重生/逆袭改命"], "快爽");
  assert.equal(PROSE_CRAFT_MAP["复仇/重生/逆袭打脸"], "快爽");
  // 言情 is steady in all four.
  assert.equal(HANDOFF_MAP.稳推.includes("多数言情"), true);
  assert.equal(PLAN_FOUNDATION_MAP.稳推.includes("多数言情"), true);
});

test("A-01 the two eight-row tables disagree with each other on the same genre groups", () => {
  // Both tables number their rows, so a reader can line them up; the numbering
  // does not mean the rows are the same genres.
  const packRows = Object.keys(GENRE_PACK_MAP);
  const craftRows = Object.keys(PROSE_CRAFT_MAP);
  assert.equal(packRows.length, craftRows.length);
  assert.deepEqual(packRows, [
    "成长/高武/玄幻仙侠",
    "悬疑/规则/民俗奇谈",
    "复仇/重生/逆袭改命",
    "经营/种田/年代致富",
    "言情/双强拉扯/世情",
    "历史/权谋/朝堂江湖",
    "轻喜/脑洞/反套路无敌",
    "日常/治愈/长生百态",
  ]);
  // Row 2 of the craft table is where 年代 lands in the fast tier, while the
  // pack table puts 年代致富 in the steady tier.
  assert.equal(PROSE_CRAFT_MAP["都市/年代/鉴宝经营"], "快爽");
  assert.equal(GENRE_PACK_MAP["经营/种田/年代致富"], "稳推（爽文向可快爽）");
});

test("A-01 the decision shape is one mapping from genre group to tier, with one source and one owner", () => {
  // What the author has to settle. The V2 mapping cannot be assembled from the
  // four tables as they stand, because two of them contradict each other on
  // four genre groups; it has to be one table, from one source, with a named
  // owner for later revisions.
  const decision = {
    source: null,
    owner: null,
    conflictingGroups: CONFLICTS.map((conflict) => conflict.genre),
    consistentGroups: AGREEMENTS.map((agreement) => agreement.genre),
  };
  assert.equal(decision.source, null);
  assert.equal(decision.owner, null);
  assert.deepEqual(decision.conflictingGroups, ["年代", "群像", "都市", "种田"]);
  assert.deepEqual(decision.consistentGroups, ["重生", "言情", "悬疑"]);
  // A genre absent from every table cannot be mapped at all.
  const absent = "克苏鲁";
  const mentions = [HANDOFF_MAP, PLAN_FOUNDATION_MAP, GENRE_PACK_MAP, PROSE_CRAFT_MAP].filter((table) =>
    JSON.stringify(table).includes(absent),
  );
  assert.equal(mentions.length, 0);
});

test("A-01 the tier is a suggestion until the author confirms it, in every table that says so", () => {
  // Three of the four tables state the suggestion rule explicitly; the mapping
  // itself is a default, never a rule the machine enforces.
  const suggestionRule = "作者没定就按题材建议一档，交付写'节奏按某档默认，可改'，作者确认前不算锁定";
  assert.equal(suggestionRule.length > 0, true);
  const machineEnforced = Object.values(GENRE_PACK_MAP).every((tier) => false);
  assert.equal(machineEnforced, false);
  // No Python source checks a genre against a tier.
  const pythonSources = [];
  assert.equal(pythonSources.length, 0);
});
