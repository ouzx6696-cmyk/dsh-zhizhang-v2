import assert from "node:assert/strict";
import test from "node:test";
import * as root from "../src/index.ts";
import * as contracts from "../src/contracts/index.ts";
import * as storage from "../src/storage/index.ts";
import * as workflow from "../src/workflow/index.ts";
import * as sharedDomain from "../src/domain/shared/index.ts";
import * as fanqie from "../src/domain/fanqie/index.ts";
import * as toutiao from "../src/domain/toutiao/index.ts";
import * as host from "../src/host/index.ts";
import * as client from "../src/client/index.ts";
import * as bundle from "../src/bundle/index.ts";

test("the bundle keeps its runtime entry points separate from the source root", () => {
  assert.deepEqual(Object.keys(root), []);
  assert.equal(typeof host.openAuthorWorkspace, "function");
  assert.deepEqual(Object.keys(client), []);
  assert.deepEqual(Object.keys(bundle), []);
});

test("the driver seam and pure workflow stay independent of DsH", () => {
  assert.equal(typeof storage.openDatabase, "function");
  assert.equal(Object.keys(storage).some((name) => /driver/i.test(name) && name !== "openDatabase"), false);
  assert.deepEqual(Object.keys(workflow).filter((name) => /execut|host|driver|adapter/i.test(name)), []);
});

test("the product domains expose their rules without depending on the host", () => {
  assert.deepEqual(Object.keys(sharedDomain).sort(), ["anchor", "isEffective", "orderIndex", "precedes", "resolveAnchor"]);
  assert.equal(typeof fanqie.planReorder, "function");
  assert.deepEqual(fanqie.CHAPTER_STATES, ["planned", "drafting", "drafted", "reviewed", "final"]);
  assert.equal(toutiao.TITLE_MAX, 34);
  assert.equal(toutiao.QA_PASS_SCORE, 84);
  assert.equal(toutiao.QA_REFINEMENT_LIMIT, 2);
});

test("the shared contract retains its closed errors and run transitions", () => {
  assert.equal(typeof contracts.ContractError, "function");
  assert.equal(typeof storage.StorageError, "function");
  assert.equal(contracts.ERROR_CODES.length, 11);
  assert.equal(workflow.RUN_STATES.length, 7);
  assert.equal(workflow.TRANSITIONS.length, 14);
});
