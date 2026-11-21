import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ARTICLE_STATES,
  CHAPTER_STATES,
  ContractError,
  DELIVERY_ENDING,
  EDITORIAL_REJECTION_LIMIT,
  ERROR_CODES,
  QA_PASS_SCORE,
  QA_REFINEMENT_LIMIT,
  TITLE_MAX,
  assertApprovalGate,
  createApproval,
} from "../src/contracts/index.ts";
import {
  SCHEMA_ID,
  SCHEMA_USER_VERSION,
  isSupportedSchema,
  assertSupportedSchema,
} from "../src/storage/index.ts";
import { assertThrowsContract } from "../support/harness.mjs";

test("protected business constants match author-frozen invariants", () => {
  assert.equal(TITLE_MAX, 34);
  assert.equal(QA_PASS_SCORE, 84);
  assert.equal(QA_REFINEMENT_LIMIT, 2);
  assert.equal(EDITORIAL_REJECTION_LIMIT, 2);
  assert.equal(DELIVERY_ENDING, "——AI 到此止步。是否采用、何时发布由你决定。");
  assert.deepEqual(CHAPTER_STATES, ["planned", "drafting", "drafted", "reviewed", "final"]);
  assert.deepEqual(ARTICLE_STATES, ["初稿待改", "待验收", "已验收", "验收退回", "已交稿"]);
});

test("client protected-rules mirror matches canonical export block verbatim", () => {
  const extractExports = (path) =>
    readFileSync(new URL(path, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("export "))
      .join("\n");

  assert.equal(
    extractExports("../src/client/contracts/protected-rules.ts"),
    extractExports("../src/contracts/protected-rules.ts"),
    "src/client/contracts/protected-rules.ts drifted from canonical src/contracts/protected-rules.ts",
  );
});

test("ContractError enforces closed code set and serializable envelope", () => {
  const err = new ContractError("gate.denied", { action: "article.deliver", reason: "approval-missing" });
  assert.ok(ERROR_CODES.includes(err.code));
  const envelope = err.toEnvelope();
  assert.equal(envelope.code, "gate.denied");
  assert.deepEqual(envelope.details, { action: "article.deliver", reason: "approval-missing" });
  assert.equal(typeof envelope.diagnosticId, "string");
  assert.throws(() => new ContractError("not.a.real.code"), Error);
});

test("approval gate binds exact actor, action, target, and targetVersion", () => {
  const created = createApproval({
    actor: "author-1",
    action: "article.deliver",
    target: "doc-1",
    targetVersion: "rev-2",
    decision: "approved",
    at: "2026-11-21T00:00:00Z",
  });
  assert.equal(created.ok, true);
  assertApprovalGate({
    record: created.record,
    actor: "author-1",
    action: "article.deliver",
    target: "doc-1",
    targetVersion: "rev-2",
  });

  assertThrowsContract(
    () =>
      assertApprovalGate({
        record: created.record,
        actor: "author-1",
        action: "article.deliver",
        target: "doc-1",
        targetVersion: "rev-3",
      }),
    "gate.denied",
  );
  assertThrowsContract(
    () =>
      assertApprovalGate({
        record: created.record,
        actor: "other-actor",
        action: "article.deliver",
        target: "doc-1",
        targetVersion: "rev-2",
      }),
    "gate.denied",
  );
});

test("workspace-dto.ts and modular dto/* emit zero runtime JavaScript", () => {
  for (const rel of [
    "../src/contracts/workspace-dto.ts",
    "../src/contracts/dto/core.ts",
    "../src/contracts/dto/fanqie.ts",
    "../src/contracts/dto/toutiao.ts",
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    const nonEmptyCode = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter(Boolean);
    for (const line of nonEmptyCode) {
      assert.doesNotMatch(line, /^export\s+(?:const|let|var|function|class|enum)\b/, `Runtime export in ${rel}: ${line}`);
    }
  }
});

test("schema window enforces clean zhizhang/3.x generation", () => {
  assert.equal(SCHEMA_ID, "zhizhang/3.0");
  assert.equal(SCHEMA_USER_VERSION, 30);
  assert.equal(isSupportedSchema("zhizhang/3.0"), true);
  assert.equal(isSupportedSchema("zhizhang/3.1"), true);
  assert.equal(isSupportedSchema("zhizhang/2.3"), false);
  assert.equal(isSupportedSchema("zhizhang/2.0"), false);
  assertSupportedSchema("zhizhang/3.0");
  assertThrowsContract(() => assertSupportedSchema("zhizhang/2.3"), "storage.format_unsupported");
});
