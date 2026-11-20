import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/index.ts";
import {
  appendEvent,
  appendRevision,
  createCommandSchema,
  createDeliverySchema,
  createEventLogSchema,
  createFtsSchema,
  executeCommand,
  stmt,
  syncChapterFts,
  withReadTx,
  withWriteTx,
  type SqliteDatabase,
} from "../storage/index.ts";
import { createGenerationLedger, type GenerationLedger } from "../storage/author-generation.ts";
import { createAuthorSchema } from "../storage/author-schema.ts";
import { createAuthorModelReader } from "../workflow/author-reads.ts";
import { isLegalTransition, type Concern, type RunState } from "../workflow/index.ts";
import type { ProductLineRegistry } from "./product-line.ts";

export type Input = Record<string, unknown>;
export type Product = "fanqie" | "toutiao";

export interface DocumentRow {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly product: Product;
  readonly state: string;
  readonly mode: string | null;
  readonly line: string | null;
  readonly revisionId: string | null;
  readonly finalRevisionId: string | null;
  readonly body: string | null;
  readonly editorialRejections: number;
  readonly qaRounds: number;
  readonly volumeId: string | null;
  readonly actId: string | null;
  readonly charCount: number;
  readonly summary: string;
  readonly updatedAt: number;
}

export interface RunRow {
  readonly id: string;
  readonly documentId: string;
  readonly state: RunState;
  readonly baseRevisionId: string;
  readonly frozenInput: string;
  readonly reserved: number;
  readonly settled: number;
  readonly candidateId: string | null;
  readonly lateUsageSettled: number;
}

export function invalid(field: string, reason = "required"): never {
  throw new ContractError("input.invalid", { field, reason });
}

export function text(input: Input, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) invalid(field);
  return value;
}

export function count(input: Input, field: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(field, "nonnegative-integer-required");
  }
  return value;
}

export function requiredRow<T>(row: unknown, objectType: string, objectId: string): T {
  if (!row) throw new ContractError("input.not_found", { objectType, objectId });
  return row as T;
}

export function refuse(action: string, reason: string): never {
  throw new ContractError("gate.denied", { action, reason });
}

export function countNonWhitespace(value: string): number {
  return [...value.replace(/\s/gu, "")].length;
}

export function optionalText(input: Input, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid(field, "string-required");
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function createWorkspaceContext(db: SqliteDatabase, registry: ProductLineRegistry) {
  createCommandSchema(db);
  createEventLogSchema(db);
  createDeliverySchema(db);
  createAuthorSchema(db);
  createFtsSchema(db);
  for (const mod of registry.all()) mod.initSchema(db);

  const atomic = <T>(apply: () => T): T => withWriteTx(db, apply);
  const read = <T>(query: () => T): T => withReadTx(db, query);

  const generation: GenerationLedger = createGenerationLedger(db);
  const readAuthorModel = createAuthorModelReader(db, { read, atomic }, registry.collectReadModels());

  const competingRunStmt = stmt(db, `
    SELECT 1 FROM author_runs
    WHERE document_id = ? AND id IS NOT ? AND state IN ('running', 'paused', 'awaiting-author')
    LIMIT 1;
  `);

  const documentSelect = `
    SELECT a.id, a.project_id AS projectId, a.title, p.product, a.state, a.mode, a.line,
      d.current_revision_id AS revisionId, a.final_revision_id AS finalRevisionId, r.body,
      a.editorial_rejections AS editorialRejections, a.qa_rounds AS qaRounds,
      a.volume_id AS volumeId, a.act_id AS actId, a.char_count AS charCount,
      a.summary, a.updated_at AS updatedAt
    FROM author_documents a
    JOIN author_projects p ON p.id = a.project_id
    JOIN documents d ON d.document_id = a.id
    LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
  `;

  function document(id: string): DocumentRow {
    return requiredRow<DocumentRow>(stmt(db, `${documentSelect} WHERE a.id = ?;`).get(id), "document", id);
  }

  function run(id: string): RunRow {
    return requiredRow<RunRow>(
      stmt(db, `
        SELECT id, document_id AS documentId, state, base_revision_id AS baseRevisionId,
          frozen_input AS frozenInput, reserved, settled, candidate_id AS candidateId,
          late_usage_settled AS lateUsageSettled
        FROM author_runs WHERE id = ?;
      `).get(id),
      "run",
      id,
    );
  }

  function event(projectId: string, concern: Concern, kind: string, payload: Input): number {
    const appended = appendEvent(db, {
      projectId,
      eventId: randomUUID(),
      kind,
      payload: { ...payload, concern },
    });
    return appended.seq;
  }

  function stage(current: RunRow, next: RunState): void {
    if (!isLegalTransition(current.state, next)) {
      refuse("run.transition", `${current.state} → ${next}`);
    }
    stmt(db, "UPDATE author_runs SET state = ? WHERE id = ?;").run(next, current.id);
    const row = document(current.documentId);
    event(row.projectId, "run", "run.state", { runId: current.id, state: next });
    if ((next === "applied" || next === "discarded" || next === "cancelled") && current.candidateId) {
      event(row.projectId, "candidate", "candidate.closed", {
        documentId: row.id,
        candidateId: current.candidateId,
      });
    }
  }

  function assertRunAvailable(action: string, documentId: string, runId: string | null = null): void {
    if (competingRunStmt.get(documentId, runId)) refuse(action, "generation-in-progress");
    if (generation.unresolvedForDocument(documentId, runId)) {
      refuse(action, "generation-needs-reconciliation");
    }
  }

  function commandInput(row: DocumentRow, input: Input) {
    const base = input.baseRevisionId;
    if (base !== null && base !== undefined && typeof base !== "string") invalid("baseRevisionId");
    return {
      actor: "author" as const,
      documentId: row.id,
      payload: input,
      baseRevisionId: base ?? null,
      idempotencyKey: typeof input.key === "string" ? input.key : undefined,
    };
  }

  function dispatch<T>(commandId: string, row: DocumentRow, input: Input, apply: () => T): T {
    const result = executeCommand(db, { commandId, ...commandInput(row, input) }, apply);
    if (!result.ok) throw new ContractError(result.code!, result.details);
    return result.result as T;
  }

  function currentBody(row: DocumentRow, input: Input): void {
    if (!row.revisionId || row.revisionId !== input.baseRevisionId) {
      throw new ContractError("version.conflict", {
        documentId: row.id,
        baseRevisionId: input.baseRevisionId ?? null,
        currentRevisionId: row.revisionId,
      });
    }
  }

  function isLockedDocument(row: Pick<DocumentRow, "product" | "state">): boolean {
    return registry.isLockedState(row.product, row.state);
  }

  function appendDraftRevision(
    row: DocumentRow,
    body: string,
    onSavedState: (doc: DocumentRow) => void,
  ): { revisionId: string } {
    if (isLockedDocument(row)) refuse("draft.save", "revision-locked");
    const now = Date.now();
    const revision = appendRevision(db, {
      revisionId: randomUUID(),
      documentId: row.id,
      body,
      createdAt: now,
    });
    const charCount = countNonWhitespace(body);
    stmt(db, "UPDATE author_documents SET char_count = ?, updated_at = ? WHERE id = ?;")
      .run(charCount, now, row.id);
    syncChapterFts(db, {
      projectId: row.projectId,
      documentId: row.id,
      title: row.title,
      summary: row.summary,
      body,
    });
    const updatedRow: DocumentRow = {
      ...row,
      body,
      revisionId: revision.revisionId,
      charCount,
      updatedAt: now,
    };
    onSavedState(updatedRow);
    event(row.projectId, "revision", "revision.saved", {
      documentId: row.id,
      revisionId: revision.revisionId,
    });
    return revision;
  }

  function chapterOrder(projectId: string, chapters?: readonly { id: string }[]): string[] {
    const known = chapters ?? (stmt(db, "SELECT id FROM author_documents WHERE project_id = ? ORDER BY rowid;")
      .all(projectId) as readonly { id: string }[]);
    const saved = stmt(db, "SELECT chapter_ids FROM author_chapter_order WHERE project_id = ?;")
      .get(projectId) as { chapter_ids: string } | undefined;
    const ids: string[] = saved ? (JSON.parse(saved.chapter_ids) as string[]) : [];
    const ordered = new Set(ids);
    return [...ids, ...known.map(({ id }) => id).filter((id) => !ordered.has(id))];
  }

  function planning(documentId: string): Input | null {
    const row = stmt(db, "SELECT value FROM author_planning WHERE document_id = ?;")
      .get(documentId) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Input) : null;
  }

  function savePlanning(row: DocumentRow, value: Input): void {
    stmt(db, `
      INSERT INTO author_planning (document_id, value) VALUES (?, ?)
      ON CONFLICT (document_id) DO UPDATE SET value = excluded.value;
    `).run(row.id, JSON.stringify(value));
    event(row.projectId, "chapter", "document.planning", { documentId: row.id });
  }

  return {
    db,
    generation,
    readAuthorModel,
    atomic,
    read,
    document,
    run,
    event,
    stage,
    assertRunAvailable,
    commandInput,
    dispatch,
    currentBody,
    isLockedDocument,
    appendDraftRevision,
    chapterOrder,
    planning,
    savePlanning,
  };
}

export type WorkspaceContext = ReturnType<typeof createWorkspaceContext>;
