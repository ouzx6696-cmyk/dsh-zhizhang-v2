import { ContractError } from "../contracts/index.ts";
import { structuralGates, type ArticleMode, type ArticleQa } from "../domain/toutiao/index.ts";
import { refineArticle } from "../domain/toutiao/refinement.ts";
import {
  createWritingBudgetGuard,
  estimateWritingInput,
  QA_SYSTEM,
  usageTupleToActual,
  WRITER_SYSTEM,
} from "../workflow/writing-budget.ts";
import {
  assertStageOutput,
  MAX_CANDIDATE_LENGTH,
  WRITING_STAGE_IDS,
  type WritingPhase,
} from "../workflow/writing-stages.ts";

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type LlmStreamChunk =
  | { readonly type: "text-delta"; readonly index: number; readonly text: string }
  | { readonly type: "block-end"; readonly index: number; readonly block: { readonly type: string; readonly text?: string } }
  | { readonly type: "usage"; readonly usage: LlmUsage }
  | { readonly type: "finish"; readonly reason: { readonly kind: string } };

export interface LlmPreparedCall {
  readonly config: Record<string, unknown>;
  stream(options: Record<string, unknown>): AsyncIterable<LlmStreamChunk>;
}

export interface LlmTransport {
  prepareCall(
    request: { readonly provider: string; readonly model: string; readonly maxTokens: number },
    signal: AbortSignal,
  ): Promise<LlmPreparedCall>;
}

export interface GenerationRunInput {
  readonly id?: string;
  readonly attemptId?: string | null;
  readonly provider: string;
  readonly model: string;
  readonly reserved: number;
  readonly autoQa: boolean;
  readonly frozenInput: string;
}

export interface GenerationReceiptLedger {
  begin(phase: WritingPhase, inputReserve: number, maxOutput: number): string;
  receive(callId: string, usage: readonly number[]): void;
}

export interface GenerationResult {
  readonly body: string;
  readonly tokens: number;
  readonly qa?: ArticleQa;
  readonly rounds?: number;
}

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

/**
 * One-shot LLM generation transport.
 *
 * No Agent session or tool list is ever passed to the model. Every model call
 * reserves and settles tokens through the frozen `BudgetGuard` and validates
 * its output through the frozen `StageRegistry`.
 */
export async function generateCandidate(
  llm: LlmTransport,
  run: GenerationRunInput,
  signal: AbortSignal,
  reserveRefinement: () => void,
  receipts: GenerationReceiptLedger,
): Promise<GenerationResult> {
  const budget = createWritingBudgetGuard(run.reserved);

  async function complete(
    phase: WritingPhase,
    system: string,
    prompt: string,
    maxOutputTokens = Infinity,
  ): Promise<string> {
    const inputReserve = estimateWritingInput(system, prompt);
    const remainingBefore = run.reserved - budget.snapshot().usedTokens - inputReserve;
    const maxTokens = Math.min(remainingBefore, maxOutputTokens);
    if (maxTokens < 1) {
      throw new ContractError("budget.exhausted", { scope: "run", reason: "input-reservation" });
    }

    const reservation = budget.reserve(inputReserve);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    const blocks = new Map<number, string>();
    let usage: LlmUsage | undefined;
    let completed = false;
    let length = 0;
    let counts: number[] = [];

    try {
      const call = await llm.prepareCall(
        { provider: run.provider, model: run.model, maxTokens },
        requestSignal,
      );
      requestSignal.throwIfAborted();
      const callId = receipts.begin(phase, inputReserve, maxTokens);
      try {
        for await (const chunk of call.stream({
          ...call.config,
          system,
          signal: requestSignal,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        })) {
          if (chunk.type === "text-delta") {
            length += chunk.text.length;
            if (length > MAX_CANDIDATE_LENGTH) throw new Error("Candidate too long");
            blocks.set(chunk.index, (blocks.get(chunk.index) ?? "") + chunk.text);
          }
          if (chunk.type === "block-end" && chunk.block.type === "text" && typeof chunk.block.text === "string") {
            blocks.set(chunk.index, chunk.block.text);
          }
          if (chunk.type === "usage") usage = chunk.usage;
          if (chunk.type === "finish") completed = chunk.reason.kind === "stop";
        }
      } finally {
        counts = usage
          ? [
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheReadTokens ?? 0,
            usage.cacheWriteTokens ?? 0,
          ]
          : [];
        if (usage && counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
          receipts.receive(callId, counts);
          reservation.settle(usageTupleToActual(counts));
        } else {
          reservation.release();
        }
      }
    } catch (error) {
      reservation.release();
      throw error;
    }

    if (!usage || counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new ContractError("usage.uncertain", { reason: "missing-token-usage" });
    }
    const body = [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value)
      .join("\n");
    if (signal.aborted) return body;
    if (budget.snapshot().usedTokens > run.reserved) {
      throw new ContractError("budget.exhausted", { scope: "run", reason: "actual-usage" });
    }
    if (!completed) {
      throw new ContractError("stage.output_invalid", { stage: WRITING_STAGE_IDS[phase], missing: "complete-text" });
    }
    if (phase !== "qa") {
      assertStageOutput(WRITING_STAGE_IDS[phase], body, "complete-text");
    }
    return body;
  }

  try {
    const body = await complete("write", WRITER_SYSTEM, run.frozenInput);
    if (!run.autoQa || signal.aborted) {
      return { body, tokens: budget.snapshot().usedTokens };
    }
    const { title, mode, scenario } = JSON.parse(run.frozenInput) as {
      title: string;
      mode: ArticleMode;
      scenario: unknown;
    };
    const result = await refineArticle(
      body,
      async (draft) => {
        signal.throwIfAborted();
        const output = await complete("qa", QA_SYSTEM, JSON.stringify({ title, mode, scenario, text: draft }), 1200);
        const qa = parseQa(output);
        return { ...qa, hardGates: [...qa.hardGates, ...structuralGates(mode, title, draft)] };
      },
      (draft, qa) => {
        signal.throwIfAborted();
        reserveRefinement();
        return complete(
          "refine",
          WRITER_SYSTEM,
          JSON.stringify({
            title,
            scenario,
            text: draft,
            instruction: "只处理未通过项与硬门，再给出完整正文。",
            fails: qa.fails,
            hardGates: qa.hardGates,
          }),
        );
      },
    );
    return { ...result, tokens: budget.snapshot().usedTokens };
  } catch (error) {
    const settledTokens = budget.snapshot().usedTokens;
    if (signal.aborted && settledTokens > 0) return { body: "", tokens: settledTokens };
    if (error instanceof Error) {
      (error as Error & { settledTokens?: number }).settledTokens = settledTokens;
    }
    throw error;
  }
}
