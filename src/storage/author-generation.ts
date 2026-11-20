import type { SqliteDatabase } from "./driver.ts";
import { stmt } from "./stmt-pool.ts";
import { withWriteTx } from "./tx.ts";

export interface OpenGenerationAttempt {
  readonly runId: string;
  readonly state: string;
  readonly usage: string;
  readonly lateUsage?: string;
}

export interface GenerationAttemptRecord {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly state: string;
  readonly stage: string | null;
  readonly usage: string;
  readonly lateUsage: string;
  readonly error: string | null;
}

export interface GenerationCallRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly phase: string;
  readonly inputReserve: number;
  readonly maxOutput: number;
  readonly usage: string | null;
}

export interface UsageConsistencyIssue {
  readonly attemptId: string;
  readonly callsTotal: number;
  readonly attemptTotal: number;
}

const OPEN_STATES = "('prepared','inflight','received')";
const UNRESOLVED_STATES = "('prepared','inflight','received','uncertain')";

function sumTuple(values: unknown): number {
  if (!Array.isArray(values)) return 0;
  let total = 0;
  for (const item of values) {
    if (typeof item === "number" && Number.isFinite(item) && item > 0) total += item;
  }
  return total;
}

export function createGenerationLedger(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS author_generation_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES author_runs(id),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL,
      stage TEXT,
      usage TEXT NOT NULL,
      late_usage TEXT NOT NULL DEFAULT '[]',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS author_generation_by_run ON author_generation_attempts(run_id);
    CREATE INDEX IF NOT EXISTS author_generation_attempts_open
      ON author_generation_attempts(state)
      WHERE state IN ('prepared', 'inflight', 'received');
    CREATE TABLE IF NOT EXISTS author_generation_calls (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL REFERENCES author_generation_attempts(id),
      phase TEXT NOT NULL,
      input_reserve INTEGER NOT NULL,
      max_output INTEGER NOT NULL,
      usage TEXT
    );
    CREATE INDEX IF NOT EXISTS author_calls_by_attempt ON author_generation_calls(attempt_id);
  `);

  const cols = new Set(
    (db.prepare("PRAGMA table_info(author_generation_attempts);").all() as readonly { name?: unknown }[])
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (!cols.has("late_usage")) {
    db.exec("ALTER TABLE author_generation_attempts ADD COLUMN late_usage TEXT NOT NULL DEFAULT '[]';");
  }

  return {
    pending(runId: string): boolean {
      return Boolean(stmt(db, `
        SELECT 1 FROM author_generation_attempts
        WHERE run_id = ? AND state IN ${UNRESOLVED_STATES};
      `).get(runId));
    },

    unresolvedForDocument(documentId: string, exceptRunId: string | null): boolean {
      return Boolean(stmt(db, `
        SELECT 1 FROM author_generation_attempts a
        JOIN author_runs r ON r.id = a.run_id
        WHERE r.document_id = ? AND r.id IS NOT ? AND a.state IN ${UNRESOLVED_STATES}
        LIMIT 1;
      `).get(documentId, exceptRunId));
    },

    create(id: string, runId: string, provider: string, model: string): void {
      stmt(db, `
        INSERT INTO author_generation_attempts (id, run_id, provider, model, state, usage, late_usage)
        VALUES (?, ?, ?, ?, 'prepared', '[]', '[]');
      `).run(id, runId, provider, model);
    },

    beginCall(attemptId: string, callId: string, phase: string, inputReserve: number, maxOutput: number): boolean {
      return withWriteTx(db, () => {
        const marked = stmt(db, `
          UPDATE author_generation_attempts SET state = 'inflight', stage = ?
          WHERE id = ? AND state IN ('prepared','received');
        `).run(phase, attemptId);
        if (!marked.changes) return false;
        stmt(db, `
          INSERT INTO author_generation_calls (id, attempt_id, phase, input_reserve, max_output)
          VALUES (?, ?, ?, ?, ?);
        `).run(callId, attemptId, phase, inputReserve, maxOutput);
        return true;
      });
    },

    /**
     * Records a usage receipt for a generation call. When the attempt is no
     * longer `inflight` (e.g., cancelled or interrupted before the usage chunk
     * arrived), the receipt is preserved in `author_generation_attempts.late_usage`
     * instead of being silently discarded (DB-14), while returning `false`.
     */
    receiveCall(attemptId: string, callId: string, usage: readonly number[]): boolean {
      return withWriteTx(db, () => {
        const call = stmt(db, `
          UPDATE author_generation_calls SET usage = ?
          WHERE id = ? AND attempt_id = ? AND usage IS NULL
            AND EXISTS (SELECT 1 FROM author_generation_attempts WHERE id = ? AND state = 'inflight')
          RETURNING phase;
        `).get(JSON.stringify(usage), callId, attemptId, attemptId) as { phase: string } | undefined;
        if (!call) {
          // DB-14: Preserve late receipts for reconciliation instead of silent drop.
          const callMeta = stmt(db, `
            SELECT phase, usage FROM author_generation_calls
            WHERE id = ? AND attempt_id = ?;
          `).get(callId, attemptId) as { phase?: string; usage?: string | null } | undefined;
          if (callMeta && callMeta.usage === null) {
            stmt(db, `
              UPDATE author_generation_calls SET usage = ?
              WHERE id = ? AND attempt_id = ? AND usage IS NULL;
            `).run(JSON.stringify(usage), callId, attemptId);
          }
          const lateEntry = JSON.stringify({
            callId,
            phase: callMeta?.phase ?? "unknown",
            usage,
            recordedAt: Date.now(),
          });
          stmt(db, `
            UPDATE author_generation_attempts
            SET late_usage = json_insert(COALESCE(NULLIF(late_usage, ''), '[]'), '$[#]', json(?))
            WHERE id = ?;
          `).run(lateEntry, attemptId);
          return false;
        }
        stmt(db, `
          UPDATE author_generation_attempts
          SET state = 'received', usage = json_insert(usage, '$[#]', json(?))
          WHERE id = ?;
        `).run(JSON.stringify({ callId, phase: call.phase, usage }), attemptId);
        return true;
      });
    },

    openAttempt(id: string): OpenGenerationAttempt | undefined {
      return stmt(db, `
        SELECT run_id AS runId, state, usage, late_usage AS lateUsage
        FROM author_generation_attempts
        WHERE id = ? AND state IN ${OPEN_STATES};
      `).get(id) as OpenGenerationAttempt | undefined;
    },

    close(id: string, state: string, error: string | null): void {
      stmt(db, "UPDATE author_generation_attempts SET state = ?, error = ? WHERE id = ?;")
        .run(state, error, id);
    },

    unfinished(): readonly { id: string }[] {
      return stmt(db, `
        SELECT id FROM author_generation_attempts WHERE state IN ${OPEN_STATES};
      `).all() as readonly { id: string }[];
    },

    reconcile(id: string, runId: string): boolean {
      return Boolean(stmt(db, `
        UPDATE author_generation_attempts SET state = 'reconciled'
        WHERE id = ? AND run_id = ? AND state = 'uncertain';
      `).run(id, runId).changes);
    },

    history(runId: string): readonly GenerationAttemptRecord[] {
      return stmt(db, `
        SELECT id, provider, model, state, stage, usage, late_usage AS lateUsage, error
        FROM author_generation_attempts
        WHERE run_id = ? ORDER BY rowid DESC;
      `).all(runId) as readonly GenerationAttemptRecord[];
    },

    calls(runId: string): readonly GenerationCallRecord[] {
      return stmt(db, `
        SELECT c.id, c.attempt_id AS attemptId, c.phase,
          c.input_reserve AS inputReserve, c.max_output AS maxOutput, c.usage
        FROM author_generation_calls c
        JOIN author_generation_attempts a ON a.id = c.attempt_id
        WHERE a.run_id = ? ORDER BY a.rowid DESC, c.rowid;
      `).all(runId) as readonly GenerationCallRecord[];
    },

    /** Computes authoritative call-level usage sum for an attempt (DB-14). */
    attemptUsageFromCalls(attemptId: string): number {
      const rows = stmt(db, `
        SELECT usage FROM author_generation_calls WHERE attempt_id = ? AND usage IS NOT NULL;
      `).all(attemptId) as readonly { usage: string }[];
      let sum = 0;
      for (const row of rows) {
        try {
          sum += sumTuple(JSON.parse(row.usage));
        } catch {
          // Ignore malformed row.
        }
      }
      return sum;
    },

    /** Compares `author_generation_calls` sums against `author_generation_attempts.usage` for `/diag` (DB-14). */
    verifyUsageConsistency(): readonly UsageConsistencyIssue[] {
      const attempts = stmt(db, `
        SELECT id, usage, late_usage AS lateUsage FROM author_generation_attempts;
      `).all() as readonly { id: string; usage: string; lateUsage: string }[];
      const issues: UsageConsistencyIssue[] = [];
      for (const attempt of attempts) {
        const callsTotal = this.attemptUsageFromCalls(attempt.id);
        let attemptTotal = 0;
        for (const raw of [attempt.usage, attempt.lateUsage]) {
          try {
            const parsed = JSON.parse(raw) as readonly { usage?: unknown }[];
            if (Array.isArray(parsed)) {
              for (const entry of parsed) attemptTotal += sumTuple(entry?.usage);
            }
          } catch {
            // Ignore malformed json.
          }
        }
        if (callsTotal !== attemptTotal) {
          issues.push({ attemptId: attempt.id, callsTotal, attemptTotal });
        }
      }
      return issues;
    },
  };
}

export type GenerationLedger = ReturnType<typeof createGenerationLedger>;
