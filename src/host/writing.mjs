import { ContractError } from "../../dist/contracts/index.js";
import { structuralGates } from "../../dist/domain/toutiao/index.js";
import { refineArticle } from "../../dist/domain/toutiao/refinement.js";
import { estimateWritingInput, WRITER_SYSTEM } from "../../dist/workflow/writing-budget.js";

const qaSystem = '你是头条稿件质检编辑。核对事实需证据，检查结构、标题正文一致性与风险，不把未核实内容视为已核实。只返回 JSON，键为 overall（0–100整数）、passed（布尔）、fails（字符串数组）和 hardGates（字符串数组）。';

function parseQa(source) {
  let result;
  try {
    result = JSON.parse(source.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
  } catch {
    throw new ContractError("stage.output_invalid", { stage: "article.qa.review", missing: "json" });
  }
  if (!result || !Number.isSafeInteger(result.overall) || result.overall < 0 || result.overall > 100
      || typeof result.passed !== "boolean" || ![result.fails, result.hardGates].every(
        (list) => Array.isArray(list) && list.every((item) => typeof item === "string"),
      )) {
    throw new ContractError("stage.output_invalid", { stage: "article.qa.review", missing: "qa-result" });
  }
  return { overall: result.overall, passed: result.passed, fails: result.fails, hardGates: result.hardGates };
}

// One-shot transport. No Agent session or tool list is passed to the model.
export async function generateCandidate(llm, run, signal, reserveRefinement, receipts) {
  let tokens = 0;
  async function complete(phase, system, prompt, maxOutputTokens = Infinity) {
    const inputReserve = estimateWritingInput(system, prompt);
    const maxTokens = Math.min(run.reserved - tokens - inputReserve, maxOutputTokens);
    if (maxTokens < 1) throw new ContractError("budget.exhausted", { scope: "run", reason: "input-reservation" });

    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    const call = await llm.prepareCall({ provider: run.provider, model: run.model, maxTokens }, requestSignal);
    const blocks = new Map();
    let usage;
    let completed = false;
    let length = 0;
    requestSignal.throwIfAborted();
    const callId = receipts.begin(phase, inputReserve, maxTokens);
    let counts = [];
    try {
      for await (const chunk of call.stream({
        ...call.config, system, signal: requestSignal,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      })) {
        if (chunk.type === "text-delta") {
          length += chunk.text.length;
          if (length > 1_000_000) throw new Error("Candidate too long");
          blocks.set(chunk.index, (blocks.get(chunk.index) ?? "") + chunk.text);
        }
        if (chunk.type === "block-end" && chunk.block.type === "text") blocks.set(chunk.index, chunk.block.text);
        if (chunk.type === "usage") usage = chunk.usage;
        if (chunk.type === "finish") completed = chunk.reason.kind === "stop";
      }
    } finally {
      counts = usage ? [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0] : [];
      if (usage && counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
        receipts.receive(callId, counts);
        tokens += counts.reduce((a, b) => a + b, 0);
      }
    }
    if (!usage || counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new ContractError("usage.uncertain", { reason: "missing-token-usage" });
    }
    const body = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join("\n");
    if (signal.aborted) return body;
    if (tokens > run.reserved) throw new ContractError("budget.exhausted", { scope: "run", reason: "actual-usage" });
    if (!completed || !body.trim() || body.length > 1_000_000) {
      throw new ContractError("stage.output_invalid", { stage: "draft.write.candidate", missing: "complete-text" });
    }
    return body;
  }

  try {
    const body = await complete("write", WRITER_SYSTEM, run.frozenInput);
    if (!run.autoQa || signal.aborted) return { body, tokens };
    const { title, mode, scenario } = JSON.parse(run.frozenInput);
    const result = await refineArticle(
      body,
      async (draft) => {
        signal.throwIfAborted();
        const output = await complete("qa", qaSystem, JSON.stringify({ title, mode, scenario, text: draft }), 1200);
        const qa = parseQa(output);
        return { ...qa, hardGates: [...qa.hardGates, ...structuralGates(mode, title, draft)] };
      },
      (draft, qa) => {
        signal.throwIfAborted();
        reserveRefinement();
        return complete("refine", WRITER_SYSTEM, JSON.stringify({
          title, scenario, text: draft, instruction: "只处理未通过项与硬门，再给出完整正文。",
          fails: qa.fails, hardGates: qa.hardGates,
        }));
      },
    );
    return { ...result, tokens };
  } catch (error) {
    if (signal.aborted && tokens > 0) return { body: "", tokens };
    if (error instanceof Error) error.settledTokens = tokens;
    throw error;
  }
}
