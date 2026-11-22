import { randomUUID } from "node:crypto";
import { QA_REFINEMENT_LIMIT } from "../../../contracts/protected-rules.ts";
import type {
  AutopilotAdoptionPolicy,
  AutopilotAutonomyMode,
  AutopilotBatchDto,
  AutopilotBatchStatus,
  AutopilotPauseReasonDto,
  AutopilotRedLineKind,
  AutopilotScope,
  AutopilotStepDto,
  AutopilotStepKind,
} from "../../../contracts/workspace-dto.ts";
import {
  applyParagraphPatches,
  diagnoseChapterOffline,
  settingsAt,
  splitChapterParagraphs,
  type HiddenFactHint,
  type ParagraphPatchInput,
} from "../../../domain/fanqie/index.ts";
import { anchor } from "../../../domain/shared/index.ts";
import { stmt, type SqliteParameter } from "../../../storage/index.ts";
import { SHARED_WORKBENCH_SYSTEM_KERNEL } from "../../../workflow/cache-layer.ts";
import { assertStageOutput, WRITING_STAGE_IDS, type SingleShotLlmCaller } from "../../../workflow/writing-stages.ts";
import { count, invalid, optionalText, requiredRow, text, type DocumentRow, type Input, type WorkspaceContext } from "../../context.ts";
import { buildFanqieFrozenContext, buildFanqieLayeredPayload, buildFanqieSharedLayeredPrefix } from "./context.ts";
import { loadProjectControls } from "./controls.ts";
import { insertObservationsBatch, loadSlopConfig } from "./diagnostics.ts";
import { recordTechniqueOutcome } from "./library.ts";
import { createManualProposal } from "./proposal-decide.ts";
import { approvedFacts, assertFanqieProject } from "./shared.ts";

const DEFAULT_TOKEN_BUDGET = 60_000;
const QUALITY_TARGET_SCORE = 74;
const QUALITY_REDLINE_FLOOR = 68;
const MAX_CONSECUTIVE_ERRORS = 2;

interface BatchRow {
  readonly id: string;
  readonly projectId: string;
  readonly scope: AutopilotScope;
  readonly autonomyMode: AutopilotAutonomyMode;
  readonly adoptionPolicy: AutopilotAdoptionPolicy;
  readonly status: AutopilotBatchStatus;
  readonly chapterIdsJson: string;
  readonly currentChapterIndex: number;
  readonly currentStep: AutopilotStepKind | null;
  readonly tokenBudget: number;
  readonly tokensSpent: number;
  readonly refineRoundsUsed: number;
  readonly provider: string;
  readonly model: string;
  readonly pauseReasonJson: string | null;
  readonly preBatchRevisionsJson: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const BATCH_COLS = `
  id, project_id AS projectId, scope, autonomy_mode AS autonomyMode,
  adoption_policy AS adoptionPolicy, status, chapter_ids_json AS chapterIdsJson,
  current_chapter_index AS currentChapterIndex, current_step AS currentStep,
  token_budget AS tokenBudget, tokens_spent AS tokensSpent,
  refine_rounds_used AS refineRoundsUsed, provider, model,
  pause_reason_json AS pauseReasonJson, pre_batch_revisions_json AS preBatchRevisionsJson,
  created_at AS createdAt, updated_at AS updatedAt
`;

const STEP_COLS = `
  id, batch_id AS batchId, document_id AS documentId, chapter_title AS chapterTitle,
  step_kind AS stepKind, round, status, input_revision_id AS inputRevisionId,
  output_revision_id AS outputRevisionId, score_before AS scoreBefore, score_after AS scoreAfter,
  tokens_used AS tokensUsed, cache_hit_rate AS cacheHitRate, summary, error, created_at AS createdAt
`;

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseJsonPayload(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/giu, "").trim();
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object payload");
  }
  return parsed as Record<string, unknown>;
}

function loadBatchSteps(ctx: WorkspaceContext, batchId: string): AutopilotStepDto[] {
  return stmt(ctx.db, `
    SELECT ${STEP_COLS} FROM author_autopilot_steps
    WHERE batch_id = ? ORDER BY created_at ASC, rowid ASC;
  `).all(batchId) as AutopilotStepDto[];
}

function mapBatchRow(ctx: WorkspaceContext, row: BatchRow): AutopilotBatchDto {
  return {
    id: row.id,
    projectId: row.projectId,
    scope: row.scope === "multi_chapter" ? "multi_chapter" : "single_chapter",
    autonomyMode: row.autonomyMode === "chapter_gate" ? "chapter_gate" : "redline_pause",
    adoptionPolicy: row.adoptionPolicy === "candidate_only" ? "candidate_only" : "working_draft_snapshot",
    status: row.status,
    chapterIds: safeJson<string[]>(row.chapterIdsJson, []),
    currentChapterIndex: row.currentChapterIndex,
    currentStep: row.currentStep,
    tokenBudget: row.tokenBudget,
    tokensSpent: row.tokensSpent,
    refineRoundsUsed: row.refineRoundsUsed,
    provider: row.provider,
    model: row.model,
    pauseReason: safeJson<AutopilotPauseReasonDto | null>(row.pauseReasonJson, null),
    preBatchRevisions: safeJson<Record<string, string | null>>(row.preBatchRevisionsJson, {}),
    steps: loadBatchSteps(ctx, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function recordStep(
  ctx: WorkspaceContext,
  step: Omit<AutopilotStepDto, "id" | "createdAt">,
): AutopilotStepDto {
  const id = randomUUID();
  const now = Date.now();
  ctx.atomic(() => {
    stmt(ctx.db, `
      INSERT INTO author_autopilot_steps (
        id, batch_id, document_id, chapter_title, step_kind, round, status,
        input_revision_id, output_revision_id, score_before, score_after,
        tokens_used, cache_hit_rate, summary, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(
      id,
      step.batchId,
      step.documentId,
      step.chapterTitle,
      step.stepKind,
      step.round,
      step.status,
      step.inputRevisionId,
      step.outputRevisionId,
      step.scoreBefore,
      step.scoreAfter,
      step.tokensUsed,
      step.cacheHitRate,
      step.summary,
      step.error,
      now,
    );
  });
  return { ...step, id, createdAt: now };
}

function updateBatchState(
  ctx: WorkspaceContext,
  batchId: string,
  patch: {
    readonly status?: AutopilotBatchStatus;
    readonly currentChapterIndex?: number;
    readonly currentStep?: AutopilotStepKind | null;
    readonly tokensSpent?: number;
    readonly refineRoundsUsed?: number;
    readonly pauseReason?: AutopilotPauseReasonDto | null;
  },
): void {
  ctx.atomic(() => {
    const sets: string[] = ["updated_at = ?"];
    const args: SqliteParameter[] = [Date.now()];
    if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
    if (patch.currentChapterIndex !== undefined) { sets.push("current_chapter_index = ?"); args.push(patch.currentChapterIndex); }
    if (patch.currentStep !== undefined) { sets.push("current_step = ?"); args.push(patch.currentStep); }
    if (patch.tokensSpent !== undefined) { sets.push("tokens_spent = ?"); args.push(patch.tokensSpent); }
    if (patch.refineRoundsUsed !== undefined) { sets.push("refine_rounds_used = ?"); args.push(patch.refineRoundsUsed); }
    if (patch.pauseReason !== undefined) {
      sets.push("pause_reason_json = ?");
      args.push(patch.pauseReason ? JSON.stringify(patch.pauseReason) : null);
    }
    args.push(batchId);
    stmt(ctx.db, `UPDATE author_autopilot_batches SET ${sets.join(", ")} WHERE id = ?;`).run(...args);
  });
}

/** Creates and persists a new Tiered Autonomous Writing batch. */
export function createAutopilotBatch(ctx: WorkspaceContext, input: Input): AutopilotBatchDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);

  const scope: AutopilotScope = input.scope === "multi_chapter" ? "multi_chapter" : "single_chapter";
  const autonomyMode: AutopilotAutonomyMode = input.autonomyMode === "chapter_gate" ? "chapter_gate" : "redline_pause";
  const adoptionPolicy: AutopilotAdoptionPolicy =
    input.adoptionPolicy === "candidate_only" ? "candidate_only" : "working_draft_snapshot";
  const tokenBudget = input.tokenBudget !== undefined ? Math.max(4_000, count(input, "tokenBudget")) : DEFAULT_TOKEN_BUDGET;
  const provider = optionalText(input, "provider") ?? "";
  const model = optionalText(input, "model") ?? "";

  let chapterIds: string[] = [];
  if (Array.isArray(input.chapterIds) && input.chapterIds.length > 0) {
    chapterIds = [...new Set(input.chapterIds.map((id) => String(id).trim()).filter(Boolean))];
  } else if (typeof input.documentId === "string" && input.documentId.trim()) {
    chapterIds = [input.documentId.trim()];
  } else {
    invalid("chapterIds", "at-least-one-chapter-required");
  }
  if (scope === "single_chapter" && chapterIds.length > 1) {
    chapterIds = [chapterIds[0]];
  }
  if (chapterIds.length > 20) {
    invalid("chapterIds", "max-20-chapters-per-batch");
  }

  return ctx.atomic(() => {
    const preBatchRevisions: Record<string, string | null> = {};
    for (const docId of chapterIds) {
      const doc = ctx.document(docId);
      if (doc.projectId !== projectId || doc.product !== "fanqie") {
        invalid("chapterIds", "chapter-not-in-project");
      }
      if (doc.state === "final") {
        invalid("chapterIds", "cannot-autopilot-final-chapter");
      }
      preBatchRevisions[docId] = doc.revisionId;
    }

    const id = randomUUID();
    const now = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_autopilot_batches (
        id, project_id, scope, autonomy_mode, adoption_policy, status,
        chapter_ids_json, current_chapter_index, current_step,
        token_budget, tokens_spent, refine_rounds_used,
        provider, model, pause_reason_json, pre_batch_revisions_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, 0, 'beat_plan', ?, 0, 0, ?, ?, NULL, ?, ?, ?);
    `).run(
      id,
      projectId,
      scope,
      autonomyMode,
      adoptionPolicy,
      JSON.stringify(chapterIds),
      tokenBudget,
      provider,
      model,
      JSON.stringify(preBatchRevisions),
      now,
      now,
    );

    ctx.event(projectId, "chapter", "autopilot.batch.created", {
      batchId: id,
      scope,
      autonomyMode,
      adoptionPolicy,
      chapterCount: chapterIds.length,
    });

    const row = stmt(ctx.db, `SELECT ${BATCH_COLS} FROM author_autopilot_batches WHERE id = ?;`).get(id) as BatchRow;
    return mapBatchRow(ctx, row);
  });
}

export function listAutopilotBatches(ctx: WorkspaceContext, input: Input): AutopilotBatchDto[] {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.read(() => {
    const rows = stmt(ctx.db, `
      SELECT ${BATCH_COLS} FROM author_autopilot_batches
      WHERE project_id = ? ORDER BY updated_at DESC LIMIT 20;
    `).all(projectId) as BatchRow[];
    return rows.map((r) => mapBatchRow(ctx, r));
  });
}

export function getAutopilotBatch(ctx: WorkspaceContext, input: Input): AutopilotBatchDto {
  const batchId = text(input, "batchId");
  return ctx.read(() => {
    const row = requiredRow<BatchRow>(
      stmt(ctx.db, `SELECT ${BATCH_COLS} FROM author_autopilot_batches WHERE id = ?;`).get(batchId),
      "autopilot_batch",
      batchId,
    );
    return mapBatchRow(ctx, row);
  });
}

export function pauseAutopilotBatch(ctx: WorkspaceContext, input: Input): AutopilotBatchDto {
  const batchId = text(input, "batchId");
  const existing = getAutopilotBatch(ctx, { batchId });
  if (existing.status === "running") {
    updateBatchState(ctx, batchId, { status: "paused_gate" });
  }
  return getAutopilotBatch(ctx, { batchId });
}

export function cancelAutopilotBatch(ctx: WorkspaceContext, input: Input): AutopilotBatchDto {
  const batchId = text(input, "batchId");
  const existing = getAutopilotBatch(ctx, { batchId });
  if (existing.status !== "completed" && existing.status !== "cancelled") {
    updateBatchState(ctx, batchId, { status: "cancelled", currentStep: null });
    ctx.atomic(() => {
      ctx.event(existing.projectId, "chapter", "autopilot.batch.cancelled", { batchId });
    });
  }
  return getAutopilotBatch(ctx, { batchId });
}

/**
 * One-click non-destructive rollback of a chapter touched by an autopilot batch
 * back to its pre-batch working draft snapshot (creates a new revision so history stays intact).
 */
export function rollbackAutopilotChapter(
  ctx: WorkspaceContext,
  input: Input,
  saveDraft: (row: DocumentRow, body: string) => { readonly revisionId: string },
): { readonly documentId: string; readonly restoredRevisionId: string; readonly preBatchRevisionId: string | null } {
  const batchId = text(input, "batchId");
  const documentId = text(input, "documentId");
  const batch = getAutopilotBatch(ctx, { batchId });
  if (!Object.hasOwn(batch.preBatchRevisions, documentId)) {
    invalid("documentId", "chapter-not-in-batch");
  }
  const preRevId = batch.preBatchRevisions[documentId] ?? null;
  let preBody = "";
  if (preRevId) {
    const revRow = stmt(ctx.db, "SELECT body FROM revisions WHERE revision_id = ?;").get(preRevId) as
      | { body?: string }
      | undefined;
    preBody = revRow?.body ?? "";
  }
  const doc = ctx.document(documentId);
  if (doc.state === "final") {
    invalid("documentId", "cannot-rollback-final-chapter");
  }
  const saved = saveDraft(doc, preBody);
  ctx.atomic(() => {
    ctx.event(batch.projectId, "chapter", "autopilot.chapter.rolled_back", {
      batchId,
      documentId,
      restoredRevisionId: saved.revisionId,
      preBatchRevisionId: preRevId,
    });
  });
  return {
    documentId,
    restoredRevisionId: saved.revisionId,
    preBatchRevisionId: preRevId,
  };
}

function diagnoseChapterDraft(
  ctx: WorkspaceContext,
  doc: DocumentRow,
  body: string,
) {
  const order = ctx.chapterOrder(doc.projectId);
  const chapterIndex = Math.max(0, order.indexOf(doc.id));
  const plan = ctx.planning(doc.id);
  const targetLength = typeof plan?.target === "number" ? plan.target : undefined;
  const viewpoint = typeof plan?.viewpoint === "string" ? plan.viewpoint.trim() : undefined;
  const config = loadSlopConfig(ctx, doc.projectId);
  const controls = loadProjectControls(ctx, doc.projectId);

  const recentIds = chapterIndex > 0 ? order.slice(Math.max(0, chapterIndex - 3), chapterIndex) : [];
  const recentChapterBodies: string[] = [];
  if (recentIds.length > 0) {
    const readBody = stmt(ctx.db, `
      SELECT r.body FROM documents d
      LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
      WHERE d.document_id = ?;
    `);
    for (const prevId of recentIds) {
      const prev = readBody.get(prevId) as { body?: string | null } | undefined;
      if (prev?.body) recentChapterBodies.push(prev.body);
    }
  }

  const hiddenFacts: HiddenFactHint[] = [];
  if (viewpoint) {
    const facts = approvedFacts(ctx, doc.projectId);
    const knownIds = new Set(settingsAt(facts, order, anchor(doc.id, 1), viewpoint).map((f) => f.id));
    const loreMeta = new Map(
      (
        stmt(ctx.db, "SELECT fact_id AS factId, entity_name AS entityName FROM author_lore_current WHERE project_id = ?;")
          .all(doc.projectId) as readonly { factId: string; entityName: string }[]
      ).map((m) => [m.factId, m.entityName]),
    );
    for (const fact of facts) {
      if (fact.kind === "agreement" || knownIds.has(fact.id)) continue;
      hiddenFacts.push({
        factId: fact.id,
        entityName: loreMeta.get(fact.id) ?? "",
        note: fact.note,
        aliases: fact.aliases,
      });
    }
  }

  return diagnoseChapterOffline(doc.id, body, {
    chapterIndex,
    targetLength,
    pacingTier: controls.pacingTier,
    genreTags: controls.genreTags,
    customBanned: config.customBanned,
    whitelist: config.whitelist,
    recentChapterBodies,
    hiddenFacts,
    viewpoint,
  });
}

function numberParagraphs(body: string): string {
  const spans = splitChapterParagraphs(body);
  return spans.map((s) => `[P${s.index}] ${s.text}`).join("\n\n");
}

/**
 * Executes or resumes a Tiered Autonomous Writing batch (single-chapter 5-step
 * pipeline or multi-chapter serial autopilot) while reusing byte-identical
 * L0+L1+L2 prompt cache across every step and enforcing red-line circuit breakers.
 */
export async function runAutopilotBatch(
  ctx: WorkspaceContext,
  deps: {
    readonly batchId: string;
    readonly caller: SingleShotLlmCaller;
    readonly signal: AbortSignal;
    readonly saveDraft: (row: DocumentRow, body: string) => { readonly revisionId: string };
    readonly instruction?: string;
    readonly overrideRedLine?: boolean;
  },
): Promise<AutopilotBatchDto> {
  const initial = getAutopilotBatch(ctx, { batchId: deps.batchId });
  if (initial.status === "completed" || initial.status === "cancelled") {
    return initial;
  }

  updateBatchState(ctx, deps.batchId, { status: "running", pauseReason: null });
  let tokensSpent = initial.tokensSpent;
  let refineRoundsUsed = initial.refineRoundsUsed;
  let consecutiveErrors = 0;
  let overrideCurrentChapter = deps.overrideRedLine === true;
  let lastCallerTokens = deps.caller.usedTokens();

  function trackTokensDelta(): number {
    const nowTokens = deps.caller.usedTokens();
    const delta = Math.max(0, nowTokens - lastCallerTokens);
    lastCallerTokens = nowTokens;
    tokensSpent += delta;
    return delta;
  }

  function pauseForRedLine(
    kind: AutopilotRedLineKind,
    doc: DocumentRow,
    message: string,
    details: readonly string[],
    problemParagraphs: readonly number[] = [],
    nextStatus: AutopilotBatchStatus = "paused_redline",
    chapterIdx?: number,
  ): AutopilotBatchDto {
    const reason: AutopilotPauseReasonDto = {
      kind,
      documentId: doc.id,
      chapterTitle: doc.title,
      message,
      details,
      problemParagraphs,
    };
    updateBatchState(ctx, deps.batchId, {
      status: nextStatus,
      ...(chapterIdx !== undefined ? { currentChapterIndex: chapterIdx } : {}),
      tokensSpent,
      refineRoundsUsed,
      pauseReason: reason,
    });
    ctx.atomic(() => {
      ctx.event(initial.projectId, "chapter", "autopilot.paused", {
        batchId: deps.batchId,
        kind,
        documentId: doc.id,
      });
    });
    return getAutopilotBatch(ctx, { batchId: deps.batchId });
  }

  for (let idx = initial.currentChapterIndex; idx < initial.chapterIds.length; idx += 1) {
    const liveBatch = getAutopilotBatch(ctx, { batchId: deps.batchId });
    if (deps.signal.aborted || liveBatch.status === "cancelled") {
      updateBatchState(ctx, deps.batchId, { status: "cancelled", currentStep: null, tokensSpent, refineRoundsUsed });
      return getAutopilotBatch(ctx, { batchId: deps.batchId });
    }

    const docId = initial.chapterIds[idx];
    let doc = ctx.document(docId);
    if (doc.state === "final") {
      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "beat_plan",
        round: 1,
        status: "skipped",
        inputRevisionId: doc.revisionId,
        outputRevisionId: doc.revisionId,
        scoreBefore: null,
        scoreAfter: null,
        tokensUsed: 0,
        cacheHitRate: null,
        summary: "章节已定稿（final），已跳过自动写作。",
        error: null,
      });
      continue;
    }

    // Budget cap red-line (>= 85%)
    if (tokensSpent >= initial.tokenBudget * 0.85 && !overrideCurrentChapter) {
      return pauseForRedLine(
        "budget_cap",
        doc,
        `Token 预算已使用 ${tokensSpent} / ${initial.tokenBudget}（达到 85% 警戒线），已自动暂停。`,
        [`剩余预算约 ${Math.max(0, initial.tokenBudget - tokensSpent)} tokens`],
      );
    }

    // Build shared L0+L1+L2 prefix and full context once for this chapter
    const frozen = buildFanqieFrozenContext(ctx, doc, { instruction: deps.instruction ?? "" }, { readOnly: false });
    const shared = buildFanqieSharedLayeredPrefix(ctx, doc.projectId, doc, { readOnly: false });
    const activeTechniqueIds = frozen.contextBundle.report.activeTechniqueIds;

    // --- Step 1: Beat Plan ---
    updateBatchState(ctx, deps.batchId, { currentChapterIndex: idx, currentStep: "beat_plan", tokensSpent });
    let beatPlanText = "";
    try {
      const beatLayered = buildFanqieLayeredPayload(shared, "beatPlan", [
        `### 本章节拍规划目标：《${doc.title}》`,
        frozen.contextBundle.dynamicTail,
      ]);
      const beatRaw = await deps.caller.complete({
        phase: "beatPlan",
        system: SHARED_WORKBENCH_SYSTEM_KERNEL,
        prompt: beatLayered.dynamicTail,
        layered: beatLayered,
      });
      const beatDelta = trackTokensDelta();
      const beatJson = parseJsonPayload(beatRaw) as Record<string, unknown>;
      assertStageOutput(WRITING_STAGE_IDS.beatPlan, beatJson, "beatPlan");
      consecutiveErrors = 0;

      const beats = Array.isArray(beatJson.beats) ? beatJson.beats : [];
      beatPlanText = [
        typeof beatJson.openingHook === "string" ? `开篇钩子：${beatJson.openingHook}` : "",
        ...beats.map((b, i) => {
          const rec = b as Record<string, unknown>;
          return `${i + 1}. 场景：${String(rec.scene ?? "")} | 冲突：${String(rec.conflict ?? "")} | 转折：${String(rec.turn ?? "")}`;
        }),
        typeof beatJson.endingHook === "string" ? `章末钩子：${beatJson.endingHook}` : "",
      ].filter(Boolean).join("\n");

      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "beat_plan",
        round: 1,
        status: "completed",
        inputRevisionId: doc.revisionId,
        outputRevisionId: doc.revisionId,
        scoreBefore: null,
        scoreAfter: null,
        tokensUsed: beatDelta,
        cacheHitRate: frozen.contextBundle.report.estimatedCacheableRatio ?? null,
        summary: `已生成 ${beats.length} 个场景节拍。`,
        error: null,
      });
    } catch (err) {
      consecutiveErrors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "beat_plan",
        round: 1,
        status: "failed",
        inputRevisionId: doc.revisionId,
        outputRevisionId: null,
        scoreBefore: null,
        scoreAfter: null,
        tokensUsed: trackTokensDelta(),
        cacheHitRate: null,
        summary: "节拍规划失败",
        error: msg,
      });
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return pauseForRedLine("consecutive_errors", doc, "连续模型调用异常，已触发熔断暂停。", [msg]);
      }
      // Graceful degradation: continue to draft_write without beat sheet
    }

    if (deps.signal.aborted) {
      updateBatchState(ctx, deps.batchId, { status: "cancelled", currentStep: null, tokensSpent });
      return getAutopilotBatch(ctx, { batchId: deps.batchId });
    }

    // --- Step 2: Draft Write ---
    updateBatchState(ctx, deps.batchId, { currentStep: "draft_write", tokensSpent });
    let draftBody = doc.body ?? "";
    let workingRevId = doc.revisionId;
    try {
      const writeSections = [
        frozen.contextBundle.dynamicTail,
        beatPlanText ? `### 本章场景节拍表（Beat-First 执行蓝图）\n${beatPlanText}` : "",
      ];
      const writeLayered = buildFanqieLayeredPayload(shared, "write", writeSections);
      const generated = await deps.caller.complete({
        phase: "write",
        system: SHARED_WORKBENCH_SYSTEM_KERNEL,
        prompt: writeLayered.dynamicTail,
        layered: writeLayered,
      });
      const writeDelta = trackTokensDelta();
      assertStageOutput(WRITING_STAGE_IDS.write, generated, "write");
      consecutiveErrors = 0;
      draftBody = generated.trim();

      if (initial.adoptionPolicy === "working_draft_snapshot") {
        const saved = deps.saveDraft(doc, draftBody);
        workingRevId = saved.revisionId;
        doc = ctx.document(doc.id);
      }

      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "draft_write",
        round: 1,
        status: "completed",
        inputRevisionId: initial.preBatchRevisions[doc.id] ?? null,
        outputRevisionId: workingRevId,
        scoreBefore: null,
        scoreAfter: null,
        tokensUsed: writeDelta,
        cacheHitRate: frozen.contextBundle.report.estimatedCacheableRatio ?? null,
        summary: `生成正文 ${[...draftBody.replace(/\s/gu, "")].length} 字（${initial.adoptionPolicy === "working_draft_snapshot" ? "已写入工作稿快照" : "仅暂存候选态"}）。`,
        error: null,
      });
    } catch (err) {
      consecutiveErrors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "draft_write",
        round: 1,
        status: "failed",
        inputRevisionId: doc.revisionId,
        outputRevisionId: null,
        scoreBefore: null,
        scoreAfter: null,
        tokensUsed: trackTokensDelta(),
        cacheHitRate: null,
        summary: "正文生成失败",
        error: msg,
      });
      return pauseForRedLine("consecutive_errors", doc, `正文生成异常：${msg}`, [msg]);
    }

    // --- Step 3a: Zero-token Offline Quality v2 QA ---
    updateBatchState(ctx, deps.batchId, { currentStep: "offline_qa", tokensSpent });
    let diag = diagnoseChapterDraft(ctx, doc, draftBody);
    const initialScore = diag.qualityV2?.compositeScore ?? diag.goldenThree.overallScore;
    recordStep(ctx, {
      batchId: deps.batchId,
      documentId: doc.id,
      chapterTitle: doc.title,
      stepKind: "offline_qa",
      round: 1,
      status: "completed",
      inputRevisionId: workingRevId,
      outputRevisionId: workingRevId,
      scoreBefore: initialScore,
      scoreAfter: initialScore,
      tokensUsed: 0,
      cacheHitRate: null,
      summary: `综合分 ${initialScore} · 章末钩子 ${diag.qualityV2?.endingHookScore ?? 0} · AI味 ${diag.aiSlop.severity} · 越权疑点 ${diag.qualityV2?.povLeakWarnings.length ?? 0}`,
      error: null,
    });

    // --- Step 3b: Model Qualitative Review (reusing L0+L1+L2) ---
    updateBatchState(ctx, deps.batchId, { currentStep: "model_review", tokensSpent });
    let reviewObs: Array<{ dimension: string; severity: string; quote: string; suggestion: string }> = [];
    try {
      const reviewLayered = buildFanqieLayeredPayload(shared, "chapterReview", [
        `### 待审章节：《${doc.title}》`,
        `### 本地 Quality v2 诊断信号\n综合分 ${initialScore}；章末钩子 ${diag.qualityV2?.endingHookScore ?? 0}；AI套话命中 ${diag.aiSlop.totalHits}；段首复读 ${diag.qualityV2?.paragraphLeadRepetitions.length ?? 0}；视角疑点 ${diag.qualityV2?.povLeakWarnings.length ?? 0}`,
        `### 章节正文\n${draftBody}`,
      ]);
      const reviewRaw = await deps.caller.complete({
        phase: "chapterReview",
        system: SHARED_WORKBENCH_SYSTEM_KERNEL,
        prompt: reviewLayered.dynamicTail,
        layered: reviewLayered,
      });
      const reviewDelta = trackTokensDelta();
      const reviewJson = parseJsonPayload(reviewRaw) as { observations?: unknown[] };
      assertStageOutput(WRITING_STAGE_IDS.chapterReview, reviewJson, "chapterReview");
      consecutiveErrors = 0;

      reviewObs = (reviewJson.observations ?? []).map((o) => {
        const rec = o as Record<string, unknown>;
        return {
          dimension: String(rec.dimension ?? "style"),
          severity: String(rec.severity ?? "warning"),
          quote: String(rec.quote ?? ""),
          suggestion: String(rec.suggestion ?? ""),
        };
      });
      if (reviewObs.length > 0) {
        ctx.atomic(() => {
          insertObservationsBatch(ctx, doc.projectId, doc.id, workingRevId, reviewObs, "autopilot");
        });
      }
      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "model_review",
        round: 1,
        status: "completed",
        inputRevisionId: workingRevId,
        outputRevisionId: workingRevId,
        scoreBefore: initialScore,
        scoreAfter: initialScore,
        tokensUsed: reviewDelta,
        cacheHitRate: frozen.contextBundle.report.estimatedCacheableRatio ?? null,
        summary: `审稿产出 ${reviewObs.length} 条观察（高危 ${reviewObs.filter((o) => o.severity === "error").length} 条）。`,
        error: null,
      });
    } catch (err) {
      consecutiveErrors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "model_review",
        round: 1,
        status: "failed",
        inputRevisionId: workingRevId,
        outputRevisionId: workingRevId,
        scoreBefore: initialScore,
        scoreAfter: initialScore,
        tokensUsed: trackTokensDelta(),
        cacheHitRate: null,
        summary: "模型定性审稿跳过",
        error: msg,
      });
    }

    // --- Step 4: Surgical Paragraph Refine (strictly capped at QA_REFINEMENT_LIMIT = 2) ---
    let currentScore = initialScore;
    let chapterRefineRound = 0;
    const highSeverityReview = () =>
      reviewObs.filter((o) => o.severity === "error" && (o.dimension === "ooc" || o.dimension === "continuity"));
    const needsRefine = () =>
      currentScore < QUALITY_TARGET_SCORE ||
      diag.aiSlop.severity === "high" ||
      (diag.qualityV2?.povLeakWarnings.length ?? 0) > 0 ||
      highSeverityReview().length > 0;

    while (needsRefine() && chapterRefineRound < QA_REFINEMENT_LIMIT) {
      if (deps.signal.aborted) break;
      chapterRefineRound += 1;
      refineRoundsUsed += 1;
      updateBatchState(ctx, deps.batchId, { currentStep: "surgical_refine", tokensSpent, refineRoundsUsed });

      const issueLines: string[] = [];
      for (const warn of diag.qualityV2?.povLeakWarnings ?? []) {
        issueLines.push(`- [P${warn.paragraphIndex}] 疑似视角越权：提及未获知设定「${warn.entityName}」（${warn.matchedTerm}）`);
      }
      for (const rep of diag.qualityV2?.paragraphLeadRepetitions ?? []) {
        issueLines.push(`- 段落 [${rep.paragraphs.map((p) => `P${p}`).join(", ")}] 开头重复「${rep.lead}」`);
      }
      if (diag.qualityV2?.endingHookStatus === "warn") {
        issueLines.push(`- 尾段章末钩子偏弱：${diag.qualityV2.endingHookSummary}`);
      }
      for (const hit of diag.aiSlop.hits.slice(0, 6)) {
        issueLines.push(`- [P${hit.paragraphIndex}] 存在 AI 高频套话「${hit.phrase}」`);
      }
      for (const obs of reviewObs.slice(0, 6)) {
        issueLines.push(`- [${obs.dimension}/${obs.severity}] ${obs.quote ? `「${obs.quote}」→ ` : ""}${obs.suggestion}`);
      }

      try {
        const patchLayered = buildFanqieLayeredPayload(shared, "surgicalPatch", [
          `### 外科手术式段落精修（第 ${chapterRefineRound}/${QA_REFINEMENT_LIMIT} 轮）：《${doc.title}》`,
          `### 待修复问题清单\n${issueLines.join("\n") || "请提升章末钩子与段落节奏"}`,
          `### 带段落编号的正文\n${numberParagraphs(draftBody)}`,
        ]);
        const patchRaw = await deps.caller.complete({
          phase: "surgicalPatch",
          system: SHARED_WORKBENCH_SYSTEM_KERNEL,
          prompt: patchLayered.dynamicTail,
          layered: patchLayered,
        });
        const patchDelta = trackTokensDelta();
        const patchJson = parseJsonPayload(patchRaw) as { patches?: ParagraphPatchInput[] };
        assertStageOutput(WRITING_STAGE_IDS.surgicalPatch, patchJson, "surgicalPatch");
        consecutiveErrors = 0;

        const applied = applyParagraphPatches(draftBody, patchJson.patches ?? []);
        const prevScore = currentScore;
        if (applied.appliedCount > 0) {
          draftBody = applied.body;
          if (initial.adoptionPolicy === "working_draft_snapshot") {
            const saved = deps.saveDraft(doc, draftBody);
            workingRevId = saved.revisionId;
            doc = ctx.document(doc.id);
          }
          diag = diagnoseChapterDraft(ctx, doc, draftBody);
          currentScore = diag.qualityV2?.compositeScore ?? diag.goldenThree.overallScore;
          // Clear addressed model review observations if patches were applied
          if (applied.appliedCount > 0 && currentScore >= prevScore) {
            reviewObs = reviewObs.filter((o) => o.severity !== "error" || (o.quote && draftBody.includes(o.quote)));
          }
        }

        recordStep(ctx, {
          batchId: deps.batchId,
          documentId: doc.id,
          chapterTitle: doc.title,
          stepKind: "surgical_refine",
          round: chapterRefineRound,
          status: "completed",
          inputRevisionId: workingRevId,
          outputRevisionId: workingRevId,
          scoreBefore: prevScore,
          scoreAfter: currentScore,
          tokensUsed: patchDelta,
          cacheHitRate: frozen.contextBundle.report.estimatedCacheableRatio ?? null,
          summary: `精修 ${applied.appliedCount} 个段落（原文保留率 ${Math.round(applied.preservedRatio * 100)}%），综合分 ${prevScore} → ${currentScore}。`,
          error: null,
        });
      } catch (err) {
        consecutiveErrors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        recordStep(ctx, {
          batchId: deps.batchId,
          documentId: doc.id,
          chapterTitle: doc.title,
          stepKind: "surgical_refine",
          round: chapterRefineRound,
          status: "failed",
          inputRevisionId: workingRevId,
          outputRevisionId: workingRevId,
          scoreBefore: currentScore,
          scoreAfter: currentScore,
          tokensUsed: trackTokensDelta(),
          cacheHitRate: null,
          summary: `第 ${chapterRefineRound} 轮精修失败`,
          error: msg,
        });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          return pauseForRedLine("consecutive_errors", doc, "连续模型调用失败，已暂停自动写作。", [msg]);
        }
        break;
      }
    }

    // --- Red-Line Circuit Breakers after refinement ---
    if (!overrideCurrentChapter) {
      const povLeaks = diag.qualityV2?.povLeakWarnings ?? [];
      if (povLeaks.length > 0) {
        return pauseForRedLine(
          "pov_leak",
          doc,
          `检测到 ${povLeaks.length} 处视角知情越权疑点，经 ${chapterRefineRound} 轮精修仍未消除，已红线暂停。`,
          povLeaks.map((w) => `P${w.paragraphIndex} 提及「${w.entityName}」(${w.matchedTerm})：${w.excerpt}`),
          povLeaks.map((w) => w.paragraphIndex),
        );
      }
      const remainingHigh = highSeverityReview();
      if (remainingHigh.length > 0) {
        return pauseForRedLine(
          "high_severity_review",
          doc,
          `审稿存在 ${remainingHigh.length} 条高危连贯性/OOC 警报，需作者介入确认。`,
          remainingHigh.map((o) => `[${o.dimension}] ${o.suggestion}`),
        );
      }
      if (currentScore < QUALITY_REDLINE_FLOOR) {
        return pauseForRedLine(
          "quality_below_floor",
          doc,
          `历经 ${chapterRefineRound} 轮外科手术精修后综合分仍为 ${currentScore}（低于红线 ${QUALITY_REDLINE_FLOOR}），已暂停等待人工调优。`,
          [
            `黄金三章/结构分：${diag.goldenThree.overallScore}`,
            `章末钩子分：${diag.qualityV2?.endingHookScore ?? 0}`,
            `AI 味密度：${diag.aiSlop.densityPer1000Chars}/千字`,
          ],
        );
      }
    }
    overrideCurrentChapter = false;

    // Record technique effectiveness telemetry
    if (activeTechniqueIds.length > 0) {
      ctx.atomic(() => {
        recordTechniqueOutcome(ctx, activeTechniqueIds, currentScore - initialScore);
      });
    }

    // --- Step 5: Fact Sync Proposal (staged to proposal inbox, never mutates locked lore) ---
    updateBatchState(ctx, deps.batchId, { currentStep: "fact_sync", tokensSpent, refineRoundsUsed });
    try {
      const syncLayered = buildFanqieLayeredPayload(shared, "factSync", [
        `### 章节记忆增量同步：《${doc.title}》`,
        `### 本章最终工作稿\n${draftBody}`,
      ]);
      const syncRaw = await deps.caller.complete({
        phase: "factSync",
        system: SHARED_WORKBENCH_SYSTEM_KERNEL,
        prompt: syncLayered.dynamicTail,
        layered: syncLayered,
      });
      const syncDelta = trackTokensDelta();
      const syncJson = parseJsonPayload(syncRaw) as Record<string, unknown>;
      assertStageOutput(WRITING_STAGE_IDS.factSync, syncJson, "factSync");

      createManualProposal(ctx, {
        kind: "fact_sync",
        origin: "ai-generate",
        projectId: doc.projectId,
        documentId: doc.id,
        sourceRef: `Autopilot · ${doc.title}`,
        payload: syncJson,
      });

      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "fact_sync",
        round: 1,
        status: "completed",
        inputRevisionId: workingRevId,
        outputRevisionId: workingRevId,
        scoreBefore: currentScore,
        scoreAfter: currentScore,
        tokensUsed: syncDelta,
        cacheHitRate: frozen.contextBundle.report.estimatedCacheableRatio ?? null,
        summary: "记忆增量提案已入列收件箱（等待作者确认，未改动锁定设定）。",
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordStep(ctx, {
        batchId: deps.batchId,
        documentId: doc.id,
        chapterTitle: doc.title,
        stepKind: "fact_sync",
        round: 1,
        status: "failed",
        inputRevisionId: workingRevId,
        outputRevisionId: workingRevId,
        scoreBefore: currentScore,
        scoreAfter: currentScore,
        tokensUsed: trackTokensDelta(),
        cacheHitRate: null,
        summary: "记忆同步提案跳过",
        error: msg,
      });
    }

    // Chapter Gate pause if multi-chapter in chapter_gate mode and more chapters remain
    if (initial.autonomyMode === "chapter_gate" && idx + 1 < initial.chapterIds.length) {
      return pauseForRedLine(
        "chapter_gate_checkpoint",
        doc,
        `《${doc.title}》流水线已完成（综合分 ${currentScore}），按「逐章放行」策略暂停，请审阅后继续下一章。`,
        [`下一章：第 ${idx + 2}/${initial.chapterIds.length} 章`],
        [],
        "paused_gate",
        idx + 1,
      );
    }

    updateBatchState(ctx, deps.batchId, {
      currentChapterIndex: idx + 1,
      tokensSpent,
      refineRoundsUsed,
    });
  }

  updateBatchState(ctx, deps.batchId, {
    status: "completed",
    currentChapterIndex: initial.chapterIds.length,
    currentStep: null,
    tokensSpent,
    refineRoundsUsed,
    pauseReason: null,
  });
  ctx.atomic(() => {
    ctx.event(initial.projectId, "chapter", "autopilot.batch.completed", {
      batchId: deps.batchId,
      chapters: initial.chapterIds.length,
      tokensSpent,
    });
  });

  return getAutopilotBatch(ctx, { batchId: deps.batchId });
}
