// The external delivery export state machine (contracts.md B.10, frozen
// 2026-11-19; pinned by `storage-a01.test.mjs`).
//
// The delivery itself commits inside the database transaction. The external
// file write is a separate side effect with its own state, because the two
// cannot be made atomic and pretending otherwise would lose a delivery:
//
//   - `pending` — committed, the external write has not succeeded yet;
//   - `exported` — the file is written and its hash recorded;
//   - `failed` — the last attempt failed; the committed row is untouched.
//
// The set is closed. A failure records whether it is retryable: a transient
// error keeps the delivery in the pending worklist, an error the author has to
// resolve (a conflicting target, say) leaves it and surfaces instead of
// retrying forever. `export_attempts` counts real attempts only — an already
// exported delivery returns early and does not count.

import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./driver.ts";
import { StorageError } from "./errors.ts";
import { withWriteTx } from "./tx.ts";

/** The closed export-state set. */
export const EXPORT_STATES = ["pending", "exported", "failed"] as const;

export type ExportState = (typeof EXPORT_STATES)[number];

/** The committed delivery row the export state hangs off. */
export interface Delivery {
  readonly articleId: string;
  readonly finalRevisionId: string;
  readonly approvalId: string;
}

/** What one export attempt reports. */
export interface ExportAttempt {
  readonly state: ExportState;
  readonly hash: string | null;
  readonly wrote: boolean;
  readonly retryable: boolean | null;
}

/** The reconciliation report after a restart. */
export interface ExportReconciliation {
  readonly pending: readonly string[];
  readonly needsAuthor: readonly string[];
}

const DELIVERY_TABLE = `
  CREATE TABLE IF NOT EXISTS deliveries (
    article_id TEXT PRIMARY KEY,
    final_revision_id TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    export_state TEXT NOT NULL,
    export_hash TEXT,
    export_error TEXT,
    export_attempts INTEGER NOT NULL DEFAULT 0
  );
`;

/** Creates the delivery table. Idempotent, so a restart can re-run it. */
export function createDeliverySchema(db: SqliteDatabase): void {
  db.exec(DELIVERY_TABLE);
}

/**
 * Inserts the delivery row inside a transaction the caller already opened.
 *
 * One article is delivered once: the table's primary key is the article, so a
 * second delivery of the same article is a version conflict rather than a
 * duplicate row. The details name the revision already delivered, using the
 * disclosure fields `version.conflict` allows.
 */
export function insertDeliveryRow(db: SqliteDatabase, delivery: Delivery): void {
  const existing = db
    .prepare("SELECT final_revision_id FROM deliveries WHERE article_id = ?;")
    .get(delivery.articleId);
  if (existing !== null && existing !== undefined) {
    const value = existing as { final_revision_id?: unknown };
    throw new StorageError("version.conflict", {
      documentId: delivery.articleId,
      baseRevisionId: delivery.finalRevisionId,
      currentRevisionId: typeof value.final_revision_id === "string" ? value.final_revision_id : null,
    });
  }
  db.prepare(
    "INSERT INTO deliveries (article_id, final_revision_id, approval_id, export_state) VALUES (?, ?, ?, 'pending');",
  ).run(delivery.articleId, delivery.finalRevisionId, delivery.approvalId);
}

/** Commits a delivery inside one transaction. The export starts `pending`. */
export function commitDelivery(db: SqliteDatabase, delivery: Delivery): void {
  withWriteTx(db, () => {
    insertDeliveryRow(db, delivery);
  });
}

/** The bytes an external write receives for one delivery. */
export function exportPayload(row: {
  readonly article_id: string;
  readonly final_revision_id: string;
  readonly approval_id: string;
}): string {
  return `${row.article_id}\n${row.final_revision_id}\n${row.approval_id}\n`;
}

function isExportState(value: unknown): value is ExportState {
  return typeof value === "string" && (EXPORT_STATES as readonly string[]).includes(value);
}

interface DeliveryRow {
  readonly article_id: string;
  readonly final_revision_id: string;
  readonly approval_id: string;
  readonly export_state: unknown;
  readonly export_hash: unknown;
}

function readDeliveryRow(db: SqliteDatabase, articleId: string): DeliveryRow {
  const row = db
    .prepare(
      "SELECT article_id, final_revision_id, approval_id, export_state, export_hash FROM deliveries WHERE article_id = ?;",
    )
    .get(articleId);
  if (row === null || row === undefined) {
    throw new StorageError("input.not_found", { objectType: "delivery", objectId: articleId });
  }
  const value = row as Partial<DeliveryRow>;
  if (
    typeof value.article_id !== "string" ||
    typeof value.final_revision_id !== "string" ||
    typeof value.approval_id !== "string"
  ) {
    throw new StorageError("input.invalid", { reason: "delivery-row-malformed", articleId });
  }
  return {
    article_id: value.article_id,
    final_revision_id: value.final_revision_id,
    approval_id: value.approval_id,
    export_state: value.export_state,
    export_hash: value.export_hash,
  };
}

/**
 * Attempts the external write for one delivery.
 *
 * `write` performs the side effect and throws on failure; a thrown error with
 * `retryable === false` means the author has to resolve it. The committed
 * delivery row is never modified by a failure beyond the export columns.
 */
export function attemptExport(
  db: SqliteDatabase,
  articleId: string,
  write: (payload: string) => void,
  render: (row: DeliveryRow) => string = exportPayload,
): ExportAttempt {
  const row = readDeliveryRow(db, articleId);
  if (!isExportState(row.export_state)) {
    throw new StorageError("input.invalid", {
      reason: "unknown-export-state",
      exportState: row.export_state,
    });
  }
  if (row.export_state === "exported") {
    return {
      state: "exported",
      hash: typeof row.export_hash === "string" ? row.export_hash : null,
      wrote: false,
      retryable: null,
    };
  }
  const payload = render(row);
  try {
    write(payload);
  } catch (error) {
    const retryable = (error as { retryable?: unknown } | null)?.retryable !== false;
    db.prepare(
      "UPDATE deliveries SET export_state = 'failed', export_error = ?, export_attempts = export_attempts + 1 WHERE article_id = ?;",
    ).run(
      JSON.stringify({ code: (error as { code?: unknown } | null)?.code ?? "export.write_failed", retryable }),
      articleId,
    );
    return { state: "failed", hash: null, wrote: false, retryable };
  }
  const hash = createHash("sha256").update(payload).digest("hex");
  db.prepare(
    "UPDATE deliveries SET export_state = 'exported', export_hash = ?, export_error = NULL, export_attempts = export_attempts + 1 WHERE article_id = ?;",
  ).run(hash, articleId);
  return { state: "exported", hash, wrote: true, retryable: null };
}

/**
 * Every delivery the automatic retry should pick up: still-pending ones, plus
 * failures that are retryable.
 *
 * A failure the author has to resolve has left this worklist — retrying it
 * forever would not help — and shows up in `reconcileExports` as
 * `needsAuthor` instead. This is exactly that report's pending side, derived
 * from it so the two can never disagree about which failures are retryable.
 */
export function pendingExports(db: SqliteDatabase): readonly string[] {
  return reconcileExports(db).pending;
}

/**
 * What still needs an export after a restart, and what failed in a way that
 * needs the author. A failed delivery whose error is not retryable is the
 * author's to resolve and leaves the automatic worklist.
 */
export function reconcileExports(db: SqliteDatabase): ExportReconciliation {
  const rows = db
    .prepare("SELECT article_id, export_state, export_error FROM deliveries WHERE export_state IN ('pending', 'failed');")
    .all();
  const pending: string[] = [];
  const needsAuthor: string[] = [];
  for (const row of rows) {
    const value = row as { article_id?: unknown; export_state?: unknown; export_error?: unknown };
    if (typeof value.article_id !== "string") continue;
    const error = typeof value.export_error === "string" ? safeParse(value.export_error) : null;
    if (value.export_state === "failed" && error?.retryable === false) {
      needsAuthor.push(value.article_id);
    } else {
      pending.push(value.article_id);
    }
  }
  return { pending, needsAuthor };
}

function safeParse(raw: string): { retryable?: unknown } | null {
  try {
    return JSON.parse(raw) as { retryable?: unknown };
  } catch {
    return null;
  }
}
