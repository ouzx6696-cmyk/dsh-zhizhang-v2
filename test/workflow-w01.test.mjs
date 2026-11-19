import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// W-01 uses an isolated SQLite file and a draft workflow shape for this test.
const runId = "fixture-run";

function startRun(db, source) {
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      input_json TEXT NOT NULL,
      state TEXT NOT NULL,
      next_stage TEXT,
      finished_at INTEGER
    );
    CREATE TABLE checkpoints (
      run_id TEXT NOT NULL REFERENCES runs(id),
      stage TEXT NOT NULL,
      stage_version INTEGER NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, stage)
    );
    CREATE TABLE model_attempts (
      run_id TEXT PRIMARY KEY REFERENCES runs(id),
      input_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      usage_json TEXT,
      received_at INTEGER
    );
  `);
  db.prepare(
    "INSERT INTO runs (id, input_json, state, next_stage) VALUES (?, ?, 'running', 'prepare')",
  ).run(runId, JSON.stringify(source));
}

function readRun(db) {
  return db
    .prepare(
      "SELECT input_json, state, next_stage, finished_at FROM runs WHERE id = ?",
    )
    .get(runId);
}

function readCheckpoint(db, stage) {
  const row = db
    .prepare(
      "SELECT stage_version, input_json, output_json, completed_at FROM checkpoints WHERE run_id = ? AND stage = ?",
    )
    .get(runId, stage);
  if (!row) return undefined;
  return {
    version: row.stage_version,
    input: JSON.parse(row.input_json),
    output: JSON.parse(row.output_json),
    completedAt: row.completed_at,
  };
}

function readAttempt(db) {
  return db
    .prepare(
      "SELECT input_json, started_at, usage_json, received_at FROM model_attempts WHERE run_id = ?",
    )
    .get(runId);
}

function commit(db, write) {
  db.exec("BEGIN IMMEDIATE");
  try {
    write();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function saveCheckpoint(db, stage, input, output, completedAt) {
  db.prepare(
    `INSERT INTO checkpoints (run_id, stage, stage_version, input_json, output_json, completed_at)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(
    runId,
    stage,
    JSON.stringify(input),
    JSON.stringify(output),
    completedAt,
  );
}

function runner(db, { clock, prepare, model }) {
  return {
    async advance() {
      const run = readRun(db);
      if (run.state !== "running") return;

      if (run.next_stage === "prepare") {
        const input = JSON.parse(run.input_json);
        const output = prepare(input);
        commit(db, () => {
          saveCheckpoint(db, "prepare", input, output, clock());
          db.prepare(
            "UPDATE runs SET next_stage = 'generate' WHERE id = ?",
          ).run(runId);
        });
        return;
      }

      // This sample supports one model attempt. An unresolved attempt is never sent again.
      const input = readCheckpoint(db, "prepare").output;
      const started = db
        .prepare(
          `INSERT INTO model_attempts (run_id, input_json, started_at)
         VALUES (?, ?, ?) ON CONFLICT (run_id) DO NOTHING`,
        )
        .run(runId, JSON.stringify(input), clock());
      if (started.changes === 0) return;

      const result = await model(input);
      const receivedAt = clock();
      commit(db, () => {
        db.prepare(
          "UPDATE model_attempts SET usage_json = ?, received_at = ? WHERE run_id = ?",
        ).run(JSON.stringify(result.usage), receivedAt, runId);
        if (readRun(db).state !== "running") return;

        saveCheckpoint(
          db,
          "generate",
          input,
          { candidate: result.candidate },
          receivedAt,
        );
        db.prepare(
          "UPDATE runs SET state = 'completed', next_stage = NULL, finished_at = ? WHERE id = ?",
        ).run(receivedAt, runId);
      });
    },
    cancel() {
      db.prepare(
        "UPDATE runs SET state = 'cancelled', next_stage = NULL, finished_at = ? WHERE id = ? AND state = 'running'",
      ).run(clock(), runId);
    },
  };
}

async function temporaryDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhizhang-v2-w01-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "workflow.sqlite");
}

test("reopening a run resumes from the committed stage and its frozen input", async (t) => {
  const path = await temporaryDatabase(t);
  let now = 100;
  const source = { revisionId: "rev-1", body: "  冻结正文  " };
  const frozen = { ...source };
  const prepared = { prompt: "冻结正文" };
  const candidate = { candidate: "候选正文" };
  const usage = { outputTokens: 7 };
  const inputs = [];
  const options = {
    clock: () => now,
    prepare: (input) => ({ prompt: input.body.trim() }),
    model: async (input) => {
      inputs.push(input);
      return { ...candidate, usage };
    },
  };

  {
    using db = new DatabaseSync(path);
    startRun(db, source);
    source.body = "后续编辑";
    await runner(db, options).advance();
    assert.equal(readRun(db).next_stage, "generate");
    assert.deepEqual(readCheckpoint(db, "prepare"), {
      version: 1,
      input: frozen,
      output: prepared,
      completedAt: 100,
    });
    assert.deepEqual(inputs, []);
  }

  now = 200;
  using db = new DatabaseSync(path);
  const resumed = runner(db, {
    ...options,
    prepare: () => assert.fail("the committed local stage must not run again"),
  });
  await resumed.advance();
  await resumed.advance();

  assert.equal(readRun(db).state, "completed");
  assert.equal(readRun(db).next_stage, null);
  assert.deepEqual(inputs, [prepared]);
  assert.deepEqual(readCheckpoint(db, "generate"), {
    version: 1,
    input: prepared,
    output: candidate,
    completedAt: 200,
  });
  assert.deepEqual(JSON.parse(readAttempt(db).usage_json), usage);
});

test("a cancelled run records late usage without committing the candidate", async (t) => {
  const path = await temporaryDatabase(t);
  using db = new DatabaseSync(path);
  let now = 100;
  const response = Promise.withResolvers();
  let modelCalls = 0;
  const options = {
    clock: () => now,
    prepare: (input) => ({ prompt: input.body.trim() }),
    model: () => {
      modelCalls += 1;
      return response.promise;
    },
  };
  startRun(db, { revisionId: "rev-1", body: "稿件" });
  const workflow = runner(db, options);
  await workflow.advance();

  now = 200;
  const pending = workflow.advance();
  assert.equal(modelCalls, 1);
  using observer = new DatabaseSync(path);
  const reopened = runner(observer, {
    ...options,
    model: () =>
      assert.fail("the unresolved model attempt must not be sent again"),
  });
  assert.deepEqual(JSON.parse(readAttempt(observer).input_json), {
    prompt: "稿件",
  });
  assert.equal(readAttempt(observer).started_at, 200);
  assert.equal(readAttempt(observer).usage_json, null);
  await reopened.advance();

  now = 300;
  reopened.cancel();
  const cancelled = readRun(observer);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.next_stage, null);
  assert.equal(cancelled.finished_at, 300);

  now = 400;
  const usage = { outputTokens: 11 };
  response.resolve({ candidate: "迟到的候选", usage });
  await pending;
  await reopened.advance();

  assert.deepEqual(readRun(observer), cancelled);
  assert.equal(readCheckpoint(observer, "generate"), undefined);
  assert.deepEqual(JSON.parse(readAttempt(observer).usage_json), usage);
  assert.equal(readAttempt(observer).received_at, 400);
  assert.equal(modelCalls, 1);
});
