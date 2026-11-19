import assert from "node:assert/strict";
import test from "node:test";
import { RecordedError } from "../support/a01.mjs";

// A-01 supporting fixture for the run state machine. The closed set and the
// transition table under test are appendix B.3 of contracts.md, **frozen on
// 2026-11-19 as an A-class item**: they replace the candidate word list
// recorded there and are kept separate from the business state tables of both
// product lines. Evidence: W-01 proves resume from the committed stage,
// cancellation as a terminal state whose late responses only add usage, and
// the frozen input invariant.

const RUN_STATES = new Set([
  "running",
  "paused",
  "awaiting-author",
  "failed",
  "cancelled",
  "applied",
  "discarded",
]);

// The only initial state and the terminal states.
const INITIAL_STATE = "running";
const TERMINAL_STATES = new Set(["cancelled", "applied", "discarded"]);

// Legal transitions, as [from, to] pairs, plus the joined lookup set.
const TRANSITION_LIST = [
  ["running", "paused"],
  ["paused", "running"],
  ["running", "awaiting-author"],
  ["paused", "awaiting-author"],
  ["awaiting-author", "running"],
  ["awaiting-author", "applied"],
  ["awaiting-author", "discarded"],
  ["running", "failed"],
  ["paused", "failed"],
  ["failed", "running"],
  ["running", "cancelled"],
  ["paused", "cancelled"],
  ["failed", "cancelled"],
  ["awaiting-author", "cancelled"],
];
const TRANSITIONS = new Set(TRANSITION_LIST.map(([from, to]) => `${from}->${to}`));

// The business state words of both product lines, recorded so the two tables
// can be asserted disjoint. These are not V2 values; they are the protected
// word sets that must not leak into the run state machine.
const BUSINESS_STATE_WORDS = [
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

class GateError extends RecordedError {
  constructor(from, to) {
    super("gate.denied", { from, to });
    this.message = `illegal run transition: ${from} -> ${to}`;
  }
}

function createRun() {
  let state = INITIAL_STATE;
  const usage = { settled: 0, pendingLate: 0 };
  return {
    get state() {
      return state;
    },
    get usage() {
      return usage;
    },
    transition(to) {
      if (!RUN_STATES.has(to) || !TRANSITIONS.has(`${state}->${to}`)) {
        throw new GateError(state, to);
      }
      state = to;
      return state;
    },
    // A late model response after cancellation only adds usage: it never
    // writes a checkpoint, never changes the state and never delivers a
    // candidate (W-01 invariant 3).
    recordLateUsage(tokens) {
      if (state === "cancelled") {
        usage.pendingLate += tokens;
        return { state, applied: false };
      }
      usage.settled += tokens;
      return { state, applied: true };
    },
  };
}

test("A-01 a run starts in the single initial state and every state word is known", () => {
  const run = createRun();
  assert.equal(run.state, "running");
  assert.equal(TERMINAL_STATES.has(run.state), false);
  for (const state of RUN_STATES) {
    assert.equal(typeof state, "string");
  }
  assert.throws(() => run.transition("finished"), (error) => error instanceof GateError);
});

test("A-01 every proposed transition is accepted and the table stays closed", () => {
  for (const [from, to] of TRANSITION_LIST) {
    const run = createRun();
    // Walk to `from` through a legal path before asserting the pair.
    const path = {
      running: [],
      paused: [["running", "paused"]],
      "awaiting-author": [["running", "awaiting-author"]],
      failed: [["running", "failed"]],
    }[from];
    for (const [stepFrom, stepTo] of path) run.transition(stepTo);
    assert.equal(run.state, from);
    assert.equal(run.transition(to), to);
  }
  assert.equal(TRANSITIONS.size, 14);
  assert.equal(RUN_STATES.size, 7);
});

test("A-01 an illegal transition is refused with the state-gate error and leaves the state unchanged", () => {
  const illegal = [
    ["running", "applied"],
    ["running", "discarded"],
    ["running", "cancelled-then-back"],
    ["awaiting-author", "failed"],
    ["awaiting-author", "paused"],
    ["failed", "applied"],
    ["failed", "discarded"],
    ["failed", "awaiting-author"],
  ];
  for (const [from, to] of illegal) {
    const run = createRun();
    const path = {
      running: [],
      "awaiting-author": [["running", "awaiting-author"]],
      failed: [["running", "failed"]],
    }[from];
    for (const [, stepTo] of path) run.transition(stepTo);
    assert.equal(run.state, from);
    assert.throws(
      () => run.transition(to),
      (error) =>
        error instanceof GateError &&
        error.code === "gate.denied" &&
        error.details.from === from &&
        error.details.to === to,
    );
    assert.equal(run.state, from);
  }
});

test("A-01 a terminal state has no outgoing transition, so cancellation cannot be undone", () => {
  for (const terminal of TERMINAL_STATES) {
    for (const target of RUN_STATES) {
      assert.equal(TRANSITIONS.has(`${terminal}->${target}`), false, `${terminal}->${target}`);
    }
  }
  const run = createRun();
  run.transition("cancelled");
  for (const target of RUN_STATES) {
    assert.throws(() => run.transition(target), (error) => error instanceof GateError);
  }
  assert.equal(run.state, "cancelled");
});

test("A-01 adopted and discarded are reachable only through the author gate", () => {
  for (const decision of ["applied", "discarded"]) {
    const gate = createRun();
    gate.transition("awaiting-author");
    assert.equal(gate.transition(decision), decision);

    const direct = createRun();
    assert.throws(() => direct.transition(decision), (error) => error instanceof GateError);
    const paused = createRun();
    paused.transition("paused");
    assert.throws(() => paused.transition(decision), (error) => error instanceof GateError);
  }
});

test("A-01 a late response after cancellation only adds usage and never changes the state", () => {
  const run = createRun();
  run.transition("cancelled");
  const late = run.recordLateUsage(120);
  assert.equal(late.applied, false);
  assert.equal(late.state, "cancelled");
  assert.equal(run.usage.settled, 0);
  assert.equal(run.usage.pendingLate, 120);

  // Before cancellation the same response settles normally.
  const active = createRun();
  const settled = active.recordLateUsage(80);
  assert.equal(settled.applied, true);
  assert.equal(active.usage.settled, 80);
});

test("A-01 the run state words and the business state words stay disjoint", () => {
  for (const word of BUSINESS_STATE_WORDS) {
    assert.equal(RUN_STATES.has(word), false, word);
  }
  for (const state of RUN_STATES) {
    assert.equal(BUSINESS_STATE_WORDS.includes(state), false, state);
  }
  // A business word is not a legal run state either.
  const run = createRun();
  for (const word of BUSINESS_STATE_WORDS) {
    assert.throws(() => run.transition(word), (error) => error instanceof GateError);
  }
});
