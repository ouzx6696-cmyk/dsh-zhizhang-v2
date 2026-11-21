import assert from "node:assert/strict";
import test from "node:test";
import { createToutiaoGenerationRunner } from "../src/application/products/toutiao.ts";
import { QA_REFINEMENT_LIMIT } from "../src/domain/toutiao/index.ts";
import {
  createSingleShotCaller,
  executeGenerationWithRunner,
  generateCandidate,
} from "../src/host/writing.ts";
import { MAX_CANDIDATE_LENGTH, WRITING_STAGE_IDS } from "../src/workflow/writing-stages.ts";
import {
  assertRejectsContract,
  createReceiptLedger,
  createScriptedLlm,
} from "../support/v2-harness.mjs";

const SHORT_VALID_BODY = "短".repeat(1150);

function baseRun(overrides = {}) {
  return {
    id: "run-1",
    product: "toutiao",
    provider: "fixture",
    model: "test-model",
    reserved: 24_000,
    autoQa: false,
    frozenInput: JSON.stringify({
      title: "测试标题",
      mode: "short",
      scenario: { label: "短图文" },
      instruction: "按提纲撰写正文",
      text: "原始草稿",
    }),
    ...overrides,
  };
}

test("createSingleShotCaller orders multi-index blocks, honors text block-end, enforces zero tools, and settles 4-category usage", async () => {
  const llm = createScriptedLlm([
    {
      chunks: [
        { type: "text-delta", index: 1, text: "stale-second" },
        { type: "text-delta", index: 0, text: "第一" },
        { type: "text-delta", index: 0, text: "段落" },
        { type: "block-end", index: 0, block: { type: "text" } },
        { type: "block-end", index: 1, block: { type: "text", text: "第二段落" } },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10 } },
        { type: "finish", reason: { kind: "stop" } },
      ],
    },
  ]);
  const ledger = createReceiptLedger();
  const caller = createSingleShotCaller(
    llm,
    { provider: "fixture", model: "test-model", reserved: 10_000 },
    new AbortController().signal,
    ledger,
  );

  const output = await caller.complete({
    phase: "write",
    system: "SYS",
    prompt: "USR",
    maxOutputTokens: 2000,
  });

  assert.equal(output, "第一段落\n第二段落");
  assert.equal(caller.usedTokens(), 180);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.tools, undefined);
  assert.equal(llm.calls[0].request.maxTokens, 2000);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].phase, "write");
  assert.deepEqual(ledger.entries[0].usage, [100, 50, 20, 10]);
});

test("DSH-03: thinking block deltas are dropped from the candidate body after block-end declares the type", async () => {
  const llm = createScriptedLlm([
    {
      chunks: [
        { type: "text-delta", index: 0, text: "先想一下" },
        { type: "text-delta", index: 0, text: "，整段都是思维链" },
        { type: "block-end", index: 0, block: { type: "thinking", text: "先想一下，整段都是思维链" } },
        { type: "text-delta", index: 1, text: "正文第一段" },
        { type: "block-end", index: 1, block: { type: "text" } },
        { type: "text-delta", index: 2, text: "正文第二段" },
        { type: "usage", usage: { inputTokens: 40, outputTokens: 20 } },
        { type: "finish", reason: { kind: "stop" } },
      ],
    },
  ]);
  const caller = createSingleShotCaller(
    llm,
    { provider: "fixture", model: "test-model", reserved: 10_000 },
    new AbortController().signal,
    createReceiptLedger(),
  );

  const output = await caller.complete({ phase: "write", system: "SYS", prompt: "USR", maxOutputTokens: 2000 });
  assert.equal(output, "正文第一段\n正文第二段");
  assert.equal(output.includes("思维链"), false, "chain of thought must never be presented as candidate text");
});

test("DSH-03: a run whose entire output was thinking reports thinking_exhausted instead of leaking the chain of thought", async () => {
  const llm = createScriptedLlm([
    {
      chunks: [
        { type: "text-delta", index: 0, text: "很长很长的思考过程" },
        { type: "block-end", index: 0, block: { type: "thinking" } },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 500 } },
        { type: "finish", reason: { kind: "length" } },
      ],
    },
  ]);
  const caller = createSingleShotCaller(
    llm,
    { provider: "fixture", model: "test-model", reserved: 4000 },
    new AbortController().signal,
    createReceiptLedger(),
  );

  await assert.rejects(
    caller.complete({ phase: "write", system: "SYS", prompt: "USR" }),
    (error) => {
      assert.equal(error.code, "stage.output_invalid");
      assert.equal(error.details.missing, "complete-text");
      assert.equal(error.recoveryKind, "thinking_exhausted");
      return true;
    },
  );
});

test("B2-5 DSH-03: a long thinking block does not consume the visible-text length budget", async () => {
  const llm = createScriptedLlm([
    {
      chunks: [
        // The upstream declares a block type only after all its deltas, so
        // this thinking text arrives before we know it should be discarded.
        { type: "text-delta", index: 0, text: "想".repeat(1_050_000) },
        { type: "block-end", index: 0, block: { type: "thinking" } },
        { type: "text-delta", index: 1, text: "可见正文" },
        { type: "block-end", index: 1, block: { type: "text" } },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } },
        { type: "finish", reason: { kind: "stop" } },
      ],
    },
  ]);
  const caller = createSingleShotCaller(
    llm,
    { provider: "fixture", model: "test-model", reserved: 10_000 },
    new AbortController().signal,
    createReceiptLedger(),
  );

  const output = await caller.complete({ phase: "write", system: "SYS", prompt: "USR", maxOutputTokens: 2000 });
  assert.equal(output, "可见正文");
});

test("single-shot caller enforces input reservation, actual usage budget, and MAX_CANDIDATE_LENGTH caps", async () => {
  const uncalledLlm = createScriptedLlm([{ text: "never" }]);
  await assertRejectsContract(
    generateCandidate(
      uncalledLlm,
      baseRun({ reserved: 100 }),
      new AbortController().signal,
      () => {},
      createReceiptLedger(),
    ),
    "budget.exhausted",
    { scope: "run", reason: "input-reservation" },
  );
  assert.equal(uncalledLlm.calls.length, 0);

  const overrunLlm = createScriptedLlm([
    {
      text: "超支正文",
      usage: { inputTokens: 4000, outputTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ]);
  const overrunLedger = createReceiptLedger();
  await assertRejectsContract(
    generateCandidate(
      overrunLlm,
      baseRun({ reserved: 5000 }),
      new AbortController().signal,
      () => {},
      overrunLedger,
    ),
    "budget.exhausted",
    { scope: "run", reason: "actual-usage" },
  );
  assert.deepEqual(overrunLedger.entries[0].usage, [4000, 1200, 0, 0]);

  const hugeLlm = createScriptedLlm([
    {
      chunks: [
        { type: "text-delta", index: 0, text: "a".repeat(MAX_CANDIDATE_LENGTH) },
        { type: "text-delta", index: 0, text: "b" },
      ],
    },
  ]);
  await assert.rejects(
    generateCandidate(hugeLlm, baseRun({ reserved: 5000 }), new AbortController().signal, () => {}, createReceiptLedger()),
    /Candidate too long/,
  );
});

test("single-shot caller rejects missing or malformed usage and incomplete or blank stage output", async () => {
  const cases = [
    {
      name: "missing-usage",
      step: { text: "缺回执", usage: null, finishKind: "stop" },
      code: "usage.uncertain",
      details: { reason: "missing-token-usage" },
      expectReceipt: false,
    },
    {
      name: "negative-usage",
      step: { text: "负用量", usage: { inputTokens: 10, outputTokens: -1 }, finishKind: "stop" },
      code: "usage.uncertain",
      expectReceipt: false,
    },
    {
      name: "non-integer-usage",
      step: { text: "小数用量", usage: { inputTokens: 10.5, outputTokens: 2 }, finishKind: "stop" },
      code: "usage.uncertain",
      expectReceipt: false,
    },
    {
      name: "truncated-finish",
      step: { text: "被截断", finishKind: "length" },
      code: "stage.output_invalid",
      details: { stage: WRITING_STAGE_IDS.write, missing: "complete-text" },
      expectReceipt: true,
    },
    {
      name: "blank-text",
      step: { text: "   \n\t  ", finishKind: "stop" },
      code: "stage.output_invalid",
      details: { stage: WRITING_STAGE_IDS.write, missing: "complete-text" },
      expectReceipt: true,
    },
  ];

  for (const item of cases) {
    const llm = createScriptedLlm([item.step]);
    const ledger = createReceiptLedger();
    await assertRejectsContract(
      generateCandidate(llm, baseRun(), new AbortController().signal, () => {}, ledger),
      item.code,
      item.details,
    );
    assert.equal(ledger.entries[0].usage !== null, item.expectReceipt, `usage expectation mismatch for ${item.name}`);
  }
});

test("executeGenerationWithRunner preserves settledTokens on abort or downstream failure", async () => {
  const controller1 = new AbortController();
  const llmAbortBeforeUsage = createScriptedLlm([
    {
      onStream() {
        controller1.abort();
      },
      throwOnStream: Object.assign(new Error("aborted"), { name: "AbortError" }),
    },
  ]);
  await assert.rejects(
    executeGenerationWithRunner(llmAbortBeforeUsage, baseRun(), controller1.signal, () => {}, createReceiptLedger()),
    (error) => {
      assert.equal(error.settledTokens, 0);
      return true;
    },
  );

  // Abort during step 2 (QA) after step 1 already settled 300 tokens: returns settled token total without losing billing.
  const controller2 = new AbortController();
  const qaGate = Promise.withResolvers();
  const llmAbortMidPipeline = createScriptedLlm([
    { text: SHORT_VALID_BODY, usage: { inputTokens: 200, outputTokens: 100 } },
    {
      onStream() {
        controller2.abort();
      },
      gate: qaGate.promise,
      text: "unreachable",
    },
  ]);
  const runner = createToutiaoGenerationRunner();
  const partialResult = await executeGenerationWithRunner(
    llmAbortMidPipeline,
    baseRun({ autoQa: true }),
    controller2.signal,
    () => {},
    createReceiptLedger(),
    runner,
  );
  assert.deepEqual(partialResult, { body: "", tokens: 300 });

  // Non-abort error on step 2 attaches step 1 settledTokens to the rethrown error.
  const llmFailSecond = createScriptedLlm([
    { text: SHORT_VALID_BODY, usage: { inputTokens: 200, outputTokens: 100 } },
    { throwOnStream: new Error("upstream-502") },
  ]);
  await assert.rejects(
    executeGenerationWithRunner(
      llmFailSecond,
      baseRun({ autoQa: true }),
      new AbortController().signal,
      () => {},
      createReceiptLedger(),
      runner,
    ),
    (error) => {
      assert.equal(error.message, "upstream-502");
      assert.equal(error.settledTokens, 300);
      return true;
    },
  );
});

test("createToutiaoGenerationRunner respects autoQa flag, fenced JSON, 2-round limit, structural gates, and malformed QA errors", async () => {
  const runner = createToutiaoGenerationRunner();

  // 1. autoQa: false runs write only
  {
    const ledger = createReceiptLedger();
    const llm = createScriptedLlm([{ text: SHORT_VALID_BODY }]);
    const result = await executeGenerationWithRunner(
      llm,
      baseRun({ autoQa: false }),
      new AbortController().signal,
      () => assert.fail("refinement should not reserve"),
      ledger,
      runner,
    );
    assert.equal(result.body, SHORT_VALID_BODY);
    assert.equal(result.rounds, undefined);
    assert.deepEqual(ledger.entries.map((e) => e.phase), ["write"]);
  }

  // 2. autoQa: true, passes 1st QA with markdown ```json fence (0 refinements)
  {
    const ledger = createReceiptLedger();
    const llm = createScriptedLlm([
      { text: SHORT_VALID_BODY },
      { text: "```json\n{\"overall\":91,\"passed\":true,\"fails\":[],\"hardGates\":[]}\n```" },
    ]);
    let refinements = 0;
    const result = await executeGenerationWithRunner(
      llm,
      baseRun({ autoQa: true }),
      new AbortController().signal,
      () => { refinements++; },
      ledger,
      runner,
    );
    assert.equal(result.rounds, 0);
    assert.equal(result.qa.overall, 91);
    assert.equal(refinements, 0);
    assert.deepEqual(ledger.entries.map((e) => e.phase), ["write", "qa"]);
  }

  // 3. Structural gates override optimistic LLM QA and cap refinements at QA_REFINEMENT_LIMIT (2)
  {
    const ledger = createReceiptLedger();
    const tooShortBody = "太短了。".repeat(20);
    const llm = createScriptedLlm([
      { text: tooShortBody },
      { text: JSON.stringify({ overall: 95, passed: true, fails: [], hardGates: [] }) },
      { text: tooShortBody + "一改" },
      { text: JSON.stringify({ overall: 95, passed: true, fails: [], hardGates: [] }) },
      { text: tooShortBody + "二改" },
      { text: JSON.stringify({ overall: 95, passed: true, fails: [], hardGates: [] }) },
    ]);
    let refinements = 0;
    const result = await executeGenerationWithRunner(
      llm,
      baseRun({ autoQa: true }),
      new AbortController().signal,
      () => { refinements++; },
      ledger,
      runner,
    );
    assert.equal(refinements, QA_REFINEMENT_LIMIT);
    assert.equal(result.rounds, QA_REFINEMENT_LIMIT);
    assert.deepEqual(ledger.entries.map((e) => e.phase), ["write", "qa", "refine", "qa", "refine", "qa"]);
    assert.ok(result.qa.hardGates.some((gate) => gate.includes("1100–2200")));
  }

  // 4. Micro heading hard gate triggers refinement even when QA passes structurally otherwise
  {
    const ledger = createReceiptLedger();
    const microWithHeading = "## 小标题\n" + "微".repeat(350);
    const microClean = "微".repeat(360);
    const llm = createScriptedLlm([
      { text: microWithHeading },
      { text: JSON.stringify({ overall: 88, passed: true, fails: [], hardGates: [] }) },
      { text: microClean },
      { text: JSON.stringify({ overall: 88, passed: true, fails: [], hardGates: [] }) },
    ]);
    let refinements = 0;
    const result = await executeGenerationWithRunner(
      llm,
      baseRun({
        autoQa: true,
        frozenInput: JSON.stringify({ title: "", mode: "micro", scenario: { label: "微头条" }, instruction: "写", text: "" }),
      }),
      new AbortController().signal,
      () => { refinements++; },
      ledger,
      runner,
    );
    assert.equal(refinements, 1);
    assert.equal(result.rounds, 1);
    assert.equal(result.body, microClean);
    assert.deepEqual(result.qa.hardGates, []);
  }

  // 5. Malformed QA JSON and out-of-range QA score reject with stage.output_invalid
  for (const badQaText of ["not-json-at-all", JSON.stringify({ overall: 101, passed: true, fails: [], hardGates: [] })]) {
    const llm = createScriptedLlm([{ text: SHORT_VALID_BODY }, { text: badQaText }]);
    await assertRejectsContract(
      executeGenerationWithRunner(
        llm,
        baseRun({ autoQa: true }),
        new AbortController().signal,
        () => {},
        createReceiptLedger(),
        runner,
      ),
      "stage.output_invalid",
      { stage: WRITING_STAGE_IDS.qa },
    );
  }
});
