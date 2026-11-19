import assert from "node:assert/strict";
import test from "node:test";
import { RecordedError } from "../support/a01.mjs";

// T-01 reference fixture for the Toutiao line. Every constant, status word and
// transition below is recorded from the v1.x implementation as forensic
// evidence, not as the frozen V2 contract: the single V2 machine rule source,
// the scenario matrix and the micro title applicability all await author
// adjudication (Q-03 in the v2.0 plan). This fixture records both v1.x
// behaviours where they diverge and adjudicates neither.
const TITLE_MAX = 34; // v1.x rules.py TITLE_MAX
const PASS_SCORE = 84; // v1.x rules.py PASS_SCORE
const FIXED_DELIVERY_ENDING = "——AI 到此止步。是否采用、何时发布由你决定。"; // v1.x toutiao domain/status.ts

// v1.x toutiao domain/status.ts word table. The V2 word table is not frozen.
const ARTICLE_STATUSES = ["初稿待改", "待验收", "已验收", "验收退回", "已交稿"];
const ARTICLE_TRANSITIONS = {
  初稿待改: ["待验收"],
  待验收: ["已验收", "验收退回", "初稿待改"],
  验收退回: ["初稿待改", "待验收"],
  已验收: ["已交稿"],
  已交稿: [],
};

class GateDenied extends RecordedError {
  constructor(from, to) {
    super("gate.denied", { from, to });
    this.message = `不允许从「${from}」直接流转到「${to}」`;
    this.from = from;
    this.to = to;
  }
}

function assertArticleTransition(from, to) {
  if (!ARTICLE_TRANSITIONS[from].includes(to)) throw new GateDenied(from, to);
}

// v1.x measures titles with Python len() and the TS matrix with UTF-16
// .length; both agree on plain CJK. Code points are used here; the V2 counting
// rule for mixed scripts is not frozen.
function titleLength(title) {
  return [...title].length;
}

// v1.x toutiao pipelines/article/helpers.ts validateTitleMatrix: the same cap
// applies to every spec, and a short or single-motif matrix fails the stage
// instead of being truncated into a pass.
function validateTitleMatrix(candidates, titleMax = TITLE_MAX) {
  const valid = [];
  const dropped = [];
  for (const item of candidates) {
    if (titleLength(item.text) <= titleMax) valid.push(item);
    else dropped.push(`${item.text}（超出 ${titleMax} 字）`);
  }
  const motifs = new Set(valid.map((item) => item.motif));
  if (valid.length < 5 || motifs.size < 3) {
    const error = new Error("标题矩阵需 ≥5 个合规标题且覆盖 ≥3 个母体");
    error.code = "model.output_invalid";
    error.validCount = valid.length;
    error.motifCount = motifs.size;
    throw error;
  }
  return { valid, dropped };
}

// v1.x qa_check.py: passed = overall >= PASS_SCORE, zero fail items and no
// hard gates. The TS gate re-checks the flag; a high score alone never passes.
function qaPassed(qa, passScore = PASS_SCORE) {
  return (
    qa.overall >= passScore &&
    qa.passed === true &&
    qa.fails.length === 0 &&
    qa.hardGates.length === 0
  );
}

// v1.x toutiao pipelines/article/qa.ts resolveQaOutcome.
function resolveQaOutcome(qa, passScore = PASS_SCORE) {
  if (qa.overall >= passScore && qa.passed) return { status: "待验收" };
  return {
    status: "初稿待改",
    qaGate: { score: qa.overall, passScore, fails: qa.fails, hardGates: qa.hardGates },
  };
}

// v1.x toutiao pipelines/article/qa.ts runQaRevisionLoop: at most two automatic
// refinement rounds, each rechecked against the real rule result; the loop only
// targets fails and hard gates.
function runQaRevisionLoop({ draft, qa, revise, recheck }) {
  const rounds = [];
  let currentDraft = draft;
  let currentQa = qa;
  for (let round = 1; round <= 2; round += 1) {
    if (currentQa.overall >= PASS_SCORE && currentQa.passed) break;
    const revised = revise(currentDraft, currentQa, round);
    rounds.push(round);
    currentDraft = revised.draft;
    currentQa = recheck(revised.draft, round);
  }
  return { draft: currentDraft, qa: currentQa, refineRounds: rounds };
}

// Author acceptance is a separate action from the QA gate; the writing agent
// cannot accept, reject or deliver at any point.
function decideArticle(article, actor, decision) {
  if (actor !== "author") return { article, outcome: "author-required" };
  if (decision === "accept") {
    assertArticleTransition(article.status, "已验收");
    return { article: { ...article, status: "已验收" }, outcome: "accepted" };
  }
  assertArticleTransition(article.status, "验收退回");
  return { article: { ...article, status: "验收退回" }, outcome: "rejected" };
}

// v1.x toutiao commands/article.ts deliverArticleCommand: the command checks the
// current status, writes the delivery sheet with the fixed ending, and is
// idempotent once delivered. Whether the ledger linkage belongs to the V2
// delivery transaction is not frozen.
function deliverArticle(article, actor) {
  if (actor !== "author") return { article, outcome: "author-required" };
  if (article.status === "已交稿") {
    return { article, outcome: "already-delivered", deliveryPath: "交稿单.md" };
  }
  assertArticleTransition(article.status, "已交稿");
  const delivery = `# ${article.title}\n\n${article.body.trim()}\n\n${FIXED_DELIVERY_ENDING}\n`;
  return {
    article: { ...article, status: "已交稿" },
    outcome: "delivered",
    deliveryPath: "交稿单.md",
    delivery,
  };
}

const matrix = [
  { text: "三十四字整的标题合规压在线上刚好通过不带标点", motif: "母体一" },
  { text: "第二个合规标题同样控制在三十四字以内可以吗", motif: "母体二" },
  { text: "第三个合规标题写短一点也没有任何问题存在", motif: "母体三" },
  { text: "第四个合规标题换个说法继续覆盖合格的长度", motif: "母体一" },
  { text: "第五个合规标题收尾全文完毕至此矩阵达到五个", motif: "母体二" },
];

test("T-01 a title of exactly the recorded cap passes and one character more does not", () => {
  const atCap = "甲".repeat(TITLE_MAX);
  const overCap = "甲".repeat(TITLE_MAX + 1);

  assert.equal(titleLength(atCap), 34);
  assert.equal(titleLength(atCap) <= TITLE_MAX, true);
  assert.equal(titleLength(overCap) <= TITLE_MAX, false);
  assert.deepEqual(validateTitleMatrix([...matrix, { text: overCap, motif: "母体三" }]).dropped, [
    `${overCap}（超出 ${TITLE_MAX} 字）`,
  ]);
});

test("T-01 the recorded title matrix applies the same cap to every spec", () => {
  // v1.x evidence: the TS matrix validates long, short and micro candidates
  // against the same 34-character cap. Recorded as-is; not adjudicated for V2.
  const result = validateTitleMatrix(matrix);

  assert.equal(result.valid.length, 5);
  assert.deepEqual(result.dropped, []);
  assert.equal(
    validateTitleMatrix(matrix, TITLE_MAX).valid.every((item) => titleLength(item.text) <= 34),
    true,
  );
});

test("T-01 micro drafts carry no title, so the recorded QA length gate skips them", () => {
  // v1.x evidence: qa_check.py computes the title-too-long hard gate only when
  // a title exists (non-micro); the TS matrix still applies the cap to every
  // spec. The two v1.x applicability conditions diverge for micro and the V2
  // micro boundary awaits author adjudication (Q-03); this fixture records the
  // divergence without choosing a side.
  const micro = { mode: "micro", title: "", hook: "首句钩子八个字" };
  const nonMicro = { mode: "long", title: "甲".repeat(35), hook: "" };

  const titleTooLong = (input) => input.mode !== "micro" && titleLength(input.title) > TITLE_MAX;

  assert.equal(titleTooLong(micro), false);
  assert.equal(titleTooLong(nonMicro), true);
  assert.equal(titleLength(micro.hook) <= 30, true); // v1.x micro hook band 8~30
});

test("T-01 a short or single-motif title matrix fails the stage instead of being truncated into a pass", () => {
  const tooFew = matrix.slice(0, 4);
  const oneMotif = matrix.map((item) => ({ ...item, motif: "母体一" }));

  assert.throws(() => validateTitleMatrix(tooFew), (error) => error.code === "model.output_invalid");
  assert.throws(
    () => validateTitleMatrix(oneMotif),
    (error) => error.code === "model.output_invalid" && error.motifCount === 1,
  );
});

test("T-01 a draft passes QA only when score, flag, fails and hard gates all clear", () => {
  const base = { overall: 90, passed: true, fails: [], hardGates: [] };

  assert.equal(qaPassed({ ...base, overall: PASS_SCORE }), true);
  assert.equal(qaPassed({ ...base, overall: PASS_SCORE - 1 }), false);
  assert.equal(qaPassed({ ...base, passed: false }), false);
  assert.equal(qaPassed({ ...base, fails: [{ code: "ai", message: "AI 腔" }] }), false);
  assert.equal(qaPassed({ ...base, hardGates: ["标题超34字"] }), false);
});

test("T-01 a passing draft reaches 待验收 and a failing draft stays 初稿待改 with its gate", () => {
  const passing = resolveQaOutcome({ overall: 84, passed: true, fails: [], hardGates: [] });
  const highScoreButFailed = resolveQaOutcome({
    overall: 92,
    passed: false,
    fails: [{ code: "compliance", message: "绝对化用语" }],
    hardGates: [],
  });
  const hardGate = resolveQaOutcome({
    overall: 88,
    passed: false,
    fails: [],
    hardGates: ["标题超34字"],
  });

  assert.deepEqual(passing, { status: "待验收" });
  assert.equal(highScoreButFailed.status, "初稿待改");
  assert.equal(highScoreButFailed.qaGate.score, 92);
  assert.equal(hardGate.status, "初稿待改");
  assert.deepEqual(hardGate.qaGate.hardGates, ["标题超34字"]);

  // The protected pass line is inclusive on both paths: the flag gate above
  // pins PASS_SCORE - 1, and the status path pins it here too, so an
  // implementation using a strict "greater than" cannot pass either one.
  const oneBelow = resolveQaOutcome({
    overall: PASS_SCORE - 1,
    passed: true,
    fails: [],
    hardGates: [],
  });
  assert.equal(oneBelow.status, "初稿待改");
  assert.equal(oneBelow.qaGate.score, PASS_SCORE - 1);
  assert.equal(oneBelow.qaGate.passScore, PASS_SCORE);
});

test("T-01 a failing draft keeps 初稿待改 after at most two automatic refinement rounds", () => {
  const failing = { overall: 71, passed: false, fails: [{ code: "ai", message: "AI 腔" }], hardGates: [] };
  const revised = { overall: 80, passed: false, fails: [{ code: "ai", message: "AI 腔" }], hardGates: [] };
  const reviseCalls = [];

  const neverPasses = runQaRevisionLoop({
    draft: "初稿",
    qa: failing,
    revise: (draft, qa, round) => {
      reviseCalls.push(round);
      return { draft: `${draft}+改${round}` };
    },
    recheck: () => revised,
  });

  assert.deepEqual(neverPasses.refineRounds, [1, 2]);
  assert.equal(neverPasses.draft, "初稿+改1+改2");
  assert.equal(neverPasses.qa.overall, 80);
  assert.equal(resolveQaOutcome(neverPasses.qa).status, "初稿待改");

  const passing = { overall: 86, passed: true, fails: [], hardGates: [] };
  const passesOnFirstRetry = runQaRevisionLoop({
    draft: "初稿",
    qa: failing,
    revise: (draft) => ({ draft: `${draft}+改1` }),
    recheck: () => passing,
  });

  assert.deepEqual(passesOnFirstRetry.refineRounds, [1]);
  assert.equal(resolveQaOutcome(passesOnFirstRetry.qa).status, "待验收");
});

test("T-01 QA pass is not author acceptance; only the author accepts or rejects", () => {
  const awaiting = { id: "article-1", status: "待验收", title: "标题", body: "正文" };
  const agentAccept = decideArticle(awaiting, "agent", "accept");
  const agentReject = decideArticle(awaiting, "agent", "reject");
  const authorAccept = decideArticle(awaiting, "author", "accept");
  const authorReject = decideArticle(awaiting, "author", "reject");

  assert.equal(agentAccept.outcome, "author-required");
  assert.strictEqual(agentAccept.article, awaiting);
  assert.equal(agentReject.outcome, "author-required");
  assert.equal(authorAccept.article.status, "已验收");
  assert.equal(authorReject.article.status, "验收退回");
});

test("T-01 delivery requires 已验收, writes the fixed ending, and is idempotent once delivered", () => {
  const accepted = { id: "article-1", status: "已验收", title: "标题", body: "正文" };
  const delivered = deliverArticle(accepted, "author");
  const again = deliverArticle(delivered.article, "author");
  const agentAttempt = deliverArticle(accepted, "agent");

  assert.equal(delivered.outcome, "delivered");
  assert.equal(delivered.article.status, "已交稿");
  assert.ok(delivered.delivery.endsWith(`${FIXED_DELIVERY_ENDING}\n`));
  assert.equal(delivered.delivery.split(FIXED_DELIVERY_ENDING).length - 1, 1);
  assert.equal(again.outcome, "already-delivered");
  assert.strictEqual(again.article, delivered.article);
  assert.equal(agentAttempt.outcome, "author-required");
  assert.strictEqual(agentAttempt.article, accepted);
});

test("T-01 transitions outside the recorded table are denied and terminal states stay terminal", () => {
  const denied = [
    ["初稿待改", "已交稿"],
    ["初稿待改", "已验收"],
    ["待验收", "已交稿"],
    ["验收退回", "已验收"],
  ];

  for (const [from, to] of denied) {
    assert.throws(() => assertArticleTransition(from, to), GateDenied);
  }
  for (const to of ARTICLE_STATUSES) {
    assert.throws(() => assertArticleTransition("已交稿", to), GateDenied);
  }
  assert.deepEqual(ARTICLE_TRANSITIONS.已交稿, []);
});
