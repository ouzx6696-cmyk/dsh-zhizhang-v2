import { ContractError } from "../contracts/index.ts";
import type { RecoveryHintDto, RecoveryHintKind } from "../contracts/workspace-dto.ts";
import {
  createWritingBudgetGuard,
  estimateWritingInput,
  usageTupleToActual,
  WRITER_SYSTEM,
} from "../workflow/writing-budget.ts";
import {
  assertStageOutput,
  isJsonStagePhase,
  MAX_CANDIDATE_LENGTH,
  WRITING_STAGE_IDS,
  type SingleShotCallRequest,
  type SingleShotLlmCaller,
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
  readonly product?: string;
  readonly attemptId?: string | null;
  readonly provider: string;
  readonly model: string;
  readonly reserved: number;
  readonly inputBudget?: number;
  readonly autoQa: boolean;
  readonly frozenInput: string;
}

export interface GenerationReceiptLedger {
  begin(phase: SingleShotCallRequest["phase"], inputReserve: number, maxOutput: number): string;
  receive(callId: string, usage: readonly number[]): void;
}

export interface GenerationResult {
  readonly body: string;
  readonly tokens: number;
  readonly qa?: unknown;
  readonly rounds?: number;
}

export type GenerationPipelineRunner = (deps: {
  readonly caller: SingleShotLlmCaller;
  readonly run: GenerationRunInput;
  readonly signal: AbortSignal;
  readonly reserveRefinement: () => void;
}) => Promise<GenerationResult>;

function attachRecoveryKind<T extends Error>(error: T, kind: RecoveryHintKind): T {
  (error as T & { recoveryKind?: RecoveryHintKind }).recoveryKind = kind;
  return error;
}

/**
 * Translates structured generation failure markers into actionable author
 * recovery hints without altering frozen error envelopes.
 */
export function buildRecoveryHints(
  recoveryKind?: string | null,
  errorCode?: string | null,
): RecoveryHintDto[] {
  const resolved = recoveryKind ?? (errorCode === "budget.exhausted" ? "budget_exhausted" : null);
  if (resolved === "thinking_exhausted") {
    return [
      {
        kind: "thinking_exhausted",
        action: "disable_thinking",
        message: "模型深度思考耗尽了输出额度，建议关闭深度思考后原地重试。",
      },
      {
        kind: "output_truncated",
        action: "increase_output_limit",
        message: "也可适当提高单次输出上限或任务总预算后重试。",
      },
    ];
  }
  if (resolved === "output_truncated") {
    return [
      {
        kind: "output_truncated",
        action: "increase_output_limit",
        message: "输出因上限被截断，建议提高单次输出上限或总预算后重试。",
      },
    ];
  }
  if (resolved === "budget_exhausted") {
    return [
      {
        kind: "budget_exhausted",
        action: "increase_budget",
        message: "当前任务预算不足，建议追加 Token 预算后原地重试。",
      },
    ];
  }
  return [];
}

/**
 * Creates a pure one-shot streaming LLM caller with zero domain knowledge.
 *
 * Enforces the frozen `BudgetGuard`, 4-category usage accounting, 180s timeout,
 * zero tool access (`tools` is never supplied), and `StageRegistry` validation.
 */
export function createSingleShotCaller(
  llm: LlmTransport,
  run: Pick<GenerationRunInput, "provider" | "model" | "reserved" | "inputBudget">,
  signal: AbortSignal,
  receipts: GenerationReceiptLedger,
): SingleShotLlmCaller {
  const budget = createWritingBudgetGuard(run.reserved, 0, run.inputBudget);

  return {
    usedTokens() {
      return budget.snapshot().usedTokens;
    },

    async complete({ phase, system, prompt, maxOutputTokens = Infinity, cachePrefix, disableThinking }) {
      const inputReserve = estimateWritingInput(system, prompt);
      const snap = budget.snapshot();
      const remainingBefore = run.reserved - snap.usedTokens - snap.inflightTokens - inputReserve;
      const maxTokens = Math.min(remainingBefore, maxOutputTokens);
      if (maxTokens < 1) {
        throw attachRecoveryKind(
          new ContractError("budget.exhausted", { scope: "run", reason: "input-reservation" }),
          "budget_exhausted",
        );
      }

      let reservation;
      try {
        reservation = budget.reserve(inputReserve);
      } catch (error) {
        if (error instanceof ContractError && error.code === "budget.exhausted") {
          attachRecoveryKind(error, "budget_exhausted");
        }
        throw error;
      }

      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
      const blocks = new Map<number, string>();
      let usage: LlmUsage | undefined;
      let completed = false;
      let finishReasonKind: string | null = null;
      let sawThinkingBlock = false;
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
          const streamOptions: Record<string, unknown> = {
            ...call.config,
            system,
            signal: requestSignal,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          };
          if (cachePrefix) streamOptions.cachePrefix = cachePrefix;
          if (disableThinking === true) streamOptions.thinking = false;
          for await (const chunk of call.stream(streamOptions)) {
            if (chunk.type === "text-delta") {
              length += chunk.text.length;
              if (length > MAX_CANDIDATE_LENGTH) throw new Error("Candidate too long");
              blocks.set(chunk.index, (blocks.get(chunk.index) ?? "") + chunk.text);
            }
            if (chunk.type === "block-end") {
              if (chunk.block.type === "thinking") sawThinkingBlock = true;
              if (chunk.block.type === "text" && typeof chunk.block.text === "string") {
                blocks.set(chunk.index, chunk.block.text);
              }
            }
            if (chunk.type === "usage") usage = chunk.usage;
            if (chunk.type === "finish") {
              finishReasonKind = chunk.reason.kind;
              completed = chunk.reason.kind === "stop";
            }
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
        throw attachRecoveryKind(
          new ContractError("budget.exhausted", { scope: "run", reason: "actual-usage" }),
          "budget_exhausted",
        );
      }
      if (!completed) {
        const err = new ContractError("stage.output_invalid", {
          stage: WRITING_STAGE_IDS[phase],
          missing: "complete-text",
        });
        if (finishReasonKind === "length" || finishReasonKind === "max_tokens") {
          attachRecoveryKind(err, sawThinkingBlock && !body.trim() ? "thinking_exhausted" : "output_truncated");
        }
        throw err;
      }
      if (!isJsonStagePhase(phase)) {
        try {
          assertStageOutput(WRITING_STAGE_IDS[phase], body, "complete-text");
        } catch (error) {
          if (error instanceof ContractError && sawThinkingBlock && !body.trim()) {
            attachRecoveryKind(error, "thinking_exhausted");
          }
          throw error;
        }
      }
      return body;
    },
  };
}

/**
 * Executes a candidate generation run using the domain-free single-shot LLM
 * caller and an optional product-line pipeline runner.
 */
export async function executeGenerationWithRunner(
  llm: LlmTransport,
  run: GenerationRunInput,
  signal: AbortSignal,
  reserveRefinement: () => void,
  receipts: GenerationReceiptLedger,
  runner?: GenerationPipelineRunner,
): Promise<GenerationResult> {
  const caller = createSingleShotCaller(llm, run, signal, receipts);

  try {
    if (runner) {
      return await runner({ caller, run, signal, reserveRefinement });
    }
    const body = await caller.complete({ phase: "write", system: WRITER_SYSTEM, prompt: run.frozenInput });
    return { body, tokens: caller.usedTokens() };
  } catch (error) {
    const settledTokens = caller.usedTokens();
    if (signal.aborted && settledTokens > 0) return { body: "", tokens: settledTokens };
    if (error instanceof Error) {
      (error as Error & { settledTokens?: number }).settledTokens = settledTokens;
    }
    throw error;
  }
}

/** Default single-shot candidate generation without product-specific post-processing. */
export function generateCandidate(
  llm: LlmTransport,
  run: GenerationRunInput,
  signal: AbortSignal,
  reserveRefinement: () => void,
  receipts: GenerationReceiptLedger,
): Promise<GenerationResult> {
  return executeGenerationWithRunner(llm, run, signal, reserveRefinement, receipts);
}
