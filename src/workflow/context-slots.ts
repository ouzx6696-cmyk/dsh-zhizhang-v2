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
  readonly priority: ContextSlotPriority;
  readonly content: string;
  /** Maximum fraction of `maxInputTokens` this non-critical slot may occupy. */
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
 * tail, enforcing priority-based budget trimming without altering critical text.
 */
export function assembleContextBundle(params: {
  readonly slots: readonly ContextSlotInput[];
  readonly maxInputTokens: number;
  readonly activeTechniqueIds?: readonly string[];
  readonly activeDeconstructionIds?: readonly string[];
  readonly estimateTokens?: (text: string) => number;
}): AssembledContextResult {
  const estimateTokens = params.estimateTokens ?? estimateTokenCount;
  const maxInputTokens = Math.max(256, Math.floor(params.maxInputTokens));
  const framingOverhead = 32;
  const availableBudget = Math.max(64, maxInputTokens - framingOverhead);

  const states = params.slots.map((slot) => {
    const rawContent = slot.content.trim();
    const rawTokens = rawContent ? estimateTokens(rawContent) : 0;
    return {
      slot,
      rawTokens,
      text: rawContent,
      includedTokens: rawTokens,
      status: (rawContent ? "included" : "empty") as ContextSlotReportDto["status"],
    };
  });

  // 1. Apply soft per-slot share caps on non-critical slots first.
  for (const item of states) {
    if (item.status === "empty" || item.slot.priority === "critical" || !item.slot.maxShare) continue;
    const capTokens = Math.max(64, Math.floor(availableBudget * item.slot.maxShare));
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

  const currentTotal = () => states.reduce((sum, item) => sum + item.includedTokens, 0);

  // 2. Iteratively trim or drop lower-priority slots until within budget.
  for (const tier of PRIORITY_DROP_ORDER) {
    if (currentTotal() <= availableBudget) break;
    const candidates = states.filter((item) => item.slot.priority === tier && item.includedTokens > 0).reverse();
    for (const item of candidates) {
      const excess = currentTotal() - availableBudget;
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
  let prefixTokens = 0;
  let dynamicTokens = 0;

  for (const item of states) {
    if (!item.text) continue;
    const block = `### ${item.slot.label}\n${item.text}`;
    if (item.slot.group === "prefix") {
      prefixParts.push(block);
      prefixTokens += item.includedTokens;
    } else {
      dynamicParts.push(block);
      dynamicTokens += item.includedTokens;
    }
  }

  const stablePrefix = prefixParts.join("\n\n");
  const dynamicTail = dynamicParts.join("\n\n");
  const promptText = [stablePrefix, dynamicTail].filter(Boolean).join("\n\n---\n\n");

  const slotReports: ContextSlotReportDto[] = states.map((item) => ({
    id: item.slot.id,
    label: item.slot.label,
    group: item.slot.group,
    priority: item.slot.priority,
    rawTokens: item.rawTokens,
    includedTokens: item.includedTokens,
    status: item.status,
  }));

  return {
    stablePrefix,
    dynamicTail,
    promptText,
    report: {
      maxInputTokens,
      totalEstimatedTokens: prefixTokens + dynamicTokens,
      prefixTokens,
      dynamicTokens,
      slots: slotReports,
      activeTechniqueIds: params.activeTechniqueIds ?? [],
      activeDeconstructionIds: params.activeDeconstructionIds ?? [],
    },
  };
}
