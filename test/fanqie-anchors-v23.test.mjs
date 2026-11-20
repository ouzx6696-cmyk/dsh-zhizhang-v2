import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { computeParagraphDelta } from "../src/application/products/fanqie/memory-sync.ts";
import { pointAtOffset, splitChapterParagraphs } from "../src/domain/shared/anchors.ts";
import { applyPointBackfill, buildPointReport } from "../scripts/evidence-point-migrate.mjs";
import { createTestWorkspace } from "../support/v2-harness.mjs";

// FQ-02: one non-empty line is one paragraph. Evidence anchors, the memory
// delta markers and the offline diagnostics must all count the same way,
// including blank-line separators and mixed line endings.

const BODY = "第一段。\r\n\r\n第二段。\r\n\r\n第三段含怀表。\r\n\r\n第四段。";

test("a blank-line separated chapter keeps one paragraph numbering across evidence and delta", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ title: "第一章", body: BODY });

  assert.equal(splitChapterParagraphs(BODY).length, 4);
  const offset = BODY.indexOf("第三段含怀表");
  assert.equal(pointAtOffset(BODY, offset), 3);

  const evidence = ws.app.mutation("evidence.record", {
    documentId: chapter.documentId,
    baseRevisionId: chapter.revisionId,
    factId: "f-watch",
    quote: "第三段含怀表。",
  });
  assert.equal(evidence.anchor.point, "3");

  const delta = computeParagraphDelta("第一段。\n\n第二段。", BODY);
  assert.match(delta.deltaText, /\[P3\] 第三段含怀表。/);
  assert.equal(delta.changedParagraphCount, 2);
});

test("lone carriage returns are paragraph separators, not part of the text", () => {
  const body = "甲\r\r乙\r丙";
  assert.equal(splitChapterParagraphs(body).length, 3);
  assert.equal(pointAtOffset(body, body.indexOf("丙")), 3);

  const delta = computeParagraphDelta("甲\r\r乙", body);
  assert.match(delta.deltaText, /\[P3\] 丙/);
  assert.doesNotMatch(delta.deltaText, /\r/);
});

test("the point backfill reports drift before touching rows and is idempotent", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ title: "第一章", body: BODY });
  const offset = BODY.indexOf("第三段含怀表");

  ws.db.prepare(`
    INSERT INTO author_evidence (
      snapshot_id, project_id, document_id, fact_id, revision_id,
      point, quote_start, quote_end, verification_kind, verification_score
    ) VALUES (?, ?, ?, ?, ?, 99, ?, ?, 'exact', 100);
  `).run(randomUUID(), chapter.projectId, chapter.documentId, "f-watch", chapter.revisionId, offset, offset + 6);

  const report = buildPointReport(ws.db);
  assert.equal(report.totalEvidence, 1);
  assert.equal(report.recomputable, 1);
  assert.equal(report.changed, 1);
  assert.deepEqual(report.samples.map((row) => ({ from: row.from, to: row.to })), [{ from: 99, to: 3 }]);

  assert.equal(applyPointBackfill(ws.db, report.samples), 1);
  assert.equal(buildPointReport(ws.db).changed, 0);
  assert.equal(applyPointBackfill(ws.db, report.samples), 0, "re-applying a stale report must not rewrite rows");

  const row = ws.db.prepare("SELECT point FROM author_evidence;").get();
  assert.equal(row.point, 3);
});
