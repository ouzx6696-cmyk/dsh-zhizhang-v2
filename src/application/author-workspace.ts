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
import {
  buildProgressiveSystemPrompt,
  getProjectCollaboration,
  getWorkspaceFocus,
  listAgentWrites,
  patchAgentParagraphs,
  rollbackAgentWrite,
  setProjectCollaboration,
  setWorkspaceFocus,
  submitAgentDraft,
} from "./collaboration.ts";
import { createJobService } from "./job-service.ts";
import { createProductLineRegistry, type ProductAgentToolSpec } from "./product-line.ts";
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
      case "focus.get":
        return getWorkspaceFocus(ctx);
      case "focus.set":
        return setWorkspaceFocus(ctx, input);
      case "project.collaboration.get":
        return ctx.read(() => getProjectCollaboration(ctx, text(input, "projectId")));
      case "project.collaboration.set":
        return setProjectCollaboration(ctx, input);
      case "agent.submit_draft":
        return submitAgentDraft(ctx, registry, saveDraftForRow, input);
      case "agent.patch_paragraphs":
        return patchAgentParagraphs(ctx, registry, saveDraftForRow, input);
      case "agent.rollback_write":
        return rollbackAgentWrite(ctx, saveDraftForRow, input);
      case "agent.writes.list":
        return listAgentWrites(ctx, input);
      case "agent.system_prompt.preview":
        return buildProgressiveSystemPrompt(ctx, registry, {
          ...(typeof input.projectId === "string" && input.projectId.trim() ? { projectId: input.projectId.trim() } : {}),
          ...(typeof input.documentId === "string" && input.documentId.trim() ? { documentId: input.documentId.trim() } : {}),
        });
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

  function resolveProjectProduct(projectId: string): Product {
    const project = requiredRow<{ product: Product }>(
      stmt(db, "SELECT product FROM author_projects WHERE id = ?;").get(projectId),
      "project",
      projectId,
    );
    return project.product;
  }

  async function runMaterialNormalizeJob(params: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly instruction?: string;
    readonly caller: import("../workflow/writing-stages.ts").SingleShotLlmCaller;
    readonly signal: AbortSignal;
  }) {
    const mod = registry.require(resolveProjectProduct(params.projectId));
    if (!mod.runMaterialNormalize) invalid("projectId", "material-normalize-unsupported");
    return mod.runMaterialNormalize(ctx, {
      sessionId: params.sessionId,
      instruction: params.instruction,
      caller: params.caller,
      signal: params.signal,
    });
  }

  async function runAutopilotJob(params: {
    readonly projectId: string;
    readonly batchId: string;
    readonly instruction?: string;
    readonly overrideRedLine?: boolean;
    readonly caller: import("../workflow/writing-stages.ts").SingleShotLlmCaller;
    readonly signal: AbortSignal;
  }) {
    const mod = registry.require(resolveProjectProduct(params.projectId));
    if (!mod.runAutopilotPipeline) invalid("projectId", "autopilot-unsupported");
    return mod.runAutopilotPipeline(ctx, {
      batchId: params.batchId,
      instruction: params.instruction,
      overrideRedLine: params.overrideRedLine,
      caller: params.caller,
      signal: params.signal,
      saveDraft: saveDraftForRow,
    });
  }

  const toolFacade = {
    mutation,
    snapshot: snapshots.snapshot,
  };

  function coreAgentTools(): readonly ProductAgentToolSpec[] {
    return [
      {
        name: "zhizhang_read_focus",
        description:
          "Read the author's active workspace focus (current book, chapter/article, collaboration mode) and all projects in Zhizhang.",
        readOnly: true,
        properties: {},
        outputDescription: "Current active focus, per-book collaboration mode, and list of workspace projects.",
        execute: () => ({
          focus: getWorkspaceFocus(ctx),
          projects: (snapshots.snapshot() as { projects?: unknown }).projects ?? [],
        }),
      },
      {
        name: "zhizhang_submit_draft",
        description:
          "Submit a full chapter or article draft written by the DsH Agent. Automatically honors the book's collaborationMode: cautious -> stages in candidate Diff for approval; co_create -> writes working draft directly with atomic rollback snapshot. Always refuses finalized/accepted/delivered documents.",
        readOnly: false,
        properties: {
          documentId: { type: "string" },
          body: { type: "string" },
          summary: { type: "string" },
          techniqueIds: { type: "array", items: { type: "string" } },
          forceCandidate: { type: "boolean" },
        },
        required: ["documentId", "body"],
        outputDescription: "Submission outcome (candidate or direct_write), snapshot/run IDs, char count, and deterministic offline diagnostics.",
        execute: (args) =>
          mutation("agent.submit_draft", {
            documentId: args.documentId,
            body: args.body,
            ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
            ...(Array.isArray(args.techniqueIds) ? { techniqueIds: args.techniqueIds } : {}),
            ...(typeof args.forceCandidate === "boolean" ? { forceCandidate: args.forceCandidate } : {}),
          }),
      },
      {
        name: "zhizhang_patch_paragraphs",
        description:
          "Surgically replace specific 1-based paragraphs of a chapter/article while leaving all untouched paragraphs verbatim. Honors the book's collaborationMode (cautious -> candidate Diff; co_create -> direct write + rollback snapshot).",
        readOnly: false,
        properties: {
          documentId: { type: "string" },
          patches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                paragraphIndex: { type: "number" },
                replacement: { type: "string" },
              },
              required: ["paragraphIndex", "replacement"],
            },
          },
          summary: { type: "string" },
          techniqueIds: { type: "array", items: { type: "string" } },
          forceCandidate: { type: "boolean" },
        },
        required: ["documentId", "patches"],
        outputDescription: "Patched draft submission outcome with offline diagnostics summary.",
        execute: (args) =>
          mutation("agent.patch_paragraphs", {
            documentId: args.documentId,
            patches: args.patches,
            ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
            ...(Array.isArray(args.techniqueIds) ? { techniqueIds: args.techniqueIds } : {}),
            ...(typeof args.forceCandidate === "boolean" ? { forceCandidate: args.forceCandidate } : {}),
          }),
      },
    ];
  }

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
    runMaterialNormalizeJob,
    runAutopilotJob,
    recoverJobs: jobs.recoverAll,
    recoverStartup,
    verifyUsageConsistency: () => ctx.jobs.verifyUsageConsistency(),
    buildSystemPrompt: (projectId?: string, documentId?: string) =>
      buildProgressiveSystemPrompt(ctx, registry, {
        ...(projectId ? { projectId } : {}),
        ...(documentId ? { documentId } : {}),
      }),
    agentTools: () => [...coreAgentTools(), ...registry.collectAgentTools(toolFacade)],
    resumeExports: () => toutiaoModule.onStartupRecover?.(ctx),
  };
}
