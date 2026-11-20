import assert from "node:assert/strict";
import test from "node:test";
import { createTestWorkspace } from "../support/v2-harness.mjs";

// FQ-01 / resolution #13: a later approval must not postpone an earlier
// "already knew it" point. Chapter 3 knows the fact, chapter 10 mentions it
// again, and a query at chapter 5 must still see it.

test("approving a later version keeps the earlier per-character knowledge anchor", (t) => {
  const ws = createTestWorkspace(t);
  const prelude = ws.createFanqieChapter({ title: "序章", body: "林砚还没见过那只怀表。" });
  const projectId = prelude.projectId;
  const preludeId = prelude.documentId;
  const c3 = ws.app.mutation("document.create", { projectId, title: "第三章" });
  const c5 = ws.app.mutation("document.create", { projectId, title: "第五章" });
  const c10 = ws.app.mutation("document.create", { projectId, title: "第十章" });

  const propose = (chapterId, note) => ws.app.mutation("setting.propose", {
    projectId,
    documentId: chapterId,
    factId: "f-clock",
    note,
    source: "手记",
    category: "character",
    entityName: "林砚",
    from: { chapterId, point: 1 },
    people: [{ character: "林砚", at: { chapterId, point: 1 } }],
  });
  const approve = (chapterId, proposalId) =>
    ws.app.mutation("setting.decide", { projectId, documentId: chapterId, proposalId, accept: true });
  const read = (chapterId) => ws.app.mutation("settings.read", {
    projectId,
    character: "林砚",
    at: { chapterId, point: 1 },
  });

  approve(c3.id, propose(c3.id, "银色怀表属于林砚").id);
  approve(c10.id, propose(c10.id, "怀表盖内侧刻着林砚的名字").id);

  assert.equal(read(preludeId).entries.length, 0, "nothing is known before the chapter 3 anchor");

  const at5 = read(c5.id);
  assert.equal(at5.entries.length, 1, "the chapter 3 version stays visible in chapter 5");
  assert.equal(at5.entries[0].id, "f-clock");
  assert.equal(at5.entries[0].note, "银色怀表属于林砚");
  assert.equal(at5.entries[0].knownFrom["林砚"].chapterId, c3.id, "knowledge anchor must stay at chapter 3");

  const at10 = read(c10.id);
  assert.equal(at10.entries.length, 1);
  assert.equal(at10.entries[0].note, "怀表盖内侧刻着林砚的名字", "the later version wins from chapter 10");
  assert.equal(at10.entries[0].knownFrom["林砚"].chapterId, c3.id, "the later version must not postpone knowledge");
  assert.equal(at10.entries[0].effectiveFrom.chapterId, c10.id, "the author's explicit from starts the new version");
});
