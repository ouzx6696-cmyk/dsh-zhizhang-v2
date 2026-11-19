import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHOR_ACTION_WORDS,
  INITIAL_STATE,
  RUN_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  createRun,
  createStageRegistry,
  isLegalTransition,
  isRunState,
  isTerminal,
  parseStageId,
  registerStage,
  stageKey,
} from "../src/workflow/index.ts";
import { ContractError } from "../src/contracts/index.ts";

// W-02 conformance for the frozen workflow contracts: the run state machine
// (B.3) and the stage registry (B.5), against the rules `runstate-a01` and
// `stages-a01` record.

const STAGE = {
  id: "fanqie.chapter.draft",
  version: 1,
  execution: "model",
  validateOutput: () => true,
};

test("W-02 a run starts in the single initial state and every state word is known", () => {
  const run = createRun();
  assert.equal(run.state, "running");
  assert.equal(INITIAL_STATE, "running");
  assert.equal(isTerminal(run.state), false);
  assert.equal(RUN_STATES.length, 7);
  for (const state of RUN_STATES) {
    assert.equal(isRunState(state), true);
  }
  assert.equal(isRunState("finished"), false);
  assert.equal(isRunState(42), false);
  assert.throws(
    () => run.transition("finished"),
    (error) => error instanceof ContractError && error.code === "gate.denied",
  );
});

test("W-02 every frozen transition is accepted and the table stays closed", () => {
  assert.equal(TRANSITIONS.length, 14);
  for (const [from, to] of TRANSITIONS) {
    assert.equal(isLegalTransition(from, to), true, `${from}->${to}`);
  }
  // The walk each fixture uses to reach a non-initial state legally.
  const paths = {
    running: [],
    paused: [["running", "paused"]],
    "awaiting-author": [["running", "awaiting-author"]],
    failed: [["running", "failed"]],
  };
  for (const [from, to] of TRANSITIONS) {
    const run = createRun();
    for (const [, stepTo] of paths[from]) run.transition(stepTo);
    assert.equal(run.state, from);
    assert.equal(run.transition(to), to);
  }
});

test("W-02 an illegal transition is refused with the state gate and leaves the state unchanged", () => {
  const illegal = [
    ["running", "applied"],
    ["running", "discarded"],
    ["awaiting-author", "failed"],
    ["awaiting-author", "paused"],
    ["failed", "applied"],
    ["failed", "discarded"],
    ["failed", "awaiting-author"],
  ];
  const paths = {
    running: [],
    "awaiting-author": [["running", "awaiting-author"]],
    failed: [["running", "failed"]],
  };
  for (const [from, to] of illegal) {
    const run = createRun();
    for (const [, stepTo] of paths[from]) run.transition(stepTo);
    assert.equal(run.state, from);
    assert.throws(
      () => run.transition(to),
      (error) =>
        error instanceof ContractError &&
        error.code === "gate.denied" &&
        error.details.from === from &&
        error.details.to === to,
    );
    assert.equal(run.state, from, "a refused transition must not move the state");
  }
});

test("W-02 a terminal state has no outgoing transition, so cancellation cannot be undone", () => {
  for (const terminal of TERMINAL_STATES) {
    assert.equal(isTerminal(terminal), true);
    for (const to of RUN_STATES) {
      assert.equal(isLegalTransition(terminal, to), false, `${terminal}->${to}`);
    }
  }
  const run = createRun();
  run.transition("cancelled");
  assert.throws(() => run.transition("running"), (error) => error.code === "gate.denied");
  assert.equal(run.state, "cancelled");
});

test("W-02 applied and discarded are reachable only through the author gate", () => {
  // Every legal path to a decision state passes through awaiting-author.
  const reachesDecision = (target) => {
    const seen = new Set();
    const queue = [["running", []]];
    while (queue.length > 0) {
      const [state, path] = queue.shift();
      if (state === target) {
        return path.includes("awaiting-author");
      }
      if (seen.has(state)) continue;
      seen.add(state);
      for (const [from, to] of TRANSITIONS) {
        if (from === state) queue.push([to, [...path, state]]);
      }
    }
    return false;
  };
  assert.equal(reachesDecision("applied"), true);
  assert.equal(reachesDecision("discarded"), true);
  // No direct edge into a decision state exists.
  for (const [from, to] of TRANSITIONS) {
    if (to === "applied" || to === "discarded") {
      assert.equal(from, "awaiting-author", `${from}->${to} must come from the author gate`);
    }
  }
});

test("W-02 a late response after cancellation only adds usage", () => {
  const run = createRun();
  run.transition("cancelled");
  const result = run.recordLateUsage(120);
  assert.deepEqual(result, { state: "cancelled", applied: false });
  assert.deepEqual(run.usage, { settled: 0, pendingLate: 120 });
  // The state did not move and no second call changes that.
  assert.equal(run.state, "cancelled");
  run.recordLateUsage(30);
  assert.deepEqual(run.usage, { settled: 0, pendingLate: 150 });
});

test("W-02 a response the run still acts on settles into usage", () => {
  const run = createRun();
  const result = run.recordLateUsage(50);
  assert.deepEqual(result, { state: "running", applied: true });
  assert.deepEqual(run.usage, { settled: 50, pendingLate: 0 });
});

test("W-02 the run vocabulary is disjoint from both product lines' business words", () => {
  const businessWords = [
    "初稿待改",
    "待验收",
    "已验收",
    "验收退回",
    "已交稿",
    "planned",
    "drafting",
    "drafted",
    "reviewed",
    "final",
  ];
  for (const word of businessWords) {
    assert.equal(isRunState(word), false, `${word} must not be a run state`);
  }
  for (const state of RUN_STATES) {
    assert.equal(businessWords.includes(state), false, `${state} must not be a business word`);
  }
});

test("W-02 a stage id is exactly three lowercase tokens plus a positive version", () => {
  assert.deepEqual(parseStageId("fanqie.chapter.draft"), {
    domain: "fanqie",
    entity: "chapter",
    action: "draft",
  });
  for (const bad of [
    "draft",
    "fanqie.draft",
    "fanqie.chapter.draft.extra",
    "Fanqie.chapter.draft",
    "fanqie..draft",
    "fanqie.chapter.",
    "fanqie.chapter.Draft",
    "fanqie.chapter.dr-aft",
  ]) {
    assert.equal(parseStageId(bad), null, bad);
  }
});

test("W-02 a stage may never carry an author-granting action word", () => {
  const registry = createStageRegistry();
  assert.equal(AUTHOR_ACTION_WORDS.length, 7);
  for (const action of AUTHOR_ACTION_WORDS) {
    const result = registry.register({ ...STAGE, id: `fanqie.chapter.${action}` });
    assert.equal(result.ok, false);
    assert.equal(result.code, "gate.denied");
  }
  assert.equal(registry.keys().length, 0);
});

test("W-02 a definition needs a positive integer version, a known execution and an output validator", () => {
  const registry = createStageRegistry();
  for (const [field, value] of [
    ["version", 0],
    ["version", -1],
    ["version", 1.5],
    ["version", "1"],
  ]) {
    const result = registry.register({ ...STAGE, [field]: value });
    assert.equal(result.ok, false, `${field}=${String(value)}`);
    assert.equal(result.code, "input.invalid");
  }
  for (const execution of ["deterministic", "model"]) {
    // A distinct version per case, so the duplicate rule is not what refuses.
    const result = registry.register({ ...STAGE, execution, version: execution === "model" ? 2 : 1 });
    assert.equal(result.ok, true, execution);
  }
  assert.equal(
    registry.register({ ...STAGE, execution: "guess", version: 3 }).code,
    "input.invalid",
  );
  const missing = registry.register({ ...STAGE, id: "fanqie.ledger.check", validateOutput: undefined });
  assert.equal(missing.ok, false);
  assert.equal(missing.details.reason, "output-validator-missing");
});

test("W-02 the same id and version registers once, and a new version is a new definition", () => {
  const registry = createStageRegistry();
  assert.deepEqual(registry.register(STAGE), { ok: true, key: "fanqie.chapter.draft@1" });

  const repeat = registry.register(STAGE);
  assert.equal(repeat.ok, false);
  assert.equal(repeat.code, "idempotency.mismatch");
  assert.equal(repeat.details.key, "fanqie.chapter.draft@1");

  // A different version is a different definition: a checkpoint records the
  // version, so redefining it would change what that checkpoint means.
  const second = registry.register({ ...STAGE, version: 2 });
  assert.deepEqual(second, { ok: true, key: "fanqie.chapter.draft@2" });
  assert.deepEqual(registry.keys(), ["fanqie.chapter.draft@1", "fanqie.chapter.draft@2"]);
  assert.equal(registry.get("fanqie.chapter.draft", 2).version, 2);
  assert.equal(registry.get("fanqie.chapter.draft", 3), undefined);
  assert.equal(stageKey("toutiao.article.write", 4), "toutiao.article.write@4");
});

test("W-02 the two product lines' stage sets are disjoint", () => {
  const registry = createStageRegistry();
  registry.register(STAGE);
  registry.register({ ...STAGE, id: "toutiao.article.write", execution: "deterministic" });
  const domains = registry.keys().map((key) => key.split(".")[0]);
  assert.deepEqual([...new Set(domains)].sort(), ["fanqie", "toutiao"]);
  // No shared entity.action pair across the two lines.
  const entities = registry.keys().map((key) => key.split(".").slice(1).join("."));
  assert.equal(new Set(entities).size, entities.length);
});

test("W-02 registerStage raises the frozen error the registry reports", () => {
  const registry = createStageRegistry();
  assert.equal(registerStage(registry, STAGE), "fanqie.chapter.draft@1");
  assert.throws(
    () => registerStage(registry, STAGE),
    (error) =>
      error instanceof ContractError &&
      error.code === "idempotency.mismatch" &&
      error.details.key === "fanqie.chapter.draft@1",
  );
  assert.throws(
    () => registerStage(registry, { ...STAGE, id: "fanqie.chapter.adopt" }),
    (error) => error instanceof ContractError && error.code === "gate.denied",
  );
});
