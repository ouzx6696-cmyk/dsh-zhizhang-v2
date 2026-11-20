import { ContractError } from "../contracts/index.ts";
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

/**
 * Creates a pure one-shot streaming LLM caller with zero domain knowledge.
 *
 * Enforces the frozen `BudgetGuard`, 4-category usage accounting, 180s timeout,
 * zero tool access (`tools` is never supplied), and `StageRegistry` validation.
 */
export function createSingleShotCaller(
  llm: LlmTransport,
  run: Pick<GenerationRunInput, "provider" | "model" | "reserved">,
  signal: AbortSignal,
  receipts: GenerationReceiptLedger,
): SingleShotLlmCaller {
  const budget = createWritingBudgetGuard(run.reserved);

  return {
    usedTokens() {
      return budget.snapshot().usedTokens;
    },

    async complete({ phase, system, prompt, maxOutputTokens = Infinity, cachePrefix }) {
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
          const streamOptions: Record<string, unknown> = {
            ...call.config,
            system,
            signal: requestSignal,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          };
          if (cachePrefix) streamOptions.cachePrefix = cachePrefix;
          for await (const chunk of call.stream(streamOptions)) {
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
      if (!isJsonStagePhase(phase)) {
        assertStageOutput(WRITING_STAGE_IDS[phase], body, "complete-text");
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
