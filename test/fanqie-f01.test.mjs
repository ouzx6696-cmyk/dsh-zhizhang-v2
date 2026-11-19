import assert from "node:assert/strict";
import test from "node:test";

// F-01 reference fixture. Checkpoints order events within this sample.
// Production chapter boundaries, default viewpoints, and state names remain open.
const chapterOrder = ["river", "tower"];
const arrival = { chapterId: "river", point: 1 };
const reveal = { chapterId: "tower", point: 1 };
const baseline = {
  id: "settings-1",
  entries: [
    {
      id: "private-note",
      effectiveAt: arrival,
      knownFrom: { lin: arrival, qiao: reveal },
    },
    { id: "hidden-door", effectiveAt: reveal, knownFrom: { lin: reveal } },
    {
      id: "sealed-letter",
      effectiveAt: arrival,
      knownFrom: { lin: arrival, qiao: arrival },
      fulfilledAt: reveal,
    },
  ],
};
const pending = {
  snapshot: baseline,
  proposal: {
    id: "tower-watch-proposal",
    nextSnapshotId: "settings-2",
    entry: {
      id: "tower-watch",
      effectiveAt: reveal,
      knownFrom: { lin: reveal, qiao: reveal },
    },
  },
};

function viewpoint(chapterId, characterId) {
  return { chapterId, characterId, point: 2 };
}

function precedes(anchor, view, order) {
  const anchorIndex = order.indexOf(anchor.chapterId);
  const viewIndex = order.indexOf(view.chapterId);
  if (anchorIndex === viewIndex) return anchor.point < view.point;
  return anchorIndex < viewIndex;
}

function readView(snapshot, order, view) {
  const observations = new Map();
  for (const entry of snapshot.entries) {
    const knowledge = entry.knownFrom[view.characterId];
    if (!knowledge || !precedes(entry.effectiveAt, view, order)) continue;
    if (!precedes(knowledge, view, order)) continue;

    if (entry.fulfilledAt) {
      const fulfilled = precedes(entry.fulfilledAt, view, order);
      observations.set(entry.id, fulfilled ? "fulfilled" : "unfulfilled");
    } else {
      observations.set(entry.id, "known");
    }
  }
  return observations;
}

function changedEntries(before, after) {
  const ids = new Set([...before.keys(), ...after.keys()]);
  return new Set([...ids].filter((id) => before.get(id) !== after.get(id)));
}

function decideSetting({ snapshot, proposal }, actor, decision) {
  if (actor !== "author") return { snapshot, recordedDecision: null };
  const recordedDecision = { proposalId: proposal.id, decision };
  if (decision === "reject") return { snapshot, recordedDecision };

  return {
    snapshot: {
      id: proposal.nextSnapshotId,
      entries: [...snapshot.entries, proposal.entry],
    },
    recordedDecision,
  };
}

function adoptDraft(chapter, actor, candidate, revisionId) {
  if (actor !== "author") return chapter;
  return {
    ...chapter,
    working: { revisionId, body: candidate.body },
    approval: { candidateId: candidate.id, revisionId },
  };
}

test("F-01 author adoption updates the working revision without finalizing it", () => {
  const chapter = {
    working: { revisionId: "draft-2", body: "工作稿" },
    finalizedRevisionId: "draft-1",
  };
  const candidate = { id: "candidate-1", body: "候选稿" };

  assert.strictEqual(
    adoptDraft(chapter, "agent", candidate, "draft-3"),
    chapter,
  );
  assert.deepEqual(adoptDraft(chapter, "author", candidate, "draft-3"), {
    working: { revisionId: "draft-3", body: "候选稿" },
    approval: { candidateId: "candidate-1", revisionId: "draft-3" },
    finalizedRevisionId: "draft-1",
  });
});

// Counts are fixed inputs. Recording further rejections and resolving an author
// ruling belong to the future state contract.
function assessFinalization(actor, editorialRejections) {
  if (actor !== "author") return "author-required";
  if (editorialRejections > 2) return "author-ruling-required";
  return "evaluate-other-finalization-conditions";
}

test("F-01 chapter and character viewpoints filter future and unknown facts", () => {
  const earlyLin = readView(baseline, chapterOrder, viewpoint("river", "lin"));
  const earlyQiao = readView(
    baseline,
    chapterOrder,
    viewpoint("river", "qiao"),
  );
  const lateLin = readView(baseline, chapterOrder, viewpoint("tower", "lin"));
  const lateQiao = readView(baseline, chapterOrder, viewpoint("tower", "qiao"));

  assert.equal(earlyLin.get("private-note"), "known");
  assert.equal(earlyQiao.has("private-note"), false);
  assert.equal(lateQiao.get("private-note"), "known");
  assert.equal(earlyLin.has("hidden-door"), false);
  assert.equal(earlyQiao.has("hidden-door"), false);
  assert.equal(lateLin.get("hidden-door"), "known");
  assert.equal(lateQiao.has("hidden-door"), false);
  assert.equal(earlyLin.get("sealed-letter"), "unfulfilled");
  assert.equal(lateLin.get("sealed-letter"), "fulfilled");
});

test("F-01 chapter reorder reports changed knowledge and foreshadowing", () => {
  const reordered = ["tower", "river"];
  const view = viewpoint("tower", "lin");
  const before = readView(baseline, chapterOrder, view);
  const after = readView(baseline, reordered, view);

  assert.deepEqual(
    changedEntries(before, after),
    new Set(["private-note", "sealed-letter"]),
  );
  assert.equal(after.get("hidden-door"), "known");
  assert.deepEqual(chapterOrder, ["river", "tower"]);
});

test("F-01 a setting proposal changes the snapshot only after author approval", () => {
  const early = viewpoint("river", "lin");
  const late = viewpoint("tower", "lin");
  const rejected = decideSetting(pending, "author", "reject");
  const agentAttempt = decideSetting(pending, "agent", "approve");
  const approved = decideSetting(pending, "author", "approve");

  assert.equal(
    readView(pending.snapshot, chapterOrder, late).has("tower-watch"),
    false,
  );
  assert.strictEqual(rejected.snapshot, pending.snapshot);
  assert.deepEqual(rejected.recordedDecision, {
    proposalId: "tower-watch-proposal",
    decision: "reject",
  });
  assert.strictEqual(agentAttempt.snapshot, pending.snapshot);
  assert.equal(agentAttempt.recordedDecision, null);
  assert.equal(approved.snapshot.id, "settings-2");
  assert.deepEqual(approved.recordedDecision, {
    proposalId: "tower-watch-proposal",
    decision: "approve",
  });
  assert.deepEqual(
    approved.snapshot.entries.find((entry) => entry.id === "tower-watch")
      .effectiveAt,
    reveal,
  );
  assert.equal(
    readView(approved.snapshot, chapterOrder, late).get("tower-watch"),
    "known",
  );
  assert.deepEqual(
    readView(approved.snapshot, chapterOrder, early),
    readView(baseline, chapterOrder, early),
  );
});

test("F-01 up to two editorial rejections permit evaluation of other finalization conditions", () => {
  for (const count of [0, 1, 2]) {
    assert.equal(
      assessFinalization("author", count),
      "evaluate-other-finalization-conditions",
    );
  }
});

test("F-01 three editorial rejections require an explicit author ruling", () => {
  assert.equal(assessFinalization("author", 3), "author-ruling-required");
});

test("F-01 a writing agent cannot finalize at any editorial rejection count", () => {
  for (const count of [0, 1, 2, 3]) {
    assert.equal(assessFinalization("agent", count), "author-required");
  }
});
