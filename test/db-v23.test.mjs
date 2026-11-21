import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildFreshSchemaSummary, renderSchemaMarkdown } from "../scripts/schema-doc.mjs";
import * as contracts from "../src/contracts/index.ts";
import * as protectedRules from "../src/contracts/protected-rules.ts";
import * as fanqieDomain from "../src/domain/fanqie/editorial.ts";
import * as toutiaoDomain from "../src/domain/toutiao/rules.ts";
import { createGenerationLedger } from "../src/storage/author-generation.ts";
import {
  SORT_KEY_STEP,
  auditEventLogConcerns,
  computeSortKeyBetween,
  createAuthorSchema,
} from "../src/storage/author-schema.ts";
import {
  MAX_STMT_CACHE_SIZE,
  SCHEMA_ID,
  SCHEMA_USER_VERSION,
  StorageError,
  appendEvent,
  appendRevision,
  clearBackupVerificationCache,
  clearStatementCache,
  compactAutoSaveRevisions,
  createBackup,
  createCandidate,
  createCommandSchema,
  createDeliverySchema,
  createDocument,
  createEventLogSchema,
  createFtsSchema,
  createHotBackup,
  createProjectionSchema,
  createStore,
  executeCommand,
  listBackupDetails,
  listBackups,
  openDatabase,
  openStore,
  optimizeDatabase,
  readDatabaseUuid,
  readSchemaId,
  readStorePragmas,
  rebuildAllFts,
  rebuildProjectFts,
  renameWithRetry,
  restoreWorkspace,
  sanitizePathSegment,
  searchRelatedChaptersByFts,
  searchWorkspaceFts,
  statementCacheSize,
  stmt,
  syncChapterFts,
  verifyBackup,
  verifyFtsIntegrity,
  withReadTx,
  withWriteTx,
  writeLocalBundleToDir,
} from "../src/storage/index.ts";
import { createAuthorModelReader } from "../src/workflow/author-reads.ts";
import { assembleContextBundle } from "../src/workflow/context-slots.ts";
import {
  normalizeActualUsage,
  normalizeUsage,
  normalizeUsageToTuple,
  totalTokens,
} from "../src/workflow/index.ts";
import * as prompts from "../src/workflow/prompts/index.ts";
import {
  ARC_PLAN_SYSTEM,
  FACT_SYNC_SYSTEM,
  FANQIE_SYSTEM_CONTINUE,
  FANQIE_SYSTEM_REWRITE,
  FANQIE_SYSTEM_TARGETED,
  computeRunBilling,
  estimateTokenCount,
  resolveTokenMultiplier,
  sumUsageTuple,
  summarizeCumulativeUsage,
  updateTokenCalibration,
} from "../src/workflow/writing-budget.ts";
import {
  WRITING_STAGE_IDS,
  assertStageOutput,
  isValidArcPlanPayload,
  isValidFactSyncPayload,
} from "../src/workflow/writing-stages.ts";
import { createTestWorkspace, withTempDir } from "../support/v2-harness.mjs";

function initFullDb(db) {
  createCommandSchema(db);
  createEventLogSchema(db);
  createDeliverySchema(db);
  createProjectionSchema(db);
  createAuthorSchema(db);
  createFtsSchema(db);
  return createGenerationLedger(db);
}

test("V2.3 protected-rules.ts matches domain protected constants verbatim with zero imports", async () => {
  assert.equal(protectedRules.TITLE_MAX, 34);
  assert.equal(protectedRules.TITLE_MAX, toutiaoDomain.TITLE_MAX);
  assert.equal(protectedRules.QA_PASS_SCORE, 84);
  assert.equal(protectedRules.QA_PASS_SCORE, toutiaoDomain.QA_PASS_SCORE);
  assert.equal(protectedRules.QA_REFINEMENT_LIMIT, 2);
  assert.equal(protectedRules.QA_REFINEMENT_LIMIT, toutiaoDomain.QA_REFINEMENT_LIMIT);
  assert.equal(protectedRules.EDITORIAL_REJECTION_LIMIT, 2);
  assert.equal(protectedRules.EDITORIAL_REJECTION_LIMIT, fanqieDomain.EDITORIAL_REJECTION_LIMIT);
  assert.equal(protectedRules.DELIVERY_ENDING, toutiaoDomain.DELIVERY_ENDING);
  assert.deepEqual(protectedRules.CHAPTER_STATES, fanqieDomain.CHAPTER_STATES);
  assert.deepEqual(protectedRules.ARTICLE_STATES, Object.keys(toutiaoDomain.ARTICLE_TRANSITIONS));

  // Re-exported cleanly from contracts/index.ts
  assert.equal(contracts.TITLE_MAX, 34);
  assert.equal(contracts.QA_PASS_SCORE, 84);
  assert.equal(contracts.EDITORIAL_REJECTION_LIMIT, 2);

  // Zero imports in protected-rules.ts (browser-safe pure constants)
  const rulesSrc = readFileSync(
    fileURLToPath(new URL("../src/contracts/protected-rules.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(rulesSrc, /^\s*import\b/m);

  // FE-16: the browser-served mirror restates the canonical module verbatim.
  const mirrorSrc = readFileSync(
    fileURLToPath(new URL("../src/client/contracts/protected-rules.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(mirrorSrc, /^\s*import\b/m);
  const exportBlock = (text) => text.slice(text.indexOf("export const TITLE_MAX")).replace(/\r\n/g, "\n");
  assert.equal(exportBlock(mirrorSrc), exportBlock(rulesSrc), "client mirror drifted from contracts/protected-rules.ts");
  const mirror = await import("../src/client/contracts/protected-rules.ts");
  assert.deepEqual({ ...mirror }, { ...protectedRules });

  // workspace-dto.ts remains strictly type-only
  const dtoRuntime = await import("../src/contracts/workspace-dto.ts");
  assert.deepEqual(Object.keys(dtoRuntime), []);
});

test("V2.3 migrations create all tables/columns/constraints, backfill sort_key & concerns, and set zhizhang/2.3 + user_version=23", async () => {
  await withTempDir("zhizhang-v23-mig-", async (dir) => {
    const dbPath = join(dir, "workspace.sqlite");
    createStore(dbPath, "zhizhang/2.0");
    const db = openStore(dbPath);
    try {

    createCommandSchema(db);
    createEventLogSchema(db);
    createDeliverySchema(db);
    createAuthorSchema(db);

    assert.equal(readSchemaId(db), SCHEMA_ID);
    assert.equal(readSchemaId(db), "zhizhang/2.3");
    assert.equal(db.prepare("PRAGMA user_version;").get().user_version, SCHEMA_USER_VERSION);
    assert.match(readDatabaseUuid(db), /^[0-9a-f-]{36}$/i);

    // Reopen through openStore verifies zhizhang/2.3 passes SCHEMA_WINDOW
    const ro = openStore(dbPath, { readOnly: true });
    assert.equal(readSchemaId(ro), "zhizhang/2.3");
    ro.close();

    // Seed project + chapter
    db.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p1', '测试书', 'fanqie');").run();
    createDocument(db, "c1");
    db.prepare("INSERT INTO author_documents (id, project_id, title, state, sort_key) VALUES ('c1', 'p1', '第一章', 'drafted', 1024);").run();

    // 1. DB-13 partial unique index ux_proposal_inflight rejects concurrent inflight proposals for same kind+scope
    db.prepare(`
      INSERT INTO author_ai_proposals (id, project_id, document_id, kind, status, base_revision_id, source_sha256, origin, origin_ref, error_detail)
      VALUES ('prop-1', 'p1', 'c1', 'fact_sync', 'inflight', 'rev-1', 'abc', 'ai-generate', '', NULL);
    `).run();
    assert.throws(() => {
      db.prepare(`
        INSERT INTO author_ai_proposals (id, project_id, document_id, kind, status)
        VALUES ('prop-2', 'p1', 'c1', 'fact_sync', 'inflight');
      `).run();
    }, /UNIQUE constraint failed/i);
    // Different kind on same document is allowed, and non-inflight status is allowed
    db.prepare(`
      INSERT INTO author_ai_proposals (id, project_id, document_id, kind, status)
      VALUES ('prop-3', 'p1', 'c1', 'chapter_review', 'inflight');
    `).run();
    db.prepare(`
      INSERT INTO author_ai_proposals (id, project_id, document_id, kind, status)
      VALUES ('prop-4', 'p1', 'c1', 'fact_sync', 'pending');
    `).run();

    // 2. author_micro_calls STRICT + CHECK + partial unique inflight mutex
    db.prepare(`
      INSERT INTO author_micro_calls (id, project_id, document_id, mode, provider, model, reserved, settled, usage, status, created_at, updated_at)
      VALUES ('mc-1', 'p1', 'c1', 'polish', 'deepseek', 'deepseek-chat', 4000, 0, '[]', 'inflight', 1, 1);
    `).run();
    assert.throws(() => {
      db.prepare(`
        INSERT INTO author_micro_calls (id, project_id, document_id, mode, provider, model, reserved, settled, usage, status, created_at, updated_at)
        VALUES ('mc-2', 'p1', 'c1', 'expand', 'deepseek', 'deepseek-chat', 4000, 0, '[]', 'inflight', 2, 2);
      `).run();
    }, /UNIQUE constraint failed/i);
    assert.throws(() => {
      db.prepare(`
        INSERT INTO author_micro_calls (id, project_id, document_id, mode, provider, model, reserved, settled, usage, status, created_at, updated_at)
        VALUES ('mc-bad', 'p1', 'c1', 'polish', 'deepseek', 'deepseek-chat', 4000, 0, '[]', 'invalid_status', 2, 2);
      `).run();
    }, /CHECK constraint failed/i);

    // 3. New columns on controls, foreshadows, observations, memory_sync, settings, checkpoints
    db.prepare(`
      INSERT INTO author_project_controls
        (project_id, author_intent, current_focus, pacing_tier, genre_tags_json, agent_tools_enabled, daily_target, stale_foreshadow_gap, token_calibration_json, updated_at)
      VALUES ('p1', '主线', '焦点', '快爽', '["悬疑","都市"]', 0, 4000, 15, '{"deepseek":0.55}', 1);
    `).run();
    const ctrl = db.prepare("SELECT * FROM author_project_controls WHERE project_id = 'p1';").get();
    assert.equal(ctrl.pacing_tier, "快爽");
    assert.equal(ctrl.daily_target, 4000);
    assert.equal(ctrl.stale_foreshadow_gap, 15);
    assert.equal(ctrl.agent_tools_enabled, 0);

    db.prepare(`
      INSERT INTO author_foreshadows (id, project_id, title, hinted_chapter_ids_json)
      VALUES ('fs-1', 'p1', '旧怀表', '["c1"]');
    `).run();
    assert.equal(db.prepare("SELECT hinted_chapter_ids_json FROM author_foreshadows WHERE id = 'fs-1';").get().hinted_chapter_ids_json, '["c1"]');

    db.prepare(`
      INSERT INTO author_chapter_observations (id, project_id, document_id, dimension, verified)
      VALUES ('obs-1', 'p1', 'c1', 'continuity', 0);
    `).run();
    assert.equal(db.prepare("SELECT verified FROM author_chapter_observations WHERE id = 'obs-1';").get().verified, 0);

    db.prepare(`
      INSERT INTO author_chapter_memory_sync (document_id, project_id, synced_revision_id)
      VALUES ('c1', 'p1', 'rev-1');
    `).run();
    assert.equal(db.prepare("SELECT synced_revision_id FROM author_chapter_memory_sync WHERE document_id = 'c1';").get().synced_revision_id, "rev-1");

    // 4. Fractional sort_key helper
    assert.equal(computeSortKeyBetween(null, null), SORT_KEY_STEP);
    assert.equal(computeSortKeyBetween(1024, 2048), 1536);
    assert.equal(computeSortKeyBetween(null, 1024), 0);
    assert.equal(computeSortKeyBetween(2048, null), 3072);
    } finally {
      db.close();
    }
  });
});

test("V2.3 sort_key backfill & event_log concern backfill/quarantine upgrade legacy databases cleanly", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  createCommandSchema(db);
  createEventLogSchema(db);
  // Simulate pre-2.3 database with author_chapter_order and legacy events missing concern
  db.exec(`
    CREATE TABLE author_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE author_documents (id TEXT PRIMARY KEY REFERENCES documents(document_id), project_id TEXT NOT NULL REFERENCES author_projects(id), title TEXT NOT NULL, state TEXT NOT NULL, mode TEXT, line TEXT, final_revision_id TEXT, editorial_rejections INTEGER NOT NULL DEFAULT 0, qa_rounds INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE author_chapter_order (project_id TEXT PRIMARY KEY REFERENCES author_projects(id), chapter_ids TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p1', '旧书', 'fanqie');").run();
  for (const id of ["c1", "c2", "c3"]) {
    createDocument(db, id);
    db.prepare("INSERT INTO author_documents (id, project_id, title, state) VALUES (?, 'p1', ?, 'drafted');").run(id, id);
  }
  // Custom flat order: c3, c1, c2
  db.prepare("INSERT INTO author_chapter_order (project_id, chapter_ids) VALUES ('p1', ?);").run(
    JSON.stringify(["c3", "c1", "c2"]),
  );
  // Insert legacy events: 1 missing concern (inferable), 1 unknown kind+concern (quarantined)
  appendEvent(db, { projectId: "p1", eventId: "e1", kind: "document.created", payload: { documentId: "c1", title: "c1" } });
  appendEvent(db, { projectId: "p1", eventId: "e2", kind: "mystery.alien", payload: { concern: "invalid_word", foo: 1 } });

  createAuthorSchema(db);

  const sorted = db
    .prepare("SELECT id, sort_key FROM author_documents WHERE project_id = 'p1' ORDER BY sort_key ASC;")
    .all();
  assert.deepEqual(sorted.map((r) => r.id), ["c3", "c1", "c2"]);
  assert.deepEqual(sorted.map((r) => r.sort_key), [1024, 2048, 3072]);

  // e1 concern was backfilled to 'chapter', e2 was recorded in event_log_quarantine without deleting seq=2
  const e1 = JSON.parse(db.prepare("SELECT payload FROM event_log WHERE event_id = 'e1';").get().payload);
  assert.equal(e1.concern, "chapter");
  const audit = auditEventLogConcerns(db);
  assert.equal(audit.total, 2);
  assert.equal(audit.valid, 1);
  assert.equal(audit.invalidConcern, 1);
  assert.equal(audit.quarantined, 1);
});

test("DB-12 query-plan guard verifies hot queries use indexed SEARCH with zero large-table SCAN", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  initFullDb(db);

  const queries = [
    ["revisions by doc+created", "SELECT revision_id FROM revisions WHERE document_id = ? ORDER BY created_at DESC LIMIT 10;", ["d1"]],
    ["candidates by doc", "SELECT candidate_id FROM candidates WHERE document_id = ?;", ["d1"]],
    ["open generation attempts", "SELECT id FROM author_generation_attempts WHERE state IN ('prepared','inflight','received');", []],
    ["proposals by doc", "SELECT id FROM author_ai_proposals WHERE document_id = ?;", ["d1"]],
    ["inflight proposal mutex", "SELECT id FROM author_ai_proposals WHERE status = 'inflight' AND kind = ? AND COALESCE(document_id, project_id, 'global') = ?;", ["fact_sync", "d1"]],
    ["runs by doc+state", "SELECT id FROM author_runs WHERE document_id = ? AND state = 'running';", ["d1"]],
    ["settings by project+fact", "SELECT id FROM author_settings WHERE project_id = ? AND fact_id = ?;", ["p1", "f1"]],
    ["foreshadows by target", "SELECT id FROM author_foreshadows WHERE project_id = ? AND target_chapter_id = ?;", ["p1", "c5"]],
    ["docs by tree+sort", "SELECT id FROM author_documents WHERE project_id = ? AND volume_id = ? AND act_id = ? ORDER BY sort_key ASC;", ["p1", "v1", "a1"]],
    ["entities by name", "SELECT document_id FROM author_chapter_entities WHERE project_id = ? AND entity_name = ?;", ["p1", "沈青"]],
    ["checkpoints LRU", "SELECT cache_key FROM author_read_checkpoints ORDER BY last_used_at ASC LIMIT 10;", []],
    ["journal by created_at", "SELECT request_key FROM command_journal WHERE created_at > 0 AND created_at < ?;", [1000]],
    ["micro_calls by doc+status", "SELECT id FROM author_micro_calls WHERE document_id = ? AND status = 'inflight';", ["d1"]],
  ];

  for (const [label, sql, params] of queries) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
    const details = plan.map((row) => String(row.detail ?? "")).join(" | ");
    assert.ok(
      /SEARCH|USING (?:COVERING )?INDEX/i.test(details),
      `Expected indexed SEARCH for [${label}], got plan: ${details}`,
    );
    assert.doesNotMatch(
      details,
      /\bSCAN\s+(?:revisions|candidates|author_generation_attempts|author_ai_proposals|author_runs|author_settings|author_foreshadows|author_documents|author_chapter_entities|command_journal|author_micro_calls)\b/i,
      `Unexpected full table SCAN for [${label}]: ${details}`,
    );
  }
});

test("DB-01 normalizeUsage prevents cache_read double-counting and FQ-29 calibrates token estimates", () => {
  // Default inputIncludesCache=true: input=1000, cacheRead=800 -> [200, 200, 800, 0] -> total=1200 (NOT 2000!)
  const norm = normalizeUsage({
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 800,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(norm, { input: 200, output: 200, cache_read: 800, cache_write: 0 });
  assert.equal(totalTokens(norm), 1200);

  const tuple = normalizeUsageToTuple({
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
  });
  assert.deepEqual(tuple, [200, 200, 800, 50]);
  assert.equal(sumUsageTuple(tuple), 1250);

  const actual = normalizeActualUsage({
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 800,
    cost: null,
  });
  assert.equal(totalTokens(actual), 1200);
  assert.equal(actual.cost, null);

  // Explicit inputIncludesCache=false: input=200 is already uncached
  const sepNorm = normalizeUsage(
    { inputTokens: 200, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0 },
    { inputIncludesCache: false },
  );
  assert.deepEqual(sepNorm, { input: 200, output: 200, cache_read: 800, cache_write: 0 });
  assert.equal(totalTokens(sepNorm), 1200);

  // Normalized computeRunBilling computes exact billed tokens & cacheHitRate without guessing
  const billing = computeRunBilling(
    [
      [400, 200, 600, 100],
      [200, 100, 800, 0],
    ],
    { normalized: true },
  );
  assert.equal(billing.totalInput, 600);
  assert.equal(billing.totalCacheRead, 1400);
  assert.equal(billing.effectiveBilledTokens, 900);
  assert.equal(billing.cacheHitRate, 1400 / 2000);

  // FQ-29 token estimation calibration
  const sample = "这是一段中文网文测试内容用于校验令牌估算校准系数。".repeat(20);
  const baseEst = estimateTokenCount(sample);
  const dsFactor = resolveTokenMultiplier("deepseek", "deepseek-chat");
  assert.equal(dsFactor, 0.55);
  assert.ok(estimateTokenCount(sample, dsFactor) < baseEst);
  assert.equal(resolveTokenMultiplier("unknown-vendor", "m1"), 1);

  const cal1 = updateTokenCalibration({}, "deepseek:deepseek-chat", 430, 1000);
  assert.ok(cal1["deepseek:deepseek-chat"] >= 0.35 && cal1["deepseek:deepseek-chat"] <= 0.6);
  assert.equal(resolveTokenMultiplier("deepseek", "deepseek-chat", cal1), cal1["deepseek:deepseek-chat"]);

  // DB-26 optional cumulative usage summary
  const cum = summarizeCumulativeUsage({ runTokens: 5000, proposalTokens: 1200, microCallTokens: 800, softLimit: 6000 });
  assert.equal(cum.totalTokens, 7000);
  assert.equal(cum.softLimitExceeded, true);
});

test("DB-02 lean command_journal keeps 100 draft.save calls < 100KB and strips huge fields on idempotent replay", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  initFullDb(db);

  createDocument(db, "doc-lean");
  let baseRev = null;
  const bigBody = "这是一段五千字节的长篇正文内容用于检验日志瘦身效果。".repeat(80); // ~6KB UTF-8

  for (let i = 0; i < 100; i += 1) {
    const revId = `rev-${i}`;
    const body = `${bigBody}#${i}`;
    const outcome = executeCommand(
      db,
      {
        commandId: "draft.save",
        actor: "author",
        documentId: "doc-lean",
        baseRevisionId: baseRev,
        payload: { documentId: "doc-lean", baseRevisionId: baseRev, body },
      },
      () => appendRevision(db, { revisionId: revId, documentId: "doc-lean", body, createdAt: Date.now() }),
    );
    assert.equal(outcome.ok, true);
    baseRev = revId;
  }

  const stats = db
    .prepare(`
      SELECT
        COUNT(*) AS rows,
        SUM(length(CAST(request_payload AS BLOB))) AS reqPayloadBytes,
        SUM(
          length(CAST(actor_id AS BLOB)) + length(CAST(command_id AS BLOB)) +
          length(CAST(document_id AS BLOB)) + length(CAST(request_key AS BLOB)) +
          length(CAST(request_payload AS BLOB)) + length(CAST(request_hash AS BLOB)) +
          length(CAST(result_payload AS BLOB))
        ) AS totalBytes
      FROM command_journal;
    `)
    .get();
  assert.equal(stats.rows, 100);
  assert.equal(stats.reqPayloadBytes, 0, "idempotent=false draft.save stores empty request_payload");
  assert.ok(stats.totalBytes < 100 * 1024, `Expected command_journal < 100KB, got ${stats.totalBytes} bytes`);

  // Idempotent command (candidate.adopt) with large mergedBody strips body to sha256 while preserving exact replay/mismatch
  createCandidate(db, { candidateId: "cand-1", documentId: "doc-lean", baseRevisionId: baseRev, body: bigBody });
  const mergedA = `${bigBody}合并稿A`;
  const firstAdopt = executeCommand(
    db,
    {
      commandId: "candidate.adopt",
      actor: "author",
      documentId: "doc-lean",
      idempotencyKey: "adopt-lean-1",
      baseRevisionId: baseRev,
      payload: { candidateId: "cand-1", baseRevisionId: baseRev, mergedBody: mergedA },
    },
    () => appendRevision(db, { revisionId: "rev-adopted", documentId: "doc-lean", body: mergedA, createdAt: Date.now() }),
  );
  assert.equal(firstAdopt.ok, true);
  assert.equal(firstAdopt.replayed, false);
  const adoptRow = db.prepare("SELECT request_payload FROM command_journal WHERE request_key = 'adopt-lean-1';").get();
  assert.ok(adoptRow.request_payload.length < 300, "mergedBody must be replaced with compact sha256 digest");
  assert.equal(adoptRow.request_payload.includes("合并稿A"), false);

  // Exact replay succeeds
  const replayAdopt = executeCommand(
    db,
    {
      commandId: "candidate.adopt",
      actor: "author",
      documentId: "doc-lean",
      idempotencyKey: "adopt-lean-1",
      baseRevisionId: baseRev,
      payload: { candidateId: "cand-1", baseRevisionId: baseRev, mergedBody: mergedA },
    },
    () => assert.fail("replay must not re-run apply"),
  );
  assert.equal(replayAdopt.ok, true);
  assert.equal(replayAdopt.replayed, true);

  // Different mergedBody with same key is rejected as idempotency.mismatch
  const mismatchAdopt = executeCommand(
    db,
    {
      commandId: "candidate.adopt",
      actor: "author",
      documentId: "doc-lean",
      idempotencyKey: "adopt-lean-1",
      baseRevisionId: baseRev,
      payload: { candidateId: "cand-1", baseRevisionId: baseRev, mergedBody: `${bigBody}篡改稿B` },
    },
    () => assert.fail("mismatch must not run apply"),
  );
  assert.equal(mismatchAdopt.ok, false);
  assert.equal(mismatchAdopt.code, "idempotency.mismatch");
});

test("DB-18 compactAutoSaveRevisions preserves protected & daily-latest revisions while pruning old intra-day autosaves", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  initFullDb(db);

  db.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p1', '修订测试', 'fanqie');").run();
  createDocument(db, "c1");
  db.prepare("INSERT INTO author_documents (id, project_id, title, state, final_revision_id) VALUES ('c1', 'p1', '章', 'drafted', 'r-final');").run();

  const dayMs = 86_400_000;
  const now = 20 * dayMs + 5000;
  const oldDay = 5 * dayMs; // 15 days ago (> 7d)

  // 3 old intra-day autosaves on oldDay -> keep only r-old-3 (daily latest), delete r-old-1 & r-old-2
  // plus r-final (protected as final_revision_id) on same day -> MUST keep!
  appendRevision(db, { revisionId: "r-old-1", documentId: "c1", body: "a1", createdAt: oldDay + 100 });
  appendRevision(db, { revisionId: "r-final", documentId: "c1", body: "af", createdAt: oldDay + 150 });
  appendRevision(db, { revisionId: "r-old-2", documentId: "c1", body: "a2", createdAt: oldDay + 200 });
  appendRevision(db, { revisionId: "r-old-3", documentId: "c1", body: "a3", createdAt: oldDay + 300 });
  // 2 recent autosaves (< 7 days) -> keep both
  appendRevision(db, { revisionId: "r-rec-1", documentId: "c1", body: "r1", createdAt: now - 2 * dayMs });
  appendRevision(db, { revisionId: "r-rec-2", documentId: "c1", body: "r2", createdAt: now - 1000 });

  const dry = compactAutoSaveRevisions(db, { nowMs: now, dryRun: true });
  assert.equal(dry.examined, 6);
  assert.equal(dry.deleted, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM revisions;").get().n, 6);

  const real = compactAutoSaveRevisions(db, { nowMs: now });
  assert.equal(real.deleted, 2);
  const remaining = db.prepare("SELECT revision_id FROM revisions ORDER BY created_at ASC;").all().map((r) => r.revision_id);
  assert.deepEqual(remaining, ["r-final", "r-old-3", "r-rec-1", "r-rec-2"]);
});

test("DB-18 compactAutoSaveRevisions only pins base revisions of pending proposals", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  initFullDb(db);

  db.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p1', '提案保护', 'fanqie');").run();
  createDocument(db, "c1");

  const dayMs = 86_400_000;
  const now = 20 * dayMs + 5000;
  const days = [6, 5, 4, 3];
  const statuses = ["pending", "approved", "rejected", "failed"];
  statuses.forEach((status, index) => {
    const base = days[index] * dayMs;
    const protectedRev = `r-${status}-base`;
    const latestRev = `r-${status}-latest`;
    appendRevision(db, { revisionId: protectedRev, documentId: "c1", body: status, createdAt: base + 100 });
    appendRevision(db, { revisionId: latestRev, documentId: "c1", body: `${status}-latest`, createdAt: base + 200 });
    db.prepare(`
      INSERT INTO author_ai_proposals (id, project_id, document_id, kind, status, base_revision_id)
      VALUES (?, 'p1', 'c1', 'fact_sync', ?, ?);
    `).run(`prop-${status}`, status, protectedRev);
  });
  // Keep the document's current pointer off the daily-latest rows so the
  // protected set is the only variable under test.
  appendRevision(db, { revisionId: "r-current", documentId: "c1", body: "current", createdAt: now - 1000 });

  const dry = compactAutoSaveRevisions(db, { nowMs: now, dryRun: true });
  assert.equal(dry.deleted, 3, "the three non-pending bases must be eligible for deletion");
  compactAutoSaveRevisions(db, { nowMs: now });

  const remaining = db.prepare("SELECT revision_id FROM revisions ORDER BY revision_id ASC;").all()
    .map((row) => row.revision_id);
  assert.ok(remaining.includes("r-pending-base"), "a pending proposal must pin its base revision");
  for (const status of ["approved", "rejected", "failed"]) {
    assert.ok(!remaining.includes(`r-${status}-base`), `${status} proposals must not pin revisions forever`);
  }
});

test("DB-03/19/25 shared per-project ProjectionStore folds once, zero write tx on 0 events, throttles/evicts checkpoints, and respects db_uuid & concern tolerance", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  initFullDb(db);

  db.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p1', '共享读模型', 'fanqie');").run();
  appendEvent(db, { projectId: "p1", eventId: "e1", kind: "project.created", payload: { concern: "chapter", name: "共享读模型" } });
  appendEvent(db, { projectId: "p1", eventId: "e2", kind: "document.created", payload: { concern: "chapter", documentId: "c1", title: "第一章", state: "drafted" } });
  appendEvent(db, { projectId: "p1", eventId: "e3", kind: "revision.saved", payload: { concern: "revision", documentId: "c1", revisionId: "rev-1" } });

  let writeTxCount = 0;
  let forbidWrites = false;
  const reader = createAuthorModelReader(
    db,
    {
      read: (fn) => withReadTx(db, fn),
      atomic: (fn) => {
        if (forbidWrites) throw new Error("Write transaction forbidden on 0-event read!");
        writeTxCount += 1;
        return withWriteTx(db, fn);
      },
    },
    {},
    { checkpointMinEvents: 5, maxDurableCheckpoints: 2 },
  );

  // First read folds all 3 events and saves initial checkpoint for navigation
  const nav1 = reader("p1", { model: "navigation" });
  assert.equal(nav1.folded, 3);
  assert.equal(nav1.asOfSeq, 3);
  // Attach revision-candidate on the same project hub
  const rev1 = reader("p1", { model: "revision-candidate", documentId: "c1" });
  assert.equal(rev1.asOfSeq, 3);
  assert.equal(rev1.value.currentRevisionId, "rev-1");

  // 0 new events -> MUST open 0 write transactions!
  forbidWrites = true;
  const navHot = reader("p1", { model: "navigation" });
  const revHot = reader("p1", { model: "revision-candidate", documentId: "c1" });
  assert.equal(navHot.folded, 0);
  assert.equal(revHot.folded, 0);
  forbidWrites = false;

  // Append 1 event: navigation advances BOTH attached units in ONE pass; revision-candidate then folds 0!
  appendEvent(db, { projectId: "p1", eventId: "e4", kind: "revision.saved", payload: { concern: "revision", documentId: "c1", revisionId: "rev-2" } });
  const writesBeforeThrottle = writeTxCount;
  const nav2 = reader("p1", { model: "navigation" });
  assert.equal(nav2.folded, 1);
  // Throttled (checkpointMinEvents=5, delta=1) -> 0 checkpoint write tx!
  assert.equal(writeTxCount, writesBeforeThrottle);
  // revision-candidate was ALREADY updated in the shared fold pass!
  const rev2 = reader("p1", { model: "revision-candidate", documentId: "c1" });
  assert.equal(rev2.folded, 0);
  assert.equal(rev2.value.currentRevisionId, "rev-2");

  // Flush checkpoints explicitly and verify durable LRU cap (maxDurableCheckpoints=2)
  assert.ok(reader.flushCheckpoints() >= 2);
  reader("p1", { model: "run", runId: "r-1" });
  appendEvent(db, { projectId: "p1", eventId: "e5", kind: "run.started", payload: { concern: "run", runId: "r-1", reserved: 5000 } });
  reader("p1", { model: "run", runId: "r-1" });
  reader.flushCheckpoints();
  const cpCount = db.prepare("SELECT COUNT(*) AS n FROM author_read_checkpoints;").get().n;
  assert.ok(cpCount <= 2, `Expected LRU checkpoint eviction <= 2, got ${cpCount}`);

  // DB-25: changing db_uuid invalidates in-memory cache cleanly
  db.prepare("UPDATE meta SET value = 'rotated-uuid-9999' WHERE key = 'db_uuid';").run();
  const navAfterRotate = reader("p1", { model: "navigation" });
  assert.equal(navAfterRotate.asOfSeq, 5);

  // DB-19: event with missing/unknown concern does not brick author-reads
  db.prepare("INSERT INTO event_log (project_id, seq, event_id, kind, payload, created_at) VALUES ('p1', 6, 'e6', 'document.renamed', '{\"documentId\":\"c1\",\"title\":\"容错改名\"}', 1);").run();
  db.prepare("INSERT INTO event_log (project_id, seq, event_id, kind, payload, created_at) VALUES ('p1', 7, 'e7', 'alien.event', '{\"concern\":\"bogus\"}', 1);").run();
  const navTolerant = reader("p1", { model: "navigation" });
  assert.equal(navTolerant.asOfSeq, 7);
  assert.equal(navTolerant.value.volumes[0].chapters[0].title, "容错改名");
});

test("DB-04 backup handles online hot backup with exports/, WAL checkpoint enforcement on offline backup, and cached listBackups", async () => {
  await withTempDir("zhizhang-v23-bak-", async (root) => {
    const liveDir = join(root, "live");
    const exportsDir = join(liveDir, "exports", "book-1");
    mkdirSync(exportsDir, { recursive: true });
    writeFileSync(join(exportsDir, "01.md"), "# 第一章\n\n导出正文。", "utf8");

    const dbPath = join(liveDir, "workspace.sqlite");
    createStore(dbPath);
    const liveDb = openStore(dbPath);
    try {
      initFullDb(liveDb);
      liveDb.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p1', '热备书', 'fanqie');").run();

      // 1. Hot backup with optional exports/ inclusion + atomic manifest write
      const backupsRoot = join(root, "backups");
      const hotDir = join(backupsRoot, "2026-11-20T10-00");
      const manifest = await createHotBackup(liveDb, hotDir, {
        exportsDirectory: join(liveDir, "exports"),
        includeExports: true,
      });
      assert.equal(manifest.schema, "zhizhang/2.3");
      assert.ok(manifest.entries.some((e) => e.path === "work.db"));
      assert.ok(manifest.entries.some((e) => e.path === "exports/book-1/01.md"));
      assert.ok(Array.isArray(manifest.migrations) && manifest.migrations.length > 0);
      await verifyBackup(hotDir);

      // Restore workspace restores exports/ cleanly too
      const restoredDir = join(root, "restored");
      await restoreWorkspace(hotDir, restoredDir);
      assert.equal(readFileSync(join(restoredDir, "exports", "book-1", "01.md"), "utf8"), "# 第一章\n\n导出正文。");

      // 2. Cached listBackups / listBackupDetails
      clearBackupVerificationCache();
      const details1 = await listBackupDetails(backupsRoot);
      const details2 = await listBackupDetails(backupsRoot);
      assert.equal(details1.length, 1);
      assert.equal(details1[0].valid, true);
      assert.equal(details1[0].schema, "zhizhang/2.3");
      assert.equal(details1[0].entryCount, 2);
      assert.deepEqual(details2, details1);
      assert.deepEqual(await listBackups(backupsRoot), [{ id: "2026-11-20T10-00", valid: true }]);

      // 3. Offline createBackup while another connection holds an active write tx on WAL -> refuses with dependency.unavailable
      liveDb.exec("BEGIN IMMEDIATE;");
      liveDb.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p2', '未落盘书', 'fanqie');").run();
      await assert.rejects(
        () => createBackup(dbPath, join(root, "blocked-offline")),
        (err) => err instanceof StorageError && err.code === "dependency.unavailable",
      );
      liveDb.exec("COMMIT;");
    } finally {
      liveDb.close();
    }

    // Once closed (or WAL checkpointable), offline createBackup succeeds cleanly
    const offlineDir = join(root, "offline-ok");
    const offlineManifest = await createBackup(dbPath, offlineDir);
    assert.equal(offlineManifest.schema, "zhizhang/2.3");
    await verifyBackup(offlineDir);
  });
});

test("DB-05/06/16/17 FTS5 supports 2-char entity fast path, project-scoped rebuildProjectFts, and UPDATE OF library triggers", (t) => {
  const ws = createTestWorkspace(t);
  const pA = ws.app.mutation("project.create", { product: "fanqie", name: "甲书" }).id;
  const pB = ws.app.mutation("project.create", { product: "fanqie", name: "乙书" }).id;

  const chA1 = ws.app.mutation("document.create", { projectId: pA, title: "甲章一" }).id;
  ws.app.mutation("draft.save", { documentId: chA1, baseRevisionId: null, body: "沈青推开古宅大门，看到青铜罗盘。" });
  const chB1 = ws.app.mutation("document.create", { projectId: pB, title: "乙章一" }).id;
  ws.app.mutation("draft.save", { documentId: chB1, baseRevisionId: null, body: "乙书独有星河罗盘秘闻。" });

  // Index 2-char entity "沈青" in author_chapter_entities
  ws.db.prepare(`
    INSERT INTO author_chapter_entities (document_id, project_id, fact_id, entity_name, category, mention_count)
    VALUES (?, ?, 'f-sq', '沈青', 'character', 5);
  `).run(chA1, pA);

  // DB-06: 2-char CJK workspace search & related-chapter recall
  const hits2 = searchWorkspaceFts(ws.db, { projectId: pA, query: "沈青", scopes: ["chapter"] });
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0].id, chA1);
  const related2 = searchRelatedChaptersByFts(ws.db, { projectId: pA, queryTerms: ["沈青"] });
  assert.equal(related2.length, 1);
  assert.equal(related2[0].documentId, chA1);

  // DB-16: rebuildProjectFts(pA) preserves pB's fts_rowid untouched
  const bRowidBefore = ws.db
    .prepare("SELECT fts_rowid FROM fts_rowid_map WHERE scope = 'chapter' AND project_id = ?;")
    .get(pB).fts_rowid;
  rebuildProjectFts(ws.db, pA);
  verifyFtsIntegrity(ws.db);
  const bRowidAfter = ws.db
    .prepare("SELECT fts_rowid FROM fts_rowid_map WHERE scope = 'chapter' AND project_id = ?;")
    .get(pB).fts_rowid;
  assert.equal(bRowidAfter, bRowidBefore);
  assert.equal(searchWorkspaceFts(ws.db, { projectId: pB, query: "星河罗盘", scopes: ["chapter"] }).length, 1);

  // rebuildAllFts succeeds and passes integrity check
  rebuildAllFts(ws.db);
  verifyFtsIntegrity(ws.db);

  // DB-17: library triggers use UPDATE OF (updating only priority / updated_at does not trigger FTS delete+insert)
  const triggerSql = ws.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('tr_fts_dec_bu', 'tr_fts_tech_bu');")
    .all()
    .map((r) => r.sql);
  assert.equal(triggerSql.length, 2);
  for (const sql of triggerSql) {
    assert.match(sql, /UPDATE\s+OF\s+/i);
  }
  const tech = ws.app.mutation("technique.save", {
    scope: "project",
    projectId: pA,
    title: "悬念反转卡",
    executionSteps: "在章末揭示隐藏动机",
    priority: 50,
  });
  // Install a spy trigger on fts_rowid_map to assert priority/updated_at update does NOT toggle indexed=0
  ws.db.exec(`
    CREATE TABLE _fts_spy (n INTEGER);
    CREATE TRIGGER _tr_spy AFTER UPDATE OF indexed ON fts_rowid_map
    BEGIN
      INSERT INTO _fts_spy VALUES (1);
    END;
  `);
  ws.db.prepare("UPDATE library_technique_cards SET priority = 90, updated_at = 12345 WHERE id = ?;").run(tech.id);
  assert.equal(ws.db.prepare("SELECT COUNT(*) AS n FROM _fts_spy;").get().n, 0);
  // Updating a text column DOES fire the column-scoped FTS trigger
  ws.db.prepare("UPDATE library_technique_cards SET title = '悬念反转卡增强版' WHERE id = ?;").run(tech.id);
  assert.ok(ws.db.prepare("SELECT COUNT(*) AS n FROM _fts_spy;").get().n > 0);
  ws.db.exec("DROP TRIGGER _tr_spy; DROP TABLE _fts_spy;");
  verifyFtsIntegrity(ws.db);
});

test("DB-07/08/14/20/27 pragmas, stmt LRU<=256, late_usage preservation, Windows local-io, and foreign-transaction guard", async () => {
  await withTempDir("zhizhang-v23-infra-", async (dir) => {
    // 1. DB-07 pragmas & optimize
    const dbPath = join(dir, "pragmas.sqlite");
    createStore(dbPath);
    const db = openStore(dbPath);
    try {
    const pragmas = readStorePragmas(db);
    assert.equal(pragmas.foreignKeys, 1);
    assert.equal(pragmas.journalMode, "wal");
    assert.equal(pragmas.busyTimeout, 5000);
    assert.equal(pragmas.journalSizeLimit, 67108864);
    assert.equal(pragmas.userVersion, 23);
    if (sep === "\\") {
      assert.equal(pragmas.mmapSize, 0, "Windows must disable mmap_size");
    }
    optimizeDatabase(db);

    // 2. DB-08 statement LRU capped at 256
    clearStatementCache(db);
    for (let i = 0; i < 400; i += 1) {
      stmt(db, `SELECT ${i} AS n;`).get();
    }
    assert.equal(statementCacheSize(db), MAX_STMT_CACHE_SIZE);
    assert.equal(MAX_STMT_CACHE_SIZE, 256);

    // 3. DB-27 foreign-transaction guard in tx.ts
    db.exec("BEGIN;");
    try {
      assert.throws(
        () => withWriteTx(db, () => {}),
        (err) => err instanceof StorageError && err.code === "gate.denied" && err.details.reason === "foreign-transaction",
      );
      assert.throws(
        () => withReadTx(db, () => {}),
        (err) => err instanceof StorageError && err.code === "gate.denied" && err.details.reason === "foreign-transaction",
      );
    } finally {
      db.exec("ROLLBACK;");
    }

    // 4. DB-14 late generation receipt preserved in late_usage
    const ledger = initFullDb(db);
    db.prepare("INSERT INTO author_projects (id, name, product) VALUES ('p1', '账本', 'fanqie');").run();
    createDocument(db, "d1");
    db.prepare("INSERT INTO author_documents (id, project_id, title, state) VALUES ('d1', 'p1', '章', 'drafted');").run();
    db.prepare(`
      INSERT INTO author_runs (id, document_id, state, base_revision_id, frozen_input, reserved)
      VALUES ('r1', 'd1', 'running', 'rev1', '{}', 10000);
    `).run();
    ledger.create("att-1", "r1", "deepseek", "deepseek-chat");
    assert.equal(ledger.beginCall("att-1", "call-1", "write", 1000, 2000), true);
    // Simulate attempt interrupted/closed as uncertain before late receipt arrives
    ledger.close("att-1", "uncertain", "interrupted");
    assert.equal(ledger.receiveCall("att-1", "call-1", [300, 150, 700, 0]), false);
    // Duplicate/retried late receipt and unknown callId must NOT duplicate late_usage
    assert.equal(ledger.receiveCall("att-1", "call-1", [300, 150, 700, 0]), false);
    assert.equal(ledger.receiveCall("att-1", "unknown-call", [999, 999, 0, 0]), false);
    const hist = ledger.history("r1");
    const lateParsed = JSON.parse(hist[0].lateUsage);
    assert.equal(lateParsed.length, 1);
    assert.deepEqual(lateParsed[0].usage, [300, 150, 700, 0]);
    assert.equal(ledger.attemptUsageFromCalls("att-1"), 1150);
    assert.deepEqual(ledger.verifyUsageConsistency(), []);

    // Duplicate receipt after an on-time receive must also leave late_usage empty
    ledger.create("att-2", "r1", "deepseek", "deepseek-chat");
    assert.equal(ledger.beginCall("att-2", "call-2", "write", 500, 1000), true);
    assert.equal(ledger.receiveCall("att-2", "call-2", [200, 100, 300, 0]), true);
    assert.equal(ledger.receiveCall("att-2", "call-2", [200, 100, 300, 0]), false);
    const att2Hist = ledger.history("r1").find((h) => h.id === "att-2");
    assert.deepEqual(JSON.parse(att2Hist.lateUsage), []);
    assert.equal(ledger.attemptUsageFromCalls("att-2"), 600);
    assert.deepEqual(ledger.verifyUsageConsistency(), []);

    // 5. DB-20 Windows reserved filenames & EPERM/EBUSY 3x rename retry
    for (const reserved of ["CON", "prn", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9", "CON.txt"]) {
      const safe = sanitizePathSegment(reserved);
      assert.notEqual(safe.toUpperCase(), reserved.toUpperCase());
      assert.doesNotMatch(safe, /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i);
    }
    assert.equal(sanitizePathSegment("第一章   ... "), "第一章");

    let transientAttempts = 0;
    renameWithRetry("a", "b", {
      maxAttempts: 3,
      baseDelayMs: 1,
      renameFn() {
        transientAttempts += 1;
        if (transientAttempts < 3) {
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        }
      },
    });
    assert.equal(transientAttempts, 3);

    assert.throws(
      () =>
        renameWithRetry("a", "b", {
          maxAttempts: 3,
          baseDelayMs: 1,
          renameFn() {
            throw Object.assign(new Error("still locked"), { code: "EPERM" });
          },
        }),
      (err) => err instanceof StorageError && err.code === "dependency.unavailable" && err.details.reason === "export-directory-locked",
    );

    const exportTarget = join(dir, "bundle-out");
    const written = writeLocalBundleToDir(exportTarget, [{ path: "01.md", content: "测试正文" }], { baseDelayMs: 1 });
    assert.equal(written.count, 1);
    assert.equal(existsSync(join(exportTarget, "01.md")), true);
    } finally {
      db.close();
    }
  });
});

test("DB-24 cross-process write lock triggers SQLITE_BUSY and recovers cleanly after release", async () => {
  await withTempDir("zhizhang-v23-busy-", async (dir) => {
    const dbPath = join(dir, "lock.sqlite");
    createStore(dbPath);
    const setupDb = openStore(dbPath);
    setupDb.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);");
    setupDb.close();

    // Child holds BEGIN EXCLUSIVE for 250ms, signaling "LOCKED" on stdout
    const childScript = `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
      db.exec("BEGIN EXCLUSIVE;");
      db.prepare("INSERT INTO kv VALUES ('holder', 'child');").run();
      process.stdout.write("LOCKED\\n");
      setTimeout(() => {
        db.exec("COMMIT;");
        db.close();
      }, 250);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, dbPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        if (buf.includes("LOCKED")) resolve();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (!buf.includes("LOCKED")) reject(new Error(`child exited early: ${code}`));
      });
    });

    // Connection with very short timeout hits SQLITE_BUSY while child holds lock
    const shortDb = openDatabase(dbPath, { timeout: 20 });
    try {
      assert.throws(() => {
        shortDb.exec("BEGIN IMMEDIATE;");
      }, /locked|busy/i);
    } finally {
      shortDb.close();
    }

    // Connection with normal 5000ms busy_timeout waits cleanly and succeeds after child commits
    const normalDb = openStore(dbPath);
    try {
      withWriteTx(normalDb, () => {
        normalDb.prepare("INSERT INTO kv VALUES ('parent', 'ok');").run();
      });
      assert.equal(normalDb.prepare("SELECT COUNT(*) AS n FROM kv;").get().n, 2);
    } finally {
      normalDb.close();
    }

    await new Promise((resolve) => child.on("exit", resolve));
  });
});

test("FQ-04 context-slots keeps stablePrefix byte-identical across dynamic tail sizes, and FQ-10/13/20/23 prompts & validators work", () => {
  const prefixSlots = [
    { id: "compass", label: "全书指南针", group: "prefix", priority: "high", content: "终局打破灰塔时间封锁。" },
    { id: "techniques", label: "显式挂载技法", group: "prefix", priority: "medium", content: "章末留半句悬念，场景具象描写。".repeat(12) },
  ];

  const smallDyn = assembleContextBundle({
    slots: [
      ...prefixSlots,
      { id: "outline", label: "章纲", group: "dynamic", priority: "critical", content: "第三章：夜探。" },
      { id: "draft", label: "正文", group: "dynamic", priority: "critical", content: "短草稿。".repeat(20) },
    ],
    maxInputTokens: 900,
  });

  const hugeDyn = assembleContextBundle({
    slots: [
      ...prefixSlots,
      { id: "outline", label: "章纲", group: "dynamic", priority: "critical", content: "第四章：决战钟室。" },
      { id: "summaries", label: "前文摘要", group: "dynamic", priority: "optional", content: "前文滚动摘要记录。".repeat(400), trimMode: "head" },
      { id: "draft", label: "正文", group: "dynamic", priority: "critical", content: "超长动态章节正文。".repeat(200) },
    ],
    maxInputTokens: 900,
  });

  assert.equal(
    smallDyn.stablePrefix,
    hugeDyn.stablePrefix,
    "stablePrefix MUST stay byte-for-byte identical regardless of dynamic tail size",
  );
  assert.equal(hugeDyn.report.slots.find((s) => s.id === "techniques").status, "included");
  assert.ok(hugeDyn.report.prefixBudget > 0 && hugeDyn.report.dynamicBudget > 0);
  const sumSlot = hugeDyn.report.slots.find((s) => s.id === "summaries");
  assert.ok(sumSlot.status === "dropped" || sumSlot.status === "truncated");

  // Prefix over prefixBudget reports overBudget=true without truncating Prefix slots
  const prefixOverflow = assembleContextBundle({
    slots: [
      { id: "bigPrefix", label: "大约定", group: "prefix", priority: "medium", content: "核心规则。".repeat(120) },
      { id: "dyn", label: "正文", group: "dynamic", priority: "critical", content: "正文。" },
    ],
    maxInputTokens: 400,
    prefixBudget: 150,
  });
  assert.equal(prefixOverflow.report.overBudget, true);
  assert.equal(prefixOverflow.report.slots.find((s) => s.id === "bigPrefix").status, "included");

  // FQ-13 prompts exported from both writing-budget.ts and workflow/prompts/
  assert.equal(FANQIE_SYSTEM_CONTINUE, prompts.FANQIE_SYSTEM_CONTINUE);
  assert.equal(FANQIE_SYSTEM_REWRITE, prompts.FANQIE_SYSTEM_REWRITE);
  assert.equal(FANQIE_SYSTEM_TARGETED, prompts.FANQIE_SYSTEM_TARGETED);
  assert.ok(FACT_SYNC_SYSTEM.includes("updates") && FACT_SYNC_SYSTEM.includes("retiredFacts"));
  assert.ok(ARC_PLAN_SYSTEM.includes("actSummary") && ARC_PLAN_SYSTEM.includes("nextActTitle"));

  // FQ-10 & FQ-20 factSync validator
  assert.equal(
    isValidFactSyncPayload({
      newFacts: [{ category: "character", entityName: "沈青", note: "出场", aliases: ["青哥"] }],
      updates: [{ factId: "fq-1", note: "更新描述" }],
      retiredFacts: [{ factId: "fq-old", point: 3, reason: "人物已确认死亡" }],
    }),
    true,
  );
  assert.equal(isValidFactSyncPayload({ updates: [{ note: "missing factId" }] }), false);
  assert.equal(isValidFactSyncPayload({ retiredFacts: [{ factId: "f1", point: 0, reason: "bad point" }] }), false);
  assertStageOutput(WRITING_STAGE_IDS.factSync, { retiredFacts: [{ factId: "f1", reason: "已失效" }] }, "factSync");

  // FQ-23 arcPlan validator
  assert.equal(isValidArcPlanPayload({ actSummary: "本幕结束", nextActTitle: "第二幕", pacingTemplate: "快爽" }), true);
  assert.equal(isValidArcPlanPayload({ actSummary: 123 }), false);
  assertStageOutput(WRITING_STAGE_IDS.arcPlan, { actSummary: "有效摘要", currentFocus: "焦点" }, "arcPlan");
});

test("DB-21 schema-doc.mjs generates deterministic schema documentation matching sqlite_master", () => {
  const summary = buildFreshSchemaSummary();
  assert.equal(summary.schemaId, "zhizhang/2.3");
  assert.equal(summary.userVersion, 23);
  assert.ok(summary.tables.some((tbl) => tbl.name === "author_micro_calls" && tbl.strict === true));
  assert.ok(summary.tables.some((tbl) => tbl.name === "event_log_quarantine" && tbl.strict === true));
  assert.ok(summary.indexes.some((idx) => idx.name === "ux_proposal_inflight" && idx.unique && idx.partial));
  assert.equal(summary.counts.ftsTables, 3);
  assert.equal(summary.counts.views, 3);
  assert.equal(summary.counts.triggers, 14);

  const md = renderSchemaMarkdown(summary);
  assert.ok(md.includes("zhizhang/2.3"));
  assert.ok(md.includes("author_micro_calls"));
  assert.ok(md.includes("ux_proposal_inflight"));
});
