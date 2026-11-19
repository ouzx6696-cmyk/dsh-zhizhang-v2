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
import { createProductLineRegistry } from "./product-line.ts";
import { createFanqieModule } from "./products/fanqie.ts";
import { createToutiaoModule } from "./products/toutiao.ts";
import { createRunService } from "./run-service.ts";
import { createSnapshotService } from "./snapshot-service.ts";

/**
 * Composition root for the Author Workspace application layer.
 * Registers isolated Fanqie and Toutiao product-line modules on top of the
 * shared workspace, run, snapshot, and event-projection platform.
 */
export function openAuthorWorkspace(
  db: SqliteDatabase,
  writeDelivery: (documentId: string, text: string) => void = () => {},
) {
  const fanqieModule = createFanqieModule();
  const toutiaoModule = createToutiaoModule(writeDelivery);
  const registry = createProductLineRegistry([fanqieModule, toutiaoModule]);
  const ctx = createWorkspaceContext(db, registry);

  function saveDraftForRow(row: DocumentRow, body: string): { revisionId: string } {
    const mod = registry.require(row.product);
    return ctx.appendDraftRevision(row, body, (saved) => mod.onDraftSaved(ctx, saved));
  }

  const runs = createRunService(ctx, registry, saveDraftForRow);
  const snapshots = createSnapshotService(ctx, registry);

  function mutation(action: string, input: Input) {
    switch (action) {
      case "read.model": {
        const projectId = text(input, "projectId");
        requiredRow(db.prepare("SELECT id FROM author_projects WHERE id = ?;").get(projectId), "project", projectId);
        return ctx.readAuthorModel(projectId, input);
      }
      case "project.create": {
        const name = text(input, "name").trim();
        const product = input.product;
        const mod = typeof product === "string" ? registry.get(product) : undefined;
        if (!mod) invalid("product", "unknown-product");
        const id = randomUUID();
        return ctx.atomic(() => {
          db.prepare("INSERT INTO author_projects (id, name, product, created_at) VALUES (?, ?, ?, ?);")
            .run(id, name, mod.id, Date.now());
          ctx.event(id, "chapter", "project.created", { name, product: mod.id });
          return { id };
        });
      }
      case "document.create": {
        const projectId = text(input, "projectId");
        const rawTitle = typeof input.title === "string" ? input.title.trim() : "";
        const project = requiredRow<{ product: Product }>(
          db.prepare("SELECT product FROM author_projects WHERE id = ?;").get(projectId),
          "project",
          projectId,
        );
        const mod = registry.require(project.product);
        const { title, mode, line } = mod.validateCreate(input, rawTitle);
        const id = randomUUID();
        const initialState = mod.initialState;
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

    const productAction = registry.resolveAction(action);
    if (productAction && productAction.scope === "project") {
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

  function recoverStartup(): void {
    for (const mod of registry.all()) {
      mod.onStartupRecover?.(ctx);
    }
  }

  return {
    snapshot: snapshots.snapshot,
    readState: snapshots.readState,
    projectSeq: snapshots.projectSeq,
    mutation,
    generationInput: runs.generationInput,
    generationRunner: runs.generationRunner,
    beginGenerationCall: runs.beginGenerationCall,
    recordGenerationReceipt: runs.recordGenerationReceipt,
    finishGeneration: runs.finishGeneration,
    recoverGenerations: runs.recoverGenerations,
    reserveRefinement: runs.reserveRefinement,
    failGeneration: runs.failGeneration,
    recoverStartup,
    resumeExports: () => toutiaoModule.onStartupRecover?.(ctx),
  };
}
