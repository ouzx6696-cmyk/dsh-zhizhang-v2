import assert from "node:assert/strict";
import { createToutiaoGenerationRunner } from "../src/application/products/toutiao.ts";
import { executeGenerationWithRunner } from "../src/host/writing.ts";

const run = { provider: "fixture", model: "test", reserved: 24000, autoQa: true, frozenInput: JSON.stringify({
  title: "长文", mode: "long", scenario: {}, instruction: "修订", text: "稿".repeat(3000),
}) };
const body = "文".repeat(3000);
const usage = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 30, cacheWriteTokens: 10 };
const reports = [
  body, JSON.stringify({ overall: 80, passed: false, fails: ["缺少依据"], hardGates: [] }),
  body, JSON.stringify({ overall: 84, passed: true, fails: [], hardGates: [] }),
];
let calls = 0;
let refinements = 0;
const llm = {
  async prepareCall({ maxTokens }) {
    assert.ok(maxTokens > 0);
    return { config: {}, async *stream(options) {
      assert.equal(options.tools, undefined);
      yield { type: "text-delta", index: 0, text: reports[calls++] };
      yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: "stop" } };
    } };
  },
};
const receipts = new Map();
const ledger = {
  begin(phase, inputReserve, maxOutput) {
    const id = receipts.size + 1;
    receipts.set(id, { phase, inputReserve, maxOutput });
    return id;
  },
  receive(id, usage) { receipts.get(id).usage = usage; },
};
const signal = new AbortController().signal;
const runner = createToutiaoGenerationRunner();
const result = await executeGenerationWithRunner(llm, run, signal, () => { refinements++; }, ledger, runner);
assert.equal(result.body, body);
assert.equal(result.qa.overall, 84);
assert.equal(refinements, 1);
assert.equal(result.tokens, 5760);
assert.deepEqual([...receipts.values()].map(({ phase }) => phase), ["write", "qa", "refine", "qa"]);
assert.deepEqual(receipts.get(1).usage, [1000, 400, 30, 10]);

await assert.rejects(executeGenerationWithRunner(llm, { ...run, reserved: 100 }, signal, () => {}, ledger, runner), { code: "budget.exhausted" });
assert.equal(calls, 4);
const missingUsage = {
  async prepareCall() {
    return { config: {}, async *stream() { yield { type: "finish", reason: { kind: "stop" } }; } };
  },
};
await assert.rejects(executeGenerationWithRunner(missingUsage, run, signal, () => {}, ledger, runner), { code: "usage.uncertain" });
console.log("通过 3000 字长稿与 QA 回改、四类用量、预算不足和缺失回执验证");
