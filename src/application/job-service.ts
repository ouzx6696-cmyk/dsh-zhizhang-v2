import { randomUUID } from "node:crypto";
import type {
  AiProposalKind,
  MicroUsageSummaryDto,
  RecoveryHintDto,
  SelectionRewriteMode,
  UnifiedJobKind,
  UnifiedJobSummaryDto,
} from "../contracts/workspace-dto.ts";
import { createCandidate, stmt, type CallCacheMeta, type JobRecord, type LedgerJobKind } from "../storage/index.ts";
import {
  diagnoseCacheBehavior,
  SHARED_WORKBENCH_SYSTEM_KERNEL,
  type LayeredPromptPayload,
} from "../workflow/cache-layer.ts";
import { normalizeFactSyncPayload } from "../workflow/fact-sync-payload.ts";
import {
  ARC_PLAN_SYSTEM,
  CHAPTER_REVIEW_SYSTEM,
  computeRunBilling,
  DECONSTRUCT_EXTRACT_SYSTEM,
  estimateWritingInput,
  FACT_SYNC_SYSTEM,
  recommendedTokenBudget,
  SELECTION_REWRITE_SYSTEM,
  SETTING_EXTRACT_SYSTEM,
  SUMMARY_DRAFT_SYSTEM,
  sumUsageTuple,
  TECHNIQUE_EXTRACT_SYSTEM,
  WRITER_SYSTEM,
} from "../workflow/writing-budget.ts";
import { WRITING_STAGE_IDS, type WritingPhase } from "../workflow/writing-stages.ts";
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
  type Product,
  type RunRow,
  type WorkspaceContext,
} from "./context.ts";
import { continuationState, readContinuationSource } from "./continuation.ts";
import { sha256Text } from "./digest.ts";
import { isDocumentBoundProposalKind } from "./proposal-kinds.ts";
import type { ProductGenerationRunner, ProductLineRegistry } from "./product-line.ts";

interface ProposalSpec {
  readonly phase: WritingPhase;
  readonly system: string;
}

const PROPOSAL_SPECS: Readonly<Partial<Record<AiProposalKind, ProposalSpec>>> = {
  deconstruct: { phase: "deconstructExtract", system: DECONSTRUCT_EXTRACT_SYSTEM },
  technique: { phase: "techniqueExtract", system: TECHNIQUE_EXTRACT_SYSTEM },
  setting: { phase: "settingExtract", system: SETTING_EXTRACT_SYSTEM },
  summary: { phase: "summaryDraft", system: SUMMARY_DRAFT_SYSTEM },
  fact_sync: { phase: "factSync", system: FACT_SYNC_SYSTEM },
  chapter_review: { phase: "chapterReview", system: CHAPTER_REVIEW_SYSTEM },
  arc_plan: { phase: "arcPlan", system: ARC_PLAN_SYSTEM },
};

function parseProposalKind(raw: unknown): AiProposalKind {
  if (typeof raw === "string" && Object.hasOwn(PROPOSAL_SPECS, raw) && PROPOSAL_SPECS[raw as AiProposalKind]) {
    return raw as AiProposalKind;
  }
  invalid("kind", "unknown-proposal-kind");
}

function parseJobKind(raw: unknown): LedgerJobKind | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "draft_generation" || raw === "proposal_extraction" || raw === "selection_rewrite") {
    return raw;
  }
  invalid("kind", "unknown-job-kind");
}

function toJobSummaryDto(record: JobRecord): UnifiedJobSummaryDto {
  return {
    id: record.id,
    kind: record.kind as UnifiedJobKind,
    subtype: record.subtype,
    projectId: record.projectId,
    documentId: record.documentId,
    runId: record.runId,
    proposalId: record.proposalId,
    provider: record.provider,
    model: record.model,
    state: record.state as UnifiedJobSummaryDto["state"],
    stage: record.stage,
    reserved: record.reserved,
    settled: record.settled,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface SelectionRewriteRequest {
  readonly documentId: string;
  readonly projectId: string;
  readonly mode: SelectionRewriteMode;
  readonly provider: string;
  readonly model: string;
  readonly reserved: number;
  readonly system: string;
  readonly prompt: string;
  readonly layered?: LayeredPromptPayload;
}

/**
 * Unified Job Service (`zhizhang/3.0`).
 *
 * Consolidates all three previously fragmented LLM workflows onto a single
 * ledger (`author_jobs` + `author_job_calls`):
 * 1. `draft_generation` — candidate writing runs & Toutiao auto-QA loops
 * 2. `proposal_extraction` — author-sovereign structured AI proposals
 * 3. `selection_rewrite` — inline micro rewrites with per-document exclusivity
 */
export function createJobService(
  ctx: WorkspaceContext,
  registry: ProductLineRegistry,
  saveDraftForRow: (row: DocumentRow, body: string) => { revisionId: string },
) {
  const { db, jobs } = ctx;

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Draft Generation (Run Lifecycle + Candidate Adoption + Billing)
  // ───────────────────────────────────────────────────────────────────────────

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
      contextBundle?: {
        stablePrefix?: string;
        bookPrefix?: string;
        volumePrefix?: string;
        dynamicTail?: string;
        report?: unknown;
      };
    };
    if (parsed.contextBundle) {
      const b = parsed.contextBundle;
      const systemForReserve = [SHARED_WORKBENCH_SYSTEM_KERNEL, b.bookPrefix ?? b.stablePrefix ?? "", b.volumePrefix ?? ""]
        .filter(Boolean)
        .join("\n\n===\n\n");
      const promptForReserve = b.dynamicTail ?? "";
      return {
        inputReserve: estimateWritingInput(systemForReserve, promptForReserve),
        contextReport: b.report ?? null,
      };
    }
    return {
      inputReserve: estimateWritingInput(WRITER_SYSTEM, frozen),
      contextReport: null,
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
        const nextState = action === "run.cancel" ? "cancelled" : "discarded";
        ctx.stage(current, nextState);
        stmt(db, `
          UPDATE author_jobs
          SET state = 'cancelled', error = ?, updated_at = ?
          WHERE run_id = ? AND kind = 'draft_generation' AND state = 'prepared';
        `).run(nextState, Date.now(), current.id);
        return { id: current.id };
      }
      if (jobs.pendingForRun(current.id)) {
        refuse(action, "generation-needs-reconciliation");
      }
      const usage = count(input, "tokens");
      if (current.state === "cancelled") {
        if (current.lateUsageSettled === 0 && jobs.historyForRun(current.id).length === 0) {
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
      const continuationSource = row.product === "fanqie" ? readContinuationSource(current.frozenInput) : null;
      ctx.event(row.projectId, "candidate", "candidate.adopted", {
        documentId: row.id,
        candidateId: current.candidateId,
        revisionId: revision.revisionId,
        adoptionMode,
        ...(continuationSource ? { continuationSource } : {}),
      });
      return input.adoptionMode !== undefined || hasMerged ? { ...revision, adoptionMode } : revision;
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
      const source = row.product === "fanqie" ? readContinuationSource(detail.frozenInput) : null;
      const meta = stmt(db, "SELECT context_trace AS contextTrace, recovery_hints AS recoveryHints FROM author_runs WHERE id = ?;")
        .get(detail.id) as { contextTrace?: string | null; recoveryHints?: string | null } | undefined;
      const candidate = detail.candidateId
        ? stmt(db, "SELECT body FROM candidates WHERE candidate_id = ?;").get(detail.candidateId)
        : null;
      const calls = jobs.callsForRun(detail.id);
      const parsedUsages = calls.map((call) => {
        if (!call.usage) return null;
        try {
          const parsed = JSON.parse(call.usage) as unknown;
          return Array.isArray(parsed) ? parsed.map((v) => Number(v)) : null;
        } catch {
          return null;
        }
      });
      const baseBilling = computeRunBilling(parsedUsages);
      const diagnosis = diagnoseCacheBehavior(
        calls.map((call, idx) => ({
          prefixSha256: call.prefixSha256,
          l1Version: call.l1Version,
          usage: parsedUsages[idx],
        })),
      );
      const billing = { ...baseBilling, ...diagnosis };
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
        ...(source ? { continuationState: continuationState(ctx, row, source) } : {}),
        candidate,
        attempts: jobs.historyForRun(detail.id),
        calls,
        billing,
        contextTrace,
        recoveryHints,
        microUsage: jobs.microUsage(row.id),
      };
    });
  }

  function reconcileRun(row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const jobId = optionalText(input, "jobId") ?? text(input, "attemptId");
      const detail = ctx.run(text(input, "runId"));
      if (detail.documentId !== row.id) invalid("runId", "document-mismatch");
      const tokens = count(input, "tokens");
      if (!Number.isSafeInteger(detail.settled + tokens)) invalid("tokens", "usage-overflow");
      if (!jobs.reconcile(jobId, detail.id)) {
        refuse("run.reconcile", "no-uncertain-attempt");
      }
      stmt(db, "UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(tokens, detail.id);
      ctx.event(row.projectId, "run", "run.attempt", {
        runId: detail.id,
        attemptId: jobId,
        stage: WRITING_STAGE_IDS.write,
        usage: tokens,
        outcome: "reconciled",
      });
      return { id: jobId };
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
      if (jobs.pendingForRun(current.id)) refuse("run.generate", "generation-needs-reconciliation");
      if (current.state !== "failed" && current.state !== "running") {
        refuse("run.generate", "run-no-longer-running");
      }
      ctx.assertRunAvailable("run.generate", row.id, current.id);
      if (current.state === "failed") {
        stmt(db, "UPDATE author_runs SET recovery_hints = NULL WHERE id = ?;").run(current.id);
        ctx.stage(current, "running");
      }
      const remaining = Math.max(0, current.reserved - current.settled);
      let attemptId: string | null = null;
      if (claim) {
        attemptId = randomUUID();
        jobs.create({
          id: attemptId,
          kind: "draft_generation",
          subtype: row.product,
          scopeKey: current.id,
          projectId: row.projectId,
          documentId: row.id,
          runId: current.id,
          provider,
          model,
          reserved: remaining,
        });
        ctx.event(row.projectId, "run", "generation.started", { runId: current.id, attemptId });
      }
      const mod = registry.require(row.product);
      return {
        id: current.id,
        product: row.product,
        attemptId,
        jobId: attemptId,
        autoQa: input.autoQa === true && mod.supportsAutoQa,
        frozenInput: current.frozenInput,
        reserved: remaining,
        provider,
        model,
      };
    });
  }

  function notifyProjectCacheActivity(jobId: string): void {
    const row = stmt(db, `
      SELECT p.id AS projectId, p.product
      FROM author_jobs j
      JOIN author_projects p ON p.id = j.project_id
      WHERE j.id = ?;
    `).get(jobId) as { projectId: string; product: Product } | undefined;
    if (row) {
      registry.get(row.product)?.onJobCacheHit?.(ctx, row.projectId);
    }
  }

  function beginJobCall(
    jobId: string,
    phase: string,
    inputReserve: number,
    maxOutput: number,
    cacheMeta?: CallCacheMeta,
  ): string {
    return ctx.atomic(() => {
      const job = jobs.openJob(jobId);
      if (!job) refuse("job.call", "job-no-longer-open");
      if (job.kind === "draft_generation" && job.runId && ctx.run(job.runId).state !== "running") {
        refuse("run.generate", "run-no-longer-running");
      }
      const callId = randomUUID();
      if (!jobs.beginCall(jobId, callId, phase, inputReserve, maxOutput, cacheMeta)) {
        refuse("job.call", "job-in-progress");
      }
      return callId;
    });
  }

  function recordJobReceipt(jobId: string, callId: string, usage: readonly number[]): void {
    ctx.atomic(() => {
      jobs.receiveCall(jobId, callId, usage);
      notifyProjectCacheActivity(jobId);
    });
  }

  function finishGeneration(
    jobId: string,
    result: Input | null,
    failure: string | null,
    recoveryHints?: readonly RecoveryHintDto[],
  ) {
    return ctx.atomic(() => {
      const attempt = jobs.openJob(jobId);
      if (!attempt || !attempt.runId) return;
      const current = ctx.run(attempt.runId);
      const row = ctx.document(current.documentId);
      const receipts = JSON.parse(attempt.usage) as readonly { usage: readonly number[] }[];
      const tokens = receipts.reduce((sum, entry) => sum + sumUsageTuple(entry.usage), 0);
      const uncertain = attempt.state === "inflight";
      const terminalState = uncertain
        ? "uncertain"
        : result
          ? "completed"
          : failure === "cancelled"
            ? "cancelled"
            : "failed";
      jobs.close(jobId, terminalState, failure);
      if (current.state === "running" && result && !uncertain) {
        stmt(db, "UPDATE author_runs SET recovery_hints = NULL WHERE id = ?;").run(current.id);
        return completeRun(current, row, { ...result, tokens });
      }
      const hintsJson = recoveryHints && recoveryHints.length > 0 ? JSON.stringify(recoveryHints) : null;
      stmt(db, "UPDATE author_runs SET settled = settled + ?, recovery_hints = ? WHERE id = ?;")
        .run(tokens, hintsJson, current.id);
      ctx.event(row.projectId, "run", "run.attempt", {
        runId: current.id,
        attemptId: jobId,
        stage: WRITING_STAGE_IDS.write,
        usage: tokens,
        outcome: uncertain ? "usage.uncertain" : failure ?? "cancelled",
      });
      if (current.state === "running") ctx.stage(current, "failed");
    });
  }

  function reserveRefinement(runId: string): void {
    ctx.atomic(() => {
      const current = ctx.run(runId);
      if (current.state !== "running") refuse("run.generate", "run-no-longer-running");
      const row = ctx.document(current.documentId);
      const mod = registry.require(row.product);
      if (!mod.reserveRefinement) refuse("run.generate", "refinement-unsupported");
      mod.reserveRefinement(ctx, runId);
    });
  }

  function failGeneration(runId: string, tokens: number): void {
    ctx.atomic(() => {
      const current = ctx.run(runId);
      if (current.state === "running") {
        stmt(db, "UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(tokens, runId);
        const row = ctx.document(current.documentId);
        ctx.event(row.projectId, "run", "run.attempt", {
          runId,
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

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Proposal Extraction (Author-Sovereign Structured Proposals)
  // ───────────────────────────────────────────────────────────────────────────

  function beginProposalGeneration(input: Input) {
    const kind = parseProposalKind(input.kind);
    const provider = text(input, "provider");
    const model = text(input, "model");
    const projectId = optionalText(input, "projectId") ?? null;
    const documentId = optionalText(input, "documentId") ?? null;
    if (isDocumentBoundProposalKind(kind) && !documentId) invalid("documentId", "chapter-required");
    const reserved = input.tokenLimit === undefined ? 12_000 : count(input, "tokenLimit");
    if (reserved === 0) invalid("tokenLimit", "positive-budget-required");

    return ctx.atomic(() => {
      let sourceText = optionalText(input, "sourceText") ?? "";
      let sourceRef = optionalText(input, "sourceRef") ?? "";
      let resolvedProjectId = projectId;
      let baseRevisionId: string | null = null;
      let sourceSha = "";

      if (documentId) {
        const doc = ctx.document(documentId);
        resolvedProjectId = doc.projectId;
        baseRevisionId = doc.revisionId ?? null;
        sourceSha = sha256Text(doc.body ?? "");
        if (!sourceText) sourceText = doc.body ?? "";
        if (!sourceRef) sourceRef = doc.title;
      }

      const scopeTarget = documentId ?? resolvedProjectId ?? "global";
      const scopeKey = `${kind}:${scopeTarget}`;
      if (jobs.hasActiveScope("proposal_extraction", scopeKey)) {
        refuse("proposal.generate", "proposal-in-progress");
      }

      const spec = PROPOSAL_SPECS[kind];
      if (!spec) invalid("kind", "proposal-kind-not-ai-generatable");
      const instruction = optionalText(input, "instruction") ?? "";
      let extraContext: Readonly<Record<string, unknown>> = {};
      let layered: LayeredPromptPayload | undefined;
      if (resolvedProjectId) {
        const project = stmt(db, "SELECT product FROM author_projects WHERE id = ?;").get(resolvedProjectId) as
          | { product: Product }
          | undefined;
        const mod = project ? registry.get(project.product) : undefined;
        const built = mod?.buildProposalContext?.(ctx, {
          kind,
          phase: spec.phase,
          projectId: resolvedProjectId,
          documentId,
          sourceText,
          sourceRef,
          instruction,
          input,
        });
        if (built) {
          if (built.sourceText !== undefined) sourceText = built.sourceText;
          if (built.sourceRef !== undefined && !sourceRef) sourceRef = built.sourceRef;
          if (built.extra) extraContext = built.extra;
          if (built.layered) layered = built.layered;
        }
      }
      if (!sourceText.trim()) invalid("sourceText", "source-text-required");

      const system = layered ? SHARED_WORKBENCH_SYSTEM_KERNEL : spec.system;
      const prompt = layered
        ? layered.dynamicTail
        : [
            `### 提案类型：${kind}${sourceRef ? `（${sourceRef}）` : ""}`,
            instruction ? `### 补充要求\n${instruction}` : "",
            Object.keys(extraContext).length > 0 ? `### 补充上下文\n${JSON.stringify(extraContext)}` : "",
            `### 输入文本\n${sourceText}`,
          ]
            .filter(Boolean)
            .join("\n\n");

      const id = randomUUID();
      const now = Date.now();
      try {
        stmt(db, `
          INSERT INTO author_ai_proposals (
            id, project_id, document_id, kind, status, source_ref,
            payload, provider, model, reserved, settled, usage,
            base_revision_id, source_sha256, origin, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'inflight', ?, '{}', ?, ?, ?, 0, '[]', ?, ?, 'ai-generate', ?, ?);
        `).run(
          id,
          resolvedProjectId,
          documentId,
          kind,
          sourceRef,
          provider,
          model,
          reserved,
          baseRevisionId,
          sourceSha,
          now,
          now,
        );
        jobs.create({
          id,
          kind: "proposal_extraction",
          subtype: kind,
          scopeKey,
          projectId: resolvedProjectId,
          documentId,
          proposalId: id,
          provider,
          model,
          reserved,
        });
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
          refuse("proposal.generate", "proposal-in-progress");
        }
        throw error;
      }

      return {
        id,
        jobId: id,
        kind,
        phase: spec.phase,
        system,
        prompt,
        layered,
        provider,
        model,
        reserved,
        disableThinking: true,
        projectId: resolvedProjectId,
        documentId,
        baseRevisionId,
      };
    });
  }

  function recordProposalReceipt(proposalId: string, callId: string, usage: readonly number[]): void {
    ctx.atomic(() => {
      jobs.receiveCall(proposalId, callId, usage);
      notifyProjectCacheActivity(proposalId);
      const tokens = sumUsageTuple(usage);
      stmt(db, `
        UPDATE author_ai_proposals
        SET settled = settled + ?,
            usage = json_insert(usage, '$[#]', json(?)),
            updated_at = ?
        WHERE id = ? AND status = 'inflight';
      `).run(tokens, JSON.stringify(usage), Date.now(), proposalId);
    });
  }

  function finishProposalGeneration(
    proposalId: string,
    payload: Record<string, unknown> | null,
    failure: string | null,
  ): void {
    ctx.atomic(() => {
      const now = Date.now();
      const open = jobs.openJob(proposalId);
      const uncertain = open?.state === "inflight";
      const target = stmt(db, "SELECT project_id AS projectId, kind FROM author_ai_proposals WHERE id = ?;")
        .get(proposalId) as { projectId?: string | null; kind?: string } | undefined;
      const normalized = payload && !failure && !uncertain && target?.kind === "fact_sync"
        ? normalizeFactSyncPayload(payload)
        : payload;
      const succeeded = Boolean(normalized && !failure && !uncertain);
      const nextStatus = succeeded ? "pending" : "failed";
      const errorReason = uncertain ? "usage.uncertain" : (failure ?? "generation.failed");

      if (open) {
        jobs.close(
          proposalId,
          uncertain ? "uncertain" : succeeded ? "completed" : failure === "cancelled" ? "cancelled" : "failed",
          succeeded ? null : errorReason,
        );
      }

      const res = succeeded
        ? stmt(db, `
            UPDATE author_ai_proposals
            SET status = 'pending', payload = ?, error = NULL, updated_at = ?
            WHERE id = ? AND status = 'inflight';
          `).run(JSON.stringify(normalized), now, proposalId)
        : stmt(db, `
            UPDATE author_ai_proposals
            SET status = 'failed', error = ?, updated_at = ?
            WHERE id = ? AND status = 'inflight';
          `).run(errorReason, now, proposalId);
      if (res.changes > 0 && target?.projectId) {
        ctx.event(target.projectId, "setting", "proposal.ready", { id: proposalId, status: nextStatus });
      }
    });
  }

  function cancelProposalGeneration(proposalId: string): boolean {
    return ctx.atomic(() => {
      jobs.close(proposalId, "cancelled", "cancelled");
      const res = stmt(db, `
        UPDATE author_ai_proposals
        SET status = 'failed', error = 'cancelled', updated_at = ?
        WHERE id = ? AND status = 'inflight';
      `).run(Date.now(), proposalId);
      return Boolean(res.changes);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Selection Rewrite (Per-Document Exclusive Inline Micro Jobs)
  // ───────────────────────────────────────────────────────────────────────────

  function buildSelectionRewriteInput(input: Input): SelectionRewriteRequest {
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
      const selectionCtx = mod.buildSelectionContext?.(ctx, row, {
        mode,
        instruction,
        beforeContext,
        selectedText,
        afterContext,
      });

      const layered = selectionCtx?.layered;
      const system = layered ? SHARED_WORKBENCH_SYSTEM_KERNEL : SELECTION_REWRITE_SYSTEM;
      const prompt = layered
        ? layered.dynamicTail
        : [
            `### 选区改写：${row.title}（模式：${mode}）`,
            instruction ? `### 改写指令\n${instruction}` : "",
            beforeContext ? `### 选区前文\n${beforeContext}` : "",
            `### 待改写选区\n${selectedText}`,
            afterContext ? `### 选区后文\n${afterContext}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
      return {
        documentId: row.id,
        projectId: row.projectId,
        mode,
        provider,
        model,
        reserved,
        system,
        prompt,
        layered,
      };
    });
  }

  function beginSelectionRewrite(request: SelectionRewriteRequest): { readonly id: string } {
    return ctx.atomic(() => {
      if (jobs.hasActiveScope("selection_rewrite", request.documentId)) {
        refuse("selection.rewrite", "rewrite-in-progress");
      }
      const id = randomUUID();
      try {
        jobs.create({
          id,
          kind: "selection_rewrite",
          subtype: request.mode,
          scopeKey: request.documentId,
          projectId: request.projectId,
          documentId: request.documentId,
          provider: request.provider,
          model: request.model,
          reserved: request.reserved,
        });
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
          refuse("selection.rewrite", "rewrite-in-progress");
        }
        throw error;
      }
      ctx.event(request.projectId, "run", "selection.rewrite.started", {
        id,
        documentId: request.documentId,
        mode: request.mode,
      });
      return { id };
    });
  }

  function finishSelectionRewrite(jobId: string, failed: boolean, reason: string | null = null): void {
    ctx.atomic(() => {
      const open = jobs.openJob(jobId);
      if (!open) return;
      if (open.state === "inflight") {
        jobs.close(jobId, "uncertain", reason ?? "usage.uncertain");
        return;
      }
      const nextState = failed ? (reason === "cancelled" ? "cancelled" : "failed") : "completed";
      jobs.close(jobId, nextState, failed ? (reason ?? "generation.failed") : null);
    });
  }

  function microUsage(documentId: string): MicroUsageSummaryDto {
    return jobs.microUsage(documentId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Unified Queries & Startup/Shutdown Recovery
  // ───────────────────────────────────────────────────────────────────────────

  function listJobs(input: Input = {}): readonly UnifiedJobSummaryDto[] {
    const projectId = optionalText(input, "projectId");
    const documentId = optionalText(input, "documentId");
    const kind = parseJobKind(input.kind);
    const limit = input.limit === undefined ? 30 : count(input, "limit");
    return ctx.read(() => jobs.list({ projectId, documentId, kind, limit }).map(toJobSummaryDto));
  }

  function recoverAll(): number {
    let recovered = 0;
    for (const open of jobs.unfinished()) {
      recovered += 1;
      if (open.kind === "draft_generation") {
        finishGeneration(open.id, null, "interrupted");
      } else if (open.kind === "proposal_extraction") {
        finishProposalGeneration(open.id, null, "interrupted");
      } else if (open.kind === "selection_rewrite") {
        finishSelectionRewrite(open.id, true, "interrupted");
      }
    }
    ctx.atomic(() => {
      stmt(db, `
        UPDATE author_ai_proposals
        SET status = 'failed', error = 'interrupted', updated_at = ?
        WHERE status = 'inflight';
      `).run(Date.now());
    });
    return recovered;
  }

  return {
    previewBudget,
    startRun,
    handleRunLifecycle,
    adoptCandidate,
    runHistory,
    runDetail,
    reconcileRun,
    generationInput,
    generationRunner,
    beginJobCall,
    recordJobReceipt,
    finishGeneration,
    reserveRefinement,
    failGeneration,
    beginProposalGeneration,
    recordProposalReceipt,
    finishProposalGeneration,
    cancelProposalGeneration,
    buildSelectionRewriteInput,
    beginSelectionRewrite,
    finishSelectionRewrite,
    microUsage,
    listJobs,
    recoverAll,
  };
}

export type JobService = ReturnType<typeof createJobService>;
