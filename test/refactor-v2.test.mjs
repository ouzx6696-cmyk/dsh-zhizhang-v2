import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computeParagraphDiff,
  countNonWhitespaceChars,
  countUnicodeCodePoints,
} from "../src/client/workbench/diff.ts";
import { openAuthorWorkspace } from "../src/host/workspace.ts";
import { generateCandidate } from "../src/host/writing.ts";
import { openDatabase } from "../src/storage/index.ts";
import {
  WRITING_STAGE_IDS,
  assertStageOutput,
  createWritingStageRegistry,
} from "../src/workflow/writing-stages.ts";

test("pure paragraph LCS diff handles identical, modified, added, removed, and CJK text", () => {
  const identical = computeParagraphDiff("第一段\n第二段", "第一段\n第二段");
  assert.equal(identical.added, 0);
  assert.equal(identical.removed, 0);
  assert.equal(identical.changed, 0);
  assert.equal(identical.unchanged, 2);

  const edited = computeParagraphDiff(
    "林推开门。\n桌上放着一封信。\n窗外下着雨。",
    "林缓缓推开门。\n桌上放着一封信。\n信封没有署名。\n窗外下着雨。",
  );
  assert.equal(edited.unchanged, 2);
  assert.equal(edited.changed, 1);
  assert.equal(edited.added, 1);
  assert.equal(edited.removed, 0);
  assert.deepEqual(
    edited.rows.map((row) => row.kind),
    ["changed", "equal", "added", "equal"],
  );

  const emptied = computeParagraphDiff("只有一段", "");
  assert.equal(emptied.removed, 1);
  assert.equal(emptied.added, 0);
});

test("Unicode code-point and non-whitespace character counters handle astral glyphs accurately", () => {
  assert.equal(countUnicodeCodePoints("织章🔥标题"), 5);
  assert.equal(countNonWhitespaceChars("第一段 　\n\t 第二段🔥"), 7);
});

test("clean V2 schema persists decided_seq, late_usage_settled, article reports, and evidence", () => {
  const db = openDatabase(":memory:");
  try {
    const app = openAuthorWorkspace(db);
    const fanqie = app.mutation("project.create", { product: "fanqie", name: "连载测试" });
    const chapter = app.mutation("document.create", { projectId: fanqie.id, title: "第一章" });
    const saved = app.mutation("draft.save", {
      documentId: chapter.id,
      baseRevisionId: null,
      body: "林收到了匿名信。",
    });

    const proposal = app.mutation("setting.propose", {
      projectId: fanqie.id,
      documentId: chapter.id,
      factId: "secret-letter",
      note: "匿名信来自旧友",
      source: "作者笔记",
      from: { chapterId: chapter.id, point: 1 },
      people: [{ character: "林", at: { chapterId: chapter.id, point: 1 } }],
    });
    app.mutation("setting.decide", {
      projectId: fanqie.id,
      documentId: chapter.id,
      proposalId: proposal.id,
      accept: true,
    });

    const settingRow = db.prepare("SELECT decided_seq, decision FROM author_settings WHERE id = ?").get(proposal.id);
    assert.equal(settingRow.decision, "approved");
    assert.ok(typeof settingRow.decided_seq === "number" && settingRow.decided_seq > 0);

    const evidence = app.mutation("evidence.record", {
      documentId: chapter.id,
      baseRevisionId: saved.revisionId,
      factId: "secret-letter",
      quote: "匿名信",
    });
    const evRow = db.prepare("SELECT fact_id, quote_start, quote_end FROM author_evidence WHERE snapshot_id = ?").get(evidence.snapshotId);
    assert.equal(evRow.fact_id, "secret-letter");
    assert.equal("林收到了匿名信。".slice(evRow.quote_start, evRow.quote_end), "匿名信");

    // Verify late_usage_settled column prevents double counting after cancel.
    const run = app.mutation("run.start", {
      documentId: chapter.id,
      baseRevisionId: saved.revisionId,
      instruction: "扩写",
      tokenLimit: 12000,
    });
    app.mutation("run.cancel", { runId: run.id });
    app.mutation("run.complete", { runId: run.id, body: "晚到的候选稿", tokens: 320 });
    const runRow = db.prepare("SELECT late_usage_settled, settled, candidate_id FROM author_runs WHERE id = ?").get(run.id);
    assert.equal(runRow.late_usage_settled, 1);
    assert.equal(runRow.settled, 320);
    assert.equal(runRow.candidate_id, null);

    // Verify author_article_reports indexed table for Toutiao.
    const toutiao = app.mutation("project.create", { product: "toutiao", name: "观察" });
    const article = app.mutation("document.create", { projectId: toutiao.id, title: "短评标题", mode: "short", line: "资讯线" });
    const articleSaved = app.mutation("draft.save", {
      documentId: article.id,
      baseRevisionId: null,
      body: "正文".repeat(600),
    });
    app.mutation("article.qa", {
      documentId: article.id,
      baseRevisionId: articleSaved.revisionId,
      score: 88,
      passed: true,
      fails: [],
      hardGates: [],
    });
    const reportRow = db.prepare("SELECT kind, payload FROM author_article_reports WHERE document_id = ?").get(article.id);
    assert.equal(reportRow.kind, "article.qa");
    assert.equal(JSON.parse(reportRow.payload).overall, 88);
  } finally {
    db.close();
  }
});

test("durable projection checkpoints survive cold workspace reopen without losing watermark or state", () => {
  const db = openDatabase(":memory:");
  try {
    const app1 = openAuthorWorkspace(db);
    const project = app1.mutation("project.create", { product: "fanqie", name: "持久化验证" });
    const chapter = app1.mutation("document.create", { projectId: project.id, title: "序章" });
    app1.mutation("draft.save", { documentId: chapter.id, baseRevisionId: null, body: "起笔正文。" });
    const nav1 = app1.mutation("read.model", { projectId: project.id, model: "navigation" });

    const checkpoints = db.prepare("SELECT cache_key, seq FROM author_read_checkpoints WHERE project_id = ?").all(project.id);
    assert.ok(checkpoints.length > 0);
    assert.ok(checkpoints.some((row) => row.seq === nav1.asOfSeq));

    // Reopen a brand new workspace instance over the same SQLite handle (cold in-memory cache).
    const app2 = openAuthorWorkspace(db);
    const nav2 = app2.mutation("read.model", { projectId: project.id, model: "navigation" });
    assert.equal(nav2.asOfSeq, nav1.asOfSeq);
    assert.deepEqual(nav2.value, nav1.value);

    // Further mutation replays forward tail cleanly on top of restored checkpoint.
    const snap = app2.snapshot(project.id, chapter.id);
    app2.mutation("draft.save", {
      documentId: chapter.id,
      baseRevisionId: snap.active.revisionId,
      body: "续写正文。",
    });
    const nav3 = app2.mutation("read.model", { projectId: project.id, model: "navigation" });
    assert.ok(nav3.asOfSeq > nav2.asOfSeq);
    const rev3 = app2.mutation("read.model", { projectId: project.id, model: "revision-candidate", documentId: chapter.id });
    assert.equal(rev3.asOfSeq, nav3.asOfSeq);
  } finally {
    db.close();
  }
});

test("writing stage registry validates stage outputs and host writing transport enforces budget guard", async () => {
  const registry = createWritingStageRegistry();
  assert.ok(registry.get(WRITING_STAGE_IDS.write, 1));
  assert.ok(registry.get(WRITING_STAGE_IDS.qa, 1));
  assert.ok(registry.get(WRITING_STAGE_IDS.refine, 1));

  assert.throws(
    () => assertStageOutput(WRITING_STAGE_IDS.write, "   ", "body"),
    (error) => error.code === "stage.output_invalid",
  );
  assert.throws(
    () => assertStageOutput(WRITING_STAGE_IDS.qa, { overall: 150, passed: true, fails: [], hardGates: [] }, "qa"),
    (error) => error.code === "stage.output_invalid",
  );

  // Empty candidate output from LLM is rejected via StageRegistry validator.
  const blankLlm = {
    async prepareCall() {
      return {
        config: {},
        async *stream() {
          yield { type: "text-delta", index: 0, text: "   " };
          yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
    },
  };
  const run = {
    provider: "fixture",
    model: "test",
    reserved: 8000,
    autoQa: false,
    frozenInput: JSON.stringify({ title: "测试", instruction: "续写", text: "原文" }),
  };
  await assert.rejects(
    generateCandidate(blankLlm, run, new AbortController().signal, () => {}, {
      begin: () => 1,
      receive: () => {},
    }),
    { code: "stage.output_invalid" },
  );
});

test("architecture boundaries enforce domain isolation and zero native browser dialogs", () => {
  const fanqieService = readFileSync(new URL("../src/application/fanqie-service.ts", import.meta.url), "utf8");
  const toutiaoService = readFileSync(new URL("../src/application/toutiao-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(fanqieService, /from\s+["'][^"']*domain\/toutiao/);
  assert.doesNotMatch(toutiaoService, /from\s+["'][^"']*domain\/fanqie/);

  const clientFiles = [
    "../src/client/workbench/main.ts",
    "../src/client/workbench/modal.ts",
    "../src/client/workbench/views/diff-view.ts",
    "../src/client/workbench/views/run-inspector.ts",
  ];
  for (const relativePath of clientFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(window|globalThis)\.(confirm|prompt|alert)\s*\(/);
    if (!relativePath.endsWith("modal.ts")) {
      assert.doesNotMatch(source, /(?<![.\w])(confirm|prompt|alert)\s*\(/);
    }
  }
});
