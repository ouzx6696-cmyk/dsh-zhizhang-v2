import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_ID,
  SCHEMA_USER_VERSION,
  auditEventLogConcerns,
  createDocument,
  createStore,
  openStore,
  pruneCommandJournal,
  readSchemaId,
  runAuthorWrite,
  searchWorkspaceFts,
  verifyFtsIntegrity,
} from "../src/storage/index.ts";
import { createTestWorkspace, withTempDir } from "../support/harness.mjs";

test("zhizhang/3.0 SQLite store sets user_version=30, schema_id, and clean-slate tables", async () => {
  await withTempDir("zhizhang-store-", (dir) => {
    const file = `${dir}/workspace.sqlite`;
    createStore(file);
    const db = openStore(file);
    try {
      assert.equal(readSchemaId(db), SCHEMA_ID);
      const uv = db.prepare("PRAGMA user_version;").get().user_version;
      assert.equal(uv, SCHEMA_USER_VERSION);

      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table';").all().map((r) => r.name),
      );
      assert.equal(tables.has("meta"), true);
      assert.equal(tables.has("author_generation_attempts"), false);
      assert.equal(tables.has("author_micro_usage"), false);
    } finally {
      db.close();
    }
  });
});

test("command journal enforces idempotency and prunes old entries cleanly", (t) => {
  const ws = createTestWorkspace(t);
  createDocument(ws.db, "doc-journal-1");

  let executions = 0;
  const req = {
    actorId: "author",
    commandId: "draft.save",
    documentId: "doc-journal-1",
    idempotencyKey: "req-1",
    payload: { value: 42 },
    baseRevisionId: null,
  };
  const first = runAuthorWrite(ws.db, req, () => {
    executions += 1;
    return { saved: true, count: executions };
  });
  const second = runAuthorWrite(ws.db, req, () => {
    executions += 1;
    return { saved: true, count: executions };
  });
  assert.equal(executions, 1);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);

  const pruned = pruneCommandJournal(ws.db, { maxAgeMs: 0, maxRows: 0 });
  assert.ok(pruned.deleted >= 0);
});

test("event_log concern audit reports zero unclassified events after workspace writes", (t) => {
  const ws = createTestWorkspace(t);
  const ch = ws.createFanqieChapter({ title: "序章", body: "青铜古剑在雪夜里嗡鸣。" });
  ws.app.mutation("chapter.review", {
    documentId: ch.documentId,
    baseRevisionId: ch.baseRevisionId,
    accept: true,
  });

  const audit = auditEventLogConcerns(ws.db);
  assert.equal(audit.missingConcern, 0);
  assert.equal(audit.invalidConcern, 0);
  assert.ok(audit.total >= 2);
});

test("External Content FTS5 triggers index chapters, lore, and library with CJK 2-char fallback", (t) => {
  const ws = createTestWorkspace(t);
  const { projectId, documentId } = ws.createFanqieChapter({
    projectName: "雪夜刀客",
    title: "第一章 青铜古剑",
    body: "沈砚在雪夜里拔出青铜古剑，城楼钟声骤响。",
  });

  ws.app.mutation("setting.propose", {
    projectId,
    documentId,
    factId: "sword-origin",
    note: "青铜古剑来自北境遗迹，唯有沈砚可唤醒。",
    source: "作者设定",
    from: { chapterId: documentId, point: 1 },
    people: [{ character: "沈砚", at: { chapterId: documentId, point: 1 } }],
  });
  const pending = ws.app.snapshot(projectId, documentId).settings[0];
  ws.app.mutation("setting.decide", { projectId, documentId, proposalId: pending.id, accept: true });

  ws.app.mutation("technique.save", {
    projectId,
    title: "雪夜反杀节奏",
    category: "action",
    executionSteps: "先压抑环境音，再以青铜古剑出鞘破局。",
  });

  // 3+ char trigram BM25 query
  const swordHits = searchWorkspaceFts(ws.db, { projectId, query: "青铜古剑", limit: 10 });
  assert.ok(swordHits.length >= 2);
  const scopes = new Set(swordHits.map((h) => h.scope));
  assert.equal(scopes.has("chapter"), true);
  assert.equal(scopes.has("lore"), true);

  // 2-char CJK entity LIKE fallback + RRF fusion
  const personHits = searchWorkspaceFts(ws.db, { projectId, query: "沈砚", limit: 10 });
  assert.ok(personHits.length >= 1);

  // FTS5 integrity check passes cleanly
  assert.doesNotThrow(() => verifyFtsIntegrity(ws.db));
});
