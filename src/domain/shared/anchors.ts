// Narrative anchors and validity intervals (contracts.md B.8, frozen
// 2026-11-19).
//
// An anchor is a chapter plus an ordinal point inside it. It survives text
// edits, which is why character offsets belong to evidence location and are
// *resolved from* the anchor rather than stored as the anchor itself.
//
// A validity interval is half-open: the start anchor is included and the end
// anchor is not. Two things this module deliberately does not do:
//
//   1. it never treats an interval as a version history position — the
//      interval says when a fact holds inside the story, the version says which
//      edit of the setting record introduced it, and neither substitutes for
//      the other;
//   2. it never reads a clock: ordering is decided by the chapter order the
//      caller supplies.
//
// Two places where the recording fixture (`facts-a01.test.mjs`) disagrees with
// the rule it records, both resolved here in favour of the frozen rule and
// recorded for the author:
//
//   - the fixture's comment says a chapter missing from the order is one group
//     *after* the known ones, while its `indexOf` implementation sorts an
//     unknown chapter *before* every known one. This module implements the
//     documented rule.
//   - the fixture's comment says the start anchor is *included* (half-open
//     `[from, to)`), while its `precedes(from, at)` check excludes a point
//     exactly at the start, making the interval open at both ends. This module
//     implements the documented half-open interval.

/** A narrative anchor: a chapter plus an ordinal point inside it. */
export interface Anchor {
  readonly chapterId: string;
  readonly point: number;
}

/** Creates an anchor. */
export function anchor(chapterId: string, point: number): Anchor {
  return { chapterId, point };
}

/**
 * The position of a chapter in an order.
 *
 * A chapter missing from the order is one group after the known ones, so two
 * unknown chapters share a position and their comparison falls back to the
 * point.
 */
export function orderIndex(chapterId: string, chapterOrder: readonly string[]): number {
  const index = chapterOrder.indexOf(chapterId);
  return index === -1 ? chapterOrder.length : index;
}

/** Whether one anchor comes before another under a chapter order. */
export function precedes(a: Anchor, b: Anchor, chapterOrder: readonly string[]): boolean {
  const indexA = orderIndex(a.chapterId, chapterOrder);
  const indexB = orderIndex(b.chapterId, chapterOrder);
  if (indexA === indexB) return a.point < b.point;
  return indexA < indexB;
}

/** A fact's narrative validity interval, with no end anchor meaning open. */
export interface ValidityInterval {
  readonly effectiveFrom: Anchor;
  readonly effectiveTo?: Anchor;
}

/**
 * Whether a fact holds at an anchor.
 *
 * Half-open: the start anchor is included and the end anchor is not, so a point
 * exactly at the end is already outside the interval.
 */
export function isEffective(
  entry: ValidityInterval,
  at: Anchor,
  chapterOrder: readonly string[],
): boolean {
  // Included at the start: `at` is at or after `effectiveFrom`.
  const afterStart = !precedes(at, entry.effectiveFrom, chapterOrder);
  // Excluded at the end: `at` is strictly before `effectiveTo`, when there is one.
  const beforeEnd = entry.effectiveTo ? precedes(at, entry.effectiveTo, chapterOrder) : true;
  return afterStart && beforeEnd;
}

/** One paragraph of a chapter, as the offset resolution needs it. */
export interface ChapterParagraphs {
  readonly paragraphs: readonly string[];
}

/** Where an anchor lands inside a chapter's text. */
export interface ResolvedAnchor {
  readonly paragraphIndex: number;
  /** The character offset of the paragraph inside the chapter text. */
  readonly start: number;
  readonly text: string;
}

/**
 * Resolves an anchor to a paragraph and character offset.
 *
 * The point is clamped into the chapter's paragraphs, so a point past the end
 * resolves to the last paragraph rather than failing.
 */
export function resolveAnchor(at: Anchor, chapter: ChapterParagraphs): ResolvedAnchor {
  const index = Math.min(Math.max(at.point - 1, 0), chapter.paragraphs.length - 1);
  let start = 0;
  for (let i = 0; i < index; i += 1) start += chapter.paragraphs[i].length + 1;
  return { paragraphIndex: index, start, text: chapter.paragraphs[index] };
}
