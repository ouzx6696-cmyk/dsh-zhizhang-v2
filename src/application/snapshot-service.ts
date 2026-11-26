import { currentSeq, stmt } from "../storage/index.ts";
import { getLatestAgentWriteForDoc, getProjectCollaboration } from "./collaboration.ts";
import type { WorkspaceContext } from "./context.ts";
import type { ProductLineRegistry } from "./product-line.ts";

export function createSnapshotService(ctx: WorkspaceContext, registry: ProductLineRegistry) {
  const { db } = ctx;

  function buildSnapshot(projectId?: string, documentId?: string) {
    const projects = stmt(db, "SELECT id, name, product FROM author_projects ORDER BY rowid;").all();
    if (!projectId) return { projects };

    const documents = stmt(
      db,
      "SELECT id, title FROM author_documents WHERE project_id = ? ORDER BY rowid;",
    ).all(projectId) as readonly { id: string; title: string }[];
    const order = ctx.chapterOrder(projectId, documents);
    const byId = new Map(documents.map((entry) => [entry.id, entry]));
    const sorted = [];
    for (const id of order) {
      const entry = byId.get(id);
      if (entry) sorted.push(entry);
    }

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
          WITH visible_runs AS (
            SELECT recent.rowid FROM (
              SELECT rowid FROM author_runs WHERE document_id = ? ORDER BY rowid DESC LIMIT 2
            ) recent
            UNION
            SELECT MAX(rowid) FROM author_runs WHERE document_id = ?
              AND state IN ('running', 'awaiting-author') GROUP BY state
            UNION
            SELECT ar.rowid FROM author_jobs aj INDEXED BY author_jobs_uncertain_draft
              CROSS JOIN author_runs ar ON ar.id = aj.run_id
              WHERE ar.document_id = ? AND aj.kind = 'draft_generation' AND aj.state = 'uncertain'
                AND aj.rowid = (
                  SELECT MAX(latest.rowid) FROM author_jobs latest
                  WHERE latest.run_id = ar.id AND latest.kind = 'draft_generation'
                )
          )
          SELECT r.id, r.state, r.base_revision_id AS baseRevisionId,
            r.reserved, r.settled, r.candidate_id AS candidateId,
            CASE WHEN r.state = 'awaiting-author' THEN c.body END AS candidateBody,
            CASE WHEN json_valid(r.frozen_input) THEN json_extract(r.frozen_input, '$.baseCandidateId') END AS baseCandidateId,
            NULL AS candidateQa, NULL AS refinementRounds,
            g.state AS generationState, g.error AS generationError,
            r.recovery_hints AS recoveryHintsRaw
          FROM visible_runs v JOIN author_runs r ON r.rowid = v.rowid
          LEFT JOIN candidates c ON c.candidate_id = r.candidate_id AND r.state = 'awaiting-author'
          LEFT JOIN author_jobs g ON g.rowid = (
            SELECT MAX(a.rowid) FROM author_jobs a
            WHERE a.run_id = r.id AND a.kind = 'draft_generation'
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

    const collab = getProjectCollaboration(ctx, projectId);
    const latestAgentWrite = active ? getLatestAgentWriteForDoc(ctx, active.id) : null;
    const productContribution = activeModule ? activeModule.contributeSnapshot(ctx, projectId, active, order) : {};

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
      collaborationMode: collab.collaborationMode,
      agentPromptInjection: collab.agentPromptInjection,
      latestAgentWrite,
      pendingProposalCount: 0,
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
