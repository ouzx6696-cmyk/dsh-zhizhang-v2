import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { applyWorkbench } from "../src/host/plugin.ts";
import { openStore, stmt } from "../src/storage/index.ts";
import {
  createMockDsHHost,
  createScriptedLlm,
  withTempDir,
} from "../support/v2-harness.mjs";

const REWRITE_TARGET = "原来的句子";
const REWRITE_RESULT = "改好后的句子";

async function seedChapter(host, { body = "正文", product = "fanqie", title = "第一章" } = {}) {
  const projectId = (await host.mutate("project.create", { name: "账本测试", product })).body.result.id;
  const documentId = (await host.mutate("document.create", { projectId, title })).body.result.id;
  const revisionId = (await host.mutate("draft.save", {
    documentId,
    baseRevisionId: null,
    body,
  })).body.result.revisionId;
  const runId = (await host.mutate("run.start", {
    documentId,
    baseRevisionId: revisionId,
    instruction: "续写",
    tokenLimit: 8000,
  })).body.result.id;
  return { projectId, documentId, revisionId, runId };
}

function rewriteInput(documentId, overrides = {}) {
  return {
    documentId,
    selectedText: REWRITE_TARGET,
    provider: "fixture",
    model: "test-model",
    mode: "polish",
    tokenLimit: 6000,
    ...overrides,
  };
}

test("DSH-10: selection.rewrite settles its usage into author_micro_calls and surfaces it in the run inspector", async () => {
  await withTempDir("zhizhang-micro-ledger-", async (dataDirectory) => {
    const llm = createScriptedLlm([{ text: REWRITE_RESULT }]);
    const host = createMockDsHHost({ llm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const { documentId, runId } = await seedChapter(host);
      const res = await host.mutate("selection.rewrite", rewriteInput(documentId));
      assert.equal(res.status, 200);
      assert.equal(res.body.result.rewrittenText, REWRITE_RESULT);
      assert.equal(res.body.result.mode, "polish");

      const detail = (await host.mutate("run.detail", { documentId, runId })).body.result;
      assert.deepEqual(detail.microUsage, {
        calls: 1,
        completed: 1,
        failed: 0,
        uncertain: 0,
        totalInput: 120,
        totalOutput: 80,
        totalCacheRead: 10,
        totalCacheWrite: 5,
        settled: 215,
      });

      // The writer's own run budget must stay untouched by the micro account (decision #7).
      assert.equal(detail.settled, 0);

      const diag = (await (await host.get("/diag")).json()).result;
      assert.equal(diag.activeMicroCalls, 0, "a finished rewrite must not stay in flight");
    } finally {
      await host.close();
    }
  });
});

test("DSH-10: a second concurrent rewrite on the same document is refused by the per-document ledger lock", async () => {
  await withTempDir("zhizhang-micro-lock-", async (dataDirectory) => {
    const gate = Promise.withResolvers();
    const llm = createScriptedLlm([
      { gate: gate.promise, text: REWRITE_RESULT },
      { text: "第二段改写" },
    ]);
    const host = createMockDsHHost({ llm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const { documentId } = await seedChapter(host);
      const first = host.mutate("selection.rewrite", rewriteInput(documentId));
      await host.waitFor(() => llm.calls.length === 1);

      const second = await host.mutate("selection.rewrite", rewriteInput(documentId));
      assert.equal(second.status, 409);
      assert.equal(second.body.code, "gate.denied");
      assert.deepEqual(second.body.details, { action: "selection.rewrite", reason: "rewrite-in-progress" });

      gate.resolve();
      const settled = await first;
      assert.equal(settled.status, 200);
      assert.equal(settled.body.result.rewrittenText, REWRITE_RESULT);
    } finally {
      await host.close();
    }
  });
});

test("DSH-10/DSH-08: an in-flight rewrite is aborted on unload and its ledger row is reconciled, never left inflight", async () => {
  await withTempDir("zhizhang-micro-drain-", async (dataDirectory) => {
    const gate = Promise.withResolvers();
    const llm = createScriptedLlm([{ gate: gate.promise, text: REWRITE_RESULT }]);
    const host = createMockDsHHost({ llm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    const { documentId, runId } = await seedChapter(host);
    const pending = host.mutate("selection.rewrite", rewriteInput(documentId));
    await host.waitFor(() => llm.calls.length === 1);
    assert.equal(llm.calls[0].signal.aborted, false);

    await host.close();
    assert.equal(llm.calls[0].signal.aborted, true, "unload must abort the in-flight rewrite");
    await pending.then(
      () => {},
      () => {},
    );

    const reopened = createMockDsHHost();
    applyWorkbench(reopened.ctx, { dataDirectory }, { readAsset: reopened.readAsset });
    try {
      const detail = (await reopened.mutate("run.detail", { documentId, runId })).body.result;
      assert.equal(detail.microUsage.calls, 1);
      assert.equal(detail.microUsage.completed, 0);
      assert.equal(detail.microUsage.uncertain, 1, "an interrupted call without a receipt must be marked uncertain");
      assert.equal(detail.microUsage.settled, 0);
    } finally {
      await reopened.close();
    }
  });
});

test("DSH-08: a receipt that arrives during the drain window is persisted instead of dropped", async () => {
  await withTempDir("zhizhang-drain-receipt-", async (dataDirectory) => {
    const calls = [];
    const llm = {
      calls,
      async prepareCall() {
        return {
          config: {},
          async *stream(options) {
            calls.push({ options });
            yield { type: "text-delta", index: 0, text: "候".repeat(1150) };
            yield {
              type: "usage",
              usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
            };
            // Block until unload aborts the request; the receipt is already emitted,
            // so the drain window must keep the ledger writable.
            await new Promise((resolve) => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener("abort", resolve, { once: true });
            });
          },
        };
      },
    };
    const host = createMockDsHHost({ llm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    const { projectId, documentId, runId } = await seedChapter(host);
    const started = await host.mutate("run.generate", { runId, provider: "fixture", model: "test" });
    assert.equal(started.status, 202);
    await host.waitFor(() => calls.length === 1);

    await host.close();

    const reopened = createMockDsHHost();
    applyWorkbench(reopened.ctx, { dataDirectory }, { readAsset: reopened.readAsset });
    try {
      const snap = (await reopened.readState({ projectId, documentId })).body.result;
      assert.equal(snap.runs[0].generationState, "completed", "the drained receipt must complete the attempt");
      assert.equal(snap.runs[0].settled, 150);
      assert.equal(snap.runs[0].state, "awaiting-author");

      const detail = (await reopened.mutate("run.detail", { documentId, runId })).body.result;
      assert.equal(detail.attempts[0].state, "completed");
      assert.equal(detail.calls[0].usage, "[100,50,0,0]");
    } finally {
      await reopened.close();
    }
  });
});

test("DB-02: the host prunes the command journal at startup, keeping only the per-document floor", async () => {
  await withTempDir("zhizhang-journal-prune-", async (dataDirectory) => {
    const dbPath = join(dataDirectory, "workspace.sqlite");

    // First boot creates the full schema; then we seed aged journal rows directly.
    const first = createMockDsHHost();
    applyWorkbench(first.ctx, { dataDirectory }, { readAsset: first.readAsset });
    await first.close();

    const seed = openStore(dbPath);
    try {
      const old = Date.now() - 40 * 86_400_000;
      for (let index = 0; index < 120; index += 1) {
        stmt(seed, `
          INSERT INTO command_journal (
            actor_id, command_id, document_id, request_key, request_payload, request_hash, result_payload, created_at
          ) VALUES ('author', 'draft.save', 'doc-journal', ?, ?, 'hash', '{}', ?);
        `).run(`key-${index}`, JSON.stringify({ body: "原稿".repeat(50) }), old + index);
      }
    } finally {
      seed.close();
    }

    const second = createMockDsHHost();
    applyWorkbench(second.ctx, { dataDirectory }, { readAsset: second.readAsset });
    await second.close();

    const check = openStore(dbPath);
    try {
      const row = stmt(check, `
        SELECT COUNT(*) AS count, MAX(length(request_payload)) AS maxPayload
        FROM command_journal WHERE document_id = 'doc-journal';
      `).get();
      assert.equal(row.count, 50, "only the newest 50 rows per document survive");
      assert.equal(row.maxPayload, 0, "surviving payloads are compacted to the request hash");
    } finally {
      check.close();
    }
  });
});
