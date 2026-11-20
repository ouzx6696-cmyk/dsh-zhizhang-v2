import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { openAuthorWorkspace } from "../src/host/workspace.ts";
import { openDatabase } from "../src/storage/index.ts";

const db = openDatabase(":memory:");
const app = openAuthorWorkspace(db, () => {});
const projectId = app.mutation("project.create", { name: "性能夹具", product: "fanqie" }).id;
const body = "章".repeat(10_000);
const chapters = [];
for (let index = 0; index < 650; index++) {
  const documentId = app.mutation("document.create", { projectId, title: `第 ${index + 1} 章` }).id;
  const { revisionId } = app.mutation("draft.save", { documentId, body });
  chapters.push({ documentId, revisionId });
}
const { documentId, revisionId: baseRevisionId } = chapters[0];
const sample = () => {
  const times = [];
  let bytes = 0;
  for (let index = 0; index < 31; index++) {
    const start = performance.now();
    const json = JSON.stringify(app.snapshot(projectId, documentId));
    if (index > 0) times.push(performance.now() - start);
    bytes = Buffer.byteLength(json);
  }
  times.sort((a, b) => a - b);
  return { bytes, p50: times[14], p95: times[28] };
};
const baseline = sample();
for (let index = 0; index < 100; index++) {
  const { id: runId } = app.mutation("run.start", { documentId, baseRevisionId, instruction: "补稿", tokenLimit: 40_000 });
  app.mutation("run.complete", { runId, body, tokens: 400 });
  app.mutation("run.discard", { runId });
}
const withHistory = sample();
assert.ok(baseline.bytes < 100 * 1024, "Initial workbench snapshot exceeds 100 KiB");
assert.ok(withHistory.bytes < 150 * 1024, "Snapshot with discarded candidates exceeds 150 KiB");

// Measure extended 650-chapter novel query latencies (tree.get, FTS5 workspace.search, context.preview)
app.mutation("volume.create", { projectId, title: "第一卷" });
const tTree0 = performance.now();
const tree = app.mutation("tree.get", { projectId });
const treeMs = performance.now() - tTree0;
assert.equal(tree.chapters.length, 650);

const tSearch0 = performance.now();
const hits = app.mutation("workspace.search", { projectId, query: "第 650 章" });
const searchMs = performance.now() - tSearch0;
assert.ok(hits.length >= 1);

const tCtx0 = performance.now();
const ctxPreview = app.mutation("context.preview", { documentId: chapters[10].documentId, instruction: "推进冲突" });
const contextMs = performance.now() - tCtx0;
assert.ok(ctxPreview.report.slots.length > 0);

console.log(JSON.stringify({ baseline, withHistory, novelOpsMs: { treeMs, searchMs, contextMs } }, null, 2));
db.close();
