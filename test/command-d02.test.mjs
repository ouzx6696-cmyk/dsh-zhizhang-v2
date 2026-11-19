import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adoptCandidate,
  canonicalJson,
  createCandidate,
  createCommandSchema,
  createDocument,
  createStore,
  currentRevision,
  openStore,
  payloadEquals,
  rowCount,
  runAuthorWrite,
  saveDraft,
  StorageError,
} from "../src/storage/index.ts";

// D-02 conformance for the command journal: the frozen write order
// (idempotency → base revision → business state, one transaction) against the
// behaviour `sqlite-d01.test.mjs` records and `commands-a01.test.mjs` pins.

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-cmd-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  createCommandSchema(db);
  try {
    return await run(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function seedDocument(db) {
  createDocument(db, "doc-1");
  const first = saveDraft(
    db,
    { actorId: "author-1", documentId: "doc-1", idempotencyKey: "save-1", baseRevisionId: null, body: "First draft" },
    { revisionId: "rev-1", createdAt: 1 },
  );
  createCandidate(db, {
    candidateId: "candidate-1",
    documentId: "doc-1",
    baseRevisionId: first.revisionId,
    body: "Agent proposal",
  });
  return first;
}

test("D-02 a replayed adoption returns the recorded result and writes nothing new", async () => {
  await withStore((db) => {
    const first = seedDocument(db);
    const adopted = adoptCandidate(
      db,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
      { revisionId: "rev-2", createdAt: 2 },
    );
    assert.equal(adopted.revisionId, "rev-2");
    assert.equal(adopted.replayed, false);
    assert.equal(currentRevision(db, "doc-1").body, "Agent proposal");

    // The replay hands back different generated values; none of them are used.
    const replay = adoptCandidate(
      db,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
      { revisionId: "unused-revision", createdAt: 3 },
    );
    assert.deepEqual(replay, { replayed: true, revisionId: "rev-2" });
    assert.equal(rowCount(db, "revisions"), 2);
    assert.equal(rowCount(db, "author_decisions"), 1);
    assert.equal(rowCount(db, "command_journal"), 2);
  });
});

test("D-02 a stale base revision is refused before any business state changes", async () => {
  await withStore((db) => {
    const first = seedDocument(db);
    adoptCandidate(
      db,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
      { revisionId: "rev-2", createdAt: 2 },
    );

    assert.throws(
      () =>
        saveDraft(
          db,
          { actorId: "author-1", documentId: "doc-1", idempotencyKey: "save-2", baseRevisionId: first.revisionId, body: "Stale edit" },
          { revisionId: "stale-revision", createdAt: 4 },
        ),
      (error) =>
        error instanceof StorageError &&
        error.code === "version.conflict" &&
        error.details.documentId === "doc-1" &&
        error.details.baseRevisionId === first.revisionId &&
        error.details.currentRevisionId === "rev-2",
    );
    assert.equal(currentRevision(db, "doc-1").revision_id, "rev-2");
    assert.equal(rowCount(db, "revisions"), 2);
  });
});

test("D-02 a reused key with a different payload is refused, not replayed", async () => {
  await withStore((db) => {
    const first = seedDocument(db);
    adoptCandidate(
      db,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
      { revisionId: "rev-2", createdAt: 2 },
    );

    // Same key, same actor, same command, same object — but a different
    // candidate. The key was already spent on a different request.
    createCandidate(db, {
      candidateId: "candidate-2",
      documentId: "doc-1",
      baseRevisionId: "rev-2",
      body: "Another proposal",
    });
    assert.throws(
      () =>
        adoptCandidate(
          db,
          { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-2", baseRevisionId: "rev-2", idempotencyKey: "adopt-1" },
          { revisionId: "rev-3", createdAt: 5 },
        ),
      (error) =>
        error instanceof StorageError &&
        error.code === "idempotency.mismatch" &&
        error.details.command === "candidate.adopt" &&
        error.details.target === "doc-1",
    );
    assert.equal(currentRevision(db, "doc-1").revision_id, "rev-2");
    assert.equal(rowCount(db, "revisions"), 2);
  });
});

test("D-02 idempotency is checked before the base revision, so a replay survives a moved base", async () => {
  await withStore((db) => {
    const first = seedDocument(db);
    adoptCandidate(
      db,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
      { revisionId: "rev-2", createdAt: 2 },
    );
    // The document has moved on, but the same request must still replay: a
    // retry after a lost response is not a new write.
    const replay = adoptCandidate(
      db,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
      { revisionId: "ignored", createdAt: 9 },
    );
    assert.deepEqual(replay, { replayed: true, revisionId: "rev-2" });
  });
});

test("D-02 the same key under a different actor is a different request", async () => {
  await withStore((db) => {
    const first = seedDocument(db);
    adoptCandidate(
      db,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
      { revisionId: "rev-2", createdAt: 2 },
    );
    createCandidate(db, {
      candidateId: "candidate-2",
      documentId: "doc-1",
      baseRevisionId: "rev-2",
      body: "Second proposal",
    });
    // A different actor is a different identity, so the same key is free.
    const other = adoptCandidate(
      db,
      { actorId: "author-2", documentId: "doc-1", candidateId: "candidate-2", baseRevisionId: "rev-2", idempotencyKey: "adopt-1" },
      { revisionId: "rev-3", createdAt: 3 },
    );
    assert.equal(other.replayed, false);
    assert.equal(other.revisionId, "rev-3");
    assert.equal(currentRevision(db, "doc-1").body, "Second proposal");
    // seedDocument's save + adopt, then this adopt.
    assert.equal(rowCount(db, "command_journal"), 3);
  });
});

test("D-02 payload comparison is structural, so key order does not matter", () => {
  assert.equal(payloadEquals({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }), true);
  assert.equal(payloadEquals({ a: 1 }, { a: 2 }), false);
  assert.equal(payloadEquals([1, { x: 1 }], [1, { x: 1 }]), true);
  assert.equal(payloadEquals({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("D-02 an unknown document is refused as not found", async () => {
  await withStore((db) => {
    assert.throws(
      () =>
        saveDraft(
          db,
          { actorId: "author-1", documentId: "missing", idempotencyKey: "save-1", baseRevisionId: null, body: "x" },
          { revisionId: "rev-1", createdAt: 1 },
        ),
      (error) =>
        error instanceof StorageError &&
        error.code === "input.not_found" &&
        error.details.objectType === "document" &&
        error.details.objectId === "missing",
    );
  });
});

test("D-02 an injected failure rolls the whole adoption back", async () => {
  await withStore((db) => {
    const first = seedDocument(db);
    // The trigger fires on the journal insert, after the revision, the
    // pointer move and the decision row have all been written.
    db.exec(`
      CREATE TRIGGER fail_journal_insert
      BEFORE INSERT ON command_journal
      BEGIN
        SELECT RAISE(ABORT, 'injected D-02 failure');
      END;
    `);
    assert.throws(
      () =>
        adoptCandidate(
          db,
          { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-fail" },
          { revisionId: "rev-failed", createdAt: 2 },
        ),
      { message: "injected D-02 failure" },
    );
    db.exec("DROP TRIGGER fail_journal_insert;");

    assert.equal(currentRevision(db, "doc-1").revision_id, "rev-1");
    assert.equal(rowCount(db, "revisions"), 1);
    assert.equal(rowCount(db, "author_decisions"), 0);
    assert.equal(rowCount(db, "command_journal"), 1);

    // The same request now succeeds: the rollback left nothing behind.
    const retried = adoptCandidate(
      db,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-fail" },
      { revisionId: "rev-2", createdAt: 3 },
    );
    assert.equal(retried.revisionId, "rev-2");
    assert.equal(currentRevision(db, "doc-1").body, "Agent proposal");
  });
});

test("D-02 a candidate adopted against a different base is refused", async () => {
  await withStore((db) => {
    const first = seedDocument(db);
    createCandidate(db, {
      candidateId: "candidate-old",
      documentId: "doc-1",
      baseRevisionId: "rev-1",
      body: "Proposal against rev-1",
    });
    // Move the document to rev-2, then try to adopt a rev-1 candidate.
    saveDraft(
      db,
      { actorId: "author-1", documentId: "doc-1", idempotencyKey: "save-2", baseRevisionId: first.revisionId, body: "Second draft" },
      { revisionId: "rev-2", createdAt: 2 },
    );
    assert.throws(
      () =>
        adoptCandidate(
          db,
          { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-old", baseRevisionId: "rev-1", idempotencyKey: "adopt-old" },
          { revisionId: "rev-3", createdAt: 3 },
        ),
      (error) => error instanceof StorageError && error.code === "version.conflict",
    );
    assert.equal(rowCount(db, "revisions"), 2);
  });
});

test("D-02 the journal survives a reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-reopen-"));
  try {
    const path = join(dir, "workspace.sqlite");
    createStore(path);
    const writer = openStore(path);
    createCommandSchema(writer);
    const first = seedDocument(writer);
    adoptCandidate(
      writer,
      { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
      { revisionId: "rev-2", createdAt: 2 },
    );
    writer.close();

    const reader = openStore(path);
    try {
      assert.equal(currentRevision(reader, "doc-1").body, "Agent proposal");
      const replay = adoptCandidate(
        reader,
        { actorId: "author-1", documentId: "doc-1", candidateId: "candidate-1", baseRevisionId: first.revisionId, idempotencyKey: "adopt-1" },
        { revisionId: "ignored", createdAt: 9 },
      );
      assert.deepEqual(replay, { replayed: true, revisionId: "rev-2" });
    } finally {
      reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-02 the journal is the only place the frozen order lives", async () => {
  await withStore((db) => {
    createDocument(db, "doc-1");
    // A write whose apply() throws leaves no journal row either.
    assert.throws(
      () =>
        runAuthorWrite(
          db,
          {
            actorId: "author-1",
            commandId: "draft.save",
            documentId: "doc-1",
            idempotencyKey: "never-recorded",
            payload: { body: "x" },
            baseRevisionId: null,
          },
          () => {
            throw new StorageError("gate.denied", { reason: "business-state-refused" });
          },
        ),
      (error) => error instanceof StorageError && error.code === "gate.denied",
    );
    assert.equal(rowCount(db, "command_journal"), 0);
    assert.equal(rowCount(db, "revisions"), 0);
  });
});
