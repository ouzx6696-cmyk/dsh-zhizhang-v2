import { ContractError } from "../../../contracts/errors.ts";
import { articleScenario, structuralGates, TITLE_MAX, type ArticleMode, type ArticleQa } from "../../../domain/toutiao/index.ts";
import { refineArticle } from "../../../domain/toutiao/refinement.ts";
import { assembleContextBundle, type ContextSlotInput } from "../../../workflow/context-slots.ts";
import { QA_SYSTEM, WRITER_SYSTEM } from "../../../workflow/writing-budget.ts";
import { assertStageOutput, WRITING_STAGE_IDS } from "../../../workflow/writing-stages.ts";
import type { DocumentRow, Input, WorkspaceContext } from "../../context.ts";
import type { ProductGenerationRunner } from "../../product-line.ts";

function parseQa(source: string): ArticleQa {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
  } catch {
    throw new ContractError("stage.output_invalid", { stage: WRITING_STAGE_IDS.qa, missing: "json" });
  }
  assertStageOutput(WRITING_STAGE_IDS.qa, parsed, "qa-result");
  const result = parsed as ArticleQa;
  return {
    overall: result.overall,
    passed: result.passed,
    fails: result.fails,
    hardGates: result.hardGates,
  };
}

function formatToutiaoRulesBlock(
  mode: string | null,
  line: string | null,
  scenario: ReturnType<typeof articleScenario>,
): string {
  const lines = [
    `体裁：${scenario.label}（${mode ?? ""}）`,
    `内容线：${line ?? ""}`,
    `总字数区间：${scenario.length[0]}–${scenario.length[1]} 非空白字符`,
  ];
  if (scenario.main) lines.push(`主线字数：${scenario.main[0]}–${scenario.main[1]} 字`);
  if (scenario.extension) lines.push(`延伸字数：${scenario.extension[0]}–${scenario.extension[1]} 字`);
  lines.push(
    scenario.hasTitle
      ? `标题规范：1–${TITLE_MAX} Unicode 码点；避免空洞标题党`
      : "微头条规范：禁止设置标题，禁止使用 Markdown 小标题（#）",
    `可选驱动：${scenario.drivers.join("、")}`,
    `可选开头：${scenario.openings.join("、")}`,
    `可选结尾：${scenario.endings.join("、")}`,
    "反 AI 腔原则：具体细节先行，禁止空泛总结词（如“综上所述/总而言之/值得注意的是”），不编造未核实事实。",
  );
  return lines.join("\n");
}

function formatToutiaoPlanningBlock(plan: Input | null): string {
  if (!plan) return "";
  const lines: string[] = [];
  if (typeof plan.driver === "string" && plan.driver) lines.push(`驱动型：${plan.driver}`);
  if (typeof plan.opening === "string" && plan.opening) lines.push(`开头方式：${plan.opening}`);
  if (typeof plan.ending === "string" && plan.ending) lines.push(`结尾方式：${plan.ending}`);
  const validTitles = (plan.titleMatrix as { valid?: readonly { text: string; motif: string }[] } | undefined)?.valid;
  if (Array.isArray(validTitles) && validTitles.length > 0) {
    const sorted = [...validTitles].sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
    lines.push("合规标题矩阵：");
    for (const item of sorted) {
      lines.push(`- ${item.text} [${item.motif}]`);
    }
  }
  return lines.join("\n");
}

export function buildToutiaoFrozenContext(
  ctx: WorkspaceContext,
  row: DocumentRow,
  input: Input,
) {
  const scenario = row.mode && row.line ? articleScenario(row.mode, row.line) : null;
  if (!scenario) return { knownFacts: [], scenario: null };
  const plan = ctx.planning(row.id);
  const tokenLimit = typeof input.tokenLimit === "number" && Number.isSafeInteger(input.tokenLimit) && input.tokenLimit > 0
    ? input.tokenLimit
    : 12_000;
  const maxInputTokens = Math.max(512, Math.floor(tokenLimit * 0.72));
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  const draftBody = [row.title ? `标题：${row.title}` : "", row.body ?? ""].filter(Boolean).join("\n\n");

  const slots: readonly ContextSlotInput[] = [
    {
      id: "toutiaoRules",
      label: "头条体裁规范与反AI腔约束（Prefix 稳定区）",
      group: "prefix",
      priority: "high",
      content: formatToutiaoRulesBlock(row.mode, row.line, scenario),
      maxShare: 0.25,
    },
    {
      id: "toutiaoPlanning",
      label: "篇纲与标题矩阵（Prefix 稳定区）",
      group: "prefix",
      priority: "medium",
      content: formatToutiaoPlanningBlock(plan),
      maxShare: 0.18,
    },
    {
      id: "articleDraft",
      label: "当前工作稿正文",
      group: "dynamic",
      priority: "critical",
      content: draftBody,
    },
    {
      id: "instruction",
      label: "本轮写作指令",
      group: "dynamic",
      priority: "critical",
      content: instruction,
    },
  ];

  const assembled = assembleContextBundle({ slots, maxInputTokens });
  return {
    knownFacts: [],
    scenario,
    contextBundle: {
      stablePrefix: assembled.stablePrefix,
      dynamicTail: assembled.dynamicTail,
      report: assembled.report,
    },
  };
}

/**
 * Toutiao-specific generation pipeline: single-shot write, optionally followed
 * by QA assessment and up to `QA_REFINEMENT_LIMIT` (2) targeted refinement rounds,
 * sharing one deterministic `cachePrefix` across all stages.
 */
export function createToutiaoGenerationRunner(): ProductGenerationRunner {
  return async ({ caller, run, signal, reserveRefinement }) => {
    const parsed = JSON.parse(run.frozenInput) as {
      title: string;
      mode: ArticleMode;
      scenario: unknown;
      contextBundle?: { readonly stablePrefix?: string; readonly dynamicTail?: string };
    };
    const { title, mode, scenario } = parsed;
    const stablePrefix = parsed.contextBundle?.stablePrefix?.trim()
      || (scenario || mode ? JSON.stringify({ mode: mode ?? null, scenario: scenario ?? null }) : undefined);
    const writePrompt = parsed.contextBundle
      ? [parsed.contextBundle.stablePrefix, parsed.contextBundle.dynamicTail].filter(Boolean).join("\n\n---\n\n") || run.frozenInput
      : run.frozenInput;

    const body = await caller.complete({
      phase: "write",
      system: WRITER_SYSTEM,
      prompt: writePrompt,
      cachePrefix: stablePrefix,
    });
    if (!run.autoQa || signal.aborted) {
      return { body, tokens: caller.usedTokens() };
    }

    const result = await refineArticle(
      body,
      async (draft) => {
        signal.throwIfAborted();
        const qaPayload = JSON.stringify({ title, mode, scenario, text: draft });
        const qaPrompt = stablePrefix ? `${stablePrefix}\n\n---\n\n### 待质检正文\n${qaPayload}` : qaPayload;
        const output = await caller.complete({
          phase: "qa",
          system: QA_SYSTEM,
          prompt: qaPrompt,
          maxOutputTokens: 1200,
          cachePrefix: stablePrefix,
          disableThinking: true,
        });
        const qa = parseQa(output);
        return { ...qa, hardGates: [...qa.hardGates, ...structuralGates(mode, title, draft)] };
      },
      (draft, qa) => {
        signal.throwIfAborted();
        reserveRefinement();
        const refinePayload = JSON.stringify({
          title,
          scenario,
          text: draft,
          instruction: "只处理未通过项与硬门，再给出完整正文。",
          fails: qa.fails,
          hardGates: qa.hardGates,
        });
        const refinePrompt = stablePrefix
          ? `${stablePrefix}\n\n---\n\n### 定向回改任务\n${refinePayload}`
          : refinePayload;
        return caller.complete({
          phase: "refine",
          system: WRITER_SYSTEM,
          prompt: refinePrompt,
          cachePrefix: stablePrefix,
        });
      },
      { signal },
    );
    return { ...result, tokens: caller.usedTokens() };
  };
}
