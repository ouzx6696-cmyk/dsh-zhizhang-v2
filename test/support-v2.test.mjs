import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ContractError } from "../src/contracts/index.ts";
import {
  assertRejectsContract,
  assertThrowsContract,
  createMemoryStorage,
  createReceiptLedger,
  createScriptedLlm,
  createTestWorkspace,
  withBrowserGlobals,
  withTempDir,
} from "../support/v2-harness.mjs";

test("V2 harness withTempDir removes directories cleanly after both return and throw", async () => {
  const created = await withTempDir("zhizhang-v2-tmp-", async (dir) => {
    assert.equal(existsSync(dir), true);
    return join(dir, "probe.txt");
  });
  assert.equal(existsSync(created), false);

  let seenDir = "";
  await assert.rejects(
    () =>
      withTempDir("zhizhang-v2-err-", async (dir) => {
        seenDir = dir;
        assert.equal(existsSync(dir), true);
        throw new Error("expected-cleanup");
      }),
    /expected-cleanup/,
  );
  assert.equal(existsSync(seenDir), false);
});

test("V2 harness createTestWorkspace manages file WAL multi-connection lifecycles without Windows handle locks", (t) => {
  const ws = createTestWorkspace(t, { mode: "file", wal: true });
  const fanqie = ws.createFanqieChapter({ title: "序章", body: "初稿正文" });
  const peer = ws.openConnection();
  const snap = peer.app.snapshot(fanqie.projectId, fanqie.documentId);
  assert.equal(snap.active.body, "初稿正文");

  const toutiao = ws.createToutiaoArticle({ mode: "micro" });
  assert.equal(ws.app.snapshot(toutiao.projectId, toutiao.documentId).active.mode, "micro");

  const capturedDir = ws.dir;
  assert.equal(existsSync(capturedDir), true);
  ws.close();
  assert.equal(existsSync(capturedDir), false);
});

test("V2 harness createScriptedLlm records options, enforces abortable gates, and pairs with createReceiptLedger", async () => {
  const gate = Promise.withResolvers();
  const llm = createScriptedLlm([
    {
      text: "第一段",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2 },
    },
    { gate: gate.promise, text: "unreachable" },
  ]);
  const ledger = createReceiptLedger();

  const callId = ledger.begin("write", 500, 1000);
  const first = await llm.prepareCall({ provider: "fixture", model: "m", maxTokens: 900 }, new AbortController().signal);
  const collected = [];
  for await (const chunk of first.stream({ messages: [{ role: "user", content: [] }] })) {
    collected.push(chunk);
  }
  ledger.receive(callId, [10, 20, 1, 2]);
  assert.equal(llm.calls[0].options.tools, undefined);
  assert.equal(collected[0].text, "第一段");
  assert.deepEqual(ledger.entries[0].usage, [10, 20, 1, 2]);

  const abortController = new AbortController();
  const second = await llm.prepareCall({ provider: "fixture", model: "m", maxTokens: 900 }, abortController.signal);
  const streamPromise = (async () => {
    for await (const chunk of second.stream({})) {
      void chunk;
    }
  })();
  abortController.abort();
  await assert.rejects(streamPromise, { name: "AbortError" });
});

test("V2 harness createMemoryStorage and withBrowserGlobals restore global state reliably", async () => {
  const storage = createMemoryStorage();
  storage.setItem("k1", "v1");
  assert.equal(storage.length, 1);
  assert.equal(storage.key(0), "k1");
  assert.equal(storage.getItem("k1"), "v1");

  const beforeLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const beforeFetch = globalThis.fetch;

  await assert.rejects(
    withBrowserGlobals(
      {
        localStorage: storage,
        fetch: async () => new Response("ok"),
      },
      async () => {
        assert.equal(globalThis.localStorage.getItem("k1"), "v1");
        assert.equal(typeof globalThis.fetch, "function");
        throw new Error("rollback-globals");
      },
    ),
    /rollback-globals/,
  );

  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "localStorage"), beforeLocalStorage);
  assert.equal(globalThis.fetch, beforeFetch);
});

test("V2 harness contract assertions verify ContractError code and detail subsets", async () => {
  assertThrowsContract(
    () => {
      throw new ContractError("gate.denied", { action: "draft.finalize", reason: "editorial-review-required" });
    },
    "gate.denied",
    { reason: "editorial-review-required" },
  );

  assert.throws(() =>
    assertThrowsContract(
      () => {
        throw new ContractError("input.invalid", { field: "title" });
      },
      "gate.denied",
    ),
  );

  await assertRejectsContract(
    async () => {
      throw new ContractError("budget.exhausted", { scope: "run", reason: "actual-usage" });
    },
    "budget.exhausted",
    { scope: "run", reason: "actual-usage" },
  );
});
