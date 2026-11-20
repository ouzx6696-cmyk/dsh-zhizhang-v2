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

/** One non-empty paragraph span inside a chapter body, with exact UTF-16 offsets. */
export interface ParagraphSpan {
  /** 1-based non-empty paragraph ordinal (`point`). */
  readonly index: number;
  /** Raw line text for the paragraph (excluding line breaks), matching `body.slice(start, end)`. */
  readonly text: string;
  /** Inclusive UTF-16 start offset inside the original chapter `body`. */
  readonly start: number;
  /** Exclusive UTF-16 end offset inside the original chapter `body`. */
  readonly end: number;
}

/**
 * Single paragraph source of truth (Res#12 / FQ-02):
 * splits a chapter body into 1-based non-empty paragraph spans while handling
 * `\r\n`, `\n`, and `\r` safely and preserving exact UTF-16 `start` / `end`
 * offsets into the original `body`.
 */
export function splitChapterParagraphs(body: string): ParagraphSpan[] {
  if (!body) return [];
  const spans: ParagraphSpan[] = [];
  const len = body.length;
  let lineStart = 0;
  let i = 0;
  while (i <= len) {
    const isEnd = i === len;
    const code = isEnd ? -1 : body.charCodeAt(i);
    if (isEnd || code === 10 || code === 13) {
      const lineEnd = i;
      if (lineEnd > lineStart) {
        const text = body.slice(lineStart, lineEnd);
        if (text.trim().length > 0) {
          spans.push({
            index: spans.length + 1,
            text,
            start: lineStart,
            end: lineEnd,
          });
        }
      }
      if (isEnd) break;
      if (code === 13 && i + 1 < len && body.charCodeAt(i + 1) === 10) {
        i += 2;
      } else {
        i += 1;
      }
      lineStart = i;
    } else {
      i += 1;
    }
  }
  return spans;
}

/**
 * Returns the 1-based non-empty paragraph index (`point`) containing UTF-16
 * `offset` inside `body`, clamped to `[1, max(1, paragraphs.length)]`.
 */
export function pointAtOffset(body: string, offset: number): number {
  const paras = splitChapterParagraphs(body);
  if (paras.length === 0) return 1;
  if (!Number.isFinite(offset) || offset <= paras[0].start) return 1;
  const clamped = Math.trunc(offset);
  if (clamped >= paras[paras.length - 1].start) return paras.length;

  let lo = 0;
  let hi = paras.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (paras[mid].start <= clamped) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return paras[lo].index;
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
 * Resolves an anchor to a non-empty paragraph and its character offset.
 *
 * The point is clamped into the chapter's non-empty paragraphs, so a point past
 * the end resolves to the last non-empty paragraph rather than failing.
 */
export function resolveAnchor(
  at: Anchor,
  chapter: ChapterParagraphs | { readonly body: string } | string,
): ResolvedAnchor {
  const spans: ParagraphSpan[] =
    typeof chapter === "string"
      ? splitChapterParagraphs(chapter)
      : "body" in chapter
        ? splitChapterParagraphs(chapter.body)
        : (() => {
            const collected: ParagraphSpan[] = [];
            let offset = 0;
            for (const raw of chapter.paragraphs) {
              if (raw.trim().length > 0) {
                collected.push({
                  index: collected.length + 1,
                  text: raw,
                  start: offset,
                  end: offset + raw.length,
                });
              }
              offset += raw.length + 1;
            }
            return collected;
          })();

  if (spans.length === 0) {
    return { paragraphIndex: 0, start: 0, text: "" };
  }
  const safePoint = Number.isFinite(at.point) ? Math.trunc(at.point) : 1;
  const index = Math.min(Math.max(safePoint - 1, 0), spans.length - 1);
  return { paragraphIndex: index, start: spans[index].start, text: spans[index].text };
}
