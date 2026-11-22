// Pure, zero-I/O author-tunable context assembly, reading window, and length
// configuration with safe defaults, strict clamping bounds, and default diffing.

import type { ContextTuningConfigDto } from "../../contracts/workspace-dto.ts";

export type ContextTuningConfig = ContextTuningConfigDto;

export interface NumericBound {
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

export const DEFAULT_CONTEXT_TUNING: ContextTuningConfig = {
  // 1. Context lengths & tier budgets
  defaultTokenLimit: 16_000,
  inputBudgetRatio: 0.72,
  l1BudgetTokens: 8_192,
  l1DirtyThreshold: 10,
  l2MilestoneChunkSize: 10,

  // 2. Reading windows & recall
  prevTailChars: 1_200,
  rollingSummaryCount: 9,
  relatedHistoryTopK: 4,
  relatedHistoryRecentExclude: 5,
  antiEchoWindow: 3,
  staleForeshadowGap: 20,

  // 3. Context slot toggles (critical slots outline/activeDraft/instruction stay always-on)
  includeL1BookBible: true,
  includeL2VolumeMilestones: true,
  includePovBoundary: true,
  includeDueForeshadows: true,
  includeAntiEchoGuard: true,
  includeTechniques: true,
  includeDeconstructions: true,
  includeCurrentFocus: true,
  includeRelatedHistory: true,
  includeRollingSummaries: true,
  includePrevTail: true,

  // 4. Library & per-slot truncation caps
  maxActiveTechniques: 3,
  maxActiveDeconstructions: 2,
  techniqueExampleChars: 400,
  deconstructionExcerptChars: 600,
};

export const CONTEXT_TUNING_BOUNDS = {
  defaultTokenLimit: { min: 4_000, max: 128_000, integer: true },
  inputBudgetRatio: { min: 0.5, max: 0.9, integer: false },
  l1BudgetTokens: { min: 1_024, max: 32_768, integer: true },
  l1DirtyThreshold: { min: 1, max: 50, integer: true },
  l2MilestoneChunkSize: { min: 5, max: 30, integer: true },
  prevTailChars: { min: 0, max: 6_000, integer: true },
  rollingSummaryCount: { min: 0, max: 30, integer: true },
  relatedHistoryTopK: { min: 0, max: 12, integer: true },
  relatedHistoryRecentExclude: { min: 1, max: 20, integer: true },
  antiEchoWindow: { min: 0, max: 10, integer: true },
  staleForeshadowGap: { min: 5, max: 100, integer: true },
  maxActiveTechniques: { min: 0, max: 10, integer: true },
  maxActiveDeconstructions: { min: 0, max: 6, integer: true },
  techniqueExampleChars: { min: 100, max: 1_200, integer: true },
  deconstructionExcerptChars: { min: 150, max: 2_000, integer: true },
} as const satisfies Record<string, NumericBound>;

type NumericTuningKey = keyof typeof CONTEXT_TUNING_BOUNDS;
type BooleanTuningKey = Exclude<keyof ContextTuningConfig, NumericTuningKey>;

const BOOLEAN_KEYS: readonly BooleanTuningKey[] = [
  "includeL1BookBible",
  "includeL2VolumeMilestones",
  "includePovBoundary",
  "includeDueForeshadows",
  "includeAntiEchoGuard",
  "includeTechniques",
  "includeDeconstructions",
  "includeCurrentFocus",
  "includeRelatedHistory",
  "includeRollingSummaries",
  "includePrevTail",
];

function clampNumber(raw: unknown, fallback: number, bound: NumericBound): number {
  const num = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.min(bound.max, Math.max(bound.min, num));
  return bound.integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  return fallback;
}

/**
 * Parses and clamps any partial or persisted context tuning object into a full,
 * safe `ContextTuningConfig` with defaults filled for omitted/invalid keys.
 */
export function normalizeContextTuning(
  raw: unknown,
  base: ContextTuningConfig = DEFAULT_CONTEXT_TUNING,
): ContextTuningConfig {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      obj = {};
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }

  const out: Record<string, number | boolean> = {};
  for (const [key, bound] of Object.entries(CONTEXT_TUNING_BOUNDS) as [NumericTuningKey, NumericBound][]) {
    out[key] = clampNumber(obj[key], base[key], bound);
  }
  for (const key of BOOLEAN_KEYS) {
    out[key] = readBool(obj[key], base[key]);
  }
  return out as unknown as ContextTuningConfig;
}

/** Counts how many tunable context parameters currently diverge from defaults. */
export function countCustomizedContextFields(config: ContextTuningConfig): number {
  let count = 0;
  for (const key of Object.keys(DEFAULT_CONTEXT_TUNING) as (keyof ContextTuningConfig)[]) {
    if (config[key] !== DEFAULT_CONTEXT_TUNING[key]) count += 1;
  }
  return count;
}

/** Returns true iff all tunable context settings match `DEFAULT_CONTEXT_TUNING`. */
export function isDefaultContextTuning(config: ContextTuningConfig): boolean {
  return countCustomizedContextFields(config) === 0;
}
