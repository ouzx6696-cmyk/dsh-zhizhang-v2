import { ContractError } from "../contracts/index.ts";
import type { AiProposalKind, ProposalOrigin } from "../contracts/workspace-dto.ts";
import { stmt } from "../storage/index.ts";
import { invalid, optionalText, type Input, type WorkspaceContext } from "./context.ts";
import { sha256Text } from "./digest.ts";
import { DOCUMENT_BOUND_PROPOSAL_KINDS, isDocumentBoundProposalKind } from "./proposal-kinds.ts";

/** The subset of an `author_ai_proposals` row needed to check revision drift. */
export interface ProposalFreshnessRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly documentId: string | null;
  readonly kind: AiProposalKind;
  readonly origin: ProposalOrigin;
  readonly baseRevisionId: string | null;
  readonly sourceSha256: string;
}

export type StaleCheck = "fresh" | "unpinned" | "not-bound";

// Chapter requirements and revision checks use the same list of proposal kinds.
const DRIFT_BOUND_KINDS: ReadonlySet<AiProposalKind> = new Set(DOCUMENT_BOUND_PROPOSAL_KINDS);

function staleError(row: ProposalFreshnessRow, currentRevisionId: string | null): ContractError {
  return new ContractError("gate.denied", {
    action: "proposal.decide",
    reason: "proposal-stale",
    proposalId: row.id,
    baseRevisionId: row.baseRevisionId,
    currentRevisionId,
  });
}

/**
 * Refuses to decide a proposal whose chapter moved after generation.
 *
 * Only AI-generated, document-bound proposals are gated. Manual proposals
 * (`origin = "author-ui"` or `"agent-tool"`) stay decidable, and legacy rows
 * created before 2.3.0 (null base revision) are checked against their body
 * hash when one exists instead of being silently approved against unseen text.
 */
export function assertProposalFresh(ctx: WorkspaceContext, row: ProposalFreshnessRow): StaleCheck {
  if (row.origin !== "ai-generate") return "not-bound";
  if (!DRIFT_BOUND_KINDS.has(row.kind)) return "not-bound";
  if (!row.documentId) return "unpinned";

  let doc: ReturnType<WorkspaceContext["document"]>;
  try {
    doc = ctx.document(row.documentId);
  } catch (error) {
    if (error instanceof ContractError && error.code === "input.not_found") {
      throw staleError(row, null);
    }
    throw error;
  }

  const current = doc.revisionId ?? null;
  if (!row.baseRevisionId) {
    if (row.sourceSha256 && sha256Text(doc.body ?? "") !== row.sourceSha256) {
      throw staleError(row, current);
    }
    return "unpinned";
  }
  if (current === row.baseRevisionId) return "fresh";
  if (row.sourceSha256 && sha256Text(doc.body ?? "") === row.sourceSha256) return "fresh";
  throw staleError(row, current);
}

/**
 * proposals written before the chapter requirement may have a
 * NULL `document_id`. Let the author pin one at decision time instead of
 * leaving the row undecidable forever, but never invent a chapter or accept
 * one belonging to another project.
 */
export function pinProposalChapter(
  ctx: WorkspaceContext,
  row: Pick<ProposalFreshnessRow, "id" | "projectId" | "kind" | "documentId">,
  input: Input,
  now: number,
): string | null {
  if (!isDocumentBoundProposalKind(row.kind) || row.documentId) return row.documentId;
  const supplied = optionalText(input, "documentId");
  if (!supplied) invalid("documentId", "chapter-required");
  const pinned = ctx.document(supplied);
  if (row.projectId && pinned.projectId !== row.projectId) invalid("documentId", "project-mismatch");
  stmt(ctx.db, "UPDATE author_ai_proposals SET document_id = ?, updated_at = ? WHERE id = ?;")
    .run(supplied, now, row.id);
  return supplied;
}
