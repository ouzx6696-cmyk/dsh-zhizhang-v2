import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createModalController } from "../src/client/workbench/modal.ts";
import { createActionCoordinator } from "../src/client/workbench/store.ts";
import { renderRunInspector } from "../src/client/workbench/views/run-inspector.ts";
import { ContractError, createApproval } from "../src/contracts/index.ts";
import { detectLoreConflicts, planTreeChapterMove } from "../src/domain/fanqie/index.ts";
import { resolveAnchor } from "../src/domain/shared/index.ts";
import { refineArticle } from "../src/domain/toutiao/refinement.ts";
import { applyWorkbench } from "../src/host/plugin.ts";
import { openAuthorWorkspace } from "../src/host/workspace.ts";
import {
  buildRecoveryHints,
  createSingleShotCaller,
} from "../src/host/writing.ts";
import { createToutiaoGenerationRunner } from "../src/application/products/toutiao.ts";
import { createGenerationLedger } from "../src/storage/author-generation.ts";
import { createHotBackup, restoreWorkspace } from "../src/storage/backup.ts";
import {
  StorageError,
  appendEvent,
  appliedMigrations,
  createCommandSchema,
  createDocument,
  createStore,
  inTransaction,
  openDatabase,
  openStore,
  pruneCommandJournal,
  restoreBackup,
  runAuthorWrite,
  runMigrations,
  saveDraft,
  verifyBackup,
  withReadTx,
  withWriteTx,
} from "../src/storage/index.ts";
import { createAuthorModelReader } from "../src/workflow/author-reads.ts";
import { assembleContextBundle } from "../src/workflow/context-slots.ts";
import { createRun } from "../src/workflow/runstate.ts";
import { computeRunBilling, createWritingBudgetGuard } from "../src/workflow/writing-budget.ts";
import {
  assertRejectsContract,
  createMockDsHHost,
  createReceiptLedger,
  createScriptedLlm,
  createTestWorkspace,
  withBrowserGlobals,
  withTempDir,
} from "../support/v2-harness.mjs";

test("tx.ts enforces SAVEPOINT nesting, refuses write-inside-read, and keeps author-generation ledger atomic", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY);");

  assert.equal(inTransaction(db), null);
  withWriteTx(db, () => {
    assert.equal(inTransaction(db), "write");
    db.prepare("INSERT INTO items VALUES ('outer-before');").run();

    assert.throws(() => {
      withWriteTx(db, () => {
        db.prepare("INSERT INTO items VALUES ('inner-rolled-back');").run();
        throw new Error("inner-abort");
      });
    }, { message: "inner-abort" });

    withReadTx(db, () => {
      assert.equal(inTransaction(db), "write");
      const count = db.prepare("SELECT COUNT(*) AS n FROM items;").get().n;
      assert.equal(count, 1);
    });
    db.prepare("INSERT INTO items VALUES ('outer-after');").run();
  });
  assert.equal(inTransaction(db), null);
  assert.deepEqual(
    db.prepare("SELECT id FROM items ORDER BY rowid;").all().map((r) => r.id),
    ["outer-before", "outer-after"],
  );

  withReadTx(db, () => {
    assert.equal(inTransaction(db), "read");
    assert.throws(
      () => withWriteTx(db, () => {}),
      (err) => err instanceof StorageError && err.code === "gate.denied" && err.details.reason === "write-inside-read-tx",
    );
  });

  // Author generation ledger beginCall & receiveCall roll back atomically on partial failure.
  const ws = createTestWorkspace(t);
  const { documentId, revisionId } = ws.createFanqieChapter();
  const runId = ws.app.mutation("run.start", {
    documentId,
    baseRevisionId: revisionId,
    instruction: "写",
    tokenLimit: 8000,
  }).id;
  const ledger = createGenerationLedger(ws.db);
  ledger.create("att-1", runId, "fixture", "m");

  ws.db.exec(`
    CREATE TRIGGER fail_call_insert BEFORE INSERT ON author_generation_calls
    BEGIN SELECT RAISE(ABORT, 'inject-call-fail'); END;
  `);
  assert.throws(() => ledger.beginCall("att-1", "call-1", "write", 100, 200), { message: "inject-call-fail" });
  ws.db.exec("DROP TRIGGER fail_call_insert;");
  assert.equal(ws.db.prepare("SELECT state FROM author_generation_attempts WHERE id = 'att-1';").get().state, "prepared");

  assert.equal(ledger.beginCall("att-1", "call-1", "write", 100, 200), true);
  ws.db.exec(`
    CREATE TRIGGER fail_attempt_receive BEFORE UPDATE OF usage ON author_generation_attempts
    BEGIN SELECT RAISE(ABORT, 'inject-receive-fail'); END;
  `);
  assert.throws(() => ledger.receiveCall("att-1", "call-1", [10, 20, 0, 0]), { message: "inject-receive-fail" });
  ws.db.exec("DROP TRIGGER fail_attempt_receive;");
  assert.equal(ws.db.prepare("SELECT usage FROM author_generation_calls WHERE id = 'call-1';").get().usage, null);
});

test("migrations.ts applies schema migrations atomically, rolls back failed migrations, and skips applied ones", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let shouldFail = true;

  const migrations = [
    {
      id: "m1-base",
      up(conn) {
        conn.exec("CREATE TABLE mig_test (id TEXT PRIMARY KEY);");
      },
    },
    {
      id: "m2-atomic",
      up(conn) {
        conn.exec("INSERT INTO mig_test VALUES ('partial');");
        if (shouldFail) throw new Error("mid-migration-crash");
      },
    },
  ];

  assert.throws(() => runMigrations(db, migrations), { message: "mid-migration-crash" });
  assert.deepEqual(appliedMigrations(db), ["m1-base"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mig_test;").get().n, 0);

  shouldFail = false;
  const secondRun = runMigrations(db, migrations);
  assert.deepEqual(secondRun, ["m2-atomic"]);
  assert.deepEqual(appliedMigrations(db), ["m1-base", "m2-atomic"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mig_test;").get().n, 1);
  assert.deepEqual(runMigrations(db, migrations), []);
});

test("openStore enables WAL/FK/busy_timeout, createHotBackup snapshots live WAL, and restore cleans sidecars read-only", async () => {
  await withTempDir("zhizhang-hotbak-", async (root) => {
    const liveDir = join(root, "live");
    mkdirSync(liveDir, { recursive: true });
    const dbPath = join(liveDir, "workspace.sqlite");
    createStore(dbPath);
    const liveDb = openStore(dbPath);
    try {
      assert.equal(liveDb.prepare("PRAGMA foreign_keys;").get().foreign_keys, 1);
      assert.equal(String(liveDb.prepare("PRAGMA journal_mode;").get().journal_mode).toLowerCase(), "wal");
      assert.equal(liveDb.prepare("PRAGMA busy_timeout;").get().timeout, 5000);

      const app = openAuthorWorkspace(liveDb);
      const proj = app.mutation("project.create", { product: "fanqie", name: "热备测试" });
      const ch = app.mutation("document.create", { projectId: proj.id, title: "第一章" });
      app.mutation("draft.save", { documentId: ch.id, baseRevisionId: null, body: "WAL未落盘内容" });

      const backupDir = join(root, "hot-backup");
      const manifest = await createHotBackup(liveDb, backupDir);
      assert.equal(manifest.entries.length, 1);
      await verifyBackup(backupDir);

      // restoreWorkspace must verify read-only without mutating backup/work.db hash.
      const restoredDir = join(root, "restored");
      await restoreWorkspace(backupDir, restoredDir);
      await verifyBackup(backupDir);

      const restoredDb = openStore(join(restoredDir, "workspace.sqlite"));
      try {
        const restoredApp = openAuthorWorkspace(restoredDb);
        assert.equal(restoredApp.snapshot(proj.id, ch.id).active.body, "WAL未落盘内容");
      } finally {
        restoredDb.close();
      }

      // restoreBackup with overwrite deletes stale -wal / -shm sidecars in targetDir.
      const overwriteTarget = join(root, "overwrite-target");
      mkdirSync(overwriteTarget, { recursive: true });
      writeFileSync(join(overwriteTarget, "work.db-wal"), "stale-wal", "utf8");
      writeFileSync(join(overwriteTarget, "work.db-shm"), "stale-shm", "utf8");
      await restoreBackup(backupDir, overwriteTarget, { overwrite: true });
      assert.equal(existsSync(join(overwriteTarget, "work.db-wal")), false);
      assert.equal(existsSync(join(overwriteTarget, "work.db-shm")), false);
    } finally {
      liveDb.close();
    }
  });
});

test("command_journal stores request_hash and pruneCommandJournal compacts/prunes while preserving replay & mismatch", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  createCommandSchema(db);
  createDocument(db, "doc-1");
  const first = saveDraft(
    db,
    { actorId: "author", documentId: "doc-1", idempotencyKey: "k-old", baseRevisionId: null, body: "第一版" },
    { revisionId: "rev-1", createdAt: 1 },
  );
  const oldRow = db.prepare("SELECT request_hash, created_at FROM command_journal WHERE request_key = 'k-old';").get();
  assert.match(oldRow.request_hash, /^[a-f0-9]{64}$/);
  assert.ok(oldRow.created_at > 0);

  // Backdate k-old by 10 days -> compact payload while keeping request_hash.
  const now = Date.now();
  db.prepare("UPDATE command_journal SET created_at = ? WHERE request_key = 'k-old';").run(now - 10 * 86_400_000);
  const compacted = pruneCommandJournal(db, { nowMs: now });
  assert.equal(compacted.compacted, 1);
  assert.equal(compacted.deleted, 0);
  assert.equal(db.prepare("SELECT request_payload FROM command_journal WHERE request_key = 'k-old';").get().request_payload, "");

  // Replay with same payload succeeds; different payload rejects via request_hash.
  const replayed = saveDraft(
    db,
    { actorId: "author", documentId: "doc-1", idempotencyKey: "k-old", baseRevisionId: null, body: "第一版" },
    { revisionId: "ignored", createdAt: 2 },
  );
  assert.deepEqual(replayed, { replayed: true, revisionId: first.revisionId });
  assert.throws(
    () =>
      saveDraft(
        db,
        { actorId: "author", documentId: "doc-1", idempotencyKey: "k-old", baseRevisionId: null, body: "篡改版" },
        { revisionId: "ignored", createdAt: 3 },
      ),
    (err) => err instanceof StorageError && err.code === "idempotency.mismatch",
  );

  // Insert expired draft.save (>35d) + expired article.deliver (>35d) + 2 recent writes; keepRecent=2.
  const expiredTs = now - 35 * 86_400_000;
  runAuthorWrite(
    db,
    { actorId: "author", commandId: "article.deliver", documentId: "doc-1", idempotencyKey: "k-deliv", payload: { ok: true }, baseRevisionId: first.revisionId },
    () => ({ ok: true }),
    { baseCheck: false },
  );
  db.prepare("UPDATE command_journal SET created_at = ? WHERE request_key IN ('k-old', 'k-deliv');").run(expiredTs);
  saveDraft(
    db,
    { actorId: "author", documentId: "doc-1", idempotencyKey: "k-r1", baseRevisionId: first.revisionId, body: "第二版" },
    { revisionId: "rev-2", createdAt: 4 },
  );
  saveDraft(
    db,
    { actorId: "author", documentId: "doc-1", idempotencyKey: "k-r2", baseRevisionId: "rev-2", body: "第三版" },
    { revisionId: "rev-3", createdAt: 5 },
  );
  const pruned = pruneCommandJournal(db, { nowMs: now, keepRecentPerDocument: 2 });
  assert.equal(pruned.deleted, 1); // k-old deleted, k-deliv preserved!
  const remainingKeys = db.prepare("SELECT request_key FROM command_journal ORDER BY rowid;").all().map((r) => r.request_key);
  assert.deepEqual(remainingKeys, ["k-deliv", "k-r1", "k-r2"]);
});

test("workflow runstate, writing-budget, context-slots, and author-reads enforce terminal guards, billing, framing, and paged replay", (t) => {
  // 1. recordLateUsage intercepts all terminal states
  for (const terminal of ["cancelled", "applied", "discarded"]) {
    const run = createRun();
    if (terminal !== "cancelled") run.transition("awaiting-author");
    run.transition(terminal);
    assert.deepEqual(run.recordLateUsage(75), { state: terminal, applied: false });
    assert.deepEqual(run.usage, { settled: 0, pendingLate: 75 });
  }

  // 2. Independent inputBudget limit & computeRunBilling
  const guard = createWritingBudgetGuard(100_000);
  assert.throws(
    () => guard.reserve(64_001),
    (err) => err instanceof ContractError && err.code === "budget.exhausted" && err.details.reason === "estimate-exceeds-input-budget",
  );
  const customGuard = createWritingBudgetGuard(20_000, 0, 1500);
  assert.throws(
    () => customGuard.reserve(1501),
    (err) => err instanceof ContractError && err.code === "budget.exhausted" && err.details.scope === "stage-input",
  );
  const unknownBilling = computeRunBilling([null]);
  assert.equal(unknownBilling.effectiveBilledTokens, null);
  assert.equal(unknownBilling.cacheHitRate, null);
  const billing = computeRunBilling([
    [1000, 200, 600, 100],
    [1000, 100, 800, 0],
  ]);
  assert.equal(billing.effectiveBilledTokens, (1000 - 600 + 200) + (1000 - 800 + 100));
  assert.equal(billing.cacheHitRate, 1400 / 2000);

  // 3. context-slots dynamic framing & overBudget flag
  const tight = assembleContextBundle({
    slots: [
      { id: "a", label: "超长关键规则", group: "prefix", priority: "critical", content: "字".repeat(260) },
      { id: "b", label: "超长关键正文", group: "dynamic", priority: "critical", content: "文".repeat(260) },
    ],
    maxInputTokens: 256,
  });
  assert.ok((tight.report.framingTokens ?? 0) > 0);
  assert.equal(tight.report.overBudget, true);

  // 4. author-reads multi-stage checkpoints & >1000 paginated replay
  const ws = createTestWorkspace(t);
  const projectId = ws.app.mutation("project.create", { product: "fanqie", name: "分页回放" }).id;
  appendEvent(ws.db, {
    projectId,
    eventId: "e-run-start",
    kind: "run.started",
    payload: { concern: "run", runId: "r1", reserved: 10_000 },
  });
  appendEvent(ws.db, {
    projectId,
    eventId: "e-stage-1",
    kind: "run.attempt",
    payload: { concern: "run", runId: "r1", stage: "draft.write.candidate", outputRef: "cand-1", usage: 100 },
  });
  appendEvent(ws.db, {
    projectId,
    eventId: "e-stage-2",
    kind: "run.attempt",
    payload: { concern: "run", runId: "r1", stage: "article.qa.review", outputRef: "qa-1", usage: 50 },
  });
  const runRead = ws.app.mutation("read.model", { projectId, model: "run", runId: "r1" });
  assert.equal(runRead.value.checkpoints.length, 2);
  assert.deepEqual(
    runRead.value.checkpoints.map((c) => c.stage),
    ["draft.write.candidate", "article.qa.review"],
  );

  // Append 1150 chapter events, cold-read via fresh reader -> paged replay across 2 pages
  for (let i = 0; i < 1150; i += 1) {
    appendEvent(ws.db, {
      projectId,
      eventId: `e-ch-${i}`,
      kind: "document.created",
      payload: { concern: "chapter", documentId: `ch-${i}`, title: `第${i + 1}章`, state: "planned" },
    });
  }
  const coldReader1 = createAuthorModelReader(ws.db);
  const nav1 = coldReader1(projectId, { model: "navigation" });
  assert.equal(nav1.folded, 1154);
  assert.equal(nav1.value.volumes[0].chapters.length, 1150);

  // Append 1050 more events and reopen a second cold reader from durable checkpoint
  for (let i = 1150; i < 2200; i += 1) {
    appendEvent(ws.db, {
      projectId,
      eventId: `e-ch-${i}`,
      kind: "document.created",
      payload: { concern: "chapter", documentId: `ch-${i}`, title: `第${i + 1}章`, state: "planned" },
    });
  }
  const coldReader2 = createAuthorModelReader(ws.db);
  const nav2 = coldReader2(projectId, { model: "navigation" });
  assert.equal(nav2.folded, 1050);
  assert.equal(nav2.value.volumes[0].chapters.length, 2200);
});

test("Toutiao Prefix Cache, keepBest/AbortSignal refinement, host recoveryHints, proposal locks/cancel, and startup recovery", async (t) => {
  // 1. refineArticle keepBest & AbortSignal
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    refineArticle("初稿", async () => ({ overall: 70, passed: false, fails: [], hardGates: [] }), async (b) => b, { signal: ac.signal }),
    { name: "AbortError" },
  );

  let round = 0;
  const bestKept = await refineArticle(
    "零改",
    async () => {
      round += 1;
      if (round === 1) return { overall: 75, passed: false, fails: ["弱"], hardGates: [] };
      if (round === 2) return { overall: 82, passed: false, fails: ["小瑕疵"], hardGates: [] };
      return { overall: 68, passed: false, fails: ["越改越差"], hardGates: [] };
    },
    async (_body, qa) => `第${round}改(${qa.overall})`,
  );
  assert.equal(bestKept.rounds, 2);
  assert.equal(bestKept.qa.overall, 82);
  assert.equal(bestKept.body, "第1改(75)");

  // 2. Toutiao generation runner shares identical cachePrefix across write -> qa (thinking=false) -> refine
  const ws = createTestWorkspace(t);
  const art = ws.createToutiaoArticle({ title: "缓存标题", body: "短".repeat(1200) });
  const runId = ws.app.mutation("run.start", {
    documentId: art.documentId,
    baseRevisionId: art.revisionId,
    instruction: "优化开篇",
    tokenLimit: 12_000,
  }).id;
  const genInput = ws.app.generationInput({ runId, provider: "fixture", model: "test", autoQa: true }, false);
  const bodyValid = "文".repeat(1200);
  const llm = createScriptedLlm([
    { text: bodyValid },
    { text: JSON.stringify({ overall: 76, passed: false, fails: ["补细节"], hardGates: [] }) },
    { text: bodyValid },
    { text: JSON.stringify({ overall: 88, passed: true, fails: [], hardGates: [] }) },
  ]);
  const runner = createToutiaoGenerationRunner();
  const caller = createSingleShotCaller(llm, genInput, new AbortController().signal, createReceiptLedger());
  const toutiaoOut = await runner({ caller, run: genInput, signal: new AbortController().signal, reserveRefinement: () => {} });
  assert.equal(toutiaoOut.rounds, 1);
  assert.ok(llm.calls[0].options.cachePrefix);
  assert.equal(llm.calls[1].options.cachePrefix, llm.calls[0].options.cachePrefix);
  assert.equal(llm.calls[2].options.cachePrefix, llm.calls[0].options.cachePrefix);
  assert.equal(llm.calls[1].options.thinking, false);

  // 3. Recovery hints + inflightTokens deduction + disableThinking
  const thinkingExhaustedLlm = createScriptedLlm([
    {
      chunks: [
        { type: "block-end", index: 0, block: { type: "thinking", text: "很长的思考" } },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 500 } },
        { type: "finish", reason: { kind: "length" } },
      ],
    },
  ]);
  const c2 = createSingleShotCaller(thinkingExhaustedLlm, { provider: "f", model: "m", reserved: 4000 }, new AbortController().signal, createReceiptLedger());
  await assertRejectsContract(c2.complete({ phase: "write", system: "s", prompt: "p" }), "stage.output_invalid");
  assert.equal(buildRecoveryHints("thinking_exhausted")[0].action, "disable_thinking");
  assert.equal(buildRecoveryHints("output_truncated")[0].action, "increase_output_limit");
  assert.equal(buildRecoveryHints(null, "budget.exhausted")[0].action, "increase_budget");

  // 4. Host plugin: proposal lock/cancel, recoveryHints persistence, GET /state 503 after close, recoverStartup()
  await withTempDir("zhizhang-host-s1-", async (dataDirectory) => {
    const propGate = Promise.withResolvers();
    const hostLlm = createScriptedLlm([
      {
        gate: propGate.promise,
        text: JSON.stringify({ summary: "不会到达" }),
      },
      {
        chunks: [
          { type: "text-delta", index: 0, text: "未写完" },
          { type: "usage", usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 60 } },
          { type: "finish", reason: { kind: "length" } },
        ],
      },
    ]);
    const host = createMockDsHHost({ llm: hostLlm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    const stateRoute = host.route("/state").fetch;

    const pid = (await host.mutate("project.create", { product: "fanqie", name: "宿主闭环" })).body.result.id;
    const did = (await host.mutate("document.create", { projectId: pid, title: "第一章" })).body.result.id;
    const rev = (await host.mutate("draft.save", { documentId: did, baseRevisionId: null, body: "正文" })).body.result.revisionId;

    const p1 = await host.mutate("proposal.generate", { kind: "summary", documentId: did, provider: "f", model: "m" });
    assert.equal(p1.status, 202);
    await host.waitFor(() => hostLlm.calls.length === 1);
    assert.equal(hostLlm.calls[0].options.thinking, false);

    // Concurrent duplicate proposal lock -> 409
    const pDup = await host.mutate("proposal.generate", { kind: "summary", documentId: did, provider: "f", model: "m" });
    assert.equal(pDup.status, 409);
    assert.equal(pDup.body.details.reason, "proposal-in-progress");

    // proposal.cancel aborts & marks failed
    const cancelled = await host.mutate("proposal.cancel", { proposalId: p1.body.result.id });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.result.cancelled, true);

    // Failed truncated run persists recoveryHints & billing in run.detail
    const runId2 = (await host.mutate("run.start", { documentId: did, baseRevisionId: rev, instruction: "写", tokenLimit: 8000 })).body.result.id;
    assert.equal((await host.mutate("run.generate", { runId: runId2, provider: "f", model: "m" })).status, 202);
    await host.waitFor(async () => {
      const snap = (await host.readState({ projectId: pid, documentId: did })).body.result;
      return snap.runs[0]?.state === "failed" ? snap.runs[0] : null;
    });
    const detail = (await host.mutate("run.detail", { documentId: did, runId: runId2 })).body.result;
    assert.equal(detail.recoveryHints[0].kind, "output_truncated");
    assert.equal(detail.billing.effectiveBilledTokens, 80);
    assert.equal(detail.billing.cacheHitRate, 0.6);
    assert.ok(detail.contextTrace);

    await host.close();
    const afterCloseState = await stateRoute(new Request("http://dsh.local/api/zhizhang/state"));
    assert.equal(afterCloseState.status, 503);
  });

  // recoverStartup recovers interrupted generation attempts
  const wsRecover = createTestWorkspace(t);
  const recChap = wsRecover.createFanqieChapter();
  const rRec = wsRecover.app.mutation("run.start", {
    documentId: recChap.documentId,
    baseRevisionId: recChap.revisionId,
    instruction: "写",
    tokenLimit: 8000,
  }).id;
  const gIn = wsRecover.app.generationInput({ runId: rRec, provider: "f", model: "m" }, true);
  wsRecover.app.beginGenerationCall(gIn.attemptId, "write", 100, 500);
  wsRecover.app.recoverStartup();
  assert.equal(wsRecover.app.snapshot(recChap.projectId, recChap.documentId).runs[0].generationState, "uncertain");
});

test("contracts and domain fixes enforce fixed diagnosticId, non-blank approvals, safe anchors, sorted move siblings, and exact lore conflicts", () => {
  const err = new ContractError("input.invalid", { field: "x", reason: "bad" });
  assert.equal(err.diagnosticId, err.toEnvelope().diagnosticId);
  assert.equal(err.toEnvelope().diagnosticId, err.toEnvelope().diagnosticId);

  const blankApproval = createApproval({
    actor: "   ",
    action: "article.deliver",
    target: "a1",
    targetVersion: "v1",
    decision: "approved",
    at: "2026-11-20T00:00:00Z",
  });
  assert.equal(blankApproval.ok, false);

  assert.deepEqual(resolveAnchor({ chapterId: "c1", point: 1 }, { paragraphs: [] }), { paragraphIndex: 0, start: 0, text: "" });
  assert.deepEqual(resolveAnchor({ chapterId: "c1", point: Number.NaN }, { paragraphs: ["第一段", "第二段"] }), { paragraphIndex: 0, start: 0, text: "第一段" });

  // planTreeChapterMove respects beforeOrder when chapters input order differs
  const moved = planTreeChapterMove(
    [{ id: "v1", sortOrder: 1 }],
    [{ id: "a1", volumeId: "v1", sortOrder: 1 }],
    [
      { id: "c3", volumeId: "v1", actId: "a1" },
      { id: "c1", volumeId: "v1", actId: "a1" },
      { id: "c2", volumeId: "v1", actId: "a1" },
    ],
    ["c1", "c2", "c3"],
    { chapterId: "c3", targetVolumeId: "v1", targetActId: "a1", targetIndex: 1 },
  );
  assert.deepEqual(moved.afterOrder, ["c1", "c3", "c2"]);

  // detectLoreConflicts boundary match (f1 must not hit f10) + inverted validity + known-before-effective
  const conflicts = detectLoreConflicts(
    [
      {
        id: "f1",
        note: "设定一",
        source: "笔记",
        kind: "fact",
        locked: false,
        effectiveFrom: { chapterId: "c1", point: 1 },
        effectiveTo: { chapterId: "c2", point: 1 },
        knownFrom: {},
      },
      {
        id: "f10",
        note: "设定十",
        source: "笔记",
        kind: "fact",
        locked: false,
        effectiveFrom: { chapterId: "c1", point: 1 },
        knownFrom: {},
      },
      {
        id: "inv-fact",
        note: "倒置",
        source: "笔记",
        kind: "fact",
        locked: false,
        effectiveFrom: { chapterId: "c2", point: 2 },
        effectiveTo: { chapterId: "c1", point: 1 },
        knownFrom: { 林: { chapterId: "c1", point: 1 } },
      },
    ],
    [],
    ["c1", "c2"],
    [{ chapterId: "c2", lockedFacts: "锁定 f10" }],
  );
  assert.equal(conflicts.some((c) => c.kind === "outline-fact-mismatch" && c.targetId === "f1"), false);
  assert.ok(conflicts.some((c) => c.kind === "inverted-validity-interval" && c.targetId === "inv-fact"));
  assert.ok(conflicts.some((c) => c.kind === "known-before-effective" && c.targetId === "inv-fact"));
});

test("client P0 fixes: modal re-entrancy/focus order, dual-channel coordinator, run inspector billing, CSS variables, and shell decoupling", async () => {
  // 1. Modal controller re-entrancy & showModal before focus
  const events = [];
  function makeNode(tag) {
    return {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      value: "",
      placeholder: "",
      rows: 0,
      type: "",
      children: [],
      open: false,
      oncancel: null,
      onsubmit: null,
      onclick: null,
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      showModal() { this.open = true; events.push("showModal"); },
      close() { this.open = false; events.push("close"); },
      focus() { events.push(`focus:${this.tagName}`); },
    };
  }
  const dialog = makeNode("dialog");
  await withBrowserGlobals({ document: { createElement: makeNode } }, async () => {
    const modal = createModalController(dialog);
    const confirmPromise = modal.confirm({ title: "确认", message: "继续？" });
    const showIdx = events.indexOf("showModal");
    const focusIdx = events.indexOf("focus:BUTTON");
    assert.ok(showIdx >= 0 && focusIdx > showIdx);

    const promptPromise = modal.prompt({ title: "输入", message: "原因", label: "原因" });
    assert.equal(await confirmPromise, false);
    dialog.oncancel({ preventDefault() {} });
    assert.equal(await promptPromise, null);
  });

  // 2. Dual-channel ActionCoordinator never lets poll block clicks or clear notices
  const coordinator = createActionCoordinator();
  let noticeCleared = 0;
  const pollGate = Promise.withResolvers();
  const pollTask = coordinator.runBackgroundPoll(() => pollGate.promise);
  assert.equal(coordinator.isPollInFlight(), true);
  let userRan = false;
  await coordinator.runUserAction(() => { userRan = true; }, () => {}, () => { noticeCleared += 1; });
  assert.equal(userRan, true);
  assert.equal(noticeCleared, 1);
  pollGate.resolve();
  assert.equal(await pollTask, true);

  // 3. runInspector renders billing, cache hit rate, overBudget, and recoveryHints
  await withBrowserGlobals(
    {
      document: {
        createElement: makeNode,
        createDocumentFragment: () => ({ children: [], append(...n) { this.children.push(...n); } }),
      },
    },
    async () => {
      const target = makeNode("div");
      renderRunInspector(target, {
        id: "r1",
        documentId: "d1",
        state: "failed",
        baseRevisionId: "rev-12345678",
        frozenInput: JSON.stringify({ instruction: "续写" }),
        reserved: 8000,
        settled: 400,
        candidateId: null,
        candidate: null,
        attempts: [],
        calls: [{ id: "c1", attemptId: "a1", phase: "write", inputReserve: 300, maxOutput: 2000, usage: "[300,100,150,0]" }],
        billing: {
          totalInput: 300,
          totalOutput: 100,
          totalCacheRead: 150,
          totalCacheWrite: 0,
          effectiveBilledTokens: 250,
          cacheHitRate: 0.5,
        },
        contextTrace: {
          maxInputTokens: 256,
          totalEstimatedTokens: 310,
          prefixTokens: 120,
          dynamicTokens: 190,
          overBudget: true,
          slots: [],
          activeTechniqueIds: [],
          activeDeconstructionIds: [],
        },
        recoveryHints: [{ kind: "thinking_exhausted", action: "disable_thinking", message: "建议关闭深度思考重试" }],
      });
      const serialized = JSON.stringify(target);
      assert.ok(serialized.includes("有效计费"));
      assert.ok(serialized.includes("250 token"));
      assert.ok(serialized.includes("50.0%"));
      assert.ok(serialized.includes("超出输入上限"));
      assert.ok(serialized.includes("建议关闭深度思考重试"));
    },
  );

  // 4. Static checks for workbench.css variables and shell.ts decoupling
  const css = readFileSync(new URL("../src/client/workbench.css", import.meta.url), "utf8");
  assert.ok(css.includes("--nav-col:"));
  assert.ok(css.includes("--pipe-col:"));
  assert.equal(css.includes(".layout.without-pipeline.pipeline-wide"), false);

  const shellSrc = readFileSync(new URL("../src/client/workbench/shell.ts", import.meta.url), "utf8");
  assert.equal(shellSrc.includes('"fanqie"'), false);
  assert.equal(shellSrc.includes("'fanqie'"), false);
});
