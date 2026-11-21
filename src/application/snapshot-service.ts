import { currentSeq, stmt } from "../storage/index.ts";
import type { WorkspaceContext } from "./context.ts";
import type { ProductLineRegistry } from "./product-line.ts";

export function createSnapshotService(ctx: WorkspaceContext, registry: ProductLineRegistry) {
  const { db } = ctx;

  function buildSnapshot(projectId?: string, documentId?: string) {
    const projects = stmt(db, "SELECT id, name, product FROM author_projects ORDER BY rowid;").all();
    if (!projectId) return { projects };

    const documents = stmt(
      db,
      "SELECT id, title, state FROM author_documents WHERE project_id = ? ORDER BY rowid;",
    ).all(projectId) as readonly { id: string; title: string; state: string }[];
    const order = ctx.chapterOrder(projectId, documents);
    const byId = new Map(documents.map((entry) => [entry.id, entry]));
    const sorted = order
      .map((id) => byId.get(id))
      .filter((entry): entry is { id: string; title: string; state: string } => entry !== undefined)
      .map(({ id, title }) => ({ id, title }));

    const active = documentId && byId.has(documentId) ? ctx.document(documentId) : undefined;
    const activeModule = active ? registry.get(active.product) : undefined;
    const activeContext = active
      ? (activeModule?.buildActiveContext?.(ctx, active) ?? {
          volumeId: active.volumeId,
          volumeTitle: null,
          actId: active.actId,
          actTitle: null,
          charCount: active.charCount,
          summary: active.summary,
        })
      : null;

    const baseRuns = active
      ? (stmt(db, `
          SELECT r.id, r.state, r.base_revision_id AS baseRevisionId,
            r.reserved, r.settled, r.candidate_id AS candidateId,
            CASE WHEN r.state = 'awaiting-author' THEN c.body END AS candidateBody,
            NULL AS candidateQa, NULL AS refinementRounds,
            g.state AS generationState, g.error AS generationError,
            r.recovery_hints AS recoveryHintsRaw
          FROM author_runs r
          LEFT JOIN candidates c ON c.candidate_id = r.candidate_id AND r.state = 'awaiting-author'
          LEFT JOIN author_jobs g ON g.rowid = (
            SELECT MAX(a.rowid) FROM author_jobs a
            WHERE a.run_id = r.id AND a.kind = 'draft_generation'
          )
          WHERE r.document_id = ? AND (
            r.rowid IN (SELECT rowid FROM author_runs WHERE document_id = ? ORDER BY rowid DESC LIMIT 2)
            OR r.rowid IN (
              SELECT MAX(rowid) FROM author_runs WHERE document_id = ?
              AND state IN ('running', 'awaiting-author') GROUP BY state
            )
            OR g.state = 'uncertain'
          )
          ORDER BY r.rowid DESC;
        `).all(active.id, active.id, active.id) as readonly Record<string, unknown>[]).map((runRow) => {
          const { recoveryHintsRaw, ...rest } = runRow;
          if (typeof recoveryHintsRaw === "string" && recoveryHintsRaw.length > 0) {
            try {
              const parsed = JSON.parse(recoveryHintsRaw) as unknown;
              if (Array.isArray(parsed) && parsed.length > 0) {
                return { ...rest, recoveryHints: parsed };
              }
            } catch {
              // Ignore malformed hints metadata on snapshot read.
            }
          }
          return rest;
        })
      : [];

    const runs = active && activeModule?.enrichRunSummaries
      ? activeModule.enrichRunSummaries(ctx, active, baseRuns)
      : baseRuns;

    const recentJobs = ctx.jobs
      .list({ projectId, ...(active ? { documentId: active.id } : {}), limit: 20 })
      .map((j) => ({
        id: j.id,
        kind: j.kind,
        subtype: j.subtype,
        projectId: j.projectId,
        documentId: j.documentId,
        runId: j.runId,
        proposalId: j.proposalId,
        provider: j.provider,
        model: j.model,
        state: j.state,
        stage: j.stage,
        reserved: j.reserved,
        settled: j.settled,
        error: j.error,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      }));

    const productContribution = activeModule ? activeModule.contributeSnapshot(ctx, projectId, active) : {};

    return {
      projects,
      documents: sorted,
      active,
      activeContext,
      runs,
      jobs: recentJobs,
      approved: false,
      delivery: null,
      exportStatus: null,
      settings: [],
      settingsCursor: null,
      report: null,
      planning: active ? ctx.planning(active.id) : null,
      scenario: null,
      ...productContribution,
      asOfSeq: currentSeq(db, projectId),
    };
  }

  return {
    snapshot: (projectId?: string, documentId?: string) => ctx.read(() => buildSnapshot(projectId, documentId)),
    readState: (projectId?: string, documentId?: string, ifSequence?: string) =>
      ctx.read(() => {
        if (projectId && ifSequence === String(currentSeq(db, projectId))) {
          return { unchanged: true };
        }
        return buildSnapshot(projectId, documentId);
      }),
    projectSeq: (projectId: string) => currentSeq(db, projectId),
  };
}
