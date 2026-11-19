import type { SqliteDatabase } from "./driver.ts";

interface Attempt {
  runId: string;
  state: string;
  usage: string;
}

const openStates = "('prepared','inflight','received')";
const unresolvedStates = "('prepared','inflight','received','uncertain')";

export function createGenerationLedger(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS author_generation_attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES author_runs(id),
      provider TEXT NOT NULL, model TEXT NOT NULL,
      state TEXT NOT NULL, stage TEXT, usage TEXT NOT NULL, error TEXT
    );
    CREATE INDEX IF NOT EXISTS author_generation_by_run ON author_generation_attempts(run_id);
    CREATE TABLE IF NOT EXISTS author_generation_calls (
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES author_generation_attempts(id),
      phase TEXT NOT NULL, input_reserve INTEGER NOT NULL, max_output INTEGER NOT NULL, usage TEXT
    );
    CREATE INDEX IF NOT EXISTS author_calls_by_attempt ON author_generation_calls(attempt_id);
  `);

  return {
    pending(runId: string) {
      return Boolean(db.prepare(`SELECT 1 FROM author_generation_attempts
        WHERE run_id = ? AND state IN ${unresolvedStates};`).get(runId));
    },
    unresolvedForDocument(documentId: string, exceptRunId: string | null) {
      return Boolean(db.prepare(`SELECT 1 FROM author_generation_attempts a JOIN author_runs r ON r.id = a.run_id
        WHERE r.document_id = ? AND r.id IS NOT ? AND a.state IN ${unresolvedStates} LIMIT 1;`).get(documentId, exceptRunId));
    },
    create(id: string, runId: string, provider: string, model: string) {
      db.prepare(`INSERT INTO author_generation_attempts (id, run_id, provider, model, state, usage)
        VALUES (?, ?, ?, ?, 'prepared', '[]');`).run(id, runId, provider, model);
    },
    beginCall(attemptId: string, callId: string, phase: string, inputReserve: number, maxOutput: number) {
      const marked = db.prepare(`UPDATE author_generation_attempts SET state = 'inflight', stage = ?
        WHERE id = ? AND state IN ('prepared','received');`).run(phase, attemptId);
      if (!marked.changes) return false;
      db.prepare(`INSERT INTO author_generation_calls (id, attempt_id, phase, input_reserve, max_output)
        VALUES (?, ?, ?, ?, ?);`).run(callId, attemptId, phase, inputReserve, maxOutput);
      return true;
    },
    receiveCall(attemptId: string, callId: string, usage: readonly number[]) {
      const call = db.prepare(`UPDATE author_generation_calls SET usage = ?
        WHERE id = ? AND attempt_id = ? AND usage IS NULL
          AND EXISTS (SELECT 1 FROM author_generation_attempts WHERE id = ? AND state = 'inflight')
        RETURNING phase;`).get(JSON.stringify(usage), callId, attemptId, attemptId) as { phase: string } | undefined;
      if (!call) return;
      // The attempt summary also retains receipts from databases written by 2.0.1.
      db.prepare(`UPDATE author_generation_attempts SET state = 'received', usage = json_insert(usage, '$[#]', json(?))
        WHERE id = ?;`).run(JSON.stringify({ callId, phase: call.phase, usage }), attemptId);
    },
    openAttempt(id: string) {
      return db.prepare(`SELECT run_id AS runId, state, usage FROM author_generation_attempts
        WHERE id = ? AND state IN ${openStates};`).get(id) as Attempt | undefined;
    },
    close(id: string, state: string, error: string | null) {
      db.prepare("UPDATE author_generation_attempts SET state = ?, error = ? WHERE id = ?;").run(state, error, id);
    },
    unfinished() {
      return db.prepare(`SELECT id FROM author_generation_attempts WHERE state IN ${openStates};`).all() as readonly { id: string }[];
    },
    reconcile(id: string, runId: string) {
      return Boolean(db.prepare(`UPDATE author_generation_attempts SET state = 'reconciled'
        WHERE id = ? AND run_id = ? AND state = 'uncertain';`).run(id, runId).changes);
    },
    history(runId: string) {
      return db.prepare(`SELECT id, provider, model, state, stage, usage, error FROM author_generation_attempts
        WHERE run_id = ? ORDER BY rowid DESC;`).all(runId);
    },
    calls(runId: string) {
      return db.prepare(`SELECT c.id, c.attempt_id AS attemptId, c.phase, c.input_reserve AS inputReserve,
        c.max_output AS maxOutput, c.usage FROM author_generation_calls c
        JOIN author_generation_attempts a ON a.id = c.attempt_id
        WHERE a.run_id = ? ORDER BY a.rowid DESC, c.rowid;`).all(runId);
    },
  };
}
