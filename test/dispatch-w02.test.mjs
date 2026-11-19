import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMMANDS,
  ContractError,
  commandAllows,
  commandPlan,
  createApproval,
} from "../src/contracts/index.ts";
import {
  appendRevision,
  createCommandSchema,
  createDocument,
  createStore,
  currentRevision,
  executeCommand,
  openStore,
  rowCount,
} from "../src/storage/index.ts";

// W-02 conformance for `executeCommand`: the dispatcher that puts the frozen
// command table in front of the frozen write order, so the alignment
// `commands-a01` records and the order `sqlite-d01` records are one path
// rather than two.

const AUTHOR = "author";
const AGENT = "agent";

async function withJournal(run) {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-w02-dispatch-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  createCommandSchema(db);
  createDocument(db, "doc-1");
  appendRevision(db, { revisionId: "rev-1", documentId: "doc-1", body: "一", createdAt: 1 });
  try {
    return await run(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("W-02 an unknown command name is refused before the journal is touched", async () => {
  await withJournal((db) => {
    const before = rowCount(db, "command_journal");
    const outcome = executeCommand(
      db,
      { commandId: "workspace.write-everything", actor: AUTHOR, documentId: "doc-1", payload: {}, baseRevisionId: "rev-1" },
      () => ({ revisionId: "rev-2" }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "input.invalid");
    assert.equal(outcome.details.field, "commandId");
    assert.equal(outcome.details.reason, "unknown-command");
    assert.equal(rowCount(db, "command_journal"), before, "a refusal leaves no journal row");
  });
});

test("W-02 the writing Agent is refused with auth.denied before any other check", async () => {
  await withJournal((db) => {
    const before = rowCount(db, "command_journal");
    for (const command of COMMANDS) {
      const outcome = executeCommand(
        db,
        { commandId: command.name, actor: AGENT, documentId: "doc-1", payload: {}, baseRevisionId: "rev-1" },
        () => ({ revisionId: "rev-x" }),
      );
      assert.equal(outcome.ok, false, command.name);
      assert.equal(outcome.code, "auth.denied", command.name);
      assert.equal(outcome.details.action, command.name);
      assert.equal(outcome.details.actor, AGENT);
    }
    assert.equal(rowCount(db, "command_journal"), before);
    // The authority table and the dispatcher agree.
    for (const command of COMMANDS) {
      assert.equal(commandAllows(command.name, AGENT), false, command.name);
    }
  });
});

test("W-02 a gated command without a matching approval record is refused", async () => {
  await withJournal((db) => {
    const before = rowCount(db, "command_journal");
    // No record at all.
    const missing = executeCommand(
      db,
      { commandId: "article.deliver", actor: AUTHOR, documentId: "doc-1", payload: {}, baseRevisionId: "rev-1" },
      () => ({ deliveryId: "d-1" }),
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "gate.denied");
    assert.equal(missing.details.reason, "approval-missing");

    // A record for another object grants nothing either.
    const wrong = createApproval({
      actor: AUTHOR,
      action: "article.deliver",
      target: "doc-2",
      targetVersion: "rev-1",
      decision: "approved",
      at: "2026-11-18T00:00:00Z",
    });
    const mismatched = executeCommand(
      db,
      {
        commandId: "article.deliver",
        actor: AUTHOR,
        documentId: "doc-1",
        payload: {},
        baseRevisionId: "rev-1",
        approval: wrong.ok ? wrong.record : null,
      },
      () => ({ deliveryId: "d-1" }),
    );
    assert.equal(mismatched.code, "gate.denied");
    assert.equal(rowCount(db, "command_journal"), before, "a refused gate leaves no journal row");
  });
});

test("W-02 a gated command with a matching approval record runs and reports one envelope", async () => {
  await withJournal((db) => {
    const created = createApproval({
      actor: AUTHOR,
      action: "article.deliver",
      target: "doc-1",
      targetVersion: "rev-1",
      decision: "approved",
      at: "2026-11-18T00:00:00Z",
    });
    const outcome = executeCommand(
      db,
      {
        commandId: "article.deliver",
        actor: AUTHOR,
        documentId: "doc-1",
        idempotencyKey: "deliver-1",
        payload: { note: "交稿" },
        baseRevisionId: "rev-1",
        approval: created.ok ? created.record : null,
      },
      () => ({ deliveryId: "d-1" }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.code, null);
    assert.deepEqual(outcome.result, { deliveryId: "d-1" });
    assert.equal(outcome.replayed, false);
    assert.equal(rowCount(db, "command_journal"), 1);

    // The same request replays through the journal rather than running again.
    const replay = executeCommand(
      db,
      {
        commandId: "article.deliver",
        actor: AUTHOR,
        documentId: "doc-1",
        idempotencyKey: "deliver-1",
        payload: { note: "交稿" },
        baseRevisionId: "rev-1",
        approval: created.ok ? created.record : null,
      },
      () => {
        throw new Error("a replay must not run the command's own work");
      },
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, { deliveryId: "d-1" });
    assert.equal(rowCount(db, "command_journal"), 1);
  });
});

test("W-02 a command whose entry declares no base check is never refused for a stale base", async () => {
  await withJournal((db) => {
    // run.start declares no base check, so a base revision the store has never
    // heard of is not a conflict.
    const outcome = executeCommand(
      db,
      {
        commandId: "run.start",
        actor: AUTHOR,
        documentId: "doc-1",
        payload: { goal: "写完一卷" },
        baseRevisionId: "rev-that-does-not-exist",
      },
      () => ({ runId: "run-1" }),
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.deepEqual(outcome.result, { runId: "run-1" });

    // The same for setting.decide.
    const decided = executeCommand(
      db,
      {
        commandId: "setting.decide",
        actor: AUTHOR,
        documentId: "doc-1",
        payload: { factId: "f-1" },
        baseRevisionId: null,
      },
      () => ({ settingVersion: 3 }),
    );
    assert.equal(decided.ok, true);
    assert.deepEqual(decided.result, { settingVersion: 3 });
  });
});

test("W-02 a base-checking command still refuses a stale base before its work runs", async () => {
  await withJournal((db) => {
    const before = rowCount(db, "command_journal");
    const outcome = executeCommand(
      db,
      {
        commandId: "draft.save",
        actor: AUTHOR,
        documentId: "doc-1",
        idempotencyKey: "save-1",
        payload: { body: "二" },
        baseRevisionId: "rev-stale",
      },
      () => {
        throw new Error("a stale base must be refused before the command's own work");
      },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "version.conflict");
    assert.equal(outcome.details.baseRevisionId, "rev-stale");
    assert.equal(outcome.details.currentRevisionId, "rev-1");
    assert.equal(rowCount(db, "command_journal"), before);
  });
});

test("W-02 a keyed command with a reused key and a different payload is idempotency.mismatch", async () => {
  await withJournal((db) => {
    const first = executeCommand(
      db,
      {
        commandId: "candidate.adopt",
        actor: AUTHOR,
        documentId: "doc-1",
        idempotencyKey: "adopt-1",
        payload: { candidateId: "c-1" },
        baseRevisionId: "rev-1",
      },
      () => ({ revisionId: "rev-2" }),
    );
    assert.equal(first.ok, true);
    appendRevision(db, { revisionId: "rev-2", documentId: "doc-1", body: "采纳", createdAt: 2 });
    assert.equal(currentRevision(db, "doc-1").revision_id, "rev-2");

    const clash = executeCommand(
      db,
      {
        commandId: "candidate.adopt",
        actor: AUTHOR,
        documentId: "doc-1",
        idempotencyKey: "adopt-1",
        payload: { candidateId: "c-2" },
        baseRevisionId: "rev-2",
      },
      () => ({ revisionId: "rev-3" }),
    );
    assert.equal(clash.ok, false);
    assert.equal(clash.code, "idempotency.mismatch");
    assert.equal(clash.details.command, "candidate.adopt");
    assert.equal(clash.details.target, "doc-1");
  });
});

test("W-02 a command whose entry declares no key is its own write each time", async () => {
  await withJournal((db) => {
    // draft.save declares no key, so two requests are two writes rather than a
    // replay: there is nothing for a replay to match.
    const first = executeCommand(
      db,
      { commandId: "draft.save", actor: AUTHOR, documentId: "doc-1", payload: { body: "二" }, baseRevisionId: "rev-1" },
      () => ({ revisionId: "rev-2" }),
    );
    assert.equal(first.ok, true);
    appendRevision(db, { revisionId: "rev-2", documentId: "doc-1", body: "二", createdAt: 2 });

    const second = executeCommand(
      db,
      { commandId: "draft.save", actor: AUTHOR, documentId: "doc-1", payload: { body: "三" }, baseRevisionId: "rev-2" },
      () => ({ revisionId: "rev-3" }),
    );
    assert.equal(second.ok, true);
    assert.equal(second.replayed, false);
    assert.equal(rowCount(db, "command_journal"), 2);
  });
});

test("W-02 the dispatcher's checks run in the order commandPlan derives", async () => {
  await withJournal((db) => {
    // article.deliver runs authority → approval gate → idempotency → base
    // check → business state. An Agent is refused before the gate is even
    // consulted, and a missing record is refused before the base check.
    assert.deepEqual(commandPlan("article.deliver"), [
      "authority",
      "approval-gate",
      "idempotency",
      "base-check",
      "business-state",
    ]);
    const asAgent = executeCommand(
      db,
      { commandId: "article.deliver", actor: AGENT, documentId: "doc-1", payload: {}, baseRevisionId: "rev-stale" },
      () => ({ deliveryId: "d-1" }),
    );
    assert.equal(asAgent.code, "auth.denied");
    const asAuthor = executeCommand(
      db,
      { commandId: "article.deliver", actor: AUTHOR, documentId: "doc-1", payload: {}, baseRevisionId: "rev-stale" },
      () => ({ deliveryId: "d-1" }),
    );
    // The gate refuses before the stale base is reached.
    assert.equal(asAuthor.code, "gate.denied");
  });
});

test("W-02 a refusal from the command's own work surfaces as its frozen code", async () => {
  await withJournal((db) => {
    const outcome = executeCommand(
      db,
      { commandId: "draft.save", actor: AUTHOR, documentId: "doc-1", payload: { body: "二" }, baseRevisionId: "rev-1" },
      () => {
        throw new ContractError("input.invalid", { field: "body", reason: "empty" });
      },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "input.invalid");
    assert.deepEqual(outcome.details, { field: "body", reason: "empty" });
    // Nothing was committed.
    assert.equal(rowCount(db, "command_journal"), 0);
    assert.equal(currentRevision(db, "doc-1").revision_id, "rev-1");
  });
});
