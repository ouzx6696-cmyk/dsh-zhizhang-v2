import type { AiProposalKind } from "../contracts/workspace-dto.ts";

/**
 * Proposals that only make sense as a diff against one chapter's current text.
 * They must carry a `documentId` at creation and stay pinned to it at decision
 * time (FQ-07); otherwise the commit path has to guess a chapter and can write
 * a summary or fact into the wrong one.
 */
export const DOCUMENT_BOUND_PROPOSAL_KINDS = [
  "setting",
  "summary",
  "fact_sync",
  "chapter_review",
] as const satisfies readonly AiProposalKind[];

const DOCUMENT_BOUND_SET: ReadonlySet<string> = new Set(DOCUMENT_BOUND_PROPOSAL_KINDS);

export function isDocumentBoundProposalKind(kind: string): kind is typeof DOCUMENT_BOUND_PROPOSAL_KINDS[number] {
  return DOCUMENT_BOUND_SET.has(kind);
}

/**
 * Fields an AI payload must never control: the proposal row already owns them,
 * and letting the payload restate them opens cross-project / cross-scope writes
 * through `deconstruct.save` and `technique.save` (FQ-06).
 */
const RESERVED_PAYLOAD_FIELDS = [
  "id",
  "scope",
  "projectId",
  "priority",
  "status",
  "overrideOfId",
] as const;

export function sanitizeProposalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...payload };
  for (const key of RESERVED_PAYLOAD_FIELDS) delete copy[key];
  return copy;
}
