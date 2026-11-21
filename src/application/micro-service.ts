import { randomUUID } from "node:crypto";
import type { MicroUsageSummaryDto } from "../contracts/workspace-dto.ts";
import { stmt } from "../storage/index.ts";
import { sumUsageTuple } from "../workflow/writing-budget.ts";
import { refuse, type WorkspaceContext } from "./context.ts";

/**
 * Ledger for `selection.rewrite` calls (DSH-10, decision #7).
 *
 * Micro rewrites are billed to their own account: they never consume a writing
 * run's budget, but their four-category usage must still be persisted, must be
 * mutually exclusive per document (the partial unique index
 * `ux_micro_call_inflight` is the hard backstop), and must not vanish when the
 * host unloads mid-call.
 */

export interface MicroCallRequest {
  readonly documentId: string;
  readonly projectId: string;
  readonly mode: string;
  readonly provider: string;
  readonly model: string;
  readonly reserved: number;
}

export interface MicroCallLedger {
  begin(request: MicroCallRequest): { readonly id: string };
  recordReceipt(id: string, usage: readonly number[]): void;
  /** `failed` keeps the settled usage of a cancelled call; no receipt means `uncertain`. */
  finish(id: string, failed: boolean): void;
  /** Startup/close recovery: orphaned inflight rows become `uncertain`. */
  recover(): number;
  usage(documentId: string): MicroUsageSummaryDto;
}

const EMPTY_SUMMARY: MicroUsageSummaryDto = {
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

function parseUsage(raw: string): readonly number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((value) => Number(value)) : null;
  } catch {
    return null;
  }
}

export function createMicroService(ctx: WorkspaceContext): MicroCallLedger {
  const db = ctx.db;

  function begin(request: MicroCallRequest): { readonly id: string } {
    return ctx.atomic(() => {
      const inflight = stmt(
        db,
        "SELECT id FROM author_micro_calls WHERE document_id = ? AND status = 'inflight';",
      ).get(request.documentId);
      if (inflight) refuse("selection.rewrite", "rewrite-in-progress");

      const id = randomUUID();
      const now = Date.now();
      try {
        stmt(db, `
          INSERT INTO author_micro_calls (
            id, project_id, document_id, mode, provider, model,
            reserved, settled, usage, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]', 'inflight', ?, ?);
        `).run(
          id,
          request.projectId,
          request.documentId,
          request.mode,
          request.provider,
          request.model,
          request.reserved,
          now,
          now,
        );
      } catch (error) {
        // WAL allows another process to win the race; mirror it as a contract refusal.
        if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
          refuse("selection.rewrite", "rewrite-in-progress");
        }
        throw error;
      }
      ctx.event(request.projectId, "run", "selection.rewrite.started", {
        id,
        documentId: request.documentId,
        mode: request.mode,
      });
      return { id };
    });
  }

  function recordReceipt(id: string, usage: readonly number[]): void {
    ctx.atomic(() => {
      stmt(db, `
        UPDATE author_micro_calls
        SET usage = ?, settled = ?, updated_at = ?
        WHERE id = ? AND status = 'inflight';
      `).run(JSON.stringify([...usage]), sumUsageTuple(usage), Date.now(), id);
    });
  }

  function finish(id: string, failed: boolean): void {
    ctx.atomic(() => {
      const row = stmt(db, "SELECT status, usage FROM author_micro_calls WHERE id = ?;")
        .get(id) as { status: string; usage: string } | undefined;
      if (!row || row.status !== "inflight") return;
      const hasReceipt = parseUsage(row.usage)?.length === 4;
      const status = hasReceipt ? (failed ? "failed" : "completed") : "uncertain";
      stmt(db, "UPDATE author_micro_calls SET status = ?, updated_at = ? WHERE id = ?;")
        .run(status, Date.now(), id);
    });
  }

  function recover(): number {
    return ctx.atomic(() =>
      stmt(db, "UPDATE author_micro_calls SET status = 'uncertain', updated_at = ? WHERE status = 'inflight';")
        .run(Date.now()).changes,
    );
  }

  function usage(documentId: string): MicroUsageSummaryDto {
    const rows = stmt(db, "SELECT status, usage, settled FROM author_micro_calls WHERE document_id = ?;")
      .all(documentId) as readonly { status: string; usage: string; settled: number }[];
    if (rows.length === 0) return EMPTY_SUMMARY;

    let completed = 0;
    let failed = 0;
    let uncertain = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let settled = 0;
    for (const row of rows) {
      if (row.status === "completed") completed += 1;
      else if (row.status === "failed") failed += 1;
      else if (row.status === "uncertain") uncertain += 1;
      settled += row.settled;
      const tuple = parseUsage(row.usage);
      if (!tuple || tuple.length < 2) continue;
      totalInput += Math.max(0, tuple[0] ?? 0);
      totalOutput += Math.max(0, tuple[1] ?? 0);
      totalCacheRead += Math.max(0, tuple[2] ?? 0);
      totalCacheWrite += Math.max(0, tuple[3] ?? 0);
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
  }

  return { begin, recordReceipt, finish, recover, usage };
}
