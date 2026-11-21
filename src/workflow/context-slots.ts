import type {
  ContextAssemblyReportDto,
  ContextSlotPriority,
  ContextSlotReportDto,
} from "../contracts/workspace-dto.ts";
import { estimateTokenCount } from "./writing-budget.ts";

export interface ContextSlotInput {
  readonly id: string;
  readonly label: string;
  readonly group: "prefix" | "dynamic";
  readonly tier?: "l1" | "l2" | "l3";
  readonly priority: ContextSlotPriority;
  readonly content: string;
  /** Maximum fraction of the group's budget this non-critical slot may occupy. */
  readonly maxShare?: number;
  /** Keep start ("tail" trims end) or keep end ("head" trims start, ideal for prev chapter ending). */
  readonly trimMode?: "tail" | "head";
}

export interface AssembledContextResult {
  readonly stablePrefix: string;
  readonly dynamicTail: string;
  readonly promptText: string;
  readonly report: ContextAssemblyReportDto;
}

const PRIORITY_DROP_ORDER: readonly ContextSlotPriority[] = ["optional", "medium", "high"];
const DEFAULT_PREFIX_BUDGET_RATIO = 0.45;

function truncateTextToTokenBudget(
  text: string,
  targetTokens: number,
  mode: "tail" | "head",
  estimateTokens: (value: string) => number,
): string {
  if (targetTokens <= 0 || !text) return "";
  if (estimateTokens(text) <= targetTokens) return text;
  const marker = "\n…[已按上下文配额裁剪]…\n";
  const markerCost = estimateTokens(marker);
  const usableTokens = Math.max(8, targetTokens - markerCost);

  // Binary search character boundary so CJK/ASCII mixed strings stay exact.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const slice = mode === "head" ? text.slice(text.length - mid) : text.slice(0, mid);
    if (estimateTokens(slice) <= usableTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (lo <= 0) return "";
  if (mode === "head") {
    const sliced = text.slice(text.length - lo);
    const newlinePos = sliced.indexOf("\n");
    const aligned = newlinePos > 0 && newlinePos < sliced.length * 0.35 ? sliced.slice(newlinePos + 1) : sliced;
    return `…[前略]\n${aligned}`;
  }
  const sliced = text.slice(0, lo);
  const lastNewline = sliced.lastIndexOf("\n");
  const aligned = lastNewline > sliced.length * 0.65 ? sliced.slice(0, lastNewline) : sliced;
  return `${aligned}\n…[后略]`;
}

/**
 * Pure deterministic context assembler that partitions slots into a
 * prefix-cache-friendly stable header (`prefix`) and per-chapter `dynamic`
 * tail (FQ-04):
 *
 * - `prefixBudget = f(maxInputTokens)` depends ONLY on `maxInputTokens` (never
 *   on dynamic slot content or count), so `stablePrefix` is mathematically
 *   byte-for-byte invariant across different chapter bodies, instructions, or
 *   dynamic slot lengths.
 * - Phase 2 priority trimming operates EXCLUSIVELY on `dynamic` slots against
 *   `dynamicBudget`; if `prefix` exceeds `prefixBudget`, `overBudget` is
 *   reported without silently truncating Prefix slots.
 */
export function assembleContextBundle(params: {
  readonly slots: readonly ContextSlotInput[];
  readonly maxInputTokens: number;
  readonly prefixBudget?: number;
  readonly prefixBudgetRatio?: number;
  readonly activeTechniqueIds?: readonly string[];
  readonly activeDeconstructionIds?: readonly string[];
  readonly estimateTokens?: (text: string) => number;
}): AssembledContextResult {
  const estimateTokens = params.estimateTokens ?? estimateTokenCount;
  const maxInputTokens = Math.max(256, Math.floor(params.maxInputTokens));
  const joinTokens = estimateTokens("\n\n");
  const groupSepTokens = estimateTokens("\n\n---\n\n");

  const prefixRatio =
    typeof params.prefixBudgetRatio === "number" &&
    Number.isFinite(params.prefixBudgetRatio) &&
    params.prefixBudgetRatio > 0.05 &&
    params.prefixBudgetRatio < 0.95
      ? params.prefixBudgetRatio
      : DEFAULT_PREFIX_BUDGET_RATIO;
  const prefixBudget =
    typeof params.prefixBudget === "number" && Number.isFinite(params.prefixBudget) && params.prefixBudget > 0
      ? Math.min(maxInputTokens, Math.floor(params.prefixBudget))
      : Math.max(128, Math.floor(maxInputTokens * prefixRatio));

  const states = params.slots.map((slot) => {
    const rawContent = slot.content.trim();
    const rawTokens = rawContent ? estimateTokens(rawContent) : 0;
    const headerTokens = estimateTokens(`### ${slot.label}\n`);
    return {
      slot,
      rawTokens,
      headerTokens,
      text: rawContent,
      includedTokens: rawTokens,
      status: (rawContent ? "included" : "empty") as ContextSlotReportDto["status"],
    };
  });

  const prefixStates = states.filter((item) => item.slot.group === "prefix");
  const dynamicStates = states.filter((item) => item.slot.group === "dynamic");

  // 1A. Process Prefix slots strictly against `prefixBudget` (zero dependence on dynamic slots!).
  const nonEmptyPrefix = prefixStates.filter((item) => item.status !== "empty");
  const prefixFraming =
    nonEmptyPrefix.reduce((sum, item) => sum + item.headerTokens, 0) +
    Math.max(0, nonEmptyPrefix.length - 1) * joinTokens;
  const availableForPrefixShares = Math.max(64, prefixBudget - Math.min(prefixBudget - 64, prefixFraming));

  for (const item of prefixStates) {
    if (item.status === "empty" || item.slot.priority === "critical" || !item.slot.maxShare) continue;
    const capTokens = Math.max(64, Math.floor(availableForPrefixShares * item.slot.maxShare));
    if (item.includedTokens > capTokens) {
      const nextText = truncateTextToTokenBudget(
        item.text,
        capTokens,
        item.slot.trimMode ?? "tail",
        estimateTokens,
      );
      item.text = nextText;
      item.includedTokens = nextText ? estimateTokens(nextText) : 0;
      item.status = item.includedTokens > 0 ? "truncated" : "dropped";
    }
  }

  let actualPrefixTotal = 0;
  let actualPrefixCount = 0;
  for (const item of prefixStates) {
    if (item.includedTokens <= 0) continue;
    actualPrefixTotal += item.headerTokens + item.includedTokens;
    if (actualPrefixCount > 0) actualPrefixTotal += joinTokens;
    actualPrefixCount += 1;
  }

  // 1B. Compute remaining dynamicBudget and apply soft share caps on dynamic slots.
  const separatorCost = actualPrefixCount > 0 ? groupSepTokens : 0;
  const dynamicBudget = Math.max(64, maxInputTokens - actualPrefixTotal - separatorCost);

  const nonEmptyDynamic = dynamicStates.filter((item) => item.status !== "empty");
  const dynamicFraming =
    nonEmptyDynamic.reduce((sum, item) => sum + item.headerTokens, 0) +
    Math.max(0, nonEmptyDynamic.length - 1) * joinTokens;
  const availableForDynamicShares = Math.max(64, dynamicBudget - Math.min(dynamicBudget - 64, dynamicFraming));

  for (const item of dynamicStates) {
    if (item.status === "empty" || item.slot.priority === "critical" || !item.slot.maxShare) continue;
    const capTokens = Math.max(64, Math.floor(availableForDynamicShares * item.slot.maxShare));
    if (item.includedTokens > capTokens) {
      const nextText = truncateTextToTokenBudget(
        item.text,
        capTokens,
        item.slot.trimMode ?? "tail",
        estimateTokens,
      );
      item.text = nextText;
      item.includedTokens = nextText ? estimateTokens(nextText) : 0;
      item.status = item.includedTokens > 0 ? "truncated" : "dropped";
    }
  }

  const currentDynamicTotal = () => {
    let dynamicCount = 0;
    let total = 0;
    for (const item of dynamicStates) {
      if (item.includedTokens <= 0) continue;
      total += item.headerTokens + item.includedTokens;
      if (dynamicCount > 0) total += joinTokens;
      dynamicCount += 1;
    }
    return total;
  };

  // 2. Iteratively trim or drop ONLY dynamic lower-priority slots to fit dynamicBudget.
  //    Prefix slots are NEVER truncated or dropped by dynamic tail pressure (FQ-04).
  for (const tier of PRIORITY_DROP_ORDER) {
    if (currentDynamicTotal() <= dynamicBudget) break;
    const candidates = dynamicStates.filter((item) => item.slot.priority === tier && item.includedTokens > 0).reverse();
    for (const item of candidates) {
      const excess = currentDynamicTotal() - dynamicBudget;
      if (excess <= 0) break;
      const target = item.includedTokens - excess;
      if (target < 48) {
        item.text = "";
        item.includedTokens = 0;
        item.status = "dropped";
      } else {
        const nextText = truncateTextToTokenBudget(
          item.text,
          target,
          item.slot.trimMode ?? "tail",
          estimateTokens,
        );
        item.text = nextText;
        item.includedTokens = nextText ? estimateTokens(nextText) : 0;
        item.status = item.includedTokens > 0 ? "truncated" : "dropped";
      }
    }
  }

  const prefixParts: string[] = [];
  const dynamicParts: string[] = [];
  let sumIncludedSlotTokens = 0;

  for (const item of states) {
    if (!item.text) continue;
    sumIncludedSlotTokens += item.includedTokens;
    const block = `### ${item.slot.label}\n${item.text}`;
    if (item.slot.group === "prefix") {
      prefixParts.push(block);
    } else {
      dynamicParts.push(block);
    }
  }

  const stablePrefix = prefixParts.join("\n\n");
  const dynamicTail = dynamicParts.join("\n\n");
  const promptText = [stablePrefix, dynamicTail].filter(Boolean).join("\n\n---\n\n");
  const prefixTokens = stablePrefix ? estimateTokens(stablePrefix) : 0;
  const dynamicTokens = dynamicTail ? estimateTokens(dynamicTail) : 0;
  const totalEstimatedTokens = promptText ? estimateTokens(promptText) : 0;
  const framingTokens = Math.max(0, totalEstimatedTokens - sumIncludedSlotTokens);
  const overBudget = prefixTokens > prefixBudget || totalEstimatedTokens > maxInputTokens;

  const slotReports: ContextSlotReportDto[] = states.map((item) => ({
    id: item.slot.id,
    label: item.slot.label,
    group: item.slot.group,
    ...(item.slot.tier ? { tier: item.slot.tier } : {}),
    priority: item.slot.priority,
    rawTokens: item.rawTokens,
    includedTokens: item.includedTokens,
    status: item.status,
  }));

  const l1Tokens = states
    .filter((item) => (item.slot.tier ?? (item.slot.group === "prefix" ? "l1" : "l3")) === "l1")
    .reduce((sum, item) => sum + item.includedTokens, 0);
  const l2Tokens = states
    .filter((item) => item.slot.tier === "l2")
    .reduce((sum, item) => sum + item.includedTokens, 0);
  const l3Tokens = states
    .filter((item) => (item.slot.tier ?? (item.slot.group === "prefix" ? "l1" : "l3")) === "l3")
    .reduce((sum, item) => sum + item.includedTokens, 0);
  const estimatedCacheableRatio = totalEstimatedTokens > 0
    ? Math.round((prefixTokens / totalEstimatedTokens) * 1000) / 1000
    : 0;

  return {
    stablePrefix,
    dynamicTail,
    promptText,
    report: {
      maxInputTokens,
      totalEstimatedTokens,
      prefixTokens,
      dynamicTokens,
      prefixBudget,
      dynamicBudget,
      framingTokens,
      overBudget,
      l1Tokens,
      l2Tokens,
      l3Tokens,
      estimatedCacheableRatio,
      slots: slotReports,
      activeTechniqueIds: params.activeTechniqueIds ?? [],
      activeDeconstructionIds: params.activeDeconstructionIds ?? [],
    },
  };
}
