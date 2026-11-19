import { currentSeq } from "../storage/index.ts";
import type { WorkspaceContext } from "./context.ts";
import type { FanqieService } from "./fanqie-service.ts";
import type { ToutiaoService } from "./toutiao-service.ts";

export function createSnapshotService(
  ctx: WorkspaceContext,
  fanqie: FanqieService,
  toutiao: ToutiaoService,
) {
  const { db } = ctx;

  function buildSnapshot(projectId?: string, documentId?: string) {
    const projects = db
      .prepare("SELECT id, name, product FROM author_projects ORDER BY rowid;")
      .all();
    if (!projectId) return { projects };

    const documents = db
      .prepare("SELECT id, title, state FROM author_documents WHERE project_id = ? ORDER BY rowid;")
      .all(projectId) as readonly { id: string; title: string; state: string }[];
    const order = ctx.chapterOrder(projectId, documents);
    const byId = new Map(documents.map((entry) => [entry.id, entry]));
    const sorted = order
      .map((id) => byId.get(id))
      .filter((entry): entry is { id: string; title: string; state: string } => entry !== undefined)
      .map(({ id, title }) => ({ id, title }));

    const active = documentId && byId.has(documentId) ? ctx.document(documentId) : undefined;
    const runs = active
      ? db.prepare(`
          SELECT r.id, r.state, r.base_revision_id AS baseRevisionId,
            r.reserved, r.settled, r.candidate_id AS candidateId,
            CASE WHEN r.state = 'awaiting-author' THEN c.body END AS candidateBody,
            q.report AS candidateQa, q.rounds AS refinementRounds,
            g.state AS generationState, g.error AS generationError
          FROM author_runs r
          LEFT JOIN candidates c ON c.candidate_id = r.candidate_id AND r.state = 'awaiting-author'
          LEFT JOIN author_candidate_qa q ON q.candidate_id = c.candidate_id
          LEFT JOIN author_generation_attempts g ON g.rowid = (
            SELECT MAX(a.rowid) FROM author_generation_attempts a WHERE a.run_id = r.id
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
        `).all(active.id, active.id, active.id)
      : [];

    const approved = Boolean(active?.revisionId && toutiao.recordedApproval(active, active.revisionId));
    const delivery = active?.state === "已交稿" ? toutiao.approvedMarkdown(active.id) : null;
    const exportStatus = delivery
      ? db.prepare(`
          SELECT export_state AS state, export_error AS error,
            export_hash AS hash, final_revision_id AS revisionId
          FROM deliveries WHERE article_id = ?;
        `).get(active!.id)
      : null;

    const report = active?.revisionId ? toutiao.latestReport(projectId, active.revisionId) : null;
    const settings = active?.product === "fanqie" ? fanqie.settingsPage(projectId) : null;

    return {
      projects,
      documents: sorted,
      active,
      runs,
      approved,
      delivery,
      exportStatus,
      settings: settings?.entries ?? [],
      settingsCursor: settings?.cursor ?? null,
      report,
      planning: active ? ctx.planning(active.id) : null,
      scenario: active ? toutiao.resolveScenario(active.mode, active.line) : null,
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
