import assert from "node:assert/strict";
import test from "node:test";
import * as root from "../src/index.ts";
import * as contracts from "../src/contracts/index.ts";
import * as host from "../src/host/index.ts";
import * as storage from "../src/storage/index.ts";
import * as workflow from "../src/workflow/index.ts";
import * as sharedDomain from "../src/domain/shared/index.ts";
import * as fanqie from "../src/domain/fanqie/index.ts";
import * as toutiao from "../src/domain/toutiao/index.ts";
import * as client from "../src/client/index.ts";
import * as bundle from "../src/bundle/index.ts";

// The composition root stays empty: nothing is re-exported through it.
test("P1-A the root entrypoint exports nothing", () => {
  assert.deepEqual(Object.keys(root), []);
});

// Freeze-state guard.
//
// Before the A-class freeze (2026-11-19) every module was an empty placeholder
// and the guard asserted that. Now the frozen contracts may be implemented, so
// the guard became a statement of the freeze state instead of a blanket
// prohibition:
//
//   - contracts, storage, workflow, domain/shared and domain/fanqie may export,
//     because the frozen parts of their contracts are in place (the error
//     envelope; the storage lifecycle, command journal, event log and projection
//     store; the run state machine, stage registry, budget guard and read-model
//     surface; the anchor, ordering and half-open interval mechanics; chapter
//     reordering and its continuity impact);
//   - every other module still exports nothing, because its contract is not
//     frozen yet.
//
// A module in `frozenModules` is only allowed to export the frozen parts. The
// assertions below check that the unfrozen halves stay out, so a module cannot
// quietly grow a surface the author has not decided.
//
// When a module's contract freezes, add it to `frozenModules` — and only then.
const frozenModules = [contracts, storage, workflow, sharedDomain, fanqie];

const unfrozenModules = [
  { name: "host", module: host, blockedBy: "C.3 宿主实测七门未通过（P0-02 未授权）" },
  { name: "domain/toutiao", module: toutiao, blockedBy: "C.1 第 1/6/8 项待作者裁决" },
  { name: "client", module: client, blockedBy: "C.1 第 10 项审批粒度待作者裁决" },
  { name: "bundle", module: bundle, blockedBy: "P2-PKG 依赖 G1 开工门" },
];

test("P1-A every module whose contract is not frozen still exports nothing", () => {
  for (const entry of unfrozenModules) {
    assert.deepEqual(Object.keys(entry.module), [], `${entry.name} must stay empty: ${entry.blockedBy}`);
  }
});

// The unfrozen halves of the frozen modules, named so a later change cannot
// widen a module's surface past what the author has decided.
test("P1-A a frozen module exports only its frozen half", () => {
  // contracts: the error envelope (§2/B.1), the approval record (B.9) and the
  // section 2 command table (B.2) are frozen. The command envelope's payload
  // shapes, the read schemas and the domain types are not, so they stay out.
  assert.deepEqual(
    Object.keys(contracts).sort(),
    [
      "APPROVAL_FIELDS",
      "APPROVAL_GATED_ACTIONS",
      "COMMANDS",
      "ContractError",
      "DEMANDED_DISTINCTIONS",
      "ERROR_CODES",
      "NON_COMMAND_ACTIONS",
      "READ_ACTIONS",
      "approvalMatches",
      "assertApprovalGate",
      "checkApprovalGate",
      "commandAllows",
      "commandByName",
      "commandPlan",
      "createApproval",
      "isApprovalGated",
      "isCommand",
      "isErrorWithCode",
      "validateCommand",
    ],
    "contracts must not grow past the frozen envelope, approval record and command table",
  );
  // storage: the lifecycle, command journal, event log and projection store
  // are frozen; the concrete driver is not (Q-05), so only the seam is named.
  assert.equal(typeof storage.openDatabase, "function");
  assert.equal(
    Object.keys(storage).some((name) => /driver/i.test(name) && name !== "openDatabase"),
    false,
    "no concrete driver may be named outside the seam",
  );
  // workflow: the run state machine, stage registry, budget guard and read
  // surface are frozen; the stage executor and the Host port are not, so no
  // execution surface may appear here.
  assert.deepEqual(
    Object.keys(workflow).filter((name) => /execut|host|driver|adapter/i.test(name)),
    [],
    "workflow must not grow an execution or Host surface",
  );
  // domain/shared: the anchor and interval mechanics are frozen; the setting
  // fact record (notably `recorded_at`'s semantics) is not.
  assert.deepEqual(
    Object.keys(sharedDomain).sort(),
    ["anchor", "isEffective", "orderIndex", "precedes", "resolveAnchor"],
    "domain/shared must not grow past the frozen B.8 mechanics",
  );
  // domain/fanqie: reorder.impact is frozen; the business state words, the
  // word-count caliber, the rhythm tiers and the outline notes are C.1 items.
  assert.deepEqual(
    Object.keys(fanqie).sort(),
    ["planReorder", "relationFlipped", "reorderImpact", "reorderImpactCommand"],
    "domain/fanqie must not grow past the frozen reorder mechanics",
  );
});

test("P1-A the frozen modules export their contract surface", () => {
  for (const module of frozenModules) {
    assert.ok(Object.keys(module).length > 0, "a frozen module must export its contract");
  }
  // The driver seam is reachable, but no concrete driver is named outside it.
  assert.equal(typeof storage.openDatabase, "function");
  assert.equal(typeof storage.StorageError, "function");
  // The frozen error envelope is shared, not a storage-private shape.
  assert.equal(typeof contracts.ContractError, "function");
  assert.equal(contracts.ERROR_CODES.length, 11);
  // The run state machine and the stage registry are the workflow surface.
  assert.equal(workflow.RUN_STATES.length, 7);
  assert.equal(workflow.TRANSITIONS.length, 14);
});
