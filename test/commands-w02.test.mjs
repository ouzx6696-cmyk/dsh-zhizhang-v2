import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS,
  DEMANDED_DISTINCTIONS,
  ERROR_CODES,
  NON_COMMAND_ACTIONS,
  READ_ACTIONS,
  commandAllows,
  commandByName,
  commandPlan,
  isApprovalGated,
  isCommand,
  validateCommand,
} from "../src/contracts/index.ts";

// W-02 conformance for the frozen section 2 command table and its check order,
// against the alignment `commands-a01` records and appendix B.2 froze.

const AUTHOR = "author";
const AGENT = "agent";

test("W-02 every section 2 command has one authority entry, declared flags and a frozen-code envelope", () => {
  assert.equal(COMMANDS.length, 7);
  const names = new Set();
  for (const entry of COMMANDS) {
    assert.equal(validateCommand(entry), null, entry.name);
    names.add(entry.name);
    // Every command is author-only, and its envelope codes are all frozen.
    assert.deepEqual([...entry.authority], [AUTHOR], entry.name);
    for (const code of entry.envelope.errors) {
      assert.ok(ERROR_CODES.includes(code), `${entry.name}: ${code}`);
    }
  }
  assert.equal(names.size, COMMANDS.length);
  // The non-command actions stay out of the command table.
  for (const action of NON_COMMAND_ACTIONS) {
    assert.equal(names.has(action.name), false, action.name);
  }
  // Reads are a separate namespace and never carry a write envelope.
  for (const read of READ_ACTIONS) {
    assert.equal(names.has(read), false, read);
    assert.equal(isCommand(read), false, read);
  }
});

test("W-02 a malformed entry is refused instead of entering the table", () => {
  const broken = [
    { ...COMMANDS[0], name: "nosuffix" },
    { ...COMMANDS[0], authority: [] },
    { ...COMMANDS[0], approvalGate: undefined },
    { ...COMMANDS[0], idempotent: undefined },
    { ...COMMANDS[0], baseCheck: undefined },
    { ...COMMANDS[0], envelope: { success: "revision", errors: ["budget.tokens"] } },
  ];
  const expected = [
    "malformed-name",
    "missing-authority",
    "undeclared-approval-gate",
    "undeclared-idempotency",
    "undeclared-base-check",
    "unfrozen-error-code",
  ];
  for (const [index, entry] of broken.entries()) {
    assert.equal(validateCommand(entry), expected[index], JSON.stringify(entry));
  }
});

test("W-02 the error distinctions section 2 demands each map to exactly one frozen code", () => {
  const demanded = {
    "version conflict": "version.conflict",
    "identity or permission refusal": "auth.denied",
    "state or business gate refusal": "gate.denied",
    "budget exhaustion": "budget.exhausted",
    "idempotency key with a different payload": "idempotency.mismatch",
    "unknown storage format": "storage.format_unsupported",
  };
  assert.deepEqual({ ...DEMANDED_DISTINCTIONS }, demanded);
  // Each distinction is a distinct code, so no two collapse onto one.
  const codes = Object.values(DEMANDED_DISTINCTIONS);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(Object.keys(DEMANDED_DISTINCTIONS).length, 6);
  // And every code a command may raise is inside the frozen set.
  for (const entry of COMMANDS) {
    for (const code of entry.envelope.errors) {
      assert.ok(ERROR_CODES.includes(code), `${entry.name}: ${code}`);
    }
  }
});

test("W-02 the check order is derived from the flags, not written out per command", () => {
  // A command with no gate, no key and no base check runs authority then the
  // business state.
  assert.deepEqual(commandPlan("setting.decide"), ["authority", "business-state"]);
  // A base-checking command inserts the base step before the business state.
  assert.deepEqual(commandPlan("draft.save"), ["authority", "base-check", "business-state"]);
  // A keyed command inserts idempotency before the base check.
  assert.deepEqual(commandPlan("candidate.adopt"), ["authority", "idempotency", "base-check", "business-state"]);
  // The delivery command runs every step, with the approval gate first.
  assert.deepEqual(commandPlan("article.deliver"), [
    "authority",
    "approval-gate",
    "idempotency",
    "base-check",
    "business-state",
  ]);
  // run.start carries neither a key nor a base check.
  assert.deepEqual(commandPlan("run.start"), ["authority", "business-state"]);
  // An unknown name has no plan.
  assert.equal(commandPlan("workspace.read"), null);
  assert.equal(commandPlan("nope"), null);
});

test("W-02 the approval gate is the only one in the frozen table, and it matches the approval module", () => {
  const gated = COMMANDS.filter((command) => command.approvalGate).map((command) => command.name);
  assert.deepEqual(gated, ["article.deliver"]);
  assert.equal(isApprovalGated("article.deliver"), true);
  // The two surfaces agree, so a command cannot be gated in one and not the other.
  for (const command of COMMANDS) {
    assert.equal(isApprovalGated(command.name), command.approvalGate, command.name);
  }
});

test("W-02 every command is author-only, so the writing Agent is refused before any other check", () => {
  for (const command of COMMANDS) {
    assert.equal(commandAllows(command.name, AUTHOR), true, command.name);
    assert.equal(commandAllows(command.name, AGENT), false, command.name);
  }
  // The Agent's only write path is a run artifact, not a command.
  const produce = NON_COMMAND_ACTIONS.find((action) => action.name === "candidate.produce");
  assert.deepEqual([...produce.authority], [AGENT]);
  // The host approval seam stays author-only.
  const decide = NON_COMMAND_ACTIONS.find((action) => action.name === "approval.decide");
  assert.deepEqual([...decide.authority], [AUTHOR]);
  assert.equal(decide.approvalGate, true);
});

test("W-02 the non-command actions carry their pending author decisions", () => {
  const cancel = NON_COMMAND_ACTIONS.find((action) => action.name === "run.cancel");
  assert.equal(cancel.pendingAuthorDecision, true, "run.cancel's Agent permission is C.1 #9");
  // The other two are settled: the Agent produces candidates, the author decides.
  for (const action of NON_COMMAND_ACTIONS) {
    if (action.name === "run.cancel") continue;
    assert.equal(action.pendingAuthorDecision, undefined, action.name);
  }
  assert.equal(NON_COMMAND_ACTIONS.length, 3);
});

test("W-02 a command's success kind and error set are frozen, and the keyed commands are the two that need a key", () => {
  assert.deepEqual(
    COMMANDS.map((command) => [command.name, command.envelope.success]),
    [
      ["draft.save", "revision"],
      ["run.start", "run"],
      ["candidate.adopt", "revision"],
      ["draft.finalize", "revision"],
      ["setting.decide", "setting-version"],
      ["article.accept", "acceptance"],
      ["article.deliver", "delivery"],
    ],
  );
  assert.deepEqual(
    COMMANDS.filter((command) => command.idempotent).map((command) => command.name),
    ["candidate.adopt", "article.deliver"],
  );
  // The base-checking commands are the ones that validate a base revision.
  assert.deepEqual(
    COMMANDS.filter((command) => command.baseCheck).map((command) => command.name),
    ["draft.save", "candidate.adopt", "draft.finalize", "article.accept", "article.deliver"],
  );
  // The delivery command is the only one that is both keyed and gated.
  assert.deepEqual(
    COMMANDS.filter((command) => command.idempotent && command.approvalGate).map((command) => command.name),
    ["article.deliver"],
  );
});

test("W-02 a lookup by name returns the frozen entry and nothing else", () => {
  const deliver = commandByName("article.deliver");
  assert.equal(deliver.name, "article.deliver");
  assert.equal(deliver.approvalGate, true);
  assert.equal(commandByName("article.delivery"), undefined);
  assert.equal(commandByName(""), undefined);
  assert.equal(isCommand("draft.save"), true);
  assert.equal(isCommand("candidate.produce"), false);
  assert.equal(isCommand("approval.decide"), false);
});
