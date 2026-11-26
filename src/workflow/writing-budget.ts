import type { RunBillingSummaryDto } from "../contracts/workspace-dto.ts";
import {
  createBudgetGuard,
  normalizeActualUsage,
  normalizeUsage,
  normalizeUsageToTuple,
  totalTokens,
  type ActualUsage,
  type BudgetGuard,
  type NormalizeUsageOptions,
  type RawLlmUsage,
  type TokenUsage,
} from "./budget.ts";

export {
  WRITER_SYSTEM,
  QA_SYSTEM,
  DECONSTRUCT_EXTRACT_SYSTEM,
  TECHNIQUE_EXTRACT_SYSTEM,
  SETTING_EXTRACT_SYSTEM,
  SUMMARY_DRAFT_SYSTEM,
  FACT_SYNC_SYSTEM,
  CHAPTER_REVIEW_SYSTEM,
  ARC_PLAN_SYSTEM,
  SELECTION_REWRITE_SYSTEM,
} from "./prompts/index.ts";

export {
  normalizeUsage,
  normalizeUsageToTuple,
  normalizeActualUsage,
  type RawLlmUsage,
  type NormalizeUsageOptions,
  type TokenUsage,
};

export const DEFAULT_MIN_RECOMMENDED_BUDGET = 8000;
export const DEFAULT_MAX_STAGE_INPUT_TOKENS = 64_000;

/**
 * Per-provider conservative calibration multipliers (FQ-29 / Res#16).
 * DeepSeek tokenizers encode CJK significantly more densely than our
 * 1.4 tokens/char baseline; other providers stay at conservative 1.0 until
 * empirically calibrated from real receipts.
 */
export const DEFAULT_PROVIDER_TOKEN_MULTIPLIERS: Readonly<Record<string, number>> = {
  deepseek: 0.55,
};

export const MIN_TOKEN_CALIBRATION_MULTIPLIER = 0.35;
export const MAX_TOKEN_CALIBRATION_MULTIPLIER = 1.5;
export const TOKEN_CALIBRATION_SAFETY_MARGIN = 1.15;

function clampMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 1;
  return Math.max(MIN_TOKEN_CALIBRATION_MULTIPLIER, Math.min(2.0, multiplier));
}

/**
 * Resolves the effective token estimation multiplier for a `(provider, model)`
 * pair from persisted project calibration data or provider defaults (FQ-29).
 */
export function resolveTokenMultiplier(
  provider?: string | null,
  model?: string | null,
  calibrationMap?: Readonly<Record<string, number>> | null,
): number {
  const normProvider = (provider ?? "").trim().toLowerCase();
  const normModel = (model ?? "").trim().toLowerCase();
  if (calibrationMap) {
    const exactKey = normProvider && normModel ? `${normProvider}:${normModel}` : "";
    if (exactKey && typeof calibrationMap[exactKey] === "number" && calibrationMap[exactKey] > 0) {
      return clampMultiplier(calibrationMap[exactKey]);
    }
    if (normProvider && typeof calibrationMap[normProvider] === "number" && calibrationMap[normProvider] > 0) {
      return clampMultiplier(calibrationMap[normProvider]);
    }
  }
  for (const [prefix, factor] of Object.entries(DEFAULT_PROVIDER_TOKEN_MULTIPLIERS)) {
    if (normProvider.includes(prefix) || normModel.includes(prefix)) {
      return factor;
    }
  }
  return 1;
}

/**
 * Updates per-provider/model exponential moving average calibration ratio from
 * real prompt receipts (`actualInput / estimatedInput`) with a 0.35 floor and
 * 15% safety margin (FQ-29).
 */
export function updateTokenCalibration(
  previous: Readonly<Record<string, number>>,
  key: string,
  actualInput: number,
  estimatedInput: number,
  alpha = 0.3,
): Record<string, number> {
  const next: Record<string, number> = { ...previous };
  const cleanKey = key.trim().toLowerCase();
  if (!cleanKey || !Number.isFinite(actualInput) || actualInput <= 0 || !Number.isFinite(estimatedInput) || estimatedInput <= 0) {
    return next;
  }
  const observed = Math.max(
    MIN_TOKEN_CALIBRATION_MULTIPLIER,
    Math.min(MAX_TOKEN_CALIBRATION_MULTIPLIER, (actualInput / estimatedInput) * TOKEN_CALIBRATION_SAFETY_MARGIN),
  );
  const prior = next[cleanKey];
  const blended = typeof prior === "number" && Number.isFinite(prior) && prior > 0
    ? prior * (1 - alpha) + observed * alpha
    : observed;
  next[cleanKey] = Math.round(
    Math.max(MIN_TOKEN_CALIBRATION_MULTIPLIER, Math.min(MAX_TOKEN_CALIBRATION_MULTIPLIER, blended)) * 1000,
  ) / 1000;
  return next;
}

/**
 * Calibrated CJK/ASCII token estimator that protects Chinese manuscripts
 * against under-reservation without the ~2.3x over-inflation of raw UTF-8 bytes.
 * Supports an optional provider calibration `multiplier` (FQ-29; default `1`).
 */
export function estimateTokenCount(text: string, multiplier = 1): number {
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x7f) {
      total += 0.4;
    } else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      total += 1.4;
    } else {
      total += 1.8;
    }
  }
  const factor = multiplier === 1 ? 1 : clampMultiplier(multiplier);
  return Math.ceil(total * factor);
}

/**
 * Calibrated conservative input reservation accounting for CJK density and
 * fixed protocol framing overhead.
 */
export function estimateWritingInput(system: string, prompt: string, multiplier = 1): number {
  return estimateTokenCount(system, multiplier) + estimateTokenCount(prompt, multiplier) + 128;
}

/**
 * Suggests a rounded total run token budget that covers the initial write
 * input, output headroom, and room for follow-up QA/refinement.
 */
export function recommendedTokenBudget(inputReserve: number): number {
  return Math.max(DEFAULT_MIN_RECOMMENDED_BUDGET, Math.ceil((inputReserve * 2 + 2400) / 1000) * 1000);
}

/**
 * Converts a 4-tuple `[input, output, cache_read, cache_write]` into the
 * frozen `ActualUsage` record (cost stays unknown unless priced by host).
 */
export function usageTupleToActual(counts: readonly number[]): ActualUsage {
  return {
    input: counts[0] ?? 0,
    output: counts[1] ?? 0,
    cache_read: counts[2] ?? 0,
    cache_write: counts[3] ?? 0,
    cost: null,
  };
}

/**
 * Sums a 4-tuple usage record through the frozen `totalTokens` helper.
 */
export function sumUsageTuple(counts: readonly number[]): number {
  return totalTokens(usageTupleToActual(counts));
}

export interface ComputeRunBillingOptions {
  /**
   * When `true` (DB-01 normalized mode), tuples are strictly mutually exclusive
   * `[uncachedInput, output, cacheRead, cacheWrite]` so `effectiveBilledTokens`
   * equals `input + output` and `cacheHitRate` equals `cacheRead / (input + cacheRead)`.
   * When omitted/false, preserves backward-compatible inference for legacy raw tuples.
   */
  readonly normalized?: boolean;
}

/**
 * Summarizes 4-category token usage across generation calls into effective
 * billed tokens and prompt cache hit rate without assuming unknown cache=0.
 */
export function computeRunBilling(
  usageTuples: readonly (readonly number[] | null)[],
  options: ComputeRunBillingOptions = {},
): RunBillingSummaryDto {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let effectiveBilledTokens = 0;
  let validCalls = 0;
  const normalized = options.normalized === true;

  for (const tuple of usageTuples) {
    if (!tuple || tuple.length < 2) continue;
    const input = Math.max(0, Number(tuple[0] ?? 0));
    const output = Math.max(0, Number(tuple[1] ?? 0));
    const cacheRead = Math.max(0, Number(tuple[2] ?? 0));
    const cacheWrite = Math.max(0, Number(tuple[3] ?? 0));
    totalInput += input;
    totalOutput += output;
    totalCacheRead += cacheRead;
    totalCacheWrite += cacheWrite;
    if (normalized) {
      effectiveBilledTokens += input + output;
    } else {
      effectiveBilledTokens += (cacheRead <= input ? input - cacheRead : input) + output;
    }
    validCalls += 1;
  }

  if (validCalls === 0) {
    return {
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      effectiveBilledTokens: null,
      cacheHitRate: null,
    };
  }

  let cacheHitRate: number | null;
  if (normalized) {
    const totalPrompt = totalInput + totalCacheRead;
    cacheHitRate = totalPrompt > 0 ? totalCacheRead / totalPrompt : null;
  } else {
    cacheHitRate = totalInput > 0
      ? (totalCacheRead <= totalInput ? totalCacheRead / totalInput : totalCacheRead / (totalInput + totalCacheRead))
      : null;
  }

  return {
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    effectiveBilledTokens,
    cacheHitRate,
  };
}

/** Optional cumulative budget summary across runs, proposals, and micro-calls (DB-26 / Res#11). */
export interface CumulativeBudgetSummary {
  readonly runTokens: number;
  readonly proposalTokens: number;
  readonly microCallTokens: number;
  readonly totalTokens: number;
  readonly softLimit: number | null;
  readonly softLimitExceeded: boolean;
}

export function summarizeCumulativeUsage(input: {
  readonly runTokens: number;
  readonly proposalTokens: number;
  readonly microCallTokens: number;
  readonly softLimit?: number | null;
}): CumulativeBudgetSummary {
  const runTokens = Math.max(0, Math.floor(input.runTokens));
  const proposalTokens = Math.max(0, Math.floor(input.proposalTokens));
  const microCallTokens = Math.max(0, Math.floor(input.microCallTokens));
  const total = runTokens + proposalTokens + microCallTokens;
  const softLimit = typeof input.softLimit === "number" && input.softLimit > 0 ? Math.floor(input.softLimit) : null;
  return {
    runTokens,
    proposalTokens,
    microCallTokens,
    totalTokens: total,
    softLimit,
    softLimitExceeded: softLimit !== null && total >= softLimit,
  };
}

/**
 * Creates a frozen `BudgetGuard` configured for one writing run with an
 * independent single-stage input budget guard.
 */
export function createWritingBudgetGuard(
  runBudget: number,
  initialSettled = 0,
  inputBudget?: number,
): BudgetGuard {
  const initial: ActualUsage | undefined = initialSettled > 0
    ? { input: initialSettled, output: 0, cache_read: 0, cache_write: 0, cost: null }
    : undefined;
  const resolvedInputBudget = inputBudget !== undefined
    ? inputBudget
    : Math.min(runBudget, DEFAULT_MAX_STAGE_INPUT_TOKENS);
  return createBudgetGuard({ inputBudget: resolvedInputBudget, runBudget }, initial);
}
