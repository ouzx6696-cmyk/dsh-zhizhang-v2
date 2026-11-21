import type { SqliteDatabase } from "./driver.ts";
import { stmt } from "./stmt-pool.ts";
import { withWriteTx } from "./tx.ts";

export type LedgerJobKind = "draft_generation" | "proposal_extraction" | "selection_rewrite";

export interface OpenJobRecord {
  readonly id: string;
  readonly kind: LedgerJobKind;
  readonly subtype: string;
  readonly projectId: string | null;
  readonly documentId: string | null;
  readonly runId: string | null;
  readonly proposalId: string | null;
  readonly state: string;
  readonly usage: string;
  readonly lateUsage: string;
}

export interface JobRecord {
  readonly id: string;
  readonly kind: LedgerJobKind;
  readonly subtype: string;
  readonly projectId: string | null;
  readonly documentId: string | null;
  readonly runId: string | null;
  readonly proposalId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly state: string;
  readonly stage: string | null;
  readonly reserved: number;
  readonly settled: number;
  readonly usage: string;
  readonly lateUsage: string;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CallCacheMeta {
  readonly prefixSha256?: string | null;
  readonly l1Version?: number | null;
  readonly cacheStrategy?: string | null;
}

export interface JobCallRecord {
  readonly id: string;
  readonly jobId: string;
  /** Alias preserved for call-detail consumers expecting attemptId. */
  readonly attemptId: string;
  readonly phase: string;
  readonly inputReserve: number;
  readonly maxOutput: number;
  readonly usage: string | null;
  readonly prefixSha256: string | null;
  readonly l1Version: number | null;
  readonly cacheStrategy: string | null;
  readonly createdAt: number;
}

export interface UsageConsistencyIssue {
  readonly jobId: string;
  readonly callsTotal: number;
  readonly jobTotal: number;
}

export interface MicroUsageAggregate {
  readonly calls: number;
  readonly completed: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly totalInput: number;
  readonly totalOutput: number;
  readonly totalCacheRead: number;
  readonly totalCacheWrite: number;
  readonly settled: number;
}

export interface CreateJobInput {
  readonly id: string;
  readonly kind: LedgerJobKind;
  readonly subtype?: string;
  readonly scopeKey?: string;
  readonly projectId?: string | null;
  readonly documentId?: string | null;
  readonly runId?: string | null;
  readonly proposalId?: string | null;
  readonly provider: string;
  readonly model: string;
  readonly reserved?: number;
}

const OPEN_STATES = "('prepared','inflight','received')";
const UNRESOLVED_STATES = "('prepared','inflight','received','uncertain')";

const EMPTY_MICRO: MicroUsageAggregate = {
  calls: 0,
  completed: 0,
  failed: 0,
  uncertain: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  settled: 0,
};

function sumTuple(values: unknown): number {
  if (!Array.isArray(values)) return 0;
  let total = 0;
  for (const item of values) {
    if (typeof item === "number" && Number.isFinite(item) && item > 0) total += item;
  }
  return total;
}

function parseEntries(raw: string): readonly { usage?: unknown }[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as readonly { usage?: unknown }[]) : [];
  } catch {
    return [];
  }
}

/**
 * Unified SQLite ledger for ALL LLM jobs across the workbench:
 * - `draft_generation` (candidate runs + Toutiao auto-QA loops)
 * - `proposal_extraction` (structured AI proposals)
 * - `selection_rewrite` (inline micro rewrites)
 *
 * Enforces per-scope concurrency via partial unique index, preserves late
 * usage receipts (`late_usage`) when calls settle after abort/close, and
 * supports cross-table billing verification.
 */
export function createJobLedger(db: SqliteDatabase) {
  return {
    create(input: CreateJobInput): void {
      const now = Date.now();
      stmt(db, `
        INSERT INTO author_jobs (
          id, kind, subtype, scope_key, project_id, document_id, run_id, proposal_id,
          provider, model, state, reserved, settled, usage, late_usage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, 0, '[]', '[]', ?, ?);
      `).run(
        input.id,
        input.kind,
        input.subtype ?? "",
        input.scopeKey ?? "",
        input.projectId ?? null,
        input.documentId ?? null,
        input.runId ?? null,
        input.proposalId ?? null,
        input.provider,
        input.model,
        input.reserved ?? 0,
        now,
        now,
      );
    },

    hasActiveScope(kind: LedgerJobKind, scopeKey: string): boolean {
      if (!scopeKey) return false;
      return Boolean(stmt(db, `
        SELECT 1 FROM author_jobs
        WHERE kind = ? AND scope_key = ? AND state IN ${OPEN_STATES}
        LIMIT 1;
      `).get(kind, scopeKey));
    },

    pendingForRun(runId: string): boolean {
      return Boolean(stmt(db, `
        SELECT 1 FROM author_jobs
        WHERE run_id = ? AND kind = 'draft_generation' AND state IN ${UNRESOLVED_STATES}
        LIMIT 1;
      `).get(runId));
    },

    unresolvedForDocument(documentId: string, exceptRunId: string | null): boolean {
      return Boolean(stmt(db, `
        SELECT 1 FROM author_jobs
        WHERE document_id = ? AND kind = 'draft_generation'
          AND run_id IS NOT ? AND state IN ${UNRESOLVED_STATES}
        LIMIT 1;
      `).get(documentId, exceptRunId));
    },

    beginCall(
      jobId: string,
      callId: string,
      phase: string,
      inputReserve: number,
      maxOutput: number,
      cacheMeta?: CallCacheMeta,
    ): boolean {
      return withWriteTx(db, () => {
        const now = Date.now();
        const marked = stmt(db, `
          UPDATE author_jobs SET state = 'inflight', stage = ?, updated_at = ?
          WHERE id = ? AND state IN ('prepared', 'received');
        `).run(phase, now, jobId);
        if (!marked.changes) return false;
        stmt(db, `
          INSERT INTO author_job_calls (
            id, job_id, phase, input_reserve, max_output,
            prefix_sha256, l1_version, cache_strategy, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        `).run(
          callId,
          jobId,
          phase,
          inputReserve,
          maxOutput,
          cacheMeta?.prefixSha256 ?? null,
          cacheMeta?.l1Version ?? null,
          cacheMeta?.cacheStrategy ?? null,
          now,
        );
        return true;
      });
    },

    /**
     * Records a 4-category token receipt for one call. Late receipts arriving
     * after a job left `inflight` are persisted once into `late_usage` so
     * billing never drifts or silently drops tokens.
     */
    receiveCall(jobId: string, callId: string, usage: readonly number[]): boolean {
      return withWriteTx(db, () => {
        const now = Date.now();
        const tokens = sumTuple(usage);
        const call = stmt(db, `
          UPDATE author_job_calls SET usage = ?
          WHERE id = ? AND job_id = ? AND usage IS NULL
            AND EXISTS (SELECT 1 FROM author_jobs WHERE id = ? AND state = 'inflight')
          RETURNING phase;
        `).get(JSON.stringify(usage), callId, jobId, jobId) as { phase: string } | undefined;

        if (!call) {
          const lateCall = stmt(db, `
            UPDATE author_job_calls SET usage = ?
            WHERE id = ? AND job_id = ? AND usage IS NULL
            RETURNING phase;
          `).get(JSON.stringify(usage), callId, jobId) as { phase: string } | undefined;
          if (lateCall) {
            const lateEntry = JSON.stringify({ callId, phase: lateCall.phase, usage, recordedAt: now });
            stmt(db, `
              UPDATE author_jobs
              SET late_usage = json_insert(COALESCE(NULLIF(late_usage, ''), '[]'), '$[#]', json(?)),
                  settled = settled + ?,
                  updated_at = ?
              WHERE id = ?;
            `).run(lateEntry, tokens, now, jobId);
          }
          return false;
        }

        stmt(db, `
          UPDATE author_jobs
          SET state = 'received',
              usage = json_insert(usage, '$[#]', json(?)),
              settled = settled + ?,
              updated_at = ?
          WHERE id = ?;
        `).run(JSON.stringify({ callId, phase: call.phase, usage }), tokens, now, jobId);
        return true;
      });
    },

    openJob(id: string): OpenJobRecord | undefined {
      return stmt(db, `
        SELECT id, kind, subtype, project_id AS projectId, document_id AS documentId,
               run_id AS runId, proposal_id AS proposalId, state, usage, late_usage AS lateUsage
        FROM author_jobs
        WHERE id = ? AND state IN ${OPEN_STATES};
      `).get(id) as OpenJobRecord | undefined;
    },

    getJob(id: string): JobRecord | undefined {
      return stmt(db, `
        SELECT id, kind, subtype, project_id AS projectId, document_id AS documentId,
               run_id AS runId, proposal_id AS proposalId, provider, model, state, stage,
               reserved, settled, usage, late_usage AS lateUsage, error,
               created_at AS createdAt, updated_at AS updatedAt
        FROM author_jobs WHERE id = ?;
      `).get(id) as JobRecord | undefined;
    },

    close(id: string, state: string, error: string | null): boolean {
      const res = stmt(db, `
        UPDATE author_jobs SET state = ?, error = ?, updated_at = ?
        WHERE id = ? AND state IN ${OPEN_STATES};
      `).run(state, error, Date.now(), id);
      return Boolean(res.changes);
    },

    unfinished(kind?: LedgerJobKind): readonly OpenJobRecord[] {
      if (kind) {
        return stmt(db, `
          SELECT id, kind, subtype, project_id AS projectId, document_id AS documentId,
                 run_id AS runId, proposal_id AS proposalId, state, usage, late_usage AS lateUsage
          FROM author_jobs
          WHERE kind = ? AND state IN ${OPEN_STATES};
        `).all(kind) as readonly OpenJobRecord[];
      }
      return stmt(db, `
        SELECT id, kind, subtype, project_id AS projectId, document_id AS documentId,
               run_id AS runId, proposal_id AS proposalId, state, usage, late_usage AS lateUsage
        FROM author_jobs
        WHERE state IN ${OPEN_STATES};
      `).all() as readonly OpenJobRecord[];
    },

    reconcile(id: string, runId?: string): boolean {
      const now = Date.now();
      if (runId) {
        return Boolean(stmt(db, `
          UPDATE author_jobs SET state = 'reconciled', updated_at = ?
          WHERE id = ? AND run_id = ? AND state = 'uncertain';
        `).run(now, id, runId).changes);
      }
      return Boolean(stmt(db, `
        UPDATE author_jobs SET state = 'reconciled', updated_at = ?
        WHERE id = ? AND state = 'uncertain';
      `).run(now, id).changes);
    },

    historyForRun(runId: string): readonly JobRecord[] {
      return stmt(db, `
        SELECT id, kind, subtype, project_id AS projectId, document_id AS documentId,
               run_id AS runId, proposal_id AS proposalId, provider, model, state, stage,
               reserved, settled, usage, late_usage AS lateUsage, error,
               created_at AS createdAt, updated_at AS updatedAt
        FROM author_jobs
        WHERE run_id = ? ORDER BY rowid DESC;
      `).all(runId) as readonly JobRecord[];
    },

    callsForRun(runId: string): readonly JobCallRecord[] {
      return stmt(db, `
        SELECT c.id, c.job_id AS jobId, c.job_id AS attemptId, c.phase,
               c.input_reserve AS inputReserve, c.max_output AS maxOutput,
               c.usage, c.prefix_sha256 AS prefixSha256, c.l1_version AS l1Version,
               c.cache_strategy AS cacheStrategy, c.created_at AS createdAt
        FROM author_job_calls c
        JOIN author_jobs j ON j.id = c.job_id
        WHERE j.run_id = ? ORDER BY j.rowid DESC, c.rowid ASC;
      `).all(runId) as readonly JobCallRecord[];
    },

    list(filter: { projectId?: string; documentId?: string; kind?: LedgerJobKind; limit?: number } = {}): readonly JobRecord[] {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.projectId) {
        clauses.push("project_id = ?");
        params.push(filter.projectId);
      }
      if (filter.documentId) {
        clauses.push("document_id = ?");
        params.push(filter.documentId);
      }
      if (filter.kind) {
        clauses.push("kind = ?");
        params.push(filter.kind);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = Math.max(1, Math.min(100, filter.limit ?? 30));
      params.push(limit);
      return stmt(db, `
        SELECT id, kind, subtype, project_id AS projectId, document_id AS documentId,
               run_id AS runId, proposal_id AS proposalId, provider, model, state, stage,
               reserved, settled, usage, late_usage AS lateUsage, error,
               created_at AS createdAt, updated_at AS updatedAt
        FROM author_jobs
        ${where}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?;
      `).all(...(params as readonly (string | number)[])) as readonly JobRecord[];
    },

    microUsage(documentId: string): MicroUsageAggregate {
      const rows = stmt(db, `
        SELECT state, usage, late_usage AS lateUsage, settled
        FROM author_jobs
        WHERE document_id = ? AND kind = 'selection_rewrite';
      `).all(documentId) as readonly { state: string; usage: string; lateUsage: string; settled: number }[];
      if (rows.length === 0) return EMPTY_MICRO;

      let completed = 0;
      let failed = 0;
      let uncertain = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let settled = 0;

      for (const row of rows) {
        if (row.state === "completed") completed += 1;
        else if (row.state === "failed" || row.state === "cancelled") failed += 1;
        else if (row.state === "uncertain") uncertain += 1;
        settled += row.settled;
        for (const entry of [...parseEntries(row.usage), ...parseEntries(row.lateUsage)]) {
          const tuple = entry.usage;
          if (!Array.isArray(tuple) || tuple.length < 2) continue;
          totalInput += Math.max(0, Number(tuple[0] ?? 0));
          totalOutput += Math.max(0, Number(tuple[1] ?? 0));
          totalCacheRead += Math.max(0, Number(tuple[2] ?? 0));
          totalCacheWrite += Math.max(0, Number(tuple[3] ?? 0));
        }
      }

      return {
        calls: rows.length,
        completed,
        failed,
        uncertain,
        totalInput,
        totalOutput,
        totalCacheRead,
        totalCacheWrite,
        settled,
      };
    },

    jobUsageFromCalls(jobId: string): number {
      const rows = stmt(db, `
        SELECT usage FROM author_job_calls WHERE job_id = ? AND usage IS NOT NULL;
      `).all(jobId) as readonly { usage: string }[];
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

    verifyUsageConsistency(): readonly UsageConsistencyIssue[] {
      const jobs = stmt(db, "SELECT id, usage, late_usage AS lateUsage FROM author_jobs;")
        .all() as readonly { id: string; usage: string; lateUsage: string }[];
      const issues: UsageConsistencyIssue[] = [];
      for (const job of jobs) {
        const callsTotal = this.jobUsageFromCalls(job.id);
        let jobTotal = 0;
        for (const entry of [...parseEntries(job.usage), ...parseEntries(job.lateUsage)]) {
          jobTotal += sumTuple(entry.usage);
        }
        if (callsTotal !== jobTotal) {
          issues.push({ jobId: job.id, callsTotal, jobTotal });
        }
      }
      return issues;
    },
  };
}

export type JobLedger = ReturnType<typeof createJobLedger>;
