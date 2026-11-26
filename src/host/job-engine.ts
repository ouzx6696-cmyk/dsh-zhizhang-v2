import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/index.ts";
import type { UnifiedJobKind } from "../contracts/workspace-dto.ts";
import { assertStageOutput, WRITING_STAGE_IDS } from "../workflow/writing-stages.ts";
import type { DsHPluginContext } from "./dsh-adapter.ts";
import {
  buildRecoveryHints,
  createSingleShotCaller,
  executeGenerationWithRunner,
  type LlmTransport,
} from "./writing.ts";
import type { AuthorWorkspace } from "./workspace.ts";

interface ActiveJobEntry {
  readonly id: string;
  readonly kind: UnifiedJobKind;
  readonly entityId: string;
  readonly scopeKey?: string;
  readonly controller: AbortController;
  readonly task: Promise<unknown>;
}

export interface ActiveJobCounts {
  readonly total: number;
  readonly draftGeneration: number;
  readonly proposalExtraction: number;
  readonly selectionRewrite: number;
  readonly autopilotPipeline?: number;
  readonly materialNormalize?: number;
}

export interface HostJobEngineOptions {
  readonly workspace: AuthorWorkspace;
  readonly llm: LlmTransport;
  readonly logger: DsHPluginContext["logger"];
  readonly isDbOpen: () => boolean;
}

/**
 * Unified async LLM Job Engine (`zhizhang/3.0`).
 *
 * Replaces the three separate in-memory registries (`generations`,
 * `proposalJobs`, `microJobs`) with a single registry, single cancellation
 * path, and single graceful shutdown drain that preserves late token receipts
 * before SQLite closes.
 */
export function createHostJobEngine(options: HostJobEngineOptions) {
  const { workspace, llm, logger, isDbOpen } = options;
  const activeJobs = new Map<string, ActiveJobEntry>();
  const activeScopes = new Set<string>();

  function hasActiveRun(runId: string): boolean {
    for (const entry of activeJobs.values()) {
      if (entry.kind === "draft_generation" && entry.entityId === runId) return true;
    }
    return false;
  }

  function findActiveByEntity(kind: UnifiedJobKind, entityId: string): ActiveJobEntry | undefined {
    for (const entry of activeJobs.values()) {
      if (entry.kind === kind && (entry.entityId === entityId || entry.id === entityId)) {
        return entry;
      }
    }
    return undefined;
  }

  function activeCounts(): ActiveJobCounts {
    let draftGeneration = 0;
    let proposalExtraction = 0;
    let selectionRewrite = 0;
    let autopilotPipeline = 0;
    let materialNormalize = 0;
    for (const entry of activeJobs.values()) {
      if (entry.kind === "draft_generation") draftGeneration += 1;
      else if (entry.kind === "proposal_extraction") proposalExtraction += 1;
      else if (entry.kind === "selection_rewrite") selectionRewrite += 1;
      else if (entry.kind === "autopilot_pipeline") autopilotPipeline += 1;
      else if (entry.kind === "material_normalize") materialNormalize += 1;
    }
    return {
      total: activeJobs.size,
      draftGeneration,
      proposalExtraction,
      selectionRewrite,
      autopilotPipeline,
      materialNormalize,
    };
  }

  function startDraftGeneration(input: Record<string, unknown>) {
    const runId = typeof input.runId === "string" ? input.runId : "";
    if (runId && hasActiveRun(runId)) {
      throw new ContractError("gate.denied", { action: "run.generate", reason: "generation-in-progress" });
    }
    const run = workspace.generationInput(input, true);
    const jobId = run.jobId!;
    const controller = new AbortController();
    const task = executeGenerationWithRunner(
      llm,
      run,
      controller.signal,
      () => {
        controller.signal.throwIfAborted();
        workspace.reserveRefinement(run.id);
      },
      {
        begin(phase, inputReserve, maxOutput, cacheMeta) {
          return workspace.beginJobCall(jobId, phase, inputReserve, maxOutput, cacheMeta);
        },
        receive(callId, usage) {
          if (isDbOpen()) workspace.recordJobReceipt(jobId, callId, usage);
        },
      },
      workspace.generationRunner(run.product),
    )
      .then((result) => {
        if (isDbOpen()) workspace.finishGeneration(jobId, { ...result }, null);
      })
      .catch((error: unknown) => {
        if (isDbOpen()) {
          const reason = error instanceof ContractError
            ? error.code
            : controller.signal.aborted
              ? "cancelled"
              : "generation.failed";
          const recoveryKind = error && typeof error === "object" && "recoveryKind" in error
            ? (error as { recoveryKind?: string }).recoveryKind
            : undefined;
          const recoveryHints = buildRecoveryHints(recoveryKind, reason);
          workspace.finishGeneration(jobId, null, reason, recoveryHints);
        }
      })
      .finally(() => {
        activeJobs.delete(jobId);
      });

    activeJobs.set(jobId, {
      id: jobId,
      kind: "draft_generation",
      entityId: run.id,
      controller,
      task,
    });
    return { id: run.id, jobId, kind: "draft_generation" as const, running: true };
  }

  function startProposalExtraction(input: Record<string, unknown>) {
    const kindKey = typeof input.proposalKind === "string"
      ? input.proposalKind
      : typeof input.kind === "string"
        ? input.kind
        : "";
    const scopeTarget = typeof input.documentId === "string"
      ? input.documentId
      : typeof input.projectId === "string"
        ? input.projectId
        : "global";
    const scopeKey = `proposal:${kindKey}:${scopeTarget}`;
    if (activeScopes.has(scopeKey)) {
      throw new ContractError("gate.denied", { action: "proposal.generate", reason: "proposal-in-progress" });
    }

    const proposalInput = { ...input, kind: kindKey };
    const job = workspace.beginProposalGeneration(proposalInput);
    activeScopes.add(scopeKey);
    const controller = new AbortController();
    const caller = createSingleShotCaller(
      llm,
      { provider: job.provider, model: job.model, reserved: job.reserved },
      controller.signal,
      {
        begin(phase, inputReserve, maxOutput, cacheMeta) {
          return workspace.beginJobCall(job.jobId, phase, inputReserve, maxOutput, cacheMeta);
        },
        receive(callId, usage) {
          if (isDbOpen()) workspace.recordProposalReceipt(job.id, callId, usage);
        },
      },
    );
    const task = caller
      .complete({
        phase: job.phase,
        system: job.system,
        prompt: job.prompt,
        layered: job.layered,
        maxOutputTokens: 2400,
        disableThinking: job.disableThinking,
      })
      .then((raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
        } catch {
          throw new ContractError("stage.output_invalid", {
            stage: WRITING_STAGE_IDS[job.phase],
            missing: "json",
          });
        }
        assertStageOutput(WRITING_STAGE_IDS[job.phase], parsed, "json");
        if (isDbOpen()) {
          workspace.finishProposalGeneration(job.id, parsed as Record<string, unknown>, null);
        }
      })
      .catch((error: unknown) => {
        if (isDbOpen()) {
          const reason = error instanceof ContractError
            ? error.code
            : controller.signal.aborted
              ? "cancelled"
              : "generation.failed";
          workspace.finishProposalGeneration(job.id, null, reason);
        }
      })
      .finally(() => {
        activeJobs.delete(job.jobId);
        activeScopes.delete(scopeKey);
      });

    activeJobs.set(job.jobId, {
      id: job.jobId,
      kind: "proposal_extraction",
      entityId: job.id,
      scopeKey,
      controller,
      task,
    });
    return {
      id: job.id,
      jobId: job.jobId,
      kind: "proposal_extraction" as const,
      proposalKind: job.kind,
      running: true,
    };
  }

  async function runSelectionRewrite(input: Record<string, unknown>, requestSignal: AbortSignal) {
    const req = workspace.buildSelectionRewriteInput(input);
    const job = workspace.beginSelectionRewrite(req);
    const controller = new AbortController();
    const signal = AbortSignal.any([requestSignal, controller.signal]);
    const caller = createSingleShotCaller(
      llm,
      { provider: req.provider, model: req.model, reserved: req.reserved },
      signal,
      {
        begin(phase, inputReserve, maxOutput, cacheMeta) {
          return workspace.beginJobCall(job.id, phase, inputReserve, maxOutput, cacheMeta);
        },
        receive(callId, usage) {
          if (isDbOpen()) workspace.recordJobReceipt(job.id, callId, usage);
        },
      },
    );
    const task = (async () => {
      try {
        const text = (
          await caller.complete({
            phase: "selectionRewrite",
            system: req.system,
            prompt: req.prompt,
            layered: req.layered,
            maxOutputTokens: 2000,
            disableThinking: true,
          })
        ).trim();
        assertStageOutput(WRITING_STAGE_IDS.selectionRewrite, text, "body");
        if (isDbOpen()) workspace.finishSelectionRewrite(job.id, false);
        return text;
      } catch (error) {
        if (isDbOpen()) {
          const reason = error instanceof ContractError
            ? error.code
            : signal.aborted
              ? "cancelled"
              : "generation.failed";
          workspace.finishSelectionRewrite(job.id, true, reason);
        }
        throw error;
      } finally {
        activeJobs.delete(job.id);
      }
    })();

    activeJobs.set(job.id, {
      id: job.id,
      kind: "selection_rewrite",
      entityId: job.id,
      controller,
      task,
    });
    const rewrittenText = await task;
    return {
      jobId: job.id,
      kind: "selection_rewrite" as const,
      rewrittenText,
      tokens: caller.usedTokens(),
      mode: req.mode,
    };
  }

  function startMaterialNormalize(input: Record<string, unknown>) {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId) {
      throw new ContractError("input.invalid", { field: "sessionId", reason: "required" });
    }
    const scopeKey = `material:${sessionId}`;
    if (activeScopes.has(scopeKey)) {
      throw new ContractError("gate.denied", { action: "material.extract", reason: "material-extract-in-progress" });
    }
    const session = workspace.mutation("material.get", { sessionId }) as { projectId: string };
    const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : "deepseek";
    const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : "deepseek-chat";
    const instruction = typeof input.instruction === "string" ? input.instruction : undefined;
    const jobId = randomUUID();
    const controller = new AbortController();
    activeScopes.add(scopeKey);

    let callSeq = 0;
    const caller = createSingleShotCaller(
      llm,
      { provider, model, reserved: 28_000 },
      controller.signal,
      {
        begin: () => `mat-${++callSeq}`,
        receive: () => {},
      },
    );

    const task = workspace
      .runMaterialNormalizeJob({
        projectId: session.projectId,
        sessionId,
        instruction,
        caller,
        signal: controller.signal,
      })
      .catch((error: unknown) => {
        logger.error("zhizhang: material normalize failed", {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        activeJobs.delete(jobId);
        activeScopes.delete(scopeKey);
      });

    activeJobs.set(jobId, {
      id: jobId,
      kind: "material_normalize",
      entityId: sessionId,
      scopeKey,
      controller,
      task,
    });

    return { id: sessionId, sessionId, jobId, kind: "material_normalize" as const, running: true };
  }

  function startAutopilotPipeline(input: Record<string, unknown>) {
    const existingBatchId = typeof input.batchId === "string" && input.batchId.trim() ? input.batchId.trim() : "";
    const batch = (existingBatchId
      ? workspace.mutation("autopilot.get", { batchId: existingBatchId })
      : workspace.mutation("autopilot.start", input)) as {
        id: string;
        projectId: string;
        tokenBudget: number;
        tokensSpent: number;
        provider: string;
        model: string;
      };
    const scopeKey = `autopilot:${batch.id}`;
    if (activeScopes.has(scopeKey)) {
      throw new ContractError("gate.denied", { action: "autopilot.start", reason: "autopilot-in-progress" });
    }
    const provider =
      typeof input.provider === "string" && input.provider.trim()
        ? input.provider.trim()
        : batch.provider || "deepseek";
    const model =
      typeof input.model === "string" && input.model.trim()
        ? input.model.trim()
        : batch.model || "deepseek-chat";
    const instruction = typeof input.instruction === "string" ? input.instruction : undefined;
    const overrideRedLine = input.overrideRedLine === true;
    const jobId = randomUUID();
    const controller = new AbortController();
    activeScopes.add(scopeKey);

    let callSeq = 0;
    const caller = createSingleShotCaller(
      llm,
      { provider, model, reserved: Math.max(0, batch.tokenBudget - batch.tokensSpent) },
      controller.signal,
      {
        begin: () => `ap-${++callSeq}`,
        receive: () => {},
      },
    );

    const task = workspace
      .runAutopilotJob({
        projectId: batch.projectId,
        batchId: batch.id,
        instruction,
        overrideRedLine,
        caller,
        signal: controller.signal,
      })
      .catch((error: unknown) => {
        workspace.mutation("autopilot.pause", { batchId: batch.id });
        logger.error("zhizhang: autopilot pipeline failed", {
          batchId: batch.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        activeJobs.delete(jobId);
        activeScopes.delete(scopeKey);
      });

    activeJobs.set(jobId, {
      id: jobId,
      kind: "autopilot_pipeline",
      entityId: batch.id,
      scopeKey,
      controller,
      task,
    });

    return { id: batch.id, batchId: batch.id, jobId, kind: "autopilot_pipeline" as const, batch, running: true };
  }

  function cancelJob(input: Record<string, unknown>) {
    const kind = typeof input.kind === "string" ? input.kind : "";
    if (kind === "autopilot_pipeline" || typeof input.batchId === "string") {
      const batchId = typeof input.batchId === "string"
        ? input.batchId.trim()
        : typeof input.jobId === "string"
          ? input.jobId.trim()
          : "";
      if (!batchId) {
        throw new ContractError("input.invalid", { field: "batchId", reason: "required" });
      }
      findActiveByEntity("autopilot_pipeline", batchId)?.controller.abort();
      const result = workspace.mutation("autopilot.cancel", { batchId });
      return { id: batchId, batch: result, cancelled: true };
    }

    if (kind === "material_normalize" || typeof input.sessionId === "string") {
      const sessionId = typeof input.sessionId === "string"
        ? input.sessionId.trim()
        : typeof input.jobId === "string"
          ? input.jobId.trim()
          : "";
      if (!sessionId) {
        throw new ContractError("input.invalid", { field: "sessionId", reason: "required" });
      }
      findActiveByEntity("material_normalize", sessionId)?.controller.abort();
      return { id: sessionId, cancelled: true };
    }

    if (kind === "draft_generation" || typeof input.runId === "string") {
      const runId = typeof input.runId === "string"
        ? input.runId.trim()
        : typeof input.jobId === "string"
          ? input.jobId.trim()
          : "";
      if (!runId) {
        throw new ContractError("input.invalid", { field: "runId", reason: "required" });
      }
      const entry = findActiveByEntity("draft_generation", runId);
      const targetRunId = entry?.entityId ?? runId;
      const result = workspace.mutation("run.cancel", { runId: targetRunId });
      entry?.controller.abort();
      return { ...(result as Record<string, unknown>), cancelled: true };
    }

    if (kind === "proposal_extraction" || typeof input.proposalId === "string") {
      const proposalId = typeof input.proposalId === "string"
        ? input.proposalId.trim()
        : typeof input.jobId === "string"
          ? input.jobId.trim()
          : "";
      if (!proposalId) {
        throw new ContractError("input.invalid", { field: "proposalId", reason: "required" });
      }
      findActiveByEntity("proposal_extraction", proposalId)?.controller.abort();
      const cancelled = workspace.cancelProposalGeneration(proposalId);
      return { id: proposalId, cancelled };
    }

    if (typeof input.jobId === "string" && input.jobId.trim()) {
      const entry = activeJobs.get(input.jobId.trim());
      if (entry) {
        entry.controller.abort();
        if (entry.kind === "draft_generation") {
          workspace.mutation("run.cancel", { runId: entry.entityId });
        } else if (entry.kind === "proposal_extraction") {
          workspace.cancelProposalGeneration(entry.entityId);
        } else if (entry.kind === "autopilot_pipeline") {
          workspace.mutation("autopilot.cancel", { batchId: entry.entityId });
        }
        return { id: entry.id, cancelled: true };
      }
    }

    throw new ContractError("input.invalid", { field: "jobId", reason: "required" });
  }

  async function shutdownDrain(drainMs: number): Promise<void> {
    for (const entry of activeJobs.values()) entry.controller.abort();
    const inFlight = Array.from(activeJobs.values(), (entry) => entry.task);
    if (inFlight.length === 0) return;

    let timer: unknown;
    const settled = Promise.allSettled(inFlight);
    const drained = await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), drainMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!drained) {
      for (const entry of activeJobs.values()) entry.controller.abort();
      activeJobs.clear();
      activeScopes.clear();
      logger.error("zhizhang: shutdown drain exceeded budget; bounding post-abort grace wait", {
        drainMs,
        pending: inFlight.length,
      });
      const graceMs = Math.min(250, Math.max(50, drainMs));
      let graceTimer: unknown;
      await Promise.race([
        settled.catch(() => undefined),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, graceMs);
        }),
      ]);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
  }

  function abortRun(runId: string): boolean {
    const entry = findActiveByEntity("draft_generation", runId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  return {
    startDraftGeneration,
    startProposalExtraction,
    runSelectionRewrite,
    startMaterialNormalize,
    startAutopilotPipeline,
    cancelJob,
    abortRun,
    abortAutopilot: (batchId: string) => findActiveByEntity("autopilot_pipeline", batchId)?.controller.abort(),
    hasActiveRun,
    activeCounts,
    shutdownDrain,
  };
}

export type HostJobEngine = ReturnType<typeof createHostJobEngine>;
