import { randomUUID } from "node:crypto";
import type { RecoveryHintDto, SelectionRewriteMode } from "../contracts/workspace-dto.ts";
import { createCandidate, stmt } from "../storage/index.ts";
import {
  computeRunBilling,
  estimateWritingInput,
  recommendedTokenBudget,
  SELECTION_REWRITE_SYSTEM,
  sumUsageTuple,
  WRITER_SYSTEM,
} from "../workflow/writing-budget.ts";
import { WRITING_STAGE_IDS } from "../workflow/writing-stages.ts";
import {
  count,
  countNonWhitespace,
  invalid,
  optionalText,
  refuse,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type RunRow,
  type WorkspaceContext,
} from "./context.ts";
import type { ProductGenerationRunner, ProductLineRegistry } from "./product-line.ts";

export function createRunService(
  ctx: WorkspaceContext,
  registry: ProductLineRegistry,
  saveDraftForRow: (row: DocumentRow, body: string) => { revisionId: string },
) {
  const { db, generation } = ctx;

  function freezeWriting(row: DocumentRow, input: Input): string {
    const plan = ctx.planning(row.id);
    const mod = registry.require(row.product);
    const productContext = mod.buildFrozenContext(ctx, row, input);
    return JSON.stringify({
      title: row.title,
      revisionId: row.revisionId,
      text: row.body,
      instruction: text(input, "instruction"),
      mode: row.mode,
      planning: plan,
      ...productContext,
    });
  }

  function completeRun(current: RunRow, row: DocumentRow, input: Input) {
    const usage = count(input, "tokens");
    if (!Number.isSafeInteger(current.settled + usage)) invalid("tokens", "usage-overflow");
    if (current.state !== "running") refuse("run.complete", "run-no-longer-running");
    stmt(db, "UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(usage, current.id);
    if (usage + current.settled > current.reserved) {
      ctx.event(row.projectId, "run", "run.attempt", {
        runId: current.id,
        stage: WRITING_STAGE_IDS.write,
        usage,
        outcome: "budget.exhausted",
      });
      ctx.stage(current, "failed");
      return { id: current.id, state: "failed" };
    }
    const body = text(input, "body");
    const candidateId = randomUUID();
    createCandidate(db, {
      candidateId,
      documentId: row.id,
      baseRevisionId: current.baseRevisionId,
      body,
    });
    const mod = registry.require(row.product);
    mod.onCandidateCreated?.(ctx, row, candidateId, body, current.frozenInput, input);
    stmt(db, "UPDATE author_runs SET candidate_id = ? WHERE id = ?;").run(candidateId, current.id);
    ctx.event(row.projectId, "run", "run.attempt", {
      runId: current.id,
      stage: WRITING_STAGE_IDS.write,
      usage,
      outputRef: candidateId,
      outcome: "completed",
    });
    ctx.stage(current, "awaiting-author");
    ctx.event(row.projectId, "candidate", "candidate.produced", {
      documentId: row.id,
      candidateId,
      runId: current.id,
    });
    return { id: current.id, candidateId };
  }

  function estimatePromptForFrozen(frozen: string): {
    readonly inputReserve: number;
    readonly contextReport: unknown;
  } {
    const parsed = JSON.parse(frozen) as {
      contextBundle?: { stablePrefix?: string; dynamicTail?: string; report?: unknown };
    };
    const promptForReserve = parsed.contextBundle
      ? [parsed.contextBundle.stablePrefix, parsed.contextBundle.dynamicTail].filter(Boolean).join("\n\n---\n\n")
      : frozen;
    return {
      inputReserve: estimateWritingInput(WRITER_SYSTEM, promptForReserve),
      contextReport: parsed.contextBundle?.report ?? null,
    };
  }

  function previewBudget(row: DocumentRow, input: Input) {
    return ctx.read(() => {
      const current = ctx.document(row.id);
      ctx.currentBody(current, input);
      const frozen = freezeWriting(current, input);
      const { inputReserve, contextReport } = estimatePromptForFrozen(frozen);
      return { inputReserve, recommended: recommendedTokenBudget(inputReserve), contextReport };
    });
  }

  function startRun(row: DocumentRow, input: Input) {
    return ctx.dispatch("run.start", row, input, () => {
      const current = ctx.document(row.id);
      ctx.currentBody(current, input);
      if (ctx.isLockedDocument(current)) refuse("run.start", "revision-locked");
      ctx.assertRunAvailable("run.start", current.id);
      const reserved = count(input, "tokenLimit");
      if (reserved === 0) invalid("tokenLimit", "positive-budget-required");
      const id = randomUUID();
      const frozenInput = freezeWriting(current, input);
      let contextTrace: string | null = null;
      try {
        const parsed = JSON.parse(frozenInput) as { contextBundle?: { report?: unknown } };
        if (parsed.contextBundle?.report) {
          contextTrace = JSON.stringify(parsed.contextBundle.report);
        }
      } catch {
        // Non-JSON synthetic input has no trace.
      }
      stmt(db, `
        INSERT INTO author_runs (id, document_id, state, base_revision_id, frozen_input, reserved, context_trace)
        VALUES (?, ?, 'running', ?, ?, ?, ?);
      `).run(id, row.id, current.revisionId, frozenInput, reserved, contextTrace);
      ctx.event(row.projectId, "run", "run.started", { documentId: row.id, runId: id, reserved });
      return { id };
    });
  }

  function handleRunLifecycle(action: "run.complete" | "run.cancel" | "run.discard", input: Input) {
    return ctx.atomic(() => {
      const current = ctx.run(text(input, "runId"));
      const row = ctx.document(current.documentId);
      if (action !== "run.complete") {
        ctx.stage(current, action === "run.cancel" ? "cancelled" : "discarded");
        return { id: current.id };
      }
      if (generation.pending(current.id)) {
        refuse(action, "generation-needs-reconciliation");
      }
      const usage = count(input, "tokens");
      if (current.state === "cancelled") {
        if (current.lateUsageSettled === 0 && generation.history(current.id).length === 0) {
          const updated = stmt(db, `
            UPDATE author_runs
            SET settled = settled + ?, late_usage_settled = 1
            WHERE id = ? AND late_usage_settled = 0;
          `).run(usage, current.id);
          if (updated.changes) {
            ctx.event(row.projectId, "run", "run.usage.late", { runId: current.id, usage });
          }
        }
        return { id: current.id };
      }
      ctx.assertRunAvailable(action, row.id, current.id);
      return completeRun(current, row, input);
    });
  }

  function adoptCandidate(row: DocumentRow, input: Input) {
    return ctx.dispatch("candidate.adopt", row, input, () => {
      const current = ctx.run(text(input, "runId"));
      if (current.documentId !== row.id || current.baseRevisionId !== input.baseRevisionId || !current.candidateId) {
        refuse("candidate.adopt", "candidate-base-mismatch");
      }
      const candidate = requiredRow<{ body: string }>(
        stmt(db, "SELECT body FROM candidates WHERE candidate_id = ?;").get(current.candidateId),
        "candidate",
        current.candidateId,
      );
      const hasMerged = input.mergedBody !== undefined;
      if (hasMerged && typeof input.mergedBody !== "string") {
        invalid("mergedBody", "string-required");
      }
      const adoptionMode =
        input.adoptionMode === "partial" || input.adoptionMode === "full"
          ? input.adoptionMode
          : hasMerged
            ? "partial"
            : "full";
      const targetBody = hasMerged ? (input.mergedBody as string) : candidate.body;
      const revision = saveDraftForRow(ctx.document(row.id), targetBody);
      ctx.stage(current, "applied");
      ctx.event(row.projectId, "candidate", "candidate.adopted", {
        documentId: row.id,
        candidateId: current.candidateId,
        revisionId: revision.revisionId,
        adoptionMode,
      });
      return input.adoptionMode !== undefined || hasMerged ? { ...revision, adoptionMode } : revision;
    });
  }

  function buildSelectionRewriteInput(input: Input) {
    const documentId = text(input, "documentId");
    const selectedText = typeof input.selectedText === "string" ? input.selectedText : "";
    if (countNonWhitespace(selectedText) < 4) {
      invalid("selectedText", "selection-too-short");
    }
    const rawMode = optionalText(input, "mode") ?? "polish";
    if (!["polish", "expand", "dialogue", "continue", "custom"].includes(rawMode)) {
      invalid("mode", "invalid-selection-mode");
    }
    const mode = rawMode as SelectionRewriteMode;
    const provider = text(input, "provider");
    const model = text(input, "model");
    const reserved = input.tokenLimit === undefined ? 6_000 : count(input, "tokenLimit");
    if (reserved === 0) invalid("tokenLimit", "positive-budget-required");

    return ctx.read(() => {
      const row = ctx.document(documentId);
      if (ctx.isLockedDocument(row)) refuse("selection.rewrite", "revision-locked");
      const beforeContext = typeof input.beforeContext === "string" ? input.beforeContext.slice(-400) : "";
      const afterContext = typeof input.afterContext === "string" ? input.afterContext.slice(0, 400) : "";
      const instruction = optionalText(input, "instruction") ?? "";
      const mod = registry.require(row.product);
      const selectionCtx = mod.buildSelectionContext?.(ctx, row, mode);

      const prompt = JSON.stringify({
        title: row.title,
        mode,
        instruction,
        ...(selectionCtx?.extra ?? {}),
        beforeContext,
        selectedText,
        afterContext,
      });
      return {
        documentId: row.id,
        projectId: row.projectId,
        mode,
        provider,
        model,
        reserved,
        system: SELECTION_REWRITE_SYSTEM,
        prompt,
        cachePrefix: selectionCtx?.cachePrefix,
      };
    });
  }

  function runHistory(row: DocumentRow, input: Input) {
    const before = input.before === undefined ? Number.MAX_SAFE_INTEGER : count(input, "before");
    return stmt(db, `
      SELECT rowid AS cursor, id, state, reserved, settled FROM author_runs
      WHERE document_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 25;
    `).all(row.id, before);
  }

  function runDetail(row: DocumentRow, input: Input) {
    return ctx.read(() => {
      const detail = ctx.run(text(input, "runId"));
      if (detail.documentId !== row.id) invalid("runId", "document-mismatch");
      const meta = stmt(db, "SELECT context_trace AS contextTrace, recovery_hints AS recoveryHints FROM author_runs WHERE id = ?;")
        .get(detail.id) as { contextTrace?: string | null; recoveryHints?: string | null } | undefined;
      const candidate = detail.candidateId
        ? stmt(db, "SELECT body FROM candidates WHERE candidate_id = ?;").get(detail.candidateId)
        : null;
      const calls = generation.calls(detail.id);
      const billing = computeRunBilling(
        calls.map((call) => {
          if (!call.usage) return null;
          try {
            const parsed = JSON.parse(call.usage) as unknown;
            return Array.isArray(parsed) ? parsed.map((v) => Number(v)) : null;
          } catch {
            return null;
          }
        }),
      );
      let contextTrace: unknown = null;
      if (meta?.contextTrace) {
        try {
          contextTrace = JSON.parse(meta.contextTrace);
        } catch {
          contextTrace = null;
        }
      }
      let recoveryHints: readonly RecoveryHintDto[] = [];
      if (meta?.recoveryHints) {
        try {
          const parsed = JSON.parse(meta.recoveryHints) as unknown;
          if (Array.isArray(parsed)) recoveryHints = parsed as RecoveryHintDto[];
        } catch {
          recoveryHints = [];
        }
      }
      return {
        ...detail,
        candidate,
        attempts: generation.history(detail.id),
        calls,
        billing,
        contextTrace,
        recoveryHints,
      };
    });
  }

  function reconcileRun(row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const id = text(input, "attemptId");
      const detail = ctx.run(text(input, "runId"));
      if (detail.documentId !== row.id) invalid("runId", "document-mismatch");
      const tokens = count(input, "tokens");
      if (!Number.isSafeInteger(detail.settled + tokens)) invalid("tokens", "usage-overflow");
      if (!generation.reconcile(id, detail.id)) {
        refuse("run.reconcile", "no-uncertain-attempt");
      }
      stmt(db, "UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(tokens, detail.id);
      ctx.event(row.projectId, "run", "run.attempt", {
        runId: detail.id,
        attemptId: id,
        stage: WRITING_STAGE_IDS.write,
        usage: tokens,
        outcome: "reconciled",
      });
      return { id };
    });
  }

  function generationInput(input: Input, claim = false) {
    const provider = text(input, "provider");
    const model = text(input, "model");
    return ctx.atomic(() => {
      const current = ctx.run(text(input, "runId"));
      const row = ctx.document(current.documentId);
      if (ctx.isLockedDocument(row) || current.baseRevisionId !== row.revisionId) {
        refuse("run.generate", "revision-changed");
      }
      if (generation.pending(current.id)) refuse("run.generate", "generation-needs-reconciliation");
      if (current.state !== "failed" && current.state !== "running") {
        refuse("run.generate", "run-no-longer-running");
      }
      ctx.assertRunAvailable("run.generate", row.id, current.id);
      if (current.state === "failed") {
        stmt(db, "UPDATE author_runs SET recovery_hints = NULL WHERE id = ?;").run(current.id);
        ctx.stage(current, "running");
      }
      let attemptId: string | null = null;
      if (claim) {
        attemptId = randomUUID();
        generation.create(attemptId, current.id, provider, model);
        ctx.event(row.projectId, "run", "generation.started", { runId: current.id, attemptId });
      }
      const mod = registry.require(row.product);
      return {
        id: current.id,
        product: row.product,
        attemptId,
        autoQa: input.autoQa === true && mod.supportsAutoQa,
        frozenInput: current.frozenInput,
        reserved: Math.max(0, current.reserved - current.settled),
        provider,
        model,
      };
    });
  }

  function beginGenerationCall(attemptId: string, phase: string, inputReserve: number, maxOutput: number): string {
    return ctx.atomic(() => {
      const attempt = generation.openAttempt(attemptId);
      if (!attempt || ctx.run(attempt.runId).state !== "running") {
        refuse("run.generate", "run-no-longer-running");
      }
      const callId = randomUUID();
      if (!generation.beginCall(attemptId, callId, phase, inputReserve, maxOutput)) {
        refuse("run.generate", "generation-in-progress");
      }
      return callId;
    });
  }

  function recordGenerationReceipt(attemptId: string, callId: string, usage: readonly number[]): void {
    ctx.atomic(() => {
      generation.receiveCall(attemptId, callId, usage);
    });
  }

  function finishGeneration(
    id: string,
    result: Input | null,
    failure: string | null,
    recoveryHints?: readonly RecoveryHintDto[],
  ) {
    return ctx.atomic(() => {
      const attempt = generation.openAttempt(id);
      if (!attempt) return;
      const current = ctx.run(attempt.runId);
      const row = ctx.document(current.documentId);
      const receipts = JSON.parse(attempt.usage) as readonly { usage: readonly number[] }[];
      const tokens = receipts.reduce((sum, entry) => sum + sumUsageTuple(entry.usage), 0);
      const uncertain = attempt.state === "inflight";
      generation.close(id, uncertain ? "uncertain" : result ? "completed" : "failed", failure);
      if (current.state === "running" && result && !uncertain) {
        stmt(db, "UPDATE author_runs SET recovery_hints = NULL WHERE id = ?;").run(current.id);
        return completeRun(current, row, { ...result, tokens });
      }
      const hintsJson = recoveryHints && recoveryHints.length > 0 ? JSON.stringify(recoveryHints) : null;
      stmt(db, "UPDATE author_runs SET settled = settled + ?, recovery_hints = ? WHERE id = ?;")
        .run(tokens, hintsJson, current.id);
      ctx.event(row.projectId, "run", "run.attempt", {
        runId: current.id,
        attemptId: id,
        stage: WRITING_STAGE_IDS.write,
        usage: tokens,
        outcome: uncertain ? "usage.uncertain" : failure ?? "cancelled",
      });
      if (current.state === "running") ctx.stage(current, "failed");
    });
  }

  function recoverGenerations(): void {
    for (const { id } of generation.unfinished()) {
      finishGeneration(id, null, "interrupted");
    }
  }

  function reserveRefinement(id: string): void {
    ctx.atomic(() => {
      const current = ctx.run(id);
      if (current.state !== "running") refuse("run.generate", "run-no-longer-running");
      const row = ctx.document(current.documentId);
      const mod = registry.require(row.product);
      if (!mod.reserveRefinement) refuse("run.generate", "refinement-unsupported");
      mod.reserveRefinement(ctx, id);
    });
  }

  function failGeneration(id: string, tokens: number): void {
    ctx.atomic(() => {
      const current = ctx.run(id);
      if (current.state === "running") {
        stmt(db, "UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(tokens, id);
        const row = ctx.document(current.documentId);
        ctx.event(row.projectId, "run", "run.attempt", {
          runId: id,
          stage: WRITING_STAGE_IDS.write,
          usage: tokens,
          outcome: "failed",
        });
        ctx.stage(current, "failed");
      }
    });
  }

  function generationRunner(product: string): ProductGenerationRunner | undefined {
    return registry.get(product)?.runGeneration;
  }

  return {
    previewBudget,
    startRun,
    handleRunLifecycle,
    adoptCandidate,
    buildSelectionRewriteInput,
    runHistory,
    runDetail,
    reconcileRun,
    generationInput,
    generationRunner,
    beginGenerationCall,
    recordGenerationReceipt,
    finishGeneration,
    recoverGenerations,
    reserveRefinement,
    failGeneration,
  };
}

export type RunService = ReturnType<typeof createRunService>;
