import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_FIELDS,
  APPROVAL_GATED_ACTIONS,
  ContractError,
  approvalMatches,
  assertApprovalGate,
  checkApprovalGate,
  createApproval,
  isApprovalGated,
} from "../src/contracts/index.ts";

// W-02/C-02 conformance for the frozen approval record and its gate, against
// the rules `authority-a01` records and appendix B.9 froze.

const AUTHOR = "author";
const AGENT = "agent";

const base = {
  actor: AUTHOR,
  action: "article.deliver",
  target: "article-1",
  targetVersion: "final-1",
  decision: "approved",
  at: "2026-11-18T00:00:00Z",
};

test("W-02 an approval record carries exactly the six frozen fields", () => {
  assert.deepEqual([...APPROVAL_FIELDS], [
    "actor",
    "action",
    "target",
    "targetVersion",
    "decision",
    "at",
  ]);
  const created = createApproval(base);
  assert.equal(created.ok, true);
  assert.deepEqual(Object.keys(created.record).sort(), [...APPROVAL_FIELDS].sort());
});

test("W-02 an incomplete record is refused rather than stored", () => {
  const created = createApproval({ actor: AUTHOR, action: "article.deliver", target: "article-1" });
  assert.equal(created.ok, false);
  assert.equal(created.code, "input.invalid");
  assert.equal(created.details.field, "approval");
  assert.deepEqual(created.details.missing, ["targetVersion", "decision", "at"]);

  // Every field is required, and an empty string counts as absent.
  for (const field of APPROVAL_FIELDS) {
    const partial = { ...base, [field]: "" };
    assert.equal(createApproval(partial).ok, false, field);
    const missing = { ...base };
    delete missing[field];
    assert.equal(createApproval(missing).ok, false, `missing ${field}`);
  }
});

test("W-02 the matching record lets the gated command through", () => {
  const created = createApproval(base);
  assert.equal(created.ok, true);
  const refusal = checkApprovalGate({
    record: created.ok ? created.record : null,
    actor: AUTHOR,
    action: "article.deliver",
    target: "article-1",
    targetVersion: "final-1",
  });
  assert.equal(refusal, null);
  // The throwing form agrees.
  assert.doesNotThrow(() =>
    assertApprovalGate({
      record: created.ok ? created.record : null,
      actor: AUTHOR,
      action: "article.deliver",
      target: "article-1",
      targetVersion: "final-1",
    }),
  );
});

test("W-02 a record for another object, version, action or subject grants nothing", () => {
  const created = createApproval(base);
  const record = created.ok ? created.record : null;
  const mismatches = [
    { ...record, target: "article-2" },
    { ...record, targetVersion: "final-0" },
    { ...record, action: "article.accept" },
    { ...record, actor: AGENT },
  ];
  for (const mismatch of mismatches) {
    const refusal = checkApprovalGate({
      record: mismatch,
      actor: AUTHOR,
      action: "article.deliver",
      target: "article-1",
      targetVersion: "final-1",
    });
    assert.ok(refusal instanceof ContractError, JSON.stringify(mismatch));
    assert.equal(refusal.code, "gate.denied");
    assert.equal(refusal.details.action, "article.deliver");
    assert.equal(refusal.details.reason, "approval-missing");
  }
});

test("W-02 a missing record refuses instead of defaulting to allowed", () => {
  for (const absent of [undefined, null]) {
    const refusal = checkApprovalGate({
      record: absent,
      actor: AUTHOR,
      action: "article.deliver",
      target: "article-1",
      targetVersion: "final-1",
    });
    assert.ok(refusal instanceof ContractError);
    assert.equal(refusal.code, "gate.denied");
  }
});

test("W-02 the gate's subject is the trusted actor, never a caller claim", () => {
  const created = createApproval(base);
  const record = created.ok ? created.record : null;
  // The record names the author, and the request is executed by the agent: the
  // host resolved the subject, so the record does not transfer.
  const refusal = checkApprovalGate({
    record,
    actor: AGENT,
    action: "article.deliver",
    target: "article-1",
    targetVersion: "final-1",
  });
  assert.ok(refusal instanceof ContractError);
  assert.equal(refusal.code, "gate.denied");
});

test("W-02 a refusal discloses only the fields the disclosure table allows", () => {
  const refusal = checkApprovalGate({
    record: null,
    actor: AUTHOR,
    action: "article.deliver",
    target: "article-1",
    targetVersion: "final-1",
  });
  const { code, details } = refusal.toEnvelope();
  assert.equal(code, "gate.denied");
  assert.deepEqual(Object.keys(details).sort(), ["action", "reason"]);
  // The object and its version stay host side.
  assert.equal(details.target, undefined);
  assert.equal(details.targetVersion, undefined);
});

test("W-02 approvalMatches compares action, object and version", () => {
  const created = createApproval(base);
  const record = created.ok ? created.record : null;
  assert.equal(approvalMatches(record, "article.deliver", "article-1", "final-1"), true);
  assert.equal(approvalMatches(record, "article.deliver", "article-1", "final-2"), false);
  assert.equal(approvalMatches(record, "article.accept", "article-1", "final-1"), false);
  assert.equal(approvalMatches(record, "article.deliver", "article-9", "final-1"), false);
});

test("W-02 the gated-command set is the frozen proposal, and its granularity is not assumed", () => {
  assert.deepEqual([...APPROVAL_GATED_ACTIONS], ["article.deliver"]);
  assert.equal(isApprovalGated("article.deliver"), true);
  // The other writing commands are author-only but not approval-gated.
  for (const action of ["draft.save", "run.start", "candidate.adopt", "draft.finalize", "setting.decide", "article.accept"]) {
    assert.equal(isApprovalGated(action), false, action);
  }
  // Read actions are never gated.
  assert.equal(isApprovalGated("workspace.read"), false);
  assert.equal(isApprovalGated("run.read"), false);
});
