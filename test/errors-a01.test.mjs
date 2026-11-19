import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture for the error model. It records the mapping from the
// error codes the offline fixtures actually raise to the closed set in
// contracts.md appendix B.1, **frozen on 2026-11-19 as an A-class item**, and it
// enforces the envelope discipline of B.2 (also frozen): one code per failure
// class, details limited to fields the caller may see, a diagnostic id for
// correlation, and consumers that branch on the code only. The v1.x names
// recorded in budget-a01 (model.context_overflow, budget.tokens, budget.money)
// are forensic evidence, not the V2 names.

// The proposed closed set. Adding a code is a contract change, not a local
// decision, so the set is asserted exactly.
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

// Every code the fixtures raise today, mapped to the proposed frozen code.
const LOCAL_TO_FROZEN = {
  "version.conflict": "version.conflict",
  "storage.format_unsupported": "storage.format_unsupported",
  "input.invalid": "input.invalid",
  "auth.denied": "auth.denied",
  "gate.denied": "gate.denied",
  "document.not_found": "input.not_found",
  "idempotency.key_reused": "idempotency.mismatch",
  "candidate.base_conflict": "version.conflict",
  "model.context_overflow": "budget.exhausted",
  "budget.tokens": "budget.exhausted",
  "budget.money": "budget.exhausted",
};

// Fields each frozen code may disclose. Anything outside the list stays host
// side and is reachable only through the diagnostic id.
const DISCLOSABLE_DETAILS = {
  "version.conflict": ["documentId", "baseRevisionId", "currentRevisionId"],
  "auth.denied": ["action", "actor"],
  "gate.denied": ["action", "reason"],
  "budget.exhausted": ["scope", "reason"],
  "idempotency.mismatch": ["command", "target"],
  "stage.output_invalid": ["stage", "missing"],
  "usage.uncertain": ["attemptId", "reason"],
  "storage.format_unsupported": ["reason"],
  "input.invalid": ["field", "reason"],
  "input.not_found": ["objectType", "objectId"],
  "dependency.unavailable": ["service"],
};

let diagnosticCounter = 0;

function toEnvelope(name, details = {}) {
  // A frozen name maps to itself; a fixture-local name maps through the table.
  const code = LOCAL_TO_FROZEN[name] ?? (FROZEN_CODES.has(name) ? name : undefined);
  if (!code) {
    throw new Error(`unmapped local error code: ${name}`);
  }
  const allowed = DISCLOSABLE_DETAILS[code];
  const disclosed = {};
  for (const [key, value] of Object.entries(details)) {
    if (allowed.includes(key)) disclosed[key] = value;
  }
  diagnosticCounter += 1;
  return { code, details: disclosed, diagnosticId: `diag-${diagnosticCounter}` };
}

// A consumer that branches on the code only. The Chinese wording of a message
// never reaches this switch.
function samePayload(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function handle(envelope) {
  switch (envelope.code) {
    case "version.conflict":
      return "keep-local-edit";
    case "auth.denied":
    case "gate.denied":
      return "refuse";
    case "budget.exhausted":
      return "stop-run";
    case "idempotency.mismatch":
      return "refuse";
    case "storage.format_unsupported":
      return "refuse";
    case "input.invalid":
    case "input.not_found":
      return "fix-request";
    case "stage.output_invalid":
      return "fail-stage";
    case "usage.uncertain":
      return "await-reconciliation";
    case "dependency.unavailable":
      return "disable-capability";
    default:
      return "unknown-code";
  }
}

test("A-01 every code the offline fixtures raise maps into the proposed closed set", () => {
  const raised = Object.keys(LOCAL_TO_FROZEN);
  assert.equal(raised.length, 11);
  for (const local of raised) {
    assert.ok(FROZEN_CODES.has(LOCAL_TO_FROZEN[local]), local);
  }
});

test("A-01 the proposed code set is closed, so an unmapped code is a contract violation rather than a new local code", () => {
  assert.equal(FROZEN_CODES.size, 11);
  assert.throws(() => toEnvelope("budget.tokens.but-different"), /unmapped local error code/);
  // The Toutiao QA dimension codes are report dimensions, not command errors.
  for (const dimension of ["ai", "read", "title", "detail", "structure", "compliance"]) {
    assert.equal(FROZEN_CODES.has(dimension), false);
    assert.equal(LOCAL_TO_FROZEN[dimension], undefined);
  }
});

test("A-01 an envelope carries the code, disclosable details only, and a diagnostic id", () => {
  const conflict = toEnvelope("candidate.base_conflict", {
    documentId: "doc-1",
    baseRevisionId: "draft-1",
    currentRevisionId: "draft-3",
    // Not disclosable: stays host side.
    body: "正文内容",
    actorId: "user-1",
  });
  assert.equal(conflict.code, "version.conflict");
  assert.deepEqual(conflict.details, {
    documentId: "doc-1",
    baseRevisionId: "draft-1",
    currentRevisionId: "draft-3",
  });
  assert.match(conflict.diagnosticId, /^diag-/);

  const overflow = toEnvelope("model.context_overflow", {
    scope: "stage",
    reason: "input-context-overflow",
    estimatedTokens: 1900,
  });
  assert.equal(overflow.code, "budget.exhausted");
  assert.deepEqual(overflow.details, { scope: "stage", reason: "input-context-overflow" });
  assert.notEqual(overflow.diagnosticId, conflict.diagnosticId);
});

test("A-01 two envelopes of the same class with different wording reach the same handling", () => {
  const first = toEnvelope("document.not_found", { objectType: "document", objectId: "doc-9" });
  const second = toEnvelope("document.not_found", { objectType: "document", objectId: "doc-9" });
  assert.equal(first.code, second.code);
  assert.equal(handle(first), handle(second));
  assert.equal(handle(first), "fix-request");
  // The same frozen code reached from a different local name behaves alike.
  assert.equal(handle(toEnvelope("input.not_found", { objectType: "document", objectId: "doc-9" })), handle(first));
});

test("A-01 a same-key replay returns the original result while a different payload is refused as an idempotency mismatch", () => {
  const records = new Map();
  function submit(key, payload) {
    const existing = records.get(key);
    if (existing) {
      return samePayload(existing.payload, payload)
        ? { replayed: true, result: existing.result }
        : { replayed: false, code: "idempotency.mismatch" };
    }
    const result = { savedRevisionId: "draft-2" };
    records.set(key, { payload, result });
    return { replayed: false, result };
  }

  const first = submit("cmd-1", { documentId: "doc-1", body: "第一段" });
  assert.equal(first.replayed, false);
  const replay = submit("cmd-1", { documentId: "doc-1", body: "第一段" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  const conflict = submit("cmd-1", { documentId: "doc-1", body: "改过的正文" });
  assert.equal(conflict.code, "idempotency.mismatch");
  assert.equal(handle(toEnvelope("idempotency.key_reused", { command: "draft.save", target: "doc-1" })), "refuse");
});

test("A-01 every frozen code has a handling branch, so no failure falls through as unknown", () => {
  for (const code of FROZEN_CODES) {
    const envelope = { code, details: {}, diagnosticId: "diag-fixed" };
    assert.notEqual(handle(envelope), "unknown-code", code);
  }
  const unmapped = { code: "some.future.code", details: {}, diagnosticId: "diag-fixed" };
  assert.equal(handle(unmapped), "unknown-code");
});
