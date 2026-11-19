import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RecordedError as SampleError } from "../support/a01.mjs";

// P1-D sample only; this does not select the target Host's SQLite driver.

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (operationError) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [operationError, rollbackError],
        "SQLite operation failed and rollback also failed",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}

function matchesSampleSchema(db) {
  const requiredColumns = {
    documents: ["document_id", "current_revision_id"],
    revisions: ["revision_id", "document_id", "body", "created_at"],
    candidates: ["candidate_id", "document_id", "base_revision_id", "body"],
    author_decisions: [
      "decision_id",
      "actor_id",
      "document_id",
      "candidate_id",
      "revision_id",
    ],
    idempotency_records: [
      "actor_id",
      "command_id",
      "document_id",
      "request_key",
      "request_payload",
      "result_revision_id",
    ],
  };

  return Object.entries(requiredColumns).every(([table, columns]) => {
    const actual = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name),
    );
    return columns.every((column) => actual.has(column));
  });
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE documents (
      document_id TEXT PRIMARY KEY,
      current_revision_id TEXT
    );
    CREATE TABLE revisions (
      revision_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(document_id),
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE candidates (
      candidate_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(document_id),
      base_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
      body TEXT NOT NULL
    );
    CREATE TABLE author_decisions (
      decision_id INTEGER PRIMARY KEY,
      actor_id TEXT NOT NULL,
      document_id TEXT NOT NULL REFERENCES documents(document_id),
      candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
      revision_id TEXT NOT NULL REFERENCES revisions(revision_id)
    );
    CREATE TABLE idempotency_records (
      actor_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      result_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
      PRIMARY KEY (actor_id, command_id, document_id, request_key)
    );
    PRAGMA user_version = 1;
  `);
}

function openSampleStore(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON;");

    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version === 1) {
      if (!matchesSampleSchema(db)) {
        throw new SampleError("storage.format_unsupported");
      }
      return db;
    }

    const tableCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get().count;
    if (version !== 0 || tableCount !== 0) {
      throw new SampleError("storage.format_unsupported");
    }

    transaction(db, () => createSchema(db));
    return db;
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Failed to close sample database after an open error",
        { cause: error },
      );
    }
    throw error;
  }
}

function createDocument(db, documentId) {
  db.prepare("INSERT INTO documents (document_id) VALUES (?)").run(documentId);
}

function saveDraft(db, request, generated) {
  return transaction(db, () => {
    const document = db
      .prepare(
        "SELECT current_revision_id FROM documents WHERE document_id = ?",
      )
      .get(request.documentId);
    if (!document) throw new SampleError("document.not_found");
    if (document.current_revision_id !== request.baseRevisionId) {
      throw new SampleError("version.conflict");
    }

    db.prepare(
      "INSERT INTO revisions (revision_id, document_id, body, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      generated.revisionId,
      request.documentId,
      request.body,
      generated.createdAt,
    );
    db.prepare(
      "UPDATE documents SET current_revision_id = ? WHERE document_id = ?",
    ).run(generated.revisionId, request.documentId);
    return { revisionId: generated.revisionId };
  });
}

function createCandidate(
  db,
  { candidateId, documentId, baseRevisionId, body },
) {
  db.prepare(
    "INSERT INTO candidates (candidate_id, document_id, base_revision_id, body) VALUES (?, ?, ?, ?)",
  ).run(candidateId, documentId, baseRevisionId, body);
}

// This sample keeps request, actor context, and generated values separate; it does not authenticate or authorize the actor.
function adoptCandidate(db, actorContext, request, generated) {
  const commandId = "candidate.adopt";
  const payload = JSON.stringify({
    baseRevisionId: request.baseRevisionId,
    candidateId: request.candidateId,
  });

  return transaction(db, () => {
    const prior = db
      .prepare(
        `SELECT request_payload, result_revision_id
         FROM idempotency_records
         WHERE actor_id = ? AND command_id = ? AND document_id = ? AND request_key = ?`,
      )
      .get(
        actorContext.actorId,
        commandId,
        request.documentId,
        request.idempotencyKey,
      );
    if (prior) {
      if (prior.request_payload !== payload) {
        throw new SampleError("idempotency.key_reused");
      }
      return { revisionId: prior.result_revision_id };
    }

    const document = db
      .prepare(
        "SELECT current_revision_id FROM documents WHERE document_id = ?",
      )
      .get(request.documentId);
    if (!document) throw new SampleError("document.not_found");
    if (document.current_revision_id !== request.baseRevisionId) {
      throw new SampleError("version.conflict");
    }

    const candidate = db
      .prepare(
        `SELECT body, base_revision_id
         FROM candidates WHERE candidate_id = ? AND document_id = ?`,
      )
      .get(request.candidateId, request.documentId);
    if (!candidate || candidate.base_revision_id !== request.baseRevisionId) {
      throw new SampleError("candidate.base_conflict");
    }

    const revisionId = generated.revisionId;
    db.prepare(
      "INSERT INTO revisions (revision_id, document_id, body, created_at) VALUES (?, ?, ?, ?)",
    ).run(revisionId, request.documentId, candidate.body, generated.createdAt);
    db.prepare(
      "UPDATE documents SET current_revision_id = ? WHERE document_id = ?",
    ).run(revisionId, request.documentId);
    db.prepare(
      `INSERT INTO author_decisions (actor_id, document_id, candidate_id, revision_id)
       VALUES (?, ?, ?, ?)`,
    ).run(
      actorContext.actorId,
      request.documentId,
      request.candidateId,
      revisionId,
    );
    db.prepare(
      `INSERT INTO idempotency_records
         (actor_id, command_id, document_id, request_key, request_payload, result_revision_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      actorContext.actorId,
      commandId,
      request.documentId,
      request.idempotencyKey,
      payload,
      revisionId,
    );
    return { revisionId };
  });
}

function currentRevision(db, documentId) {
  return db
    .prepare(
      `SELECT revisions.revision_id, revisions.body
       FROM documents JOIN revisions USING (document_id)
       WHERE documents.document_id = ?
         AND revisions.revision_id = documents.current_revision_id`,
    )
    .get(documentId);
}

function rowCount(db, tableName) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

async function makeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhizhang-v2-d01-"));
  let db;
  t.after(async () => {
    if (db?.isOpen) db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const databasePath = join(directory, "workspace.sqlite");
  db = openSampleStore(databasePath);
  return { directory, databasePath, db };
}

test("D-01 sample persists revisions and rejects a stale base", async (t) => {
  const { databasePath, db } = await makeFixture(t);
  createDocument(db, "doc-1");
  const first = saveDraft(
    db,
    {
      documentId: "doc-1",
      baseRevisionId: null,
      body: "First draft",
    },
    { revisionId: "rev-1", createdAt: 1 },
  );
  assert.equal(first.revisionId, "rev-1");

  createCandidate(db, {
    candidateId: "candidate-1",
    documentId: "doc-1",
    baseRevisionId: first.revisionId,
    body: "Agent proposal",
  });
  assert.equal(currentRevision(db, "doc-1").body, "First draft");

  const adopted = adoptCandidate(
    db,
    { actorId: "author-1" },
    {
      documentId: "doc-1",
      candidateId: "candidate-1",
      baseRevisionId: first.revisionId,
      idempotencyKey: "adopt-1",
    },
    { revisionId: "rev-2", createdAt: 2 },
  );
  assert.equal(adopted.revisionId, "rev-2");
  assert.equal(currentRevision(db, "doc-1").body, "Agent proposal");

  const replay = adoptCandidate(
    db,
    { actorId: "author-1" },
    {
      documentId: "doc-1",
      candidateId: "candidate-1",
      baseRevisionId: first.revisionId,
      idempotencyKey: "adopt-1",
    },
    { revisionId: "unused-revision", createdAt: 3 },
  );
  assert.deepEqual(replay, adopted);
  assert.equal(rowCount(db, "revisions"), 2);
  assert.equal(rowCount(db, "author_decisions"), 1);

  assert.throws(
    () =>
      saveDraft(
        db,
        {
          documentId: "doc-1",
          baseRevisionId: first.revisionId,
          body: "Stale edit",
        },
        { revisionId: "stale-revision", createdAt: 4 },
      ),
    (error) => error.code === "version.conflict",
  );
  assert.equal(currentRevision(db, "doc-1").revision_id, "rev-2");

  assert.throws(
    () =>
      adoptCandidate(
        db,
        { actorId: "author-1" },
        {
          documentId: "doc-1",
          candidateId: "different-candidate",
          baseRevisionId: first.revisionId,
          idempotencyKey: "adopt-1",
        },
        { revisionId: "different-request", createdAt: 5 },
      ),
    (error) => error.code === "idempotency.key_reused",
  );

  db.close();
  const reopened = openSampleStore(databasePath);
  try {
    assert.equal(currentRevision(reopened, "doc-1").body, "Agent proposal");
  } finally {
    reopened.close();
  }
});

test("D-01 sample rolls back a partial adoption and restores a closed backup", async (t) => {
  const { databasePath, directory, db } = await makeFixture(t);
  createDocument(db, "doc-1");
  saveDraft(
    db,
    {
      documentId: "doc-1",
      baseRevisionId: null,
      body: "Current draft",
    },
    { revisionId: "rev-1", createdAt: 1 },
  );
  createCandidate(db, {
    candidateId: "candidate-1",
    documentId: "doc-1",
    baseRevisionId: "rev-1",
    body: "Candidate body",
  });

  db.exec(`
    CREATE TRIGGER fail_idempotency_insert
    BEFORE INSERT ON idempotency_records
    BEGIN
      SELECT RAISE(ABORT, 'injected D-01 failure');
    END;
  `);
  assert.throws(
    () =>
      adoptCandidate(
        db,
        { actorId: "author-1" },
        {
          documentId: "doc-1",
          candidateId: "candidate-1",
          baseRevisionId: "rev-1",
          idempotencyKey: "adopt-fail",
        },
        { revisionId: "rev-failed", createdAt: 2 },
      ),
    { message: "injected D-01 failure" },
  );
  db.exec("DROP TRIGGER fail_idempotency_insert");
  assert.equal(currentRevision(db, "doc-1").revision_id, "rev-1");
  assert.equal(rowCount(db, "revisions"), 1);
  assert.equal(rowCount(db, "author_decisions"), 0);
  assert.equal(rowCount(db, "idempotency_records"), 0);

  db.close();
  const backupPath = join(directory, "workspace.backup.sqlite");
  await copyFile(databasePath, backupPath);
  const restored = openSampleStore(backupPath);
  try {
    assert.equal(currentRevision(restored, "doc-1").body, "Current draft");
  } finally {
    restored.close();
  }
});

test("D-01 sample rejects unknown databases even with the expected version number", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhizhang-v2-format-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  for (const version of [0, 1]) {
    const path = join(directory, `unknown-${version}.sqlite`);
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TABLE documents (document_id TEXT PRIMARY KEY);
        PRAGMA user_version = ${version};`);
    } finally {
      db.close();
    }

    assert.throws(() => openSampleStore(path), {
      code: "storage.format_unsupported",
    });
  }
});
