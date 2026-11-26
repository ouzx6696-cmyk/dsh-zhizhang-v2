import type { ChapterContinuationState, ChapterVersionDto } from "../contracts/workspace-dto.ts";
import { stmt } from "../storage/index.ts";
import { invalid, optionalText, type DocumentRow, type Input, type WorkspaceContext } from "./context.ts";

export function previousChapter(ctx: WorkspaceContext, row: DocumentRow, order = ctx.chapterOrder(row.projectId)) {
  const index = order.indexOf(row.id);
  if (index <= 0) return null;
  const previous = ctx.document(order[index - 1]);
  return previous.projectId === row.projectId ? previous : null;
}

export function chapterVersionOptions(
  ctx: WorkspaceContext, row: DocumentRow, order: readonly string[] = ctx.chapterOrder(row.projectId),
): readonly ChapterVersionDto[] {
  const index = order.indexOf(row.id);
  if (index <= 0) return [];
  const previous = stmt(ctx.db, `
    SELECT a.id, a.title, d.current_revision_id AS revisionId
    FROM author_documents a JOIN documents d ON d.document_id = a.id
    WHERE a.id = ? AND a.project_id = ?;
  `).get(order[index - 1], row.projectId) as { id: string; title: string; revisionId: string | null } | undefined;
  if (!previous) return [];
  const versions = stmt(ctx.db, `
    SELECT revision_id AS id, created_at AS createdAt
    FROM revisions WHERE document_id = ? AND revision_id != COALESCE(?, '')
    ORDER BY rowid DESC LIMIT 8;
  `).all(previous.id, previous.revisionId) as readonly { id: string; createdAt: number }[];
  const pending = stmt(ctx.db, `
    SELECT candidate_id AS id
    FROM author_runs WHERE document_id = ? AND state = 'awaiting-author' AND candidate_id IS NOT NULL
    ORDER BY rowid DESC;
  `).all(previous.id) as readonly { id: string }[];
  const current = previous.revisionId ? [{ id: previous.revisionId, kind: "revision" as const, current: true }] : [];
  return [
    ...current,
    ...pending.map((version) => ({ ...version, kind: "candidate" as const })),
    ...versions.map((version) => ({ ...version, kind: "revision" as const })),
  ].map((version) => ({
    ...version,
    documentId: previous.id,
    title: previous.title,
  }));
}

function lookupVersion(ctx: WorkspaceContext, documentId: string, versionId: string) {
  return stmt(ctx.db, `
    SELECT 'revision' AS kind, body, NULL AS baseRevisionId, NULL AS state
    FROM revisions WHERE document_id = ? AND revision_id = ?
    UNION ALL
    SELECT 'candidate' AS kind, c.body, c.base_revision_id AS baseRevisionId, r.state
    FROM candidates c LEFT JOIN author_runs r ON r.document_id = c.document_id AND r.candidate_id = c.candidate_id
    WHERE c.document_id = ? AND c.candidate_id = ?;
  `).get(documentId, versionId, documentId, versionId) as {
    kind: ChapterVersionDto["kind"]; body: string; baseRevisionId: string | null; state: string | null;
  } | undefined;
}

export function resolveContinuation(
  ctx: WorkspaceContext,
  row: DocumentRow,
  input: Input,
  order?: string[],
): { source: ChapterVersionDto; body: string } | null {
  const versionId = optionalText(input, "previousVersionId");
  const previous = previousChapter(ctx, row, order);
  if (!versionId) {
    if (!previous?.revisionId) return null;
    return {
      source: { id: previous.revisionId, kind: "revision", documentId: previous.id, title: previous.title, current: true },
      body: previous.body ?? "",
    };
  }
  const match = previous && lookupVersion(ctx, previous.id, versionId);
  if (!previous || !match) invalid("previousVersionId", "previous-chapter-version-required");
  return {
    source: {
      id: versionId,
      kind: match.kind,
      documentId: previous.id,
      title: previous.title,
      current: versionId === previous.revisionId,
    },
    body: match.body,
  };
}

export function readContinuationSource(frozenInput: string): ChapterVersionDto | null {
  try {
    const source = (JSON.parse(frozenInput) as { continuationSource?: ChapterVersionDto } | null)?.continuationSource;
    return source && typeof source.id === "string" && typeof source.documentId === "string" ? source : null;
  } catch {
    return null;
  }
}

export function continuationState(ctx: WorkspaceContext, row: DocumentRow, source: ChapterVersionDto): ChapterContinuationState {
  const previous = previousChapter(ctx, row);
  if (previous?.id !== source.documentId) return "changed";
  if (previous.revisionId === source.id) return "aligned";
  const version = lookupVersion(ctx, previous.id, source.id);
  if (!version) return "unavailable";
  if (previous.body === version.body) return "aligned";
  if (version.state === "awaiting-author" && version.baseRevisionId === previous.revisionId) return "pending";
  return "changed";
}
