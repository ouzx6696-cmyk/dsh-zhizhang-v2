import assert from "node:assert/strict";
import test from "node:test";
import { anchor, precedes } from "../support/a01.mjs";

// A-01 supporting fixture for setting facts and continuity. The mechanics
// under test are recorded from the v1.x Fanqie assets reviewed in DOC-01
// §3.8.3/§3.8.4 (current_state's five ledgers, threads' planned-versus-actual
// plant and payoff, the handoff contract's four-state isolation,
// story_foundation's locked facts and effective user agreements) together with
// the F-01 reference fixture. They are written here as the executable shape of
// appendix B.8 of contracts.md. **Frozen on 2026-11-19 as A-class items**: the
// anchor form `{chapterId, point}` with character offsets derived rather than
// stored, the half-open interval, the append-per-fact revision rows, the field
// renames (`effectiveAt` → `effectiveFrom`) and the `reorder.impact` command
// shape. Still open: whether `recorded_at` carries the narrative anchor or the
// audit time (B-class, C.1 item 14 in the audit table).

// A narrative anchor is a chapter plus an ordering point inside it, as in the
// F-01 fixture. Reordering chapters changes which anchor precedes which.
const order = ["river", "tower", "harbor"];

// A setting fact carries a narrative validity interval and a version history
// position. The two answer different questions and never substitute for each
// other: the interval says when the fact holds inside the story, the version
// says which edit of the setting record introduced it.
// The proposed anchor form is a chapter plus an ordinal point inside it, so it
// survives text edits. Character offsets belong to evidence location and are
// resolved from the anchor, never stored as the anchor itself.
function resolveAnchor(anchor, chapter) {
  const paragraphs = chapter.paragraphs;
  const index = Math.min(Math.max(anchor.point - 1, 0), paragraphs.length - 1);
  let start = 0;
  for (let i = 0; i < index; i += 1) start += paragraphs[i].length + 1;
  return { paragraphIndex: index, start, text: paragraphs[index] };
}

// A narrative validity interval is half-open: the start anchor is included and
// the end anchor is not.
function isEffective(entry, at, chapterOrder = order) {
  const afterStart = precedes(entry.effectiveFrom, at, chapterOrder);
  const beforeEnd = entry.effectiveTo
    ? precedes(at, entry.effectiveTo, chapterOrder)
    : true;
  return afterStart && beforeEnd;
}

// A version-ordered read: per fact, the latest revision at or below the
// requested version, so a later edit is never applied to an earlier cut.
function asOfVersion(history, version) {
  const latest = new Map();
  for (const row of history) {
    if (row.version > version) continue;
    const current = latest.get(row.value.id);
    if (!current || row.version > current.version) latest.set(row.value.id, row);
  }
  return { version, entries: [...latest.values()].map((row) => row.value) };
}

// Chapter reordering must list the temporal relations whose relative order
// changed, for the author to review instead of silently accepting.
function reorderImpact(entries, before, after) {
  const impacts = [];
  for (const entry of entries) {
    const flipped = entry.relations.filter(
      (relation) =>
        precedes(relation.from, relation.to, before) !==
        precedes(relation.from, relation.to, after),
    );
    if (flipped.length > 0) {
      impacts.push({ id: entry.id, relations: flipped });
    }
  }
  return impacts;
}

// A narrative thread records the plant and payoff the plan promised and the
// ones the text actually delivered. A payoff that appears before its plant is
// a continuity defect, not a success.
function threadStatus(thread) {
  const actual = thread.actual;
  if (actual.payoff && (!actual.plant || precedes(actual.payoff, actual.plant, order))) {
    return "payoff-before-plant";
  }
  if (actual.plant && actual.payoff) return "planted-and-paid";
  if (actual.plant) return "planted-open";
  return "unplanted";
}

// The four-state isolation recorded from the handoff contract: happened,
// locked, adopted and candidate. A candidate never reaches the happened set
// without an author decision, and a locked fact cannot be contradicted.
function applyProposal(state, proposal, actor) {
  if (proposal.contradictsLocked) {
    return { state, outcome: "locked-conflict" };
  }
  if (actor !== "author") {
    return { state, outcome: "author-required" };
  }
  if (proposal.decision === "reject") {
    return { state, outcome: "rejected" };
  }
  return {
    state: {
      ...state,
      happened: [...state.happened, proposal.entry],
      candidates: state.candidates.filter((id) => id !== proposal.id),
    },
    outcome: "adopted",
  };
}

test("A-01 a narrative anchor is a chapter plus an ordinal point, so it survives an edit that moves character offsets", () => {
  const anchor = { chapterId: "river", point: 2 };
  const before = resolveAnchor(anchor, {
    chapterId: "river",
    paragraphs: ["老周蹲在冷柜前。", "他把鸡腿过了秤。", "手机震了一下。"],
  });
  const after = resolveAnchor(anchor, {
    chapterId: "river",
    paragraphs: ["老周蹲在冷柜前，挑了半晌，又把鸡腿放了回去。", "他把鸡腿过了秤。", "手机震了一下。"],
  });
  // The same anchor resolves to the same paragraph, while the character offset
  // moved — which is why evidence location records offsets separately.
  assert.equal(before.paragraphIndex, 1);
  assert.equal(after.paragraphIndex, 1);
  assert.equal(after.text, "他把鸡腿过了秤。");
  assert.notEqual(before.start, after.start);
  assert.ok(after.start > before.start);
});

test("A-01 a validity interval is half-open, so the end anchor is already outside it", () => {
  const entry = {
    id: "sealed-door",
    effectiveFrom: anchor("river", 1),
    effectiveTo: anchor("tower", 1),
    version: 2,
  };
  assert.equal(isEffective(entry, anchor("river", 2)), true);
  assert.equal(isEffective(entry, anchor("tower", 1)), false);
  // A point with no end anchor stays effective.
  const open = { id: "window-latch", effectiveFrom: anchor("river", 1), version: 1 };
  assert.equal(isEffective(open, anchor("harbor", 1)), true);
});

test("A-01 the version history is append-only revision rows per fact, never a rewrite of an earlier row", () => {
  const rows = [
    { factId: "sealed-door", version: 1, value: { id: "sealed-door", note: "first recorded" }, recordedAt: anchor("river", 1) },
    { factId: "window-latch", version: 1, value: { id: "window-latch", note: "added" }, recordedAt: anchor("river", 1) },
  ];
  const snapshotBefore = structuredClone(rows);

  // A revision appends a row and leaves the earlier rows untouched.
  rows.push({ factId: "sealed-door", version: 2, value: { id: "sealed-door", note: "wording revised" }, recordedAt: anchor("tower", 1) });
  assert.deepEqual(rows.slice(0, 2), snapshotBefore);
  assert.equal(rows.length, 3);

  // A read at an intermediate version still returns the historical wording.
  assert.deepEqual(asOfVersion(rows, 1).entries, [
    { id: "sealed-door", note: "first recorded" },
    { id: "window-latch", note: "added" },
  ]);
  assert.deepEqual(asOfVersion(rows, 2).entries, [
    { id: "sealed-door", note: "wording revised" },
    { id: "window-latch", note: "added" },
  ]);
  // The revision row carries the value; the interval lives on the fact entry.
  // The two are separate fields and neither substitutes for the other.
  assert.equal(rows[2].value.effectiveFrom, undefined);
  const entry = {
    id: "sealed-door",
    effectiveFrom: anchor("river", 1),
    effectiveTo: anchor("tower", 1),
    version: 2,
  };
  assert.equal(isEffective(entry, anchor("river", 2)), true);
  assert.equal(isEffective(entry, anchor("tower", 1)), false);
});

test("A-01 a validity interval and a version history answer different questions and neither substitutes for the other", () => {
  const entry = {
    id: "sealed-door",
    effectiveFrom: anchor("river", 1),
    effectiveTo: anchor("tower", 1),
    version: 2,
  };
  assert.equal(isEffective(entry, anchor("river", 2)), true);
  assert.equal(isEffective(entry, anchor("harbor", 1)), false);

  // The same fact read at version 1 does not carry the version-2 wording, even
  // though its narrative interval starts in the first chapter.
  const history = [
    { version: 1, value: { id: "sealed-door", note: "first recorded" } },
    { version: 1, value: { id: "window-latch", note: "added" } },
    { version: 2, value: { id: "sealed-door", note: "wording revised" } },
  ];
  assert.deepEqual(asOfVersion(history, 1).entries, [
    { id: "sealed-door", note: "first recorded" },
    { id: "window-latch", note: "added" },
  ]);
  assert.equal(asOfVersion(history, 1).version, 1);
  assert.deepEqual(asOfVersion(history, 2).entries, [
    { id: "sealed-door", note: "wording revised" },
    { id: "window-latch", note: "added" },
  ]);
});

test("A-01 reordering chapters lists the temporal relations that flipped instead of silently accepting them", () => {
  const entries = [
    {
      id: "lin-learns",
      relations: [
        {
          from: anchor("river", 1),
          to: anchor("tower", 1),
          label: "knowledge-before-fact",
        },
      ],
    },
    { id: "harbor-arrival", relations: [] },
  ];
  const before = ["river", "tower", "harbor"];
  const after = ["tower", "river", "harbor"];

  assert.deepEqual(reorderImpact(entries, before, after), [
    {
      id: "lin-learns",
      relations: [
        {
          from: anchor("river", 1),
          to: anchor("tower", 1),
          label: "knowledge-before-fact",
        },
      ],
    },
  ]);
  assert.deepEqual(reorderImpact(entries, after, after), []);
});

test("A-01 a thread separates the planned plant and payoff from the ones the text delivered", () => {
  assert.equal(
    threadStatus({
      planned: { plant: anchor("river", 1), payoff: anchor("tower", 1) },
      actual: { plant: anchor("river", 1), payoff: anchor("harbor", 1) },
    }),
    "planted-and-paid",
  );
  assert.equal(
    threadStatus({
      planned: { plant: anchor("river", 1), payoff: anchor("tower", 1) },
      actual: { plant: anchor("river", 1) },
    }),
    "planted-open",
  );
  // The text paid the thread off before planting it: a defect, not a success.
  assert.equal(
    threadStatus({
      planned: { plant: anchor("river", 1), payoff: anchor("tower", 1) },
      actual: { payoff: anchor("river", 1), plant: anchor("tower", 1) },
    }),
    "payoff-before-plant",
  );
  assert.equal(threadStatus({ planned: {}, actual: {} }), "unplanted");
});

test("A-01 a candidate setting stays out of the happened set until the author adopts it", () => {
  const state = {
    happened: [{ id: "river-arrival" }],
    candidates: ["tower-watch"],
  };
  const proposal = { id: "tower-watch", entry: { id: "tower-watch" } };

  const agentAttempt = applyProposal(state, proposal, "agent");
  assert.equal(agentAttempt.outcome, "author-required");
  assert.equal(agentAttempt.state, state);

  const authorAdoption = applyProposal(state, proposal, "author");
  assert.equal(authorAdoption.outcome, "adopted");
  assert.deepEqual(authorAdoption.state.happened, [
    { id: "river-arrival" },
    { id: "tower-watch" },
  ]);
  assert.deepEqual(authorAdoption.state.candidates, []);

  const rejected = applyProposal(
    state,
    { ...proposal, decision: "reject" },
    "author",
  );
  assert.equal(rejected.outcome, "rejected");
  assert.deepEqual(rejected.state.happened, [{ id: "river-arrival" }]);
});

test("A-01 a proposal that contradicts a locked fact is refused before any author decision is recorded", () => {
  const state = {
    happened: [{ id: "river-arrival" }],
    candidates: ["tower-watch"],
    locked: [{ id: "no-magic" }],
  };
  const contradicting = {
    id: "tower-watch",
    entry: { id: "tower-watch" },
    contradictsLocked: true,
  };
  const refused = applyProposal(state, contradicting, "author");
  assert.equal(refused.outcome, "locked-conflict");
  assert.equal(refused.state, state);
});

test("A-01 an effective user agreement is recorded with its source and stays separable from locked facts", () => {
  const agreements = [
    {
      id: "keep-pov-third",
      source: "author",
      recordedAt: anchor("river", 1),
      locked: false,
    },
  ];
  const locked = [{ id: "no-magic", source: "author", locked: true }];

  assert.equal(agreements[0].locked, false);
  assert.equal(locked[0].locked, true);
  assert.notEqual(agreements[0].id, locked[0].id);
  // An agreement can be revised by its source; a locked fact cannot be
  // contradicted by a proposal at all (previous test).
  const revised = agreements.map((agreement) =>
    agreement.id === "keep-pov-third"
      ? { ...agreement, recordedAt: anchor("tower", 1) }
      : agreement,
  );
  assert.deepEqual(revised[0].recordedAt, anchor("tower", 1));
});
