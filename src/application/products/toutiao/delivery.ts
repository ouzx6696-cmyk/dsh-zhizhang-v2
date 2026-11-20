import { ContractError, type ApprovalRecord } from "../../../contracts/index.ts";
import { formatDelivery } from "../../../domain/toutiao/index.ts";
import { attemptExport, pendingExports, stmt } from "../../../storage/index.ts";
import { commitApprovedDelivery } from "../../../storage/delivery.ts";
import { refuse, requiredRow, text, type DocumentRow, type Input, type WorkspaceContext } from "../../context.ts";
import { moveArticle } from "./workflow.ts";

export function recordedApproval(ctx: WorkspaceContext, row: DocumentRow, revisionId: string): ApprovalRecord | null {
  const record = stmt(ctx.db, "SELECT at FROM author_approvals WHERE document_id = ? AND revision_id = ?;")
    .get(row.id, revisionId) as { at: string } | undefined;
  return record
    ? {
        actor: "author",
        action: "article.deliver",
        target: row.id,
        targetVersion: revisionId,
        decision: "approved",
        at: record.at,
      }
    : null;
}

export function approvedMarkdown(ctx: WorkspaceContext, id: string): string {
  const revision = requiredRow<{ title: string; body: string }>(
    stmt(ctx.db, `
      SELECT a.title, r.body FROM deliveries d
      JOIN revisions r ON r.revision_id = d.final_revision_id AND r.document_id = d.article_id
      JOIN author_documents a ON a.id = d.article_id
      WHERE d.article_id = ?;
    `).get(id),
    "delivery",
    id,
  );
  return formatDelivery(revision.title, revision.body);
}

export function exportDelivery(
  ctx: WorkspaceContext,
  id: string,
  writeDelivery: (documentId: string, body: string) => void,
) {
  return attemptExport(ctx.db, id, (body) => writeDelivery(id, body), () => approvedMarkdown(ctx, id));
}

export function decideApproval(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
  return ctx.atomic(() => {
    const current = ctx.document(row.id);
    ctx.currentBody(current, input);
    if (current.state !== "已验收") refuse("approval.decide", "accepted-article-required");
    if (input.confirmed !== true) refuse("approval.decide", "explicit-confirmation-required");
    if (recordedApproval(ctx, current, current.revisionId!)) return { approved: true };
    const at = new Date().toISOString();
    const approvalRow = stmt(ctx.db, "INSERT INTO author_approvals (document_id, revision_id, at) VALUES (?, ?, ?);")
      .run(row.id, current.revisionId, at);
    const version = stmt(ctx.db, "SELECT rowid AS number FROM revisions WHERE revision_id = ?;")
      .get(current.revisionId) as { number: number };
    ctx.event(row.projectId, "approval", "delivery.approved", {
      documentId: row.id,
      revisionId: current.revisionId,
      approvalId: String(approvalRow.lastInsertRowid),
      versionNumber: version.number,
      at,
    });
    return { approved: true };
  });
}

export function deliverArticle(
  ctx: WorkspaceContext,
  row: DocumentRow,
  input: Input,
  writeDelivery: (documentId: string, body: string) => void,
) {
  const approval = recordedApproval(ctx, row, text(input, "baseRevisionId"));
  if (!approval) refuse("article.deliver", "approval-missing");
  const outcome = commitApprovedDelivery(
    ctx.db,
    {
      ...ctx.commandInput(row, input),
      finalRevisionId: approval.targetVersion,
      approval,
    },
    () => {
      const current = ctx.document(row.id);
      if (current.state !== "已验收" || current.finalRevisionId !== approval.targetVersion) {
        refuse("article.deliver", "accepted-article-required");
      }
      moveArticle(ctx, current, "已交稿");
      return { id: row.id };
    },
  );
  if (!outcome.ok) throw new ContractError(outcome.code!, outcome.details);
  return exportDelivery(ctx, row.id, writeDelivery);
}

export function resumeExports(
  ctx: WorkspaceContext,
  writeDelivery: (documentId: string, body: string) => void,
): void {
  for (const id of pendingExports(ctx.db)) {
    const row = ctx.document(id);
    if (row.state !== "已交稿") continue;
    exportDelivery(ctx, id, writeDelivery);
  }
}
