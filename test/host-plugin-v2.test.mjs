import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CLIENT_ENTRY_CSS, CLIENT_ENTRY_HTML, CLIENT_JS_MODULES } from "../src/client/manifest.ts";
import { DELIVERY_ENDING } from "../src/domain/toutiao/index.ts";
import { apply, applyWorkbench, inject } from "../src/host/plugin.ts";
import { createStore, openStore } from "../src/storage/index.ts";
import {
  createMockDsHHost,
  createScriptedLlm,
  withTempDir,
} from "../support/v2-harness.mjs";

const EXPECTED_CSP = "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'";

test("host plugin declares inject dependencies and rejects missing dataDirectory", () => {
  assert.deepEqual(inject, ["connection", "llm"]);
  const host = createMockDsHHost();
  assert.throws(() => apply(host.ctx, { dataDirectory: "" }), /dataDirectory/);
  assert.throws(() => apply(host.ctx, {}), /dataDirectory/);
});

test("host plugin disposes registered routes in reverse order and closes SQLite if asset loading fails during startup", async () => {
  await withTempDir("zhizhang-plugin-fail-", async (dataDirectory) => {
    const host = createMockDsHHost();
    let jsLoads = 0;
    assert.throws(
      () =>
        applyWorkbench(host.ctx, { dataDirectory }, {
          readAsset(kind, path) {
            if (kind === "js" && jsLoads++ === 2) {
              throw new Error(`simulated missing asset: ${path}`);
            }
            return host.readAsset(kind, path);
          },
        }),
      /simulated missing asset/,
    );
    // workbench, workbench.css, and first 2 JS modules were registered before the 3rd JS load threw.
    assert.deepEqual(host.disposedPaths, [
      `/api/zhizhang/${CLIENT_JS_MODULES[1]}`,
      `/api/zhizhang/${CLIENT_JS_MODULES[0]}`,
      "/api/zhizhang/workbench.css",
      "/api/zhizhang/workbench",
    ]);
    assert.equal(host.routes.size, 0);
  });
});

test("host plugin registers all static workbench assets and API routes with strict security headers", async () => {
  await withTempDir("zhizhang-plugin-static-", async (dataDirectory) => {
    const host = createMockDsHHost();
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      assert.equal(host.effectName, "zhizhang: author workbench");
      const expectedPaths = [
        "/api/zhizhang/workbench",
        "/api/zhizhang/workbench.css",
        ...CLIENT_JS_MODULES.map((mod) => `/api/zhizhang/${mod}`),
        "/api/zhizhang/diag",
        "/api/zhizhang/state",
        "/api/zhizhang/mutate",
      ];
      assert.equal(host.routes.size, expectedPaths.length);
      for (const path of expectedPaths) {
        assert.equal(host.routes.has(path), true, `Missing route ${path}`);
      }
      assert.deepEqual(host.route("/state").methods, ["GET"]);
      assert.equal(host.route("/state").requestBody, "buffered");
      assert.deepEqual(host.route("/mutate").methods, ["POST"]);
      assert.equal(host.route("/mutate").requestBody, "streaming");

      const htmlRes = await host.get("/workbench");
      assert.equal(htmlRes.status, 200);
      assert.equal(htmlRes.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(htmlRes.headers.get("x-content-type-options"), "nosniff");
      assert.equal(htmlRes.headers.get("cache-control"), "no-store");
      assert.equal(htmlRes.headers.get("content-security-policy"), EXPECTED_CSP);
      assert.ok((await htmlRes.text()).includes("织章工作台"));

      const cssRes = await host.get("/workbench.css");
      assert.equal(cssRes.status, 200);
      assert.equal(cssRes.headers.get("content-type"), "text/css; charset=utf-8");
      assert.equal(cssRes.headers.get("content-security-policy"), EXPECTED_CSP);

      const jsRes = await host.get(`/${CLIENT_JS_MODULES[0]}`);
      assert.equal(jsRes.status, 200);
      assert.equal(jsRes.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(jsRes.headers.get("x-content-type-options"), "nosniff");
      assert.ok((await jsRes.text()).includes(CLIENT_JS_MODULES[0]));
      assert.equal(CLIENT_ENTRY_HTML, "workbench.html");
      assert.equal(CLIENT_ENTRY_CSS, "workbench.css");
    } finally {
      await host.close();
    }
  });
});

test("host plugin /state supports initial read, project snapshot, and ifSequence conditional no-op", async () => {
  await withTempDir("zhizhang-plugin-state-", async (dataDirectory) => {
    const host = createMockDsHHost();
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const empty = await host.readState();
      assert.equal(empty.status, 200);
      assert.equal(empty.headers.get("cache-control"), "no-store");
      assert.deepEqual(empty.body, { ok: true, result: { projects: [] } });

      const project = (await host.mutate("project.create", { name: "长风卷", product: "fanqie" })).body.result;
      const doc = (await host.mutate("document.create", { projectId: project.id, title: "第一章" })).body.result;

      const snapRes = await host.readState({ projectId: project.id, documentId: doc.id });
      assert.equal(snapRes.status, 200);
      assert.equal(snapRes.body.ok, true);
      const seq = snapRes.body.result.asOfSeq;
      assert.ok(typeof seq === "number" && seq > 0);
      assert.equal(snapRes.body.result.active.title, "第一章");

      const unchanged = await host.readState({
        projectId: project.id,
        documentId: doc.id,
        ifSequence: String(seq),
      });
      assert.deepEqual(unchanged.body, { ok: true, result: { unchanged: true } });

      const stale = await host.readState({
        projectId: project.id,
        documentId: doc.id,
        ifSequence: String(seq - 1),
      });
      assert.equal(stale.body.result.asOfSeq, seq);
      assert.equal(stale.body.result.active.id, doc.id);
    } finally {
      await host.close();
    }
  });
});

test("host plugin /mutate enforces content-type, 2 MiB limit, JSON validation, HTTP status mapping, and 500 diagnosticId logging", async () => {
  await withTempDir("zhizhang-plugin-mutate-", async (dataDirectory) => {
    const host = createMockDsHHost();
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const noType = await host.postRaw("/mutate", {
        contentType: "text/plain",
        body: JSON.stringify({ action: "project.create", product: "fanqie", name: "甲" }),
      });
      assert.equal(noType.status, 400);
      assert.deepEqual((await noType.json()).details, { field: "content-type", reason: "expected-json" });

      const badJson = await host.postRaw("/mutate", {
        contentType: "application/json",
        body: "{invalid",
      });
      assert.equal(badJson.status, 400);
      assert.deepEqual((await badJson.json()).details, { field: "body", reason: "invalid-json" });

      for (const nonObj of ["[]", "123", "null"]) {
        const res = await host.postRaw("/mutate", { contentType: "application/json", body: nonObj });
        assert.equal(res.status, 400);
        assert.deepEqual((await res.json()).details, { field: "body", reason: "expected-object" });
      }

      const oversized = await host.postRaw("/mutate", {
        contentType: "application/json",
        body: "x".repeat(2 * 1024 * 1024 + 1),
      });
      assert.equal(oversized.status, 400);
      assert.deepEqual((await oversized.json()).details, { field: "body", reason: "too-large" });

      const missingAction = await host.mutate(undefined, { name: "x" });
      assert.equal(missingAction.status, 400);
      assert.deepEqual(missingAction.body.details, { field: "action", reason: "required" });

      // Content-Type parameters (e.g. charset=utf-8) are accepted.
      const withCharset = await host.postRaw("/mutate", {
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ action: "project.create", product: "fanqie", name: "编码测试" }),
      });
      assert.equal(withCharset.status, 200);
      const projectId = (await withCharset.json()).result.id;

      const notFound = await host.mutate("document.create", { projectId: "missing-id", title: "章" });
      assert.equal(notFound.status, 404);
      assert.equal(notFound.body.code, "input.not_found");

      const docId = (await host.mutate("document.create", { projectId, title: "第一章" })).body.result.id;
      const rev1 = (await host.mutate("draft.save", { documentId: docId, baseRevisionId: null, body: "v1" })).body.result.revisionId;

      const gateDenied = await host.mutate("draft.finalize", { documentId: docId, baseRevisionId: rev1 });
      assert.equal(gateDenied.status, 409);
      assert.equal(gateDenied.body.code, "gate.denied");

      const conflict = await host.mutate("draft.save", { documentId: docId, baseRevisionId: "stale-rev", body: "v2" });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, "version.conflict");

      // Inject a DB trigger from a separate closed handle to trigger a genuine unexpected SQLite error (HTTP 500 + diagnosticId).
      const aux = openStore(join(dataDirectory, "workspace.sqlite"));
      aux.exec(`
        CREATE TRIGGER test_fail_project BEFORE INSERT ON author_projects
        BEGIN
          SELECT RAISE(ABORT, 'simulated-internal-failure');
        END;
      `);
      aux.close();

      const internal = await host.mutate("project.create", { product: "fanqie", name: "触发500" });
      assert.equal(internal.status, 500);
      assert.equal(internal.body.ok, false);
      assert.equal(internal.body.code, "internal.error");
      assert.equal(typeof internal.body.diagnosticId, "string");
      assert.equal(host.logs.length, 1);
      assert.equal(host.logs[0].message, "zhizhang: request failed");
      assert.equal(host.logs[0].details.diagnosticId, internal.body.diagnosticId);
      assert.equal(typeof host.logs[0].details.name, "string");
    } finally {
      await host.close();
    }
  });
});

test("host plugin handles async 202 run.generate, concurrency locks, run.cancel abort, Toutiao autoQa, and failure propagation", async () => {
  await withTempDir("zhizhang-plugin-gen-", async (dataDirectory) => {
    const fanqieGate = Promise.withResolvers();
    const cancelGate = Promise.withResolvers();
    const toutiaoBody = "文".repeat(1200);

    const llm = createScriptedLlm([
      // Call 0: gated Fanqie generation
      {
        gate: fanqieGate.promise,
        text: "番茄生成候选稿",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      },
      // Call 1: Toutiao write
      {
        text: toutiaoBody,
        usage: { inputTokens: 200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      // Call 2: Toutiao QA fails first pass
      {
        text: JSON.stringify({ overall: 79, passed: false, fails: ["补证据"], hardGates: [] }),
        usage: { inputTokens: 150, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      // Call 3: Toutiao refine
      {
        text: toutiaoBody,
        usage: { inputTokens: 220, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      // Call 4: Toutiao QA passes
      {
        text: JSON.stringify({ overall: 88, passed: true, fails: [], hardGates: [] }),
        usage: { inputTokens: 150, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      // Call 5: gated run that gets cancelled via run.cancel
      {
        gate: cancelGate.promise,
        text: "不会写完",
      },
      // Call 6: run whose stream throws unexpectedly
      {
        throwOnStream: new Error("transport-dropped"),
      },
    ]);

    const host = createMockDsHHost({ llm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      // 1. Fanqie gated generation + concurrency guard + settlement
      const fp = (await host.mutate("project.create", { name: "小说", product: "fanqie" })).body.result.id;
      const fc = (await host.mutate("document.create", { projectId: fp, title: "第一章" })).body.result.id;
      const fRev = (await host.mutate("draft.save", { documentId: fc, baseRevisionId: null, body: "原稿" })).body.result.revisionId;
      const run1 = (await host.mutate("run.start", { documentId: fc, baseRevisionId: fRev, instruction: "续写", tokenLimit: 8000 })).body.result.id;

      const gen1 = await host.mutate("run.generate", { runId: run1, provider: "fixture", model: "test" });
      assert.equal(gen1.status, 202);
      assert.deepEqual(gen1.body, { ok: true, result: { id: run1, generating: true } });

      const dupGen = await host.mutate("run.generate", { runId: run1, provider: "fixture", model: "test" });
      assert.equal(dupGen.status, 409);
      assert.deepEqual(dupGen.body.details, { action: "run.generate", reason: "generation-in-progress" });

      const conflictComplete = await host.mutate("run.complete", { runId: run1, body: "手动", tokens: 10 });
      assert.equal(conflictComplete.status, 409);
      assert.deepEqual(conflictComplete.body.details, { action: "run.complete", reason: "generation-in-progress" });

      fanqieGate.resolve();
      const finishedFanqie = await host.waitFor(async () => {
        const snap = (await host.readState({ projectId: fp, documentId: fc })).body.result;
        return snap.runs[0]?.state === "awaiting-author" ? snap.runs[0] : null;
      });
      assert.equal(finishedFanqie.candidateBody, "番茄生成候选稿");
      assert.equal(finishedFanqie.settled, 165);
      await host.mutate("run.discard", { runId: run1 });

      // 2. Toutiao autoQa over HTTP
      const tp = (await host.mutate("project.create", { name: "专栏", product: "toutiao" })).body.result.id;
      const ta = (await host.mutate("document.create", { projectId: tp, title: "观察标题", mode: "short", line: "资讯线" })).body.result.id;
      const tRev = (await host.mutate("draft.save", { documentId: ta, baseRevisionId: null, body: toutiaoBody })).body.result.revisionId;
      const run2 = (await host.mutate("run.start", { documentId: ta, baseRevisionId: tRev, instruction: "写短评", tokenLimit: 12000 })).body.result.id;

      const gen2 = await host.mutate("run.generate", { runId: run2, provider: "fixture", model: "test", autoQa: true });
      assert.equal(gen2.status, 202);
      const finishedToutiao = await host.waitFor(async () => {
        const snap = (await host.readState({ projectId: tp, documentId: ta })).body.result;
        return snap.runs[0]?.state === "awaiting-author" ? snap.runs[0] : null;
      });
      assert.equal(finishedToutiao.refinementRounds, 1);
      assert.equal(JSON.parse(finishedToutiao.candidateQa).overall, 88);
      assert.equal(finishedToutiao.settled, 200 + 300 + 150 + 40 + 220 + 300 + 150 + 40);

      // 3. run.cancel aborts active LLM signal
      const fc2 = (await host.mutate("document.create", { projectId: fp, title: "第二章" })).body.result.id;
      const f2Rev = (await host.mutate("draft.save", { documentId: fc2, baseRevisionId: null, body: "原稿二" })).body.result.revisionId;
      const run3 = (await host.mutate("run.start", { documentId: fc2, baseRevisionId: f2Rev, instruction: "写", tokenLimit: 8000 })).body.result.id;
      assert.equal((await host.mutate("run.generate", { runId: run3, provider: "fixture", model: "test" })).status, 202);
      await host.waitFor(() => llm.calls.length === 6);
      const cancelSignal = llm.calls[5].signal;
      assert.equal(cancelSignal.aborted, false);
      assert.equal((await host.mutate("run.cancel", { runId: run3 })).status, 200);
      assert.equal(cancelSignal.aborted, true);
      const cancelledRun = await host.waitFor(async () => {
        const snap = (await host.readState({ projectId: fp, documentId: fc2 })).body.result;
        const entry = snap.runs[0];
        return entry?.state === "cancelled" && entry.generationState === "uncertain" ? entry : null;
      });
      assert.equal(cancelledRun.candidateBody, null);

      // Reconcile the uncertain attempt on fc2 so the document unlocks for another run.
      const cancelDetail = (await host.mutate("run.detail", { documentId: fc2, runId: run3 })).body.result;
      await host.mutate("run.reconcile", {
        documentId: fc2,
        runId: run3,
        attemptId: cancelDetail.attempts[0].id,
        tokens: 0,
      });

      // 4. budget.exhausted (input reservation) & unexpected stream failure
      const runBudget = (await host.mutate("run.start", { documentId: fc, baseRevisionId: fRev, instruction: "小预算", tokenLimit: 50 })).body.result.id;
      assert.equal((await host.mutate("run.generate", { runId: runBudget, provider: "fixture", model: "test" })).status, 202);
      const budgetFailed = await host.waitFor(async () => {
        const snap = (await host.readState({ projectId: fp, documentId: fc })).body.result;
        return snap.runs.find((r) => r.id === runBudget && r.state === "failed");
      });
      assert.equal(budgetFailed.generationError, "budget.exhausted");

      const runStreamErr = (await host.mutate("run.start", { documentId: fc2, baseRevisionId: f2Rev, instruction: "出错", tokenLimit: 8000 })).body.result.id;
      assert.equal((await host.mutate("run.generate", { runId: runStreamErr, provider: "fixture", model: "test" })).status, 202);
      const streamFailed = await host.waitFor(async () => {
        const snap = (await host.readState({ projectId: fp, documentId: fc2 })).body.result;
        return snap.runs.find((r) => r.id === runStreamErr && r.state === "failed");
      });
      assert.equal(streamFailed.generationError, "generation.failed");
    } finally {
      await host.close();
    }
  });
});

test("host plugin enforces atomic writeDelivery, export.conflict protection, and startup recovery", async () => {
  await withTempDir("zhizhang-plugin-export-", async (dataDirectory) => {
    const prepareArticle = async (host, projectId, title) => {
      const docId = (await host.mutate("document.create", { projectId, title, mode: "short", line: "资讯线" })).body.result.id;
      const revId = (await host.mutate("draft.save", { documentId: docId, baseRevisionId: null, body: "稿".repeat(1100) })).body.result.revisionId;
      await host.mutate("article.qa", { documentId: docId, baseRevisionId: revId, score: 86, passed: true, fails: [] });
      await host.mutate("article.accept", { documentId: docId, baseRevisionId: revId, accept: true });
      await host.mutate("approval.decide", { documentId: docId, baseRevisionId: revId, confirmed: true });
      return { docId, revId };
    };

    const host1 = createMockDsHHost();
    applyWorkbench(host1.ctx, { dataDirectory }, { readAsset: host1.readAsset });
    let projectId;
    let doc1;
    let doc2;
    let doc3;
    try {
      projectId = (await host1.mutate("project.create", { name: "交稿测试", product: "toutiao" })).body.result.id;
      doc1 = await prepareArticle(host1, projectId, "正常交稿");
      doc2 = await prepareArticle(host1, projectId, "冲突交稿");
      doc3 = await prepareArticle(host1, projectId, "重启恢复");

      // 1. Atomic writeDelivery + idempotent retry
      const delivered1 = (await host1.mutate("article.deliver", { documentId: doc1.docId, baseRevisionId: doc1.revId, key: "k1" })).body.result;
      assert.equal(delivered1.state, "exported");
      assert.equal(delivered1.wrote, true);
      const file1 = join(dataDirectory, "deliveries", `${doc1.docId}.md`);
      const content1 = readFileSync(file1, "utf8");
      assert.ok(content1.startsWith("# 正常交稿\n\n"));
      assert.ok(content1.endsWith(`${DELIVERY_ENDING}\n`));
      assert.equal(readdirSync(join(dataDirectory, "deliveries")).some((name) => name.startsWith(".")), false);

      const secondAttempt = (await host1.mutate("article.deliver", { documentId: doc1.docId, baseRevisionId: doc1.revId, key: "k1" })).body.result;
      assert.equal(secondAttempt.wrote, false);

      // 2. Existing differing file triggers non-retryable export.conflict without overwriting author's file
      const file2 = join(dataDirectory, "deliveries", `${doc2.docId}.md`);
      writeFileSync(file2, "作者原有手工文件", "utf8");
      const delivered2 = (await host1.mutate("article.deliver", { documentId: doc2.docId, baseRevisionId: doc2.revId, key: "k2" })).body.result;
      assert.equal(delivered2.state, "failed");
      assert.equal(delivered2.retryable, false);
      assert.equal(readFileSync(file2, "utf8"), "作者原有手工文件");

      // 3. Deliver doc3 so we can simulate a crash before file write by resetting its delivery export_state to 'pending'
      assert.equal(
        (await host1.mutate("article.deliver", { documentId: doc3.docId, baseRevisionId: doc3.revId, key: "k3" })).body.result.state,
        "exported",
      );
    } finally {
      await host1.close();
    }

    const file3 = join(dataDirectory, "deliveries", `${doc3.docId}.md`);
    rmSync(file3);
    const patchDb = openStore(join(dataDirectory, "workspace.sqlite"));
    patchDb.prepare("UPDATE deliveries SET export_state = 'pending', export_hash = NULL, export_error = NULL WHERE article_id = ?;")
      .run(doc3.docId);
    patchDb.close();

    // Reopen plugin: startup recovery automatically exports pending doc3, but leaves conflict doc2 untouched.
    const host2 = createMockDsHHost();
    applyWorkbench(host2.ctx, { dataDirectory }, { readAsset: host2.readAsset });
    try {
      assert.equal(existsSync(file3), true);
      assert.ok(readFileSync(file3, "utf8").startsWith("# 重启恢复\n\n"));
      const snap3 = (await host2.readState({ projectId, documentId: doc3.docId })).body.result;
      assert.equal(snap3.exportStatus.state, "exported");

      const file2 = join(dataDirectory, "deliveries", `${doc2.docId}.md`);
      assert.equal(readFileSync(file2, "utf8"), "作者原有手工文件");
      const snap2Before = (await host2.readState({ projectId, documentId: doc2.docId })).body.result;
      assert.equal(snap2Before.exportStatus.state, "failed");
      assert.ok(snap2Before.exportStatus.error.includes("export.conflict"));

      // Once author resolves the conflicting file, retrying article.deliver with the same key completes export.
      rmSync(file2);
      const retry2 = (await host2.mutate("article.deliver", { documentId: doc2.docId, baseRevisionId: doc2.revId, key: "k2" })).body.result;
      assert.equal(retry2.state, "exported");
      assert.equal(retry2.wrote, true);
      assert.ok(readFileSync(file2, "utf8").startsWith("# 冲突交稿\n\n"));
    } finally {
      await host2.close();
    }
  });
});

test("host plugin shutdown aborts active generation, returns 503 to in-flight requests, disposes routes, and recovers on reopen", async () => {
  await withTempDir("zhizhang-plugin-close-", async (dataDirectory) => {
    mkdirSync(dataDirectory, { recursive: true });
    const dbPath = join(dataDirectory, "workspace.sqlite");
    if (!existsSync(dbPath)) createStore(dbPath);
    openStore(dbPath).close();

    const gate = Promise.withResolvers();
    const llm = createScriptedLlm([{ gate: gate.promise, text: "未完成" }]);
    const host1 = createMockDsHHost({ llm });
    applyWorkbench(host1.ctx, { dataDirectory }, { readAsset: host1.readAsset });

    const mutateRoute = host1.route("/mutate").fetch;
    const projectId = (await host1.mutate("project.create", { name: "关闭测试", product: "fanqie" })).body.result.id;
    const docId = (await host1.mutate("document.create", { projectId, title: "第一章" })).body.result.id;
    const revId = (await host1.mutate("draft.save", { documentId: docId, baseRevisionId: null, body: "正文" })).body.result.revisionId;
    const runId = (await host1.mutate("run.start", { documentId: docId, baseRevisionId: revId, instruction: "写", tokenLimit: 8000 })).body.result.id;

    assert.equal((await host1.mutate("run.generate", { runId, provider: "fixture", model: "test" })).status, 202);
    await host1.waitFor(() => llm.calls.length === 1);
    const activeSignal = llm.calls[0].signal;

    await host1.close();
    assert.equal(activeSignal.aborted, true);
    assert.equal(host1.disposedPaths.length, 5 + CLIENT_JS_MODULES.length);
    assert.equal(host1.routes.size, 0);

    // Calling the previously captured /mutate handler after shutdown returns 503 without touching closed SQLite.
    const postCloseRes = await mutateRoute(
      new Request("http://dsh.local/api/zhizhang/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "project.create", name: "late", product: "fanqie" }),
      }),
    );
    assert.equal(postCloseRes.status, 503);

    // Give background task .finally() a turn before reopening cleanly.
    await new Promise((resolve) => setImmediate(resolve));

    const host2 = createMockDsHHost();
    applyWorkbench(host2.ctx, { dataDirectory }, { readAsset: host2.readAsset });
    try {
      const snap = (await host2.readState({ projectId, documentId: docId })).body.result;
      assert.equal(snap.active.title, "第一章");
      assert.equal(snap.runs[0].state, "failed");
      assert.equal(snap.runs[0].generationState, "uncertain");
    } finally {
      await host2.close();
    }
  });
});
