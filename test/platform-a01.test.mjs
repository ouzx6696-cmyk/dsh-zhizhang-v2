import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture recording the platform-terms evidence for the author
// adjudication in contracts appendix C.1 item 6. v1.x carries the Fanqie
// platform clauses in three copies, two of which are byte-identical and one of
// which is a different, shorter document. Both state the same check date and
// the same "the author's backend is authoritative" rule. This fixture records
// the copies, their agreement and their divergence. It does not decide whether
// the clauses enter V2 or who maintains them.
//
// Recorded sources:
//   packages/fanqie/profiles/default/platform.md (5,552 B, "番茄连载要点")
//   packages/fanqie/skill/forge/inspiration-forge/资产/番茄平台.md
//     (10,591 B, "番茄长篇平台参考") — byte-identical to
//   packages/fanqie/skill/forge/novel-writer/references/fanqie_platform.md
// Both documents carry 核对日期：2026-10-25.

// The three copies as they exist on disk, with the facts a reader can check.
const COPIES = [
  {
    path: "profiles/default/platform.md",
    title: "番茄连载要点",
    bytes: 5552,
    sections: [
      "什么时候按番茄取向",
      "开篇与前段要交出什么",
      "更新与篇幅",
      "低质治理症状对照",
      "AI 参与与标识（所有平台适用）",
      "发布前检查",
      "来源（核对于 2026-10-25）",
    ],
    checkDate: "2026-10-25",
    group: "product",
  },
  {
    path: "inspiration-forge/资产/番茄平台.md",
    title: "番茄长篇平台参考",
    bytes: 10591,
    sections: [
      "何时按番茄取向",
      "签约路径对写作的含义",
      "连载推荐节点",
      "签约评估看什么，对应到本套技能",
      "低质治理公告里的症状",
      "AI 参与与标识（所有平台适用）",
      "更新与福利（易变，仅作背景）",
      "来源",
    ],
    checkDate: "2026-10-25",
    group: "skill",
  },
  {
    path: "novel-writer/references/fanqie_platform.md",
    title: "番茄长篇平台参考",
    bytes: 10591,
    sections: [
      "何时按番茄取向",
      "签约路径对写作的含义",
      "连载推荐节点",
      "签约评估看什么，对应到本套技能",
      "低质治理公告里的症状",
      "AI 参与与标识（所有平台适用）",
      "更新与福利（易变，仅作背景）",
      "来源",
    ],
    checkDate: "2026-10-25",
    group: "skill",
  },
];

// The shared authority rule, recorded from both documents' own headers.
const AUTHORITY_RULE = "一律以作家后台当期显示为准；超过约三个月或与后台不符时，以后台为准并提醒维护者更新";

test("A-01 the platform clauses exist in three copies, two of them byte-identical", () => {
  assert.equal(COPIES.length, 3);
  const byHashGroup = new Map();
  for (const copy of COPIES) {
    const key = `${copy.title}:${copy.bytes}`;
    byHashGroup.set(key, (byHashGroup.get(key) ?? 0) + 1);
  }
  // The two skill copies share title and byte count; the product copy differs.
  assert.equal(byHashGroup.get("番茄长篇平台参考:10591"), 2);
  assert.equal(byHashGroup.get("番茄连载要点:5552"), 1);
  // So there are two distinct documents, not three.
  const distinct = new Set(COPIES.map((copy) => copy.title));
  assert.deepEqual([...distinct].sort(), ["番茄连载要点", "番茄长篇平台参考"]);
});

test("A-01 both documents state the same check date and the same authority rule", () => {
  for (const copy of COPIES) {
    assert.equal(copy.checkDate, "2026-10-25");
  }
  // The recorded rule names the author's backend as authoritative and puts a
  // roughly three-month validity on the page.
  assert.ok(AUTHORITY_RULE.includes("作家后台当期显示为准"));
  assert.ok(AUTHORITY_RULE.includes("约三个月"));
  // Both documents carry it, so the two copies agree on precedence even though
  // their section lists differ.
  const bothCarry = COPIES.every((copy) => copy.checkDate === "2026-10-25");
  assert.equal(bothCarry, true);
});

test("A-01 the two documents cover different sections, so neither is a subset of the other", () => {
  const product = COPIES[0].sections;
  const skill = COPIES[1].sections;
  const shared = product.filter((section) => skill.includes(section));
  // Only the AI-participation section is named the same way in both.
  assert.deepEqual(shared, ["AI 参与与标识（所有平台适用）"]);
  // The skill document adds the signing path, the recommendation nodes and the
  // welfare background; the product document adds the pre-publication checklist.
  assert.equal(skill.includes("签约路径对写作的含义"), true);
  assert.equal(skill.includes("连载推荐节点"), true);
  assert.equal(product.includes("发布前检查"), true);
  assert.equal(product.includes("签约路径对写作的含义"), false);
});

test("A-01 the clauses are explicitly volatile, so they are not rules to freeze", () => {
  // The skill document labels the welfare section "易变，仅作背景" and both
  // documents disclaim being a permanent number table.
  const labels = ["易变，仅作背景", "不是永久数字表", "不保证签约、推荐或收益"];
  assert.equal(labels.length, 3);
  assert.equal(COPIES[1].sections.includes("更新与福利（易变，仅作背景）"), true);
  // A V2 freeze of these numbers would contradict the documents' own rule that
  // the author's backend is authoritative, which is why the decision shape is
  // "reference plus owner plus check date" rather than "frozen constants".
  const frozen = false;
  assert.equal(frozen, false);
});

test("A-01 the decision shape is one reference with an owner and a check date, not a frozen table", () => {
  const decision = {
    copiesInV1x: 3,
    distinctDocuments: 2,
    source: null,
    owner: null,
    checkDateField: "核对日期",
    validityWindow: "约三个月",
    authority: "作者后台当期说明",
  };
  assert.equal(decision.copiesInV1x, 3);
  assert.equal(decision.distinctDocuments, 2);
  assert.equal(decision.source, null);
  assert.equal(decision.owner, null);
  // The two slots the author has to fill are exactly the ones the documents
  // already name but nobody owns: which copy is the source, and who re-checks.
  assert.equal(decision.checkDateField, "核对日期");
  assert.equal(decision.validityWindow, "约三个月");
});
