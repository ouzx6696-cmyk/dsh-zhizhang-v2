import { createBudgetGuard, totalTokens, type ActualUsage, type BudgetGuard } from "./budget.ts";

export const WRITER_SYSTEM =
  "你是织章的候选稿写作者。根据给定的作者要求和冻结输入写作。只返回候选正文。维持人物知识边界与锁定设定，不执行外部操作。";

export const QA_SYSTEM =
  "你是头条稿件质检编辑。核对事实需证据，检查结构、标题正文一致性与风险，不把未核实内容视为已核实。只返回 JSON，键为 overall（0–100整数）、passed（布尔）、fails（字符串数组）和 hardGates（字符串数组）。";

export const DEFAULT_MIN_RECOMMENDED_BUDGET = 8000;

/**
 * Conservative UTF-8 byte-based input reservation that guarantees Chinese
 * manuscripts never under-reserve tokens when provider tokenizers are absent.
 */
export function estimateWritingInput(system: string, prompt: string): number {
  return new TextEncoder().encode(system + prompt).length + 128;
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

/**
 * Creates a frozen `BudgetGuard` configured for one writing run.
 */
export function createWritingBudgetGuard(runBudget: number, initialSettled = 0): BudgetGuard {
  const initial: ActualUsage | undefined = initialSettled > 0
    ? { input: initialSettled, output: 0, cache_read: 0, cache_write: 0, cost: null }
    : undefined;
  return createBudgetGuard({ inputBudget: runBudget, runBudget }, initial);
}
