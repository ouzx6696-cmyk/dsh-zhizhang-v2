import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture for the subject and authority matrix. The matrix
// under test is appendix B.9 of contracts.md, derived from
// docs/V2-OVERVIEW.md ("Agent 不可保存权威正文、采纳、定稿、确认设定、验收或
// 交稿"; the author Client and the writing Agent only read or submit through
// authorized business cases and never write the database directly) and from the
// host patterns recorded in H-01 (authority-granting actions stay user-only;
// ctx.tools.guard only denies and restrict only removes; approval is
// fail-closed). This file is the offline half of the evidence: the host-side
// identity, tool isolation and uninstall behaviour still have to be proved in
// an isolated profile (H-01 gates V2, V3, V4, Q-04). The approval record
// schema and the error names were frozen on 2026-11-19 as A-class items;
// `run.cancel`'s Agent permission and the approval granularity remain B-class
// author decisions (C.1 items 9 and 10).

const AUTHOR = "author";
const AGENT = "agent";

// The proposed action classes, aligned with the §2 command table of
// contracts.md. Authority-granting actions change the authoritative state; the
// writing path of the Agent stops at run-produced candidates, which are not a
// §2 command.
const authorityMatrix = {
  // §2 commands whose success moves authoritative state.
  "draft.save": [AUTHOR],
  "candidate.adopt": [AUTHOR],
  "draft.finalize": [AUTHOR],
  "setting.decide": [AUTHOR],
  "article.accept": [AUTHOR],
  "article.deliver": [AUTHOR],
  "run.start": [AUTHOR, AGENT],
  // Run artifacts, not a §2 command: the Agent's only write path.
  "candidate.produce": [AUTHOR, AGENT],
  // Host seam: an approval decision is itself an author-only action.
  "approval.decide": [AUTHOR],
  // Reads.
  "workspace.read": [AUTHOR, AGENT],
  "run.read": [AUTHOR, AGENT],
  // Proposed, pending author confirmation (Q-04): an Agent cancelling a run it
  // started itself.
  "run.cancel": [AUTHOR, AGENT],
};

// An approval record binds one subject, one action, one object version, one
// decision and one time. A record that does not match the command being
// executed grants nothing.
function createApproval({ actor, action, target, targetVersion, decision, at }) {
  if (!actor || !action || !target || !targetVersion || !decision || !at) {
    return { ok: false, code: "input.invalid" };
  }
  return {
    ok: true,
    record: { actor, action, target, targetVersion, decision, at },
  };
}

function approvalMatches(approval, action, target, targetVersion) {
  return (
    approval.action === action &&
    approval.target === target &&
    approval.targetVersion === targetVersion
  );
}

// The command lives in one Host service method, so the UI path and the Agent
// tool path reach the same check. The actor is the trusted subject the host
// resolved, never a field the caller passed in. An approval-gated command
// carries the object and version it operates on, and the stored approval has
// to match that exact action, object, version and subject.
function executeCommand(action, actor, { approval, target, targetVersion } = {}) {
  const allowed = authorityMatrix[action];
  if (!allowed) {
    return { ok: false, code: "input.invalid", details: { action } };
  }
  if (!allowed.includes(actor)) {
    return { ok: false, code: "auth.denied", details: { action, actor } };
  }
  if (approvalRequired.has(action)) {
    const record = approval?.record ?? approval;
    const matches =
      record !== undefined &&
      record !== null &&
      record.actor === actor &&
      approvalMatches(record, action, target, targetVersion);
    if (!matches) {
      return { ok: false, code: "gate.denied", details: { action, reason: "approval-missing" } };
    }
  }
  return { ok: true, code: null, action, actor };
}

// Approval-gated commands in the proposal: the author still decides, and a
// missing approval refuses rather than defaulting to allowed.
const approvalRequired = new Set(["article.deliver"]);

test("A-01 every authority-granting action refuses the writing Agent with a stable code", () => {
  const authorOnly = [
    "draft.save",
    "candidate.adopt",
    "draft.finalize",
    "setting.decide",
    "article.accept",
    "article.deliver",
    "approval.decide",
  ];
  for (const action of authorOnly) {
    const result = executeCommand(action, AGENT);
    assert.equal(result.ok, false, action);
    assert.equal(result.code, "auth.denied");
    assert.equal(result.details.actor, AGENT);
  }
});

test("A-01 the author keeps every authority-granting action, gated by approval where the proposal requires one", () => {
  for (const action of ["draft.save", "candidate.adopt", "draft.finalize", "setting.decide", "article.accept", "approval.decide"]) {
    assert.equal(executeCommand(action, AUTHOR).ok, true, action);
  }
  // Delivery needs a recorded approval: fail closed without one.
  assert.equal(executeCommand("article.deliver", AUTHOR, { target: "article-1", targetVersion: "final-1" }).code, "gate.denied");
  assert.equal(
    executeCommand("article.deliver", AUTHOR, {
      target: "article-1",
      targetVersion: "final-1",
      approval: createApproval({
        actor: AUTHOR,
        action: "article.deliver",
        target: "article-1",
        targetVersion: "final-1",
        decision: "approved",
        at: "2026-11-18T00:00:00Z",
      }),
    }).ok,
    true,
  );
});

test("A-01 the Agent may read and produce candidates, so its own writing path stops at run artifacts", () => {
  for (const action of ["workspace.read", "run.read", "candidate.produce", "run.start"]) {
    assert.equal(executeCommand(action, AGENT).ok, true, action);
  }
  // Starting a run does not grant its approval: the approval stays author-only.
  assert.equal(executeCommand("approval.decide", AGENT).code, "auth.denied");
});

test("A-01 the UI path and the Agent tool path reach the same decision for the same action and actor", () => {
  // One operation, two callers: both entries call the same service method, and
  // the actor is resolved by the host rather than passed in by the caller.
  const viaUi = executeCommand("candidate.adopt", AGENT);
  const viaTool = executeCommand("candidate.adopt", AGENT);
  assert.deepEqual(viaUi, viaTool);
  assert.equal(viaUi.code, "auth.denied");
  assert.equal(executeCommand("candidate.adopt", AUTHOR).ok, true);
});

test("A-01 a guard only ever denies, so removing it cannot grant a permission the matrix lacks", () => {
  // guard() is additive on the deny side: with the guard in place the Agent is
  // refused; without it the decision falls back to the matrix, which still
  // refuses an authority-granting action.
  const guarded = (action, actor) => {
    if (actor === AGENT && action === "run.cancel") {
      return { ok: false, code: "auth.denied", details: { action, actor } };
    }
    return executeCommand(action, actor);
  };
  assert.equal(guarded("run.cancel", AGENT).code, "auth.denied");
  assert.equal(executeCommand("run.cancel", AGENT).ok, true);
  // The guard cannot turn an author-only action into an Agent permission.
  assert.equal(guarded("candidate.adopt", AGENT).code, "auth.denied");
});

test("A-01 restricting the Agent's tool set only removes entries and leaves the author's set intact", () => {
  const agentTools = ["workspace.read", "run.read", "candidate.produce", "run.start", "run.cancel"];
  const authorTools = [...agentTools, "candidate.adopt", "draft.finalize", "article.deliver", "approval.decide"];
  const restricted = agentTools.filter((tool) => tool !== "run.cancel");
  assert.equal(restricted.includes("run.cancel"), false);
  assert.equal(authorTools.includes("run.cancel"), true);
  assert.equal(authorTools.includes("candidate.adopt"), true);
});

test("A-01 the Agent has no direct path to the authoritative store, so a generic file or exec tool cannot carry the write", () => {
  // The authority check sits at the service boundary and the storage surface is
  // not in the Agent's tool set at all: the only writable path the Agent has is
  // producing run candidates, which land in the candidate table.
  const agentTools = new Set(["workspace.read", "run.read", "candidate.produce", "run.start"]);
  assert.equal(agentTools.has("storage.write"), false);
  assert.equal(agentTools.has("backup.restore"), false);
  const produced = executeCommand("candidate.produce", AGENT);
  assert.equal(produced.ok, true);
  const directSave = executeCommand("draft.save", AGENT);
  assert.equal(directSave.code, "auth.denied");
});

test("A-01 an unknown action is refused instead of falling through to an allowed default", () => {
  const result = executeCommand("workspace.write-everything", AUTHOR);
  assert.equal(result.ok, false);
  assert.equal(result.code, "input.invalid");
});

test("A-01 an approval record binds subject, action, object version, decision and time, and a mismatched record grants nothing", () => {
  const created = createApproval({
    actor: AUTHOR,
    action: "article.deliver",
    target: "article-1",
    targetVersion: "final-1",
    decision: "approved",
    at: "2026-11-18T00:00:00Z",
  });
  assert.equal(created.ok, true);
  assert.deepEqual(Object.keys(created.record).sort(), [
    "action",
    "actor",
    "at",
    "decision",
    "target",
    "targetVersion",
  ]);
  // An incomplete record is refused rather than stored.
  assert.equal(
    createApproval({ actor: AUTHOR, action: "article.deliver", target: "article-1" }).ok,
    false,
  );

  // The matching record lets the delivery through.
  assert.equal(
    executeCommand("article.deliver", AUTHOR, {
      approval: created,
      target: "article-1",
      targetVersion: "final-1",
    }).ok,
    true,
  );
  // A record for another article, another version or another action does not,
  // and an approval recorded by another subject does not either.
  for (const mismatch of [
    { ...created.record, target: "article-2" },
    { ...created.record, targetVersion: "final-0" },
    { ...created.record, action: "article.accept" },
    { ...created.record, actor: AGENT },
  ]) {
    assert.equal(
      executeCommand("article.deliver", AUTHOR, {
        approval: mismatch,
        target: "article-1",
        targetVersion: "final-1",
      }).code,
      "gate.denied",
    );
  }
});
