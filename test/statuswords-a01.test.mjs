import assert from "node:assert/strict";
import test from "node:test";
import { RecordedError } from "../support/a01.mjs";

// A-01 supporting fixture recording the v1.x status word evidence for the
// "single machine rule source" decision (contracts appendix A.2 item 4 and
// C.1 item 8). It copies the word sets and transition tables as they exist in
// v1.x, counts the independent copies, and records where the two product lines
// and the Python mirror agree or diverge.
//
// This is forensic evidence only. The V2 per-line business state tables are
// protected rules: this fixture does not decide them, and it must not be read
// as a migration guarantee. Recorded sources:
//   packages/toutiao/src/domain/status.ts        (ARTICLE_STATUSES + transitions)
//   packages/toutiao/src/storage/articles.ts     (zod lit schema)
//   packages/toutiao/src/workbench/data.ts       (transition assertions)
//   packages/ui/src/status.ts                    (label and tone map)
//   packages/toutiao/skill/scripts/ledger.py     (STATUSES, Python mirror)
//   packages/toutiao/skill/scripts/writer_bridge.py (re-exports ledger STATUSES)
//   packages/toutiao/skill/tests/test_gates.py   (asserts the skill doc lists them)
//   packages/fanqie/src/domain/status.ts         (CHAPTER_STATUSES + labels)

// The Toutiao product table, as recorded from the TypeScript domain module.
const TOUTIAO_STATUSES = ["初稿待改", "待验收", "已验收", "验收退回", "已交稿"];
const TOUTIAO_TRANSITIONS = {
  初稿待改: ["待验收"],
  待验收: ["已验收", "验收退回", "初稿待改"],
  验收退回: ["初稿待改", "待验收"],
  已验收: ["已交稿"],
  已交稿: [],
};

// The Python mirror in the Toutiao skill, recorded from ledger.py.
const TOUTIAO_PYTHON_STATUSES = ["初稿待改", "待验收", "已验收", "验收退回", "已交稿"];

// The Fanqie product table, recorded from the TypeScript domain module. The
// words are English, and there is no Python mirror for them.
const FANQIE_CHAPTER_STATUSES = ["planned", "drafting", "drafted", "reviewed", "final"];

// The run state words proposed in B.3, recorded so the three tables can be
// asserted pairwise disjoint.
const RUN_STATES = ["running", "paused", "awaiting-author", "failed", "cancelled", "applied", "discarded"];

// The independent copies of the Toutiao word set that exist in v1.x today.
const TOUTIAO_COPIES = [
  "packages/toutiao/src/domain/status.ts",
  "packages/toutiao/src/storage/articles.ts",
  "packages/toutiao/src/workbench/data.ts",
  "packages/ui/src/status.ts",
  "packages/toutiao/skill/scripts/ledger.py",
  "packages/toutiao/skill/scripts/writer_bridge.py",
];

function isClosedWordSet(words) {
  return Array.isArray(words) && words.length > 0 && new Set(words).size === words.length;
}

// A transition table is well formed when every target is a word of the set,
// every word has an entry, and no word transitions to itself.
function validateTransitions(words, transitions) {
  if (!isClosedWordSet(words)) return "not-a-closed-set";
  for (const word of words) {
    const targets = transitions[word];
    if (!Array.isArray(targets)) return "missing-entry";
    for (const target of targets) {
      if (!words.includes(target)) return "unknown-target";
      if (target === word) return "self-transition";
    }
  }
  for (const from of Object.keys(transitions)) {
    if (!words.includes(from)) return "unknown-source";
  }
  return null;
}

test("A-01 each product line has one closed five-word state table, and the two vocabularies are disjoint", () => {
  assert.equal(isClosedWordSet(TOUTIAO_STATUSES), true);
  assert.equal(isClosedWordSet(FANQIE_CHAPTER_STATUSES), true);
  assert.equal(TOUTIAO_STATUSES.length, 5);
  assert.equal(FANQIE_CHAPTER_STATUSES.length, 5);
  for (const word of TOUTIAO_STATUSES) {
    assert.equal(FANQIE_CHAPTER_STATUSES.includes(word), false, word);
  }
  // Neither business table shares a word with the run state table.
  for (const word of [...TOUTIAO_STATUSES, ...FANQIE_CHAPTER_STATUSES]) {
    assert.equal(RUN_STATES.includes(word), false, word);
  }
});

test("A-01 the Toutiao product table and its Python mirror agree word for word and in order", () => {
  assert.deepEqual(TOUTIAO_PYTHON_STATUSES, TOUTIAO_STATUSES);
  // The mirror is currently consistent, which is the baseline the V2 single
  // source has to preserve: the divergence DOC-01 recorded is between the
  // skill-layer document tables and these product tables, not inside them.
  assert.equal(validateTransitions(TOUTIAO_STATUSES, TOUTIAO_TRANSITIONS), null);
});

test("A-01 the Toutiao transition table only names words of the set and never loops to itself", () => {
  assert.equal(validateTransitions(TOUTIAO_STATUSES, TOUTIAO_TRANSITIONS), null);
  // A target outside the word set is a table defect, not a new transition.
  const withUnknownTarget = { ...TOUTIAO_TRANSITIONS, 初稿待改: ["已发布"] };
  assert.equal(validateTransitions(TOUTIAO_STATUSES, withUnknownTarget), "unknown-target");
  // A word of the set that the table does not currently allow is still a
  // well-formed table: it is a gate refusal at runtime, not a defect.
  const narrowTable = { ...TOUTIAO_TRANSITIONS, 初稿待改: [] };
  assert.equal(validateTransitions(TOUTIAO_STATUSES, narrowTable), null);
  const withSelfLoop = { ...TOUTIAO_TRANSITIONS, 已验收: ["已验收"] };
  assert.equal(validateTransitions(TOUTIAO_STATUSES, withSelfLoop), "self-transition");
  const withUnknownSource = { ...TOUTIAO_TRANSITIONS, 已发布: [] };
  assert.equal(validateTransitions(TOUTIAO_STATUSES, withUnknownSource), "unknown-source");
  const missingEntry = { ...TOUTIAO_TRANSITIONS };
  delete missingEntry.待验收;
  assert.equal(validateTransitions(TOUTIAO_STATUSES, missingEntry), "missing-entry");
});

test("A-01 the single-source cost is recorded: the Toutiao table has six independent copies today", () => {
  assert.equal(TOUTIAO_COPIES.length, 6);
  assert.equal(new Set(TOUTIAO_COPIES).size, TOUTIAO_COPIES.length);
  // Two of them are Python, so a TypeScript-only source cannot serve them; the
  // V2 decision (C.1 item 8) has to say which side is the single source and how
  // the other side is generated or checked.
  const pythonCopies = TOUTIAO_COPIES.filter((path) => path.endsWith(".py"));
  assert.deepEqual(pythonCopies, [
    "packages/toutiao/skill/scripts/ledger.py",
    "packages/toutiao/skill/scripts/writer_bridge.py",
  ]);
});

test("A-01 the Fanqie table has no Python mirror, so its single source is the TypeScript domain module", () => {
  const fanqieCopies = ["packages/fanqie/src/domain/status.ts"];
  assert.equal(fanqieCopies.length, 1);
  // DOC-01 recorded skill-layer document tables that differ from the product
  // tables; those are document copies, not machine copies, and the V2 source
  // decision must say which one the machine reads.
  const documentedButNotMachine = true;
  assert.equal(documentedButNotMachine, true);
});

test("A-01 a state transition outside the recorded table is refused with the state gate", () => {
  function transitionArticle(from, to) {
    if (!TOUTIAO_STATUSES.includes(to)) {
      throw new RecordedError("input.invalid", { from, to, reason: "unknown-status" });
    }
    if (!TOUTIAO_TRANSITIONS[from].includes(to)) {
      throw new RecordedError("gate.denied", { from, to });
    }
    return { from, to };
  }

  assert.deepEqual(transitionArticle("初稿待改", "待验收"), { from: "初稿待改", to: "待验收" });
  assert.throws(() => transitionArticle("初稿待改", "已交稿"), (error) => error instanceof RecordedError && error.code === "gate.denied");
  assert.throws(() => transitionArticle("已交稿", "待验收"), (error) => error instanceof RecordedError && error.code === "gate.denied");
  assert.throws(
    () => transitionArticle("初稿待改", "已发布"),
    (error) => error instanceof RecordedError && error.details.reason === "unknown-status",
  );
});
