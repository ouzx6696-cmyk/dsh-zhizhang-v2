import assert from "node:assert/strict";
import test from "node:test";
import { fanqie, sharedDomain } from "../src/domain/index.ts";

// D-02/F-02 conformance for the frozen continuity mechanics: the anchor, the
// chapter-order comparison, the half-open validity interval, and the
// `reorder.impact` command pair, against the rules `facts-a01` records.
//
// Two of those rules the recording fixture states in a comment but does not
// implement. Both are pinned here in favour of the stated rule, because that is
// what appendix B.8 froze:
//
//   - a chapter missing from the order is one group AFTER the known ones (the
//     fixture's `indexOf` sorts it before them);
//   - the start anchor is INCLUDED and the end anchor is not, so the interval is
//     `[from, to)` (the fixture's `precedes(from, at)` check excludes the start
//     too, making it open at both ends).

const { anchor, isEffective, orderIndex, precedes, resolveAnchor } = sharedDomain;
const { planReorder, reorderImpact, reorderImpactCommand, relationFlipped } = fanqie;

const order = ["river", "tower", "harbor"];

test("D-02 an anchor is a chapter plus an ordinal point, and survives a reorder", () => {
  assert.deepEqual(anchor("river", 1), { chapterId: "river", point: 1 });
  // Reordering chapters changes which anchor precedes which.
  const a = anchor("river", 1);
  const b = anchor("tower", 1);
  assert.equal(precedes(a, b, order), true);
  assert.equal(precedes(a, b, ["tower", "river", "harbor"]), false);
  assert.equal(precedes(a, a, order), false, "an anchor never precedes itself");
  // Inside one chapter the point decides.
  assert.equal(precedes(anchor("river", 1), anchor("river", 2), order), true);
  assert.equal(precedes(anchor("river", 2), anchor("river", 1), order), false);
});

test("D-02 a chapter missing from the order is one group after the known ones", () => {
  // The stated rule: an unknown chapter sorts after every known one.
  assert.equal(orderIndex("elsewhere", order), order.length);
  assert.equal(precedes(anchor("elsewhere", 1), anchor("river", 1), order), false);
  assert.equal(precedes(anchor("river", 1), anchor("elsewhere", 1), order), true);
  // Two unknown chapters share a position, so their comparison falls back to
  // the point — not to the chapter id.
  assert.equal(orderIndex("a", order), orderIndex("b", order));
  assert.equal(precedes(anchor("a", 1), anchor("b", 2), order), true);
  assert.equal(precedes(anchor("b", 1), anchor("a", 2), order), true);
  // The fallback is the point alone: a later point on an alphabetically
  // earlier chapter does not precede an earlier point.
  assert.equal(precedes(anchor("a", 5), anchor("b", 2), order), false);
});

test("D-02 a validity interval is half-open, so the start is in and the end is out", () => {
  const entry = { effectiveFrom: anchor("river", 1), effectiveTo: anchor("tower", 1) };
  // Strictly inside: effective.
  assert.equal(isEffective(entry, anchor("river", 2), order), true);
  // The end anchor itself is already outside.
  assert.equal(isEffective(entry, anchor("tower", 1), order), false);
  // The start anchor itself is included — the half-open rule the fixture's
  // comment states and its implementation does not do.
  assert.equal(isEffective(entry, anchor("river", 1), order), true);
  // Before the start: outside.
  assert.equal(isEffective(entry, anchor("river", 0), order), false);
  // A point with no end anchor stays effective.
  const open = { effectiveFrom: anchor("river", 1) };
  assert.equal(isEffective(open, anchor("harbor", 1), order), true);
});

test("D-02 an anchor resolves to a paragraph and offset, and clamps past the end", () => {
  const chapter = { paragraphs: ["一", "二", "三"] };
  assert.deepEqual(resolveAnchor(anchor("river", 1), chapter), {
    paragraphIndex: 0,
    start: 0,
    text: "一",
  });
  assert.deepEqual(resolveAnchor(anchor("river", 2), chapter), {
    paragraphIndex: 1,
    start: 2,
    text: "二",
  });
  // A point past the last paragraph resolves to the last one rather than failing.
  assert.deepEqual(resolveAnchor(anchor("river", 99), chapter), {
    paragraphIndex: 2,
    start: 4,
    text: "三",
  });
  assert.equal(resolveAnchor(anchor("river", 0), chapter).paragraphIndex, 0);
});

test("D-02 reordering chapters lists the temporal relations that flipped instead of silently accepting them", () => {
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
  // The same order on both sides disturbs nothing.
  assert.deepEqual(reorderImpact(entries, after, after), []);
  assert.deepEqual(reorderImpact(entries, before, before), []);
});

test("D-02 a relation flips only when its own relative order changes", () => {
  const inside = {
    from: anchor("river", 1),
    to: anchor("river", 2),
    label: "same-chapter",
  };
  const across = {
    from: anchor("river", 1),
    to: anchor("tower", 1),
    label: "across-chapters",
  };
  // Swapping river and tower flips the cross-chapter relation and leaves the
  // within-chapter one alone.
  assert.equal(relationFlipped(across, ["river", "tower"], ["tower", "river"]), true);
  assert.equal(relationFlipped(inside, ["river", "tower"], ["tower", "river"]), false);
  // Moving an unrelated chapter changes nothing.
  assert.equal(relationFlipped(across, ["river", "tower"], ["river", "harbor", "tower"]), false);
});

test("D-02 the frozen command pair is read-only first, then the author's write", () => {
  const entries = [
    {
      id: "lin-learns",
      relations: [{ from: anchor("river", 1), to: anchor("tower", 1), label: "knowledge-before-fact" }],
    },
  ];
  const current = { chapterIds: ["river", "tower", "harbor"] };
  const proposed = { chapterIds: ["tower", "river", "harbor"] };

  const read = reorderImpactCommand(entries, current, proposed);
  assert.equal(read.impact.length, 1);
  assert.equal(read.requiresAuthorConfirmation, true, "a flipped relation must reach the author");

  const plan = planReorder(entries, current.chapterIds, proposed.chapterIds);
  assert.deepEqual(plan.impact, read.impact);
  assert.equal(plan.requiresAuthorConfirmation, true);

  // A reorder that flips nothing needs no confirmation, because there is
  // nothing for the author to review.
  const harmless = reorderImpactCommand(entries, current, current);
  assert.deepEqual(harmless.impact, []);
  assert.equal(harmless.requiresAuthorConfirmation, false);
});

test("D-02 a reorder that only moves an unaffected chapter reports nothing", () => {
  const entries = [
    {
      id: "lin-learns",
      relations: [{ from: anchor("river", 1), to: anchor("tower", 1), label: "knowledge-before-fact" }],
    },
  ];
  // harbor moves from last to first; river still precedes tower.
  const plan = planReorder(entries, ["river", "tower", "harbor"], ["harbor", "river", "tower"]);
  assert.deepEqual(plan.impact, []);
  assert.equal(plan.requiresAuthorConfirmation, false);
});
