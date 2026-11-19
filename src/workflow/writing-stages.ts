import { ContractError } from "../contracts/errors.ts";
import { createStageRegistry, registerStage, type StageRegistry } from "./stages.ts";

export const WRITING_STAGE_IDS = {
  write: "draft.write.candidate",
  qa: "article.qa.review",
  refine: "article.qa.refine",
} as const;

export type WritingPhase = keyof typeof WRITING_STAGE_IDS;

export const MAX_CANDIDATE_LENGTH = 1_000_000;

function isValidCandidateText(output: unknown): boolean {
  return typeof output === "string" && output.trim().length > 0 && output.length <= MAX_CANDIDATE_LENGTH;
}

function isValidQaPayload(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  return (
    typeof record.overall === "number" &&
    Number.isSafeInteger(record.overall) &&
    record.overall >= 0 &&
    record.overall <= 100 &&
    typeof record.passed === "boolean" &&
    Array.isArray(record.fails) &&
    record.fails.every((item) => typeof item === "string") &&
    Array.isArray(record.hardGates) &&
    record.hardGates.every((item) => typeof item === "string")
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
