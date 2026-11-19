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
  `);

  return {
    pending(runId: string) {
      return Boolean(db.prepare(`SELECT 1 FROM author_generation_attempts
        WHERE run_id = ? AND state IN ${unresolvedStates};`).get(runId));
    },
    uncertainForDocument(documentId: string) {
      return Boolean(db.prepare(`SELECT 1 FROM author_generation_attempts a JOIN author_runs r ON r.id = a.run_id
        WHERE r.document_id = ? AND a.state = 'uncertain' LIMIT 1;`).get(documentId));
    },
    create(id: string, runId: string, provider: string, model: string) {
      db.prepare(`INSERT INTO author_generation_attempts (id, run_id, provider, model, state, usage)
        VALUES (?, ?, ?, ?, 'prepared', '[]');`).run(id, runId, provider, model);
    },
    progress(id: string, phase: string, usage?: readonly number[]) {
      if (!usage) {
        db.prepare(`UPDATE author_generation_attempts SET state = 'inflight', stage = ?
          WHERE id = ? AND state IN ('prepared','received');`).run(phase, id);
      } else {
        db.prepare(`UPDATE author_generation_attempts SET state = 'received',
          usage = json_insert(usage, '$[#]', json(?))
          WHERE id = ? AND state = 'inflight' AND stage = ?;`).run(JSON.stringify({ phase, usage }), id, phase);
      }
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
  };
}
