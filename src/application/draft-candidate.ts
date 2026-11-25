import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/errors.ts";
import { createCandidate, stmt } from "../storage/index.ts";
import { refuse, type DocumentRow, type WorkspaceContext } from "./context.ts";

export function stageDraftCandidate(
  ctx: WorkspaceContext,
  base: DocumentRow,
  saveDraft: (row: DocumentRow, body: string) => { readonly revisionId: string },
  body: string,
  metadata: { readonly origin: string; readonly [key: string]: unknown },
) {
  return ctx.atomic(() => {
    const row = ctx.document(base.id);
    if (ctx.isLockedDocument(row)) refuse("candidate.create", "revision-locked");
    if (row.revisionId !== base.revisionId) {
      throw new ContractError("version.conflict", {
        documentId: row.id, baseRevisionId: base.revisionId, currentRevisionId: row.revisionId,
      });
    }
    ctx.assertRunAvailable("candidate.create", row.id);
    const baseRevisionId = row.revisionId ?? saveDraft(row, "").revisionId;
    const runId = randomUUID();
    const candidateId = randomUUID();
    const frozenInput = JSON.stringify({ ...metadata, title: row.title, revisionId: baseRevisionId });
    stmt(ctx.db, `
      INSERT INTO author_runs (
        id, document_id, state, base_revision_id, frozen_input, reserved, settled, candidate_id
      ) VALUES (?, ?, 'awaiting-author', ?, ?, 0, 0, ?);
    `).run(runId, row.id, baseRevisionId, frozenInput, candidateId);
    createCandidate(ctx.db, { candidateId, documentId: row.id, baseRevisionId, body });
    ctx.event(row.projectId, "candidate", "candidate.created", {
      documentId: row.id, runId, candidateId, origin: metadata.origin,
    });
    return { runId, candidateId, baseRevisionId };
  });
}
