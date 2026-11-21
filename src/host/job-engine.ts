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
    for (const entry of activeJobs.values()) {
      if (entry.kind === "draft_generation") draftGeneration += 1;
      else if (entry.kind === "proposal_extraction") proposalExtraction += 1;
      else if (entry.kind === "selection_rewrite") selectionRewrite += 1;
    }
    return {
      total: activeJobs.size,
      draftGeneration,
      proposalExtraction,
      selectionRewrite,
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
        begin(phase, inputReserve, maxOutput) {
          return workspace.beginJobCall(jobId, phase, inputReserve, maxOutput);
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
        begin(phase, inputReserve, maxOutput) {
          return workspace.beginJobCall(job.jobId, phase, inputReserve, maxOutput);
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
        begin(phase, inputReserve, maxOutput) {
          return workspace.beginJobCall(job.id, phase, inputReserve, maxOutput);
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
            maxOutputTokens: 2000,
            cachePrefix: req.cachePrefix,
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

  function cancelJob(input: Record<string, unknown>) {
    const kind = typeof input.kind === "string" ? input.kind : "";
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
    cancelJob,
    abortRun,
    hasActiveRun,
    activeCounts,
    shutdownDrain,
  };
}

export type HostJobEngine = ReturnType<typeof createHostJobEngine>;
