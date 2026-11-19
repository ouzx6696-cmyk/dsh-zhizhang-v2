import assert from "node:assert/strict";
import test from "node:test";

// C-01 reference fixture for the workbench surface. The layout, comparison and
// draft-stash mechanics below are recorded from the v1.x workbench client as
// forensic evidence, not as the frozen V2 contract. The editor-kernel
// comparison at a real mount position (Chinese IME, Markdown, long chapters,
// undo, disconnect recovery, host theme) depends on H-01 and is not covered
// here; this fixture records the comparison criteria and the author-facing
// guarantees that any kernel must keep.
//
// Guarantees recorded for every candidate kernel:
//   - only the centre region holds the manuscript; panel toggles never clear it
//   - candidate comparison is read-only until the author adopts
//   - adoption moves the working revision and never the finalized one
//   - unsaved edits survive a reopen with their base revision attached
//   - a stashed draft whose base revision moved on surfaces the conflict and
//     preserves the current edit instead of silently overwriting it
const REGIONS = ["assistant", "manuscript", "pipeline"];

function createWorkbench() {
  return {
    regions: { assistant: true, manuscript: true, pipeline: true },
    manuscript: null,
  };
}

function openManuscript(workbench, work) {
  return { ...workbench, manuscript: { ...work } };
}

// Panel visibility is per region; the open manuscript is never part of it.
function setRegionVisible(workbench, region, visible) {
  assert.ok(REGIONS.includes(region));
  return { ...workbench, regions: { ...workbench.regions, [region]: visible } };
}

function openComparison(manuscript, candidates) {
  return {
    workId: manuscript.workId,
    baseRevision: manuscript.revisionId,
    candidates: candidates.map((candidate) => ({ ...candidate })),
  };
}

function adoptCandidate(manuscript, comparison, candidateId, actor) {
  if (actor !== "author") return { manuscript, outcome: "author-required" };
  const candidate = comparison.candidates.find((item) => item.id === candidateId);
  if (!candidate) return { manuscript, outcome: "candidate-missing" };
  return {
    manuscript: {
      ...manuscript,
      revisionId: `rev-${candidate.id}`,
      text: candidate.text,
    },
    outcome: "adopted",
  };
}

// v1.x drafts: an entry carries the text, a save timestamp and the base
// revision it was typed against (.zhizhang/drafts, never localStorage).
function createDraftStore() {
  const entries = new Map();
  return {
    write(key, text, baseRevision, savedAt) {
      entries.set(key, { text, savedAt, baseRevision });
    },
    read(key) {
      const entry = entries.get(key);
      return entry ? { ...entry } : null;
    },
    clear(key) {
      entries.delete(key);
    },
  };
}

function offerRestore(store, key, manuscript) {
  const entry = store.read(key);
  if (!entry) return { status: "none" };
  if (entry.baseRevision !== manuscript.revisionId) return { status: "stale", entry };
  return { status: "restorable", entry };
}

// The author confirms every restore. A stale offer keeps the current edit and
// shows the stashed text for comparison; it never overwrites silently.
function applyRestore(manuscript, offer, actor) {
  if (actor !== "author") return { manuscript, outcome: "author-required" };
  if (offer.status === "none") return { manuscript, outcome: "nothing-to-restore" };
  if (offer.status === "stale") {
    return { manuscript, outcome: "conflict-preserved", stashed: offer.entry };
  }
  return {
    manuscript: { ...manuscript, text: offer.entry.text },
    outcome: "restored",
  };
}

// v1.x reading position: a share of the scrollable range, so it survives a
// change of layout. The DOM lookup of the scrolling box is host work; only the
// ratio arithmetic is recorded here.
function readScrollRatio(box) {
  const range = box.scrollHeight - box.clientHeight;
  return range > 0 ? box.scrollTop / range : 0;
}

function applyScrollRatio(box, ratio) {
  const range = box.scrollHeight - box.clientHeight;
  return { ...box, scrollTop: ratio * range };
}

// v1.x incremental row snapshots: a full delta replaces, an incremental one
// merges, removals delete, and an empty same-revision delta is a no-op.
function applySnapshotDelta(prev, delta) {
  if (
    delta.revision &&
    delta.revision === prev.revision &&
    !delta.full &&
    delta.rows.length === 0 &&
    !delta.removedIds?.length
  ) {
    return prev;
  }
  const byId = delta.full ? {} : { ...prev.byId };
  if (!delta.full && delta.removedIds) {
    for (const id of delta.removedIds) delete byId[id];
  }
  for (const row of delta.rows) byId[row.id] = row;
  return { revision: delta.revision, rows: Object.values(byId), byId };
}

const candidates = [
  { id: "cand-1", text: "候选一", score: 86 },
  { id: "cand-2", text: "候选二", score: 88 },
];

test("C-01 the three workbench regions toggle independently and never clear the open manuscript", () => {
  let workbench = openManuscript(createWorkbench(), {
    workId: "work-1",
    revisionId: "rev-1",
    text: "正文",
    finalizedRevisionId: "rev-0",
  });

  for (const region of REGIONS) {
    workbench = setRegionVisible(workbench, region, false);
    assert.equal(workbench.regions[region], false);
    assert.equal(workbench.manuscript.text, "正文");
  }
  workbench = setRegionVisible(workbench, "manuscript", true);
  assert.equal(workbench.manuscript.revisionId, "rev-1");
  assert.equal(workbench.manuscript.finalizedRevisionId, "rev-0");
});

test("C-01 candidate comparison is read-only until the author adopts one", () => {
  const manuscript = {
    workId: "work-1",
    revisionId: "rev-1",
    text: "正文",
    finalizedRevisionId: "rev-0",
  };
  const comparison = openComparison(manuscript, candidates);

  assert.deepEqual(comparison.candidates, candidates);
  assert.equal(comparison.baseRevision, "rev-1");
  assert.equal(manuscript.text, "正文");

  const agentAttempt = adoptCandidate(manuscript, comparison, "cand-2", "agent");
  assert.equal(agentAttempt.outcome, "author-required");
  assert.strictEqual(agentAttempt.manuscript, manuscript);
  assert.equal(adoptCandidate(manuscript, comparison, "missing", "author").outcome, "candidate-missing");
});

test("C-01 adopting a candidate updates the working revision without finalizing it", () => {
  const manuscript = {
    workId: "work-1",
    revisionId: "rev-1",
    text: "正文",
    finalizedRevisionId: "rev-0",
  };
  const comparison = openComparison(manuscript, candidates);

  const adopted = adoptCandidate(manuscript, comparison, "cand-2", "author");

  assert.equal(adopted.outcome, "adopted");
  assert.equal(adopted.manuscript.text, "候选二");
  assert.equal(adopted.manuscript.revisionId, "rev-cand-2");
  assert.equal(adopted.manuscript.finalizedRevisionId, "rev-0");
});

test("C-01 an unsaved edit is stashed with its base revision and offered again after reopening", () => {
  const store = createDraftStore();
  const manuscript = { workId: "work-1", revisionId: "rev-1", text: "正文" };

  store.write("draft:work-1", "半段新写的字", "rev-1", 100);
  const offer = offerRestore(store, "draft:work-1", manuscript);

  assert.equal(offer.status, "restorable");
  const restored = applyRestore(manuscript, offer, "author");
  assert.equal(restored.outcome, "restored");
  assert.equal(restored.manuscript.text, "半段新写的字");
  assert.equal(offerRestore(store, "draft:absent", manuscript).status, "none");
  assert.equal(applyRestore(manuscript, offer, "agent").outcome, "author-required");
});

test("C-01 a stashed draft whose base revision moved on surfaces a conflict and preserves the current edit", () => {
  const store = createDraftStore();
  const manuscript = { workId: "work-1", revisionId: "rev-2", text: "作者后来保存的正文" };

  store.write("draft:work-1", "旧基准上的未保存 edit", "rev-1", 100);
  const offer = offerRestore(store, "draft:work-1", manuscript);
  assert.equal(offer.status, "stale");

  const result = applyRestore(manuscript, offer, "author");
  assert.equal(result.outcome, "conflict-preserved");
  assert.equal(result.manuscript.text, "作者后来保存的正文");
  assert.equal(result.stashed.text, "旧基准上的未保存 edit");
  assert.equal(result.stashed.baseRevision, "rev-1");
});

test("C-01 the reading position survives a layout change as a share of the scroll range", () => {
  const narrow = { scrollHeight: 5000, clientHeight: 1000, scrollTop: 1600 };
  const ratio = readScrollRatio(narrow);
  assert.equal(ratio, 0.4);

  const wide = applyScrollRatio({ scrollHeight: 8000, clientHeight: 1000, scrollTop: 0 }, ratio);
  assert.equal(wide.scrollTop, 2800);
  assert.equal(readScrollRatio(applyScrollRatio(wide, readScrollRatio(wide))), ratio);
  assert.equal(readScrollRatio({ scrollHeight: 800, clientHeight: 800, scrollTop: 0 }), 0);
});

test("C-01 incremental row updates merge without dropping unrelated rows and skip empty deltas", () => {
  const prev = {
    revision: "r1",
    rows: [
      { id: "a", label: "甲" },
      { id: "b", label: "乙" },
    ],
    byId: { a: { id: "a", label: "甲" }, b: { id: "b", label: "乙" } },
  };

  const noop = applySnapshotDelta(prev, { revision: "r1", full: false, rows: [] });
  assert.strictEqual(noop, prev);

  const merged = applySnapshotDelta(prev, {
    revision: "r2",
    full: false,
    rows: [{ id: "b", label: "乙改" }, { id: "c", label: "丙" }],
    removedIds: ["a"],
  });
  assert.equal(merged.revision, "r2");
  assert.deepEqual(merged.rows, [
    { id: "b", label: "乙改" },
    { id: "c", label: "丙" },
  ]);

  const full = applySnapshotDelta(prev, {
    revision: "r3",
    full: true,
    rows: [{ id: "z", label: "重来" }],
  });
  assert.deepEqual(full.rows, [{ id: "z", label: "重来" }]);
});
