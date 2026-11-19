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
console.log(JSON.stringify({ baseline, withHistory }, null, 2));
db.close();
