// The delivery command: the approval-gated write joined to its external export.
//
// This is the one command whose frozen rules span two modules, so it lives in
// neither:
//
//   - §1 and B.9 — a delivery requires an approval record bound to this exact
//     action, object, object version and subject; without one the command is
//     `gate.denied` before anything is written;
//   - B.10 — the delivery commits inside the database transaction, while the
//     external file write is a separate side effect that cannot be made atomic
//     with it.
//
// The order those two rules force is the whole point of this module:
//
//   1. the command table's checks (authority, approval gate) run first;
//   2. the delivery row commits inside the journal transaction, together with
//      the journal row, so a crash cannot leave a delivery without its audit
//      record;
//   3. only after that transaction commits does the external write run, and a
//      failed export never rolls the delivery back — it only moves the export
//      state.
//
// So a delivery that fails to export is still a delivery: the committed row
// stays, the export stays retryable, and a restart reconciles it.

import {
  executeCommand,
  type CommandOutcome,
} from "./command.ts";
import type { SqliteDatabase } from "./driver.ts";
import {
  attemptExport,
  insertDeliveryRow,
  type Delivery,
  type ExportAttempt,
} from "./export.ts";
import type { ApprovalRecord, Subject } from "../contracts/index.ts";

/** What one delivery request carries. */
export interface DeliverArticleRequest {
  /** The subject the Host resolved. */
  readonly actor: Subject;
  /** The article being delivered. */
  readonly articleId: string;
  /** The final revision the delivery versions. */
  readonly finalRevisionId: string;
  /** The approval record that authorises this exact delivery. */
  readonly approval: ApprovalRecord | null;
  /** The revision the caller believes is current. */
  readonly baseRevisionId: string | null;
  /** The caller's idempotency key for this delivery. */
  readonly idempotencyKey: string;
}

/** What a delivery reports, including the export's own state. */
export interface DeliverArticleOutcome {
  readonly articleId: string;
  readonly export: ExportAttempt;
}

/** The external write a delivery performs after its transaction commits. */
export type ExportWriter = (payload: string) => void;

/**
 * Runs `article.deliver` end to end.
 *
 * The refusal checks and the delivery commit happen inside the frozen write
 * order; the export happens after it, so its failure is reported through the
 * export state rather than through the command's envelope.
 */
export function deliverArticle(
  db: SqliteDatabase,
  request: DeliverArticleRequest,
  write: ExportWriter,
): CommandOutcome<DeliverArticleOutcome> {
  const delivery: Delivery = {
    articleId: request.articleId,
    finalRevisionId: request.finalRevisionId,
    approvalId: request.approval?.at ?? "",
  };
  const outcome = executeCommand(
    db,
    {
      commandId: "article.deliver",
      actor: request.actor,
      documentId: request.articleId,
      idempotencyKey: request.idempotencyKey,
      payload: {
        articleId: request.articleId,
        finalRevisionId: request.finalRevisionId,
      },
      baseRevisionId: request.baseRevisionId,
      approval: request.approval,
      // The delivery versions the revision it delivers, not the one it starts
      // from, so the approval record has to name that revision.
      targetVersion: request.finalRevisionId,
    },
    () => {
      insertDeliveryRow(db, delivery);
      return { articleId: request.articleId };
    },
  );
  if (!outcome.ok) {
    return { ok: false, code: outcome.code, details: outcome.details };
  }

  // Outside the transaction now: the external write is a separate side effect.
  const attempt = attemptExport(db, request.articleId, write);
  return {
    ok: true,
    code: null,
    result: { articleId: request.articleId, export: attempt },
    replayed: outcome.replayed,
  };
}
