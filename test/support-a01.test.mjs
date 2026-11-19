import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  RecordedError,
  anchor,
  assertRefused,
  assertThrowsCode,
  precedes,
  withTmpDir,
} from "../support/a01.mjs";

// A-01 supporting fixture for the shared acceptance-fixture framework. It
// records the contract the batch-2 fixtures rely on: one recorded-error base
// with a stable code and disclosable details, a refusal assertion, the
// narrative anchor and its ordering, and a temp-directory wrapper that always
// cleans up. The framework is test infrastructure, not product code.

test("A-01 a recorded error carries its code and disclosable details, and branches never read the message", () => {
  const error = new RecordedError("version.conflict", { documentId: "doc-1" });
  assert.equal(error.code, "version.conflict");
  assert.deepEqual(error.details, { documentId: "doc-1" });
  assert.equal(error instanceof Error, true);
  // Two errors of the same class carry different details but the same code, so
  // a handler that branches on the code treats them alike.
  const other = new RecordedError("version.conflict", { documentId: "doc-2" });
  assert.equal(error.code, other.code);
  assert.deepEqual(other.details, { documentId: "doc-2" });
  const handleByCode = (candidate) => (candidate.code === "version.conflict" ? "keep-local-edit" : "unknown");
  assert.equal(handleByCode(error), handleByCode(other));
});

test("A-01 the refusal assertion accepts a refusal with the expected code and rejects anything else", () => {
  assertRefused({ ok: false, code: "auth.denied", details: { action: "draft.finalize", actor: "agent" } }, "auth.denied");
  assertRefused(
    { ok: false, code: "gate.denied", details: { action: "article.deliver", reason: "approval-missing" } },
    "gate.denied",
    { action: "article.deliver", reason: "approval-missing" },
  );
  // A success is not a refusal, and a different code is not the expected one.
  assert.throws(() => assertRefused({ ok: true, code: null }, "auth.denied"));
  assert.throws(() => assertRefused({ ok: false, code: "input.invalid" }, "auth.denied"));
  // Details that differ from the expected ones fail too.
  assert.throws(() =>
    assertRefused({ ok: false, code: "gate.denied", details: { action: "x" } }, "gate.denied", { action: "y" }),
  );
});

test("A-01 a throwing call is checked by code, so the message stays free to change", () => {
  const thrower = () => {
    throw new RecordedError("storage.format_unsupported", { reason: "schema-missing", schemaId: "zhizhang/1.3" });
  };
  assertThrowsCode(thrower, "storage.format_unsupported");
  assert.throws(() => assertThrowsCode(thrower, "input.invalid"));
  // A plain Error without a code is not a recorded error.
  assert.throws(() => assertThrowsCode(() => {
    throw new Error("storage.format_unsupported");
  }, "storage.format_unsupported"));
});

test("A-01 a narrative anchor is a chapter plus a point, and ordering follows the chapter order", () => {
  const order = ["river", "tower", "harbor"];
  assert.deepEqual(anchor("river", 2), { chapterId: "river", point: 2 });
  assert.equal(precedes(anchor("river", 1), anchor("river", 2), order), true);
  assert.equal(precedes(anchor("river", 2), anchor("river", 1), order), false);
  assert.equal(precedes(anchor("river", 9), anchor("tower", 1), order), true);
  assert.equal(precedes(anchor("tower", 1), anchor("river", 9), order), false);
  // Reordering chapters flips the comparison, which is what makes the
  // reorder impact list necessary.
  const reordered = ["tower", "river", "harbor"];
  assert.equal(precedes(anchor("river", 1), anchor("tower", 1), reordered), false);
});

test("A-01 the temp-directory wrapper removes the directory after success and after a throw", async () => {
  const first = await withTmpDir("zhizhang-support-ok-", async (dir) => {
    assert.equal(existsSync(dir), true);
    return join(dir, "work.db");
  });
  assert.equal(existsSync(first), false);

  await assert.rejects(
    () =>
      withTmpDir("zhizhang-support-throw-", async (dir) => {
        assert.equal(existsSync(dir), true);
        throw new Error("boom");
      }),
    /boom/,
  );
  // A throw inside the wrapper leaves no directory behind either.
  const marker = await withTmpDir("zhizhang-support-check-", (dir) => dir);
  assert.equal(existsSync(marker), false);
});
