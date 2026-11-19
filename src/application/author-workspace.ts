import { randomUUID } from "node:crypto";
import { createDocument, type SqliteDatabase } from "../storage/index.ts";
import {
  createWorkspaceContext,
  invalid,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type Product,
} from "./context.ts";
import { createFanqieService } from "./fanqie-service.ts";
import { createRunService } from "./run-service.ts";
import { createSnapshotService } from "./snapshot-service.ts";
import { createToutiaoService } from "./toutiao-service.ts";

/**
 * Composition root for the Author Workspace application layer.
 * Routes author actions to isolated Fanqie, Toutiao, Run, and Snapshot services.
 */
export function openAuthorWorkspace(
  db: SqliteDatabase,
  writeDelivery: (documentId: string, text: string) => void,
) {
  const ctx = createWorkspaceContext(db);
  const fanqie = createFanqieService(ctx);
  const toutiao = createToutiaoService(ctx, writeDelivery);

  function saveDraftForRow(row: DocumentRow, body: string): { revisionId: string } {
    return ctx.appendDraftRevision(
      row,
      body,
      row.product === "fanqie" ? fanqie.onDraftSaved : toutiao.onDraftSaved,
    );
  }

  const runs = createRunService(ctx, fanqie, toutiao, saveDraftForRow);
  const snapshots = createSnapshotService(ctx, fanqie, toutiao);

  function mutation(action: string, input: Input) {
    switch (action) {
      case "read.model": {
        const projectId = text(input, "projectId");
        requiredRow(db.prepare("SELECT id FROM author_projects WHERE id = ?;").get(projectId), "project", projectId);
        return ctx.read(() => ctx.readAuthorModel(projectId, input));
      }
      case "setting.propose":
      case "setting.decide":
      case "settings.history":
      case "settings.read":
      case "reorder.impact":
      case "reorder.commit":
        return fanqie.handleContinuity(action, input);
      case "project.create": {
        const name = text(input, "name").trim();
        const product = input.product;
        if (product !== "fanqie" && product !== "toutiao") invalid("product", "unknown-product");
        const id = randomUUID();
        return ctx.atomic(() => {
          db.prepare("INSERT INTO author_projects (id, name, product, created_at) VALUES (?, ?, ?, ?);")
            .run(id, name, product, Date.now());
          ctx.event(id, "chapter", "project.created", { name, product });
          return { id };
        });
      }
      case "document.create": {
        const projectId = text(input, "projectId");
        const title = typeof input.title === "string" ? input.title.trim() : "";
        const project = requiredRow<{ product: Product }>(
          db.prepare("SELECT product FROM author_projects WHERE id = ?;").get(projectId),
          "project",
          projectId,
        );
        const isArticle = project.product === "toutiao";
        const mode = isArticle ? text(input, "mode") : null;
        const line = isArticle ? text(input, "line") : null;
        if (mode && line) toutiao.resolveScenario(mode, line);
        toutiao.validateArticleTitle(mode, title);
        const id = randomUUID();
        const initialState = isArticle ? "初稿待改" : "planned";
        return ctx.atomic(() => {
          createDocument(db, id);
          db.prepare(`
            INSERT INTO author_documents (id, project_id, title, state, mode, line)
            VALUES (?, ?, ?, ?, ?, ?);
          `).run(id, projectId, title, initialState, mode, line);
          ctx.event(projectId, "chapter", "document.created", {
            documentId: id,
            title,
            mode,
            line,
            state: initialState,
          });
          return { id };
        });
      }
      case "run.complete":
      case "run.cancel":
      case "run.discard":
        return runs.handleRunLifecycle(action, input);
    }

    const row = ctx.document(text(input, "documentId"));
    switch (action) {
      case "draft.save":
        return ctx.dispatch(action, row, input, () => saveDraftForRow(ctx.document(row.id), text(input, "body")));
      case "chapter.outline":
        return fanqie.saveOutline(row, input);
      case "chapter.review":
        return fanqie.reviewChapter(row, input);
      case "draft.finalize":
        return fanqie.finalizeChapter(row, input);
      case "evidence.record":
        return fanqie.recordEvidence(row, input);
      case "evidence.detail":
        return fanqie.evidenceDetail(row, input);
      case "article.plan":
        return toutiao.planArticle(row, input);
      case "article.rename":
        return toutiao.renameArticle(row, input);
      case "article.qa":
        return toutiao.recordQa(row, input);
      case "article.refine":
        return toutiao.refineDraft(row, input);
      case "article.accept":
        return toutiao.acceptArticle(row, input);
      case "approval.decide":
        return toutiao.decideApproval(row, input);
      case "article.deliver":
        return toutiao.deliverArticle(row, input);
      case "run.preview":
        return runs.previewBudget(row, input);
      case "run.start":
        return runs.startRun(row, input);
      case "candidate.adopt":
        return runs.adoptCandidate(row, input);
      case "run.history":
        return runs.runHistory(row, input);
      case "run.detail":
        return runs.runDetail(row, input);
      case "run.reconcile":
        return runs.reconcileRun(row, input);
      default:
        return invalid("action", "unknown-action");
    }
  }

  return {
    snapshot: snapshots.snapshot,
    readState: snapshots.readState,
    projectSeq: snapshots.projectSeq,
    mutation,
    generationInput: runs.generationInput,
    beginGenerationCall: runs.beginGenerationCall,
    recordGenerationReceipt: runs.recordGenerationReceipt,
    finishGeneration: runs.finishGeneration,
    recoverGenerations: runs.recoverGenerations,
    reserveRefinement: runs.reserveRefinement,
    failGeneration: runs.failGeneration,
    resumeExports: toutiao.resumeExports,
  };
}
