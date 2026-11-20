import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENT_ENTRY_CSS, CLIENT_ENTRY_HTML, CLIENT_JS_MODULES } from "../src/client/manifest.ts";
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
  const fanqieFiles = [
    fileURLToPath(new URL("../src/application/products/fanqie.ts", import.meta.url)),
    ...walkTsFiles("../src/application/products/fanqie/"),
  ];
  for (const file of fanqieFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(domain\/toutiao|products\/toutiao)/);
  }
  const toutiaoFiles = [
    fileURLToPath(new URL("../src/application/products/toutiao.ts", import.meta.url)),
    ...walkTsFiles("../src/application/products/toutiao/"),
  ];
  for (const file of toutiaoFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(domain\/fanqie|products\/fanqie)/);
  }

  const hostFiles = [
    "../src/host/writing.ts",
    "../src/host/plugin.ts",
    "../src/host/tools.ts",
    "../src/host/settings.ts",
  ];
  for (const relativePath of hostFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*domain\//);
  }

  const basePlatformFiles = [
    "../src/application/context.ts",
    "../src/application/run-service.ts",
    "../src/application/snapshot-service.ts",
    "../src/application/proposal-service.ts",
    "../src/workflow/author-reads.ts",
  ];
  for (const relativePath of basePlatformFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(domain\/fanqie|domain\/toutiao|products\/fanqie|products\/toutiao)/);
  }
  for (const decoupledFile of ["../src/application/snapshot-service.ts", "../src/application/proposal-service.ts"]) {
    const source = readFileSync(new URL(decoupledFile, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(author_volumes|author_acts|author_candidate_qa|author_lore_current)\b/);
  }

  const shellSource = readFileSync(new URL("../src/client/workbench/shell.ts", import.meta.url), "utf8");
  assert.doesNotMatch(shellSource, /from\s+["'][^"']*plugins\/(fanqie|toutiao)/);

  const fanqieUi = readFileSync(new URL("../src/client/workbench/plugins/fanqie.ts", import.meta.url), "utf8");
  const toutiaoUi = readFileSync(new URL("../src/client/workbench/plugins/toutiao.ts", import.meta.url), "utf8");
  assert.doesNotMatch(fanqieUi, /from\s+["'][^"']*plugins\/toutiao/);
  assert.doesNotMatch(toutiaoUi, /from\s+["'][^"']*plugins\/fanqie/);

  for (const file of walkTsFiles("../src/client/workbench/")) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\b(window|globalThis)\.(confirm|prompt|alert)\s*\(/);
    if (!file.endsWith("modal.ts")) {
      assert.doesNotMatch(source, /(?<![.\w])(confirm|prompt|alert)\s*\(/);
    }
  }
});

function walkTsFiles(relativeDir) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
    }
  }
  visit(fileURLToPath(new URL(relativeDir, import.meta.url)));
  return files;
}

function importSpecifiers(source) {
  const specs = [];
  for (const match of source.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s+["']([^"']+)["']/g)) {
    specs.push(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
    specs.push(match[1]);
  }
  return specs;
}

test("all layers satisfy recursive static dependency boundaries and workspace-dto remains strictly type-only", async () => {
  const rules = [
    {
      dir: "../src/domain/fanqie/",
      forbidden: [/(^|\/)domain\/toutiao/, /(^|\/)host(\/|$)/, /(^|\/)client(\/|$)/, /(^|\/)application(\/|$)/],
    },
    {
      dir: "../src/domain/toutiao/",
      forbidden: [/(^|\/)domain\/fanqie/, /(^|\/)host(\/|$)/, /(^|\/)client(\/|$)/, /(^|\/)application(\/|$)/],
    },
    {
      dir: "../src/domain/shared/",
      forbidden: [/fanqie/, /toutiao/, /(^|\/)storage(\/|$)/, /(^|\/)workflow(\/|$)/, /(^|\/)application(\/|$)/, /(^|\/)host(\/|$)/, /(^|\/)client(\/|$)/],
    },
    {
      dir: "../src/storage/",
      forbidden: [/(^|\/)domain(\/|$)/, /(^|\/)application(\/|$)/, /(^|\/)host(\/|$)/, /(^|\/)client(\/|$)/],
    },
    {
      dir: "../src/client/",
      forbidden: [/(^|\/)storage(\/|$)/, /(^|\/)host(\/|$)/, /(^|\/)application(\/|$)/, /^node:/],
    },
  ];

  for (const rule of rules) {
    const files = walkTsFiles(rule.dir);
    assert.ok(files.length > 0, `No .ts files found in ${rule.dir}`);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        for (const pattern of rule.forbidden) {
          assert.doesNotMatch(spec, pattern, `Forbidden import "${spec}" in ${file}`);
        }
      }
    }
  }

  // Browser-safe DTO module must emit zero runtime code.
  const dtoPath = fileURLToPath(new URL("../src/contracts/workspace-dto.ts", import.meta.url));
  const dtoSource = readFileSync(dtoPath, "utf8");
  assert.doesNotMatch(dtoSource, /^\s*export\s+(?:const|let|var|function|class|enum)\b/m);
  const dtoRuntime = await import("../src/contracts/workspace-dto.ts");
  assert.deepEqual(Object.keys(dtoRuntime), []);
});

test("AGENTS.md test layout invariant keeps shared helpers outside test/ and only *.test.mjs inside test/", () => {
  const testDir = fileURLToPath(new URL("../test/", import.meta.url));
  const entries = readdirSync(testDir, { withFileTypes: true });
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.isFile(), true, `Unexpected non-file entry in test/: ${entry.name}`);
    assert.equal(entry.name.endsWith(".test.mjs"), true, `Non-test module found in test/: ${entry.name}`);
  }
  assert.equal(existsSync(fileURLToPath(new URL("../support/a01.mjs", import.meta.url))), true);
  assert.equal(existsSync(fileURLToPath(new URL("../support/v2-harness.mjs", import.meta.url))), true);
});

test("client manifest, package.json, and cordis.patch.yml metadata stay synchronized with zero runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, true);

  for (const entryFile of [CLIENT_ENTRY_HTML, CLIENT_ENTRY_CSS]) {
    assert.equal(existsSync(fileURLToPath(new URL(`../src/client/${entryFile}`, import.meta.url))), true);
    assert.equal(pkg.files.includes(`src/client/${entryFile}`), true);
  }
  for (const modulePath of CLIENT_JS_MODULES) {
    const tsRelative = `../src/client/${modulePath.replace(/\.js$/, ".ts")}`;
    assert.equal(existsSync(fileURLToPath(new URL(tsRelative, import.meta.url))), true, `Missing TS source for ${modulePath}`);
  }

  const patch = readFileSync(new URL("../src/bundle/cordis.patch.yml", import.meta.url), "utf8");
  assert.ok(patch.includes(`'${pkg.name}'`), `cordis.patch.yml must reference ${pkg.name}`);
});
