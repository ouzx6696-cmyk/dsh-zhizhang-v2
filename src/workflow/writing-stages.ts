import { ContractError } from "../contracts/errors.ts";
import { createStageRegistry, registerStage, type StageRegistry } from "./stages.ts";

export const WRITING_STAGE_IDS = {
  write: "draft.write.candidate",
  qa: "article.qa.review",
  refine: "article.qa.refine",
  deconstructExtract: "novel.deconstruct.extract",
  techniqueExtract: "novel.technique.extract",
  settingExtract: "novel.setting.propose",
  summaryDraft: "novel.summary.draft",
} as const;

export type WritingPhase = keyof typeof WRITING_STAGE_IDS;

const JSON_STAGE_PHASES: ReadonlySet<WritingPhase> = new Set([
  "qa",
  "deconstructExtract",
  "techniqueExtract",
  "settingExtract",
  "summaryDraft",
]);

export function isJsonStagePhase(phase: WritingPhase): boolean {
  return JSON_STAGE_PHASES.has(phase);
}

export interface SingleShotCallRequest {
  readonly phase: WritingPhase;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly cachePrefix?: string;
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
    typeof output.title === "string" &&
    output.title.trim().length > 0 &&
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
    typeof output.title === "string" &&
    output.title.trim().length > 0 &&
    typeof output.executionSteps === "string" &&
    output.executionSteps.trim().length > 0 &&
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
    typeof output.summary === "string" &&
    output.summary.trim().length > 0 &&
    output.summary.length <= 1500
  );
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
