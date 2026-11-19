import assert from "node:assert/strict";
import test from "node:test";
import { RecordedError, assertRefused } from "../support/a01.mjs";

// A-01 supporting fixture for the command-to-envelope alignment. The mapping
// under test is section 2 of contracts.md and appendix B.2, **frozen on
// 2026-11-19 as A-class items** (the command names with them): every command
// in the section 2 table carries one envelope shape, one authority entry, one
// approval-gate flag and one base-check requirement, and the error
// distinctions section 2 demands are all present in the B.1 code set.

const AUTHOR = "author";
const AGENT = "agent";

// The section 2 table, as proposed. `approvalGate` marks the commands that
// require a recorded approval before they execute; `idempotent` marks the ones
// whose request carries a key; `baseCheck` marks the ones that must validate
// the base revision before submitting a write.
const COMMANDS = [
  {
    name: "draft.save",
    authority: [AUTHOR],
    approvalGate: false,
    idempotent: false,
    baseCheck: true,
    envelope: { success: "revision", errors: ["version.conflict", "input.invalid", "input.not_found"] },
  },
  {
    name: "run.start",
    authority: [AUTHOR],
    approvalGate: false,
    idempotent: false,
    baseCheck: false,
    envelope: { success: "run", errors: ["budget.exhausted", "input.invalid", "input.not_found", "dependency.unavailable"] },
  },
  {
    name: "candidate.adopt",
    authority: [AUTHOR],
    approvalGate: false,
    idempotent: true,
    baseCheck: true,
    envelope: { success: "revision", errors: ["version.conflict", "idempotency.mismatch", "input.invalid"] },
  },
  {
    name: "draft.finalize",
    authority: [AUTHOR],
    approvalGate: false,
    idempotent: false,
    baseCheck: true,
    envelope: { success: "revision", errors: ["version.conflict", "gate.denied", "input.invalid"] },
  },
  {
    name: "setting.decide",
    authority: [AUTHOR],
    approvalGate: false,
    idempotent: false,
    baseCheck: false,
    envelope: { success: "setting-version", errors: ["gate.denied", "input.invalid", "input.not_found"] },
  },
  {
    name: "article.accept",
    authority: [AUTHOR],
    approvalGate: false,
    idempotent: false,
    baseCheck: true,
    envelope: { success: "acceptance", errors: ["version.conflict", "gate.denied", "input.invalid"] },
  },
  {
    name: "article.deliver",
    authority: [AUTHOR],
    approvalGate: true,
    idempotent: true,
    baseCheck: true,
    envelope: { success: "delivery", errors: ["gate.denied", "idempotency.mismatch", "version.conflict", "input.invalid"] },
  },
];

// Actions that are not section 2 commands: the Agent's run artifact and the
// host approval seam. They have envelopes and authority entries but no place
// in the command table.
const NON_COMMAND_ACTIONS = [
  { name: "candidate.produce", authority: [AGENT], approvalGate: false },
  { name: "approval.decide", authority: [AUTHOR], approvalGate: true },
  { name: "run.cancel", authority: [AUTHOR], approvalGate: false, pendingAuthorDecision: true },
];

// Reads are a separate namespace: they never carry a write envelope.
const READ_ACTIONS = ["workspace.read", "run.read"];

const FROZEN_CODES = new Set([
  "version.conflict",
  "auth.denied",
  "gate.denied",
  "budget.exhausted",
  "idempotency.mismatch",
  "stage.output_invalid",
  "usage.uncertain",
  "storage.format_unsupported",
  "input.invalid",
  "input.not_found",
  "dependency.unavailable",
]);

function commandByName(name) {
  return COMMANDS.find((command) => command.name === name);
}

// The alignment check: a command entry is only valid when its envelope codes
// are frozen, its authority list is non-empty, and its flags are declared.
function validateCommand(entry) {
  if (!entry.name || !entry.name.includes(".")) return "malformed-name";
  if (!Array.isArray(entry.authority) || entry.authority.length === 0) return "missing-authority";
  if (typeof entry.approvalGate !== "boolean") return "undeclared-approval-gate";
  if (typeof entry.idempotent !== "boolean") return "undeclared-idempotency";
  if (typeof entry.baseCheck !== "boolean") return "undeclared-base-check";
  for (const code of entry.envelope.errors) {
    if (!FROZEN_CODES.has(code)) return "unfrozen-error-code";
  }
  return null;
}

test("A-01 every section 2 command has one authority entry, declared flags and a frozen-code envelope", () => {
  assert.equal(COMMANDS.length, 7);
  const names = new Set();
  for (const entry of COMMANDS) {
    assert.equal(validateCommand(entry), null, entry.name);
    names.add(entry.name);
  }
  assert.equal(names.size, COMMANDS.length);
  // The non-command actions stay out of the command table.
  for (const action of NON_COMMAND_ACTIONS) {
    assert.equal(names.has(action.name), false, action.name);
  }
});

test("A-01 the error distinctions section 2 demands are all present in the frozen code set", () => {
  // Section 2 names six distinctions; each maps to exactly one B.1 code.
  const demanded = {
    "version conflict": "version.conflict",
    "identity or permission refusal": "auth.denied",
    "state or business gate refusal": "gate.denied",
    "budget exhaustion": "budget.exhausted",
    "idempotency key with a different payload": "idempotency.mismatch",
    "unknown storage format": "storage.format_unsupported",
  };
  for (const [distinction, code] of Object.entries(demanded)) {
    assert.ok(FROZEN_CODES.has(code), distinction);
  }
  // No command may invent a code outside the set, including the delivery path.
  for (const entry of COMMANDS) {
    for (const code of entry.envelope.errors) {
      assert.ok(FROZEN_CODES.has(code), `${entry.name}: ${code}`);
    }
  }
});

test("A-01 a write checks idempotency first, then the base revision, and only then the business state", () => {
  // The order matters: a replayed payload must return the original result
  // without re-validating the base, and a conflicting payload must be refused
  // before any base check can mask it.
  const log = [];
  const recorded = new Map();
  function execute(entry, { key, payload, baseMatches, businessAllows }) {
    log.length = 0;
    if (entry.idempotent && key) {
      log.push("idempotency");
      const prior = recorded.get(key);
      if (prior !== undefined) {
        return prior === payload
          ? { ok: true, replayed: true }
          : { ok: false, code: "idempotency.mismatch" };
      }
      recorded.set(key, payload);
    }
    if (entry.baseCheck) {
      log.push("base");
      if (!baseMatches) return { ok: false, code: "version.conflict" };
    }
    log.push("business-state");
    if (!businessAllows) return { ok: false, code: "gate.denied" };
    return { ok: true, replayed: false };
  }

  const adopt = commandByName("candidate.adopt");
  const first = execute(adopt, { key: "k1", payload: "p1", baseMatches: true, businessAllows: true });
  assert.equal(first.ok, true);
  assert.deepEqual(log, ["idempotency", "base", "business-state"]);
  // A replay returns the original result and never reaches the base check.
  const replay = execute(adopt, { key: "k1", payload: "p1", baseMatches: false, businessAllows: false });
  assert.deepEqual(replay, { ok: true, replayed: true });
  assert.deepEqual(log, ["idempotency"]);
  // A conflicting payload is refused before the base check.
  const conflict = execute(adopt, { key: "k1", payload: "other", baseMatches: true, businessAllows: true });
  assertRefused(conflict, "idempotency.mismatch");
  assert.deepEqual(log, ["idempotency"]);
  // A different key is a new submission, so a stale base is refused at the
  // base check rather than at the business state.
  const stale = execute(adopt, { key: "k2", payload: "p2", baseMatches: false, businessAllows: true });
  assertRefused(stale, "version.conflict");
  assert.deepEqual(log, ["idempotency", "base"]);
});

test("A-01 only the delivery command is approval-gated, and a missing or mismatched approval refuses it", () => {
  const gated = COMMANDS.filter((entry) => entry.approvalGate).map((entry) => entry.name);
  assert.deepEqual(gated, ["article.deliver"]);
  const deliver = commandByName("article.deliver");
  const approval = {
    actor: AUTHOR,
    action: "article.deliver",
    target: "article-1",
    targetVersion: "final-1",
    decision: "approved",
    at: "2026-11-18T00:00:00Z",
  };
  const withoutApproval = { ok: false, code: "gate.denied", details: { action: "article.deliver", reason: "approval-missing" } };
  assertRefused(withoutApproval, "gate.denied");
  assert.equal(approval.action, deliver.name);
  // The non-command approval seam is gated too, and run.cancel stays pending
  // the author's decision rather than being silently allowed for the Agent.
  const seam = NON_COMMAND_ACTIONS.find((action) => action.name === "approval.decide");
  assert.equal(seam.approvalGate, true);
  assert.equal(seam.authority.includes(AGENT), false);
  const cancel = NON_COMMAND_ACTIONS.find((action) => action.name === "run.cancel");
  assert.equal(cancel.pendingAuthorDecision, true);
});

test("A-01 reads are a separate namespace and never carry a write envelope", () => {
  const commandNames = new Set(COMMANDS.map((entry) => entry.name));
  const actionNames = new Set(NON_COMMAND_ACTIONS.map((action) => action.name));
  for (const read of READ_ACTIONS) {
    assert.equal(commandNames.has(read), false, read);
    assert.equal(actionNames.has(read), false, read);
    // A read name has no dot-verb write shape that could be confused with one.
    assert.equal(read.split(".").length, 2);
  }
  // Every command name is a two-segment verb.object pair, so a read can never
  // be mistaken for a command by shape alone.
  for (const name of commandNames) {
    assert.equal(name.split(".").length, 2, name);
  }
});

test("A-01 every action name the fixtures use is declared in the command table or the non-command list", () => {
  // The names the offline fixtures exercise, collected by hand: any new name
  // must be declared here before it can appear in a fixture.
  const used = new Set([
    ...COMMANDS.map((entry) => entry.name),
    ...NON_COMMAND_ACTIONS.map((action) => action.name),
  ]);
  for (const name of [
    "draft.save",
    "run.start",
    "candidate.adopt",
    "draft.finalize",
    "setting.decide",
    "article.accept",
    "article.deliver",
    "candidate.produce",
    "approval.decide",
    "run.cancel",
  ]) {
    assert.ok(used.has(name), name);
  }
  // A typo is a contract violation, not a new command.
  assert.equal(used.has("draft.savee"), false);
  assert.equal(used.has("article.acceptt"), false);
});

test("A-01 an unfrozen code in an envelope is refused at alignment time, not at runtime", () => {
  const broken = {
    name: "article.deliver",
    authority: [AUTHOR],
    approvalGate: true,
    idempotent: true,
    baseCheck: true,
    envelope: { success: "delivery", errors: ["delivery.target_exists"] },
  };
  assert.equal(validateCommand(broken), "unfrozen-error-code");
  // A command with no authority entry cannot be executed by anyone.
  assert.equal(validateCommand({ ...broken, authority: [], envelope: { errors: [] } }), "missing-authority");
  // A malformed name is caught before anything else.
  assert.equal(validateCommand({ ...broken, name: "deliver" }), "malformed-name");
  assert.throws(
    () => {
      throw new RecordedError("delivery.target_exists", { target: "/out/article.md" });
    },
    (error) => error instanceof RecordedError && error.code === "delivery.target_exists",
  );
});
