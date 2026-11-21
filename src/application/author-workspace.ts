import { randomUUID } from "node:crypto";
import { createDocument, stmt, type SqliteDatabase } from "../storage/index.ts";
import {
  createWorkspaceContext,
  invalid,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type Product,
} from "./context.ts";
import { createJobService } from "./job-service.ts";
import { createProductLineRegistry } from "./product-line.ts";
import { createFanqieModule } from "./products/fanqie.ts";
import type { ProjectBundleDiskWriter } from "./products/fanqie/io.ts";
import { createToutiaoModule } from "./products/toutiao.ts";
import { createSnapshotService } from "./snapshot-service.ts";

/**
 * Composition root for the Author Workspace application layer (`zhizhang/3.0`).
 * Registers isolated Fanqie and Toutiao product-line modules on top of the
 * shared workspace, unified job service, snapshot, and event-projection platform.
 */
export function openAuthorWorkspace(
  db: SqliteDatabase,
  writeDelivery: (documentId: string, text: string) => void = () => {},
  writeProjectExport?: ProjectBundleDiskWriter,
) {
  const fanqieModule = createFanqieModule(writeProjectExport);
  const toutiaoModule = createToutiaoModule(writeDelivery);
  const registry = createProductLineRegistry([fanqieModule, toutiaoModule]);
  const ctx = createWorkspaceContext(db, registry);

  function saveDraftForRow(row: DocumentRow, body: string): { revisionId: string } {
    const mod = registry.require(row.product);
    return ctx.appendDraftRevision(row, body, (saved) => mod.onDraftSaved(ctx, saved));
  }

  const jobs = createJobService(ctx, registry, saveDraftForRow);
  const snapshots = createSnapshotService(ctx, registry);

  function mutation(action: string, input: Input) {
    switch (action) {
      case "read.model": {
        const projectId = text(input, "projectId");
        requiredRow(stmt(db, "SELECT id FROM author_projects WHERE id = ?;").get(projectId), "project", projectId);
        return ctx.readAuthorModel(projectId, input);
      }
      case "jobs.list":
        return jobs.listJobs(input);
      case "project.create": {
        const name = text(input, "name").trim();
        const product = input.product;
        const mod = typeof product === "string" ? registry.get(product) : undefined;
        if (!mod) invalid("product", "unknown-product");
        const id = randomUUID();
        return ctx.atomic(() => {
          stmt(db, "INSERT INTO author_projects (id, name, product, created_at) VALUES (?, ?, ?, ?);")
            .run(id, name, mod.id, Date.now());
          ctx.event(id, "chapter", "project.created", { name, product: mod.id });
          return { id };
        });
      }
      case "document.create": {
        const projectId = text(input, "projectId");
        const rawTitle = typeof input.title === "string" ? input.title.trim() : "";
        const project = requiredRow<{ product: Product }>(
          stmt(db, "SELECT product FROM author_projects WHERE id = ?;").get(projectId),
          "project",
          projectId,
        );
        const mod = registry.require(project.product);
        const { title, mode, line } = mod.validateCreate(input, rawTitle);
        const id = randomUUID();
        const initialState = mod.initialState;
        return ctx.atomic(() => {
          createDocument(db, id);
          stmt(db, `
            INSERT INTO author_documents (id, project_id, title, state, mode, line, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?);
          `).run(id, projectId, title, initialState, mode, line, Date.now());
          ctx.event(projectId, "chapter", "document.created", {
            documentId: id,
            title,
            mode,
            line,
            state: initialState,
          });
          mod.onDocumentCreated?.(ctx, projectId, id, input);
          return { id };
        });
      }
      case "run.complete":
      case "run.cancel":
      case "run.discard":
        return jobs.handleRunLifecycle(action, input);
    }

    const productAction = registry.resolveAction(action);
    if (productAction && (productAction.scope === "project" || productAction.scope === "global")) {
      return productAction.handler(ctx, input);
    }

    const row = ctx.document(text(input, "documentId"));
    if (productAction && productAction.scope === "document") {
      return productAction.handler(ctx, input, row);
    }

    switch (action) {
      case "draft.save":
        return ctx.dispatch(action, row, input, () => saveDraftForRow(ctx.document(row.id), text(input, "body")));
      case "run.preview":
        return jobs.previewBudget(row, input);
      case "run.start":
        return jobs.startRun(row, input);
      case "candidate.adopt":
        return jobs.adoptCandidate(row, input);
      case "run.history":
        return jobs.runHistory(row, input);
      case "run.detail":
        return jobs.runDetail(row, input);
      case "run.reconcile":
        return jobs.reconcileRun(row, input);
      default:
        return invalid("action", "unknown-action");
    }
  }

  function recoverStartup(): void {
    jobs.recoverAll();
    for (const mod of registry.all()) {
      mod.onStartupRecover?.(ctx);
    }
  }

  const toolFacade = {
    mutation,
    snapshot: snapshots.snapshot,
  };

  return {
    snapshot: snapshots.snapshot,
    readState: snapshots.readState,
    projectSeq: snapshots.projectSeq,
    mutation,
    listJobs: jobs.listJobs,
    generationInput: jobs.generationInput,
    generationRunner: jobs.generationRunner,
    beginJobCall: jobs.beginJobCall,
    recordJobReceipt: jobs.recordJobReceipt,
    finishGeneration: jobs.finishGeneration,
    reserveRefinement: jobs.reserveRefinement,
    failGeneration: jobs.failGeneration,
    buildSelectionRewriteInput: jobs.buildSelectionRewriteInput,
    beginSelectionRewrite: jobs.beginSelectionRewrite,
    finishSelectionRewrite: jobs.finishSelectionRewrite,
    microUsage: jobs.microUsage,
    beginProposalGeneration: jobs.beginProposalGeneration,
    recordProposalReceipt: jobs.recordProposalReceipt,
    finishProposalGeneration: jobs.finishProposalGeneration,
    cancelProposalGeneration: jobs.cancelProposalGeneration,
    recoverJobs: jobs.recoverAll,
    recoverStartup,
    verifyUsageConsistency: () => ctx.jobs.verifyUsageConsistency(),
    agentTools: () => registry.collectAgentTools(toolFacade),
    resumeExports: () => toutiaoModule.onStartupRecover?.(ctx),
  };
}
