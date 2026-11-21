import { ContractError } from "../contracts/errors.ts";
import type { LayeredPromptPayload } from "./cache-layer.ts";
import { createStageRegistry, registerStage, type StageRegistry } from "./stages.ts";

export const WRITING_STAGE_IDS = {
  write: "draft.write.candidate",
  qa: "article.qa.review",
  refine: "article.qa.refine",
  deconstructExtract: "novel.deconstruct.extract",
  techniqueExtract: "novel.technique.extract",
  settingExtract: "novel.setting.propose",
  summaryDraft: "novel.summary.draft",
  factSync: "novel.memory.sync",
  chapterReview: "novel.chapter.review",
  arcPlan: "novel.arc.plan",
  selectionRewrite: "draft.selection.rewrite",
} as const;

export type WritingPhase = keyof typeof WRITING_STAGE_IDS;

const JSON_STAGE_PHASES: ReadonlySet<WritingPhase> = new Set([
  "qa",
  "deconstructExtract",
  "techniqueExtract",
  "settingExtract",
  "summaryDraft",
  "factSync",
  "chapterReview",
  "arcPlan",
]);

export function isJsonStagePhase(phase: WritingPhase): boolean {
  return JSON_STAGE_PHASES.has(phase);
}

export interface SingleShotCallRequest {
  readonly phase: WritingPhase;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly layered?: LayeredPromptPayload;
  /** @deprecated Superseded by `layered` 4-tier prefix structure; never emitted on the wire. */
  readonly cachePrefix?: string;
  readonly disableThinking?: boolean;
}

export interface SingleShotLlmCaller {
  complete(request: SingleShotCallRequest): Promise<string>;
  usedTokens(): number;
}

export const MAX_CANDIDATE_LENGTH = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidCandidateText(output: unknown): boolean {
  return typeof output === "string" && output.trim().length > 0 && output.length <= MAX_CANDIDATE_LENGTH;
}

function isValidQaPayload(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return (
    typeof output.overall === "number" &&
    Number.isSafeInteger(output.overall) &&
    output.overall >= 0 &&
    output.overall <= 100 &&
    typeof output.passed === "boolean" &&
    isStringArray(output.fails) &&
    isStringArray(output.hardGates)
  );
}

function isValidDeconstructPayload(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return (
    isNonEmptyString(output.title) &&
    typeof output.hookAnalysis === "string" &&
    typeof output.conflictBeats === "string" &&
    typeof output.payoffRhythm === "string" &&
    typeof output.proseNotes === "string" &&
    (output.tags === undefined || isStringArray(output.tags))
  );
}

function isValidTechniquePayload(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return (
    isNonEmptyString(output.title) &&
    isNonEmptyString(output.executionSteps) &&
    (output.sceneTags === undefined || isStringArray(output.sceneTags))
  );
}

function isValidSettingExtractPayload(output: unknown): boolean {
  if (!isRecord(output)) return false;
  const settingsOk = output.settings === undefined || (Array.isArray(output.settings) && output.settings.every(isRecord));
  const foreshadowsOk =
    output.foreshadows === undefined || (Array.isArray(output.foreshadows) && output.foreshadows.every(isRecord));
  return settingsOk && foreshadowsOk && (Array.isArray(output.settings) || Array.isArray(output.foreshadows));
}

function isValidSummaryDraftPayload(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return (
    isNonEmptyString(output.summary) &&
    output.summary.length <= 1500
  );
}

/**
 * Validates V2.3 continuity memory-sync payloads (FQ-10 & FQ-20):
 * - `newFacts` (optional `factId`, optional `aliases` string array);
 * - `updates` (requires non-empty `factId` referencing existing lore);
 * - `retiredFacts` (requires non-empty `factId` and `reason`, optional positive integer `point`);
 * - `knownFromUpdates`, `foreshadowUpdates`, `summaryDraft`.
 */
export function isValidFactSyncPayload(output: unknown): boolean {
  if (!isRecord(output)) return false;
  const hasAny =
    output.newFacts !== undefined ||
    output.updates !== undefined ||
    output.retiredFacts !== undefined ||
    output.knownFromUpdates !== undefined ||
    output.foreshadowUpdates !== undefined ||
    output.summaryDraft !== undefined;
  if (!hasAny) return false;

  if (
    output.newFacts !== undefined &&
    !(
      Array.isArray(output.newFacts) &&
      output.newFacts.every(
        (item) =>
          isRecord(item) &&
          (item.aliases === undefined || isStringArray(item.aliases)),
      )
    )
  ) {
    return false;
  }

  if (
    output.updates !== undefined &&
    !(
      Array.isArray(output.updates) &&
      output.updates.every(
        (item) =>
          isRecord(item) &&
          isNonEmptyString(item.factId) &&
          (item.aliases === undefined || isStringArray(item.aliases)),
      )
    )
  ) {
    return false;
  }

  if (
    output.retiredFacts !== undefined &&
    !(
      Array.isArray(output.retiredFacts) &&
      output.retiredFacts.every(
        (item) =>
          isRecord(item) &&
          isNonEmptyString(item.factId) &&
          typeof item.reason === "string" &&
          (item.point === undefined || (typeof item.point === "number" && Number.isSafeInteger(item.point) && item.point >= 1)),
      )
    )
  ) {
    return false;
  }

  if (
    output.knownFromUpdates !== undefined &&
    !(
      Array.isArray(output.knownFromUpdates) &&
      output.knownFromUpdates.every(
        (item) =>
          isRecord(item) &&
          isNonEmptyString(item.factId) &&
          isNonEmptyString(item.character),
      )
    )
  ) {
    return false;
  }

  if (
    output.foreshadowUpdates !== undefined &&
    !(
      Array.isArray(output.foreshadowUpdates) &&
      output.foreshadowUpdates.every(
        (item) =>
          isRecord(item) &&
          (isNonEmptyString(item.title) || isNonEmptyString(item.id)),
      )
    )
  ) {
    return false;
  }

  if (
    output.summaryDraft !== undefined &&
    (typeof output.summaryDraft !== "string" || output.summaryDraft.length > 1500)
  ) {
    return false;
  }

  return true;
}

const VALID_OBSERVATION_DIMENSIONS: ReadonlySet<string> = new Set([
  "continuity",
  "ooc",
  "pacing",
  "foreshadow",
  "style",
  "ai_slop",
]);

function isValidChapterReviewPayload(output: unknown): boolean {
  if (!isRecord(output) || !Array.isArray(output.observations)) return false;
  return output.observations.every(
    (item) =>
      isRecord(item) &&
      typeof item.dimension === "string" &&
      VALID_OBSERVATION_DIMENSIONS.has(item.dimension) &&
      typeof item.quote === "string" &&
      typeof item.suggestion === "string" &&
      item.suggestion.trim().length > 0,
  );
}

const ARC_PLAN_TEXT_KEYS = [
  "actSummary",
  "nextActTitle",
  "nextActGoal",
  "nextActSummary",
  "pacingTemplate",
  "currentFocus",
] as const;

/** Validates V2.3 rolling arc-plan payloads (FQ-23). */
export function isValidArcPlanPayload(output: unknown): boolean {
  if (!isRecord(output)) return false;
  for (const key of ARC_PLAN_TEXT_KEYS) {
    if (output[key] !== undefined && typeof output[key] !== "string") {
      return false;
    }
  }
  const hasTextField = ARC_PLAN_TEXT_KEYS.some((k) => isNonEmptyString(output[k]));
  const hasBeats =
    Array.isArray(output.chapterBeats) &&
    output.chapterBeats.length > 0 &&
    output.chapterBeats.every((b) => isRecord(b) && isNonEmptyString(b.title));
  return hasTextField || hasBeats;
}

/**
 * Creates a StageRegistry pre-populated with the author-workbench model stages.
 * Every stage id satisfies the frozen `domain.entity.action@version` contract
 * and enforces an executable output validator.
 */
export function createWritingStageRegistry(): StageRegistry {
  const registry = createStageRegistry();
  registerStage(registry, {
    id: WRITING_STAGE_IDS.write,
    version: 1,
    execution: "model",
    validateOutput: isValidCandidateText,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.qa,
    version: 1,
    execution: "model",
    validateOutput: isValidQaPayload,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.refine,
    version: 1,
    execution: "model",
    validateOutput: isValidCandidateText,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.deconstructExtract,
    version: 1,
    execution: "model",
    validateOutput: isValidDeconstructPayload,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.techniqueExtract,
    version: 1,
    execution: "model",
    validateOutput: isValidTechniquePayload,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.settingExtract,
    version: 1,
    execution: "model",
    validateOutput: isValidSettingExtractPayload,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.summaryDraft,
    version: 1,
    execution: "model",
    validateOutput: isValidSummaryDraftPayload,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.factSync,
    version: 1,
    execution: "model",
    validateOutput: isValidFactSyncPayload,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.chapterReview,
    version: 1,
    execution: "model",
    validateOutput: isValidChapterReviewPayload,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.arcPlan,
    version: 1,
    execution: "model",
    validateOutput: isValidArcPlanPayload,
  });
  registerStage(registry, {
    id: WRITING_STAGE_IDS.selectionRewrite,
    version: 1,
    execution: "model",
    validateOutput: isValidCandidateText,
  });
  return registry;
}

export const WRITING_STAGES: StageRegistry = createWritingStageRegistry();

/**
 * Validates model stage output against the registered StageDefinition,
 * raising the frozen `stage.output_invalid` contract error on mismatch.
 */
export function assertStageOutput(
  stageId: string,
  output: unknown,
  missing: string,
  version = 1,
): void {
  const definition = WRITING_STAGES.get(stageId, version);
  if (!definition || !definition.validateOutput(output)) {
    throw new ContractError("stage.output_invalid", { stage: stageId, missing });
  }
}
