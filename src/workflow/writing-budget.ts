import { createBudgetGuard, totalTokens, type ActualUsage, type BudgetGuard } from "./budget.ts";

export const WRITER_SYSTEM =
  "你是织章的候选稿写作者。根据给定的作者要求和冻结输入写作。只返回候选正文。维持人物知识边界与锁定设定，不执行外部操作。";

export const QA_SYSTEM =
  "你是头条稿件质检编辑。核对事实需证据，检查结构、标题正文一致性与风险，不把未核实内容视为已核实。只返回 JSON，键为 overall（0–100整数）、passed（布尔）、fails（字符串数组）和 hardGates（字符串数组）。";

export const DECONSTRUCT_EXTRACT_SYSTEM =
  "你是织章长篇拆书分析助手。根据给定样章片段，提取结构化拆书字段，仅作为待作者确认的提案。只返回 JSON，键为 title、sourceBook、genre、pacing（快爽/稳推/慢燃或空）、tags（字符串数组）、hookAnalysis、conflictBeats、payoffRhythm、proseNotes。";

export const TECHNIQUE_EXTRACT_SYSTEM =
  "你是织章写作技法提炼助手。根据给定片段或拆书笔记提炼可复用的叙事技法卡片提案。只返回 JSON，键为 title、category（opening/hook/conflict/dialogue/atmosphere/foreshadow/pacing/cliffhanger/narrative）、pacing、sceneTags（字符串数组）、triggerWhen、executionSteps、constraints、antiPatterns。";

export const SETTING_EXTRACT_SYSTEM =
  "你是织章动态设定与伏笔提取助手。仅从给定章节正文与已有设定中提取新增或变更的人物/物品/地点/势力/规则与伏笔线索，全部作为待作者审阅的提案，不改动已锁定设定。只返回 JSON，键为 settings（数组，每项含 factId/category/entityName/note/point/people）与 foreshadows（数组，每项含 title/factId/status/note）。";

export const SUMMARY_DRAFT_SYSTEM =
  "你是织章章节摘要助手。将给定章节浓缩为 120–240 字的客观剧情滚动摘要，保留时间线、出场核心人物与关键状态变化。只返回 JSON，键为 summary（字符串）。";

export const DEFAULT_MIN_RECOMMENDED_BUDGET = 8000;

/**
 * Calibrated CJK/ASCII token estimator that protects Chinese manuscripts
 * against under-reservation without the ~2.3x over-inflation of raw UTF-8 bytes.
 */
export function estimateTokenCount(text: string): number {
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
  return Math.ceil(total);
}

/**
 * Calibrated conservative input reservation accounting for CJK density and
 * fixed protocol framing overhead.
 */
export function estimateWritingInput(system: string, prompt: string): number {
  return estimateTokenCount(system) + estimateTokenCount(prompt) + 128;
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
