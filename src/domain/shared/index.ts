// The shared domain mechanics' public surface.
//
// Only the frozen parts of B.8 are exported: the anchor form, the chapter-order
// comparison, the half-open validity interval and the offset resolution. The
// setting-fact record itself — in particular whether `recorded_at` carries the
// narrative anchor or the audit time — is an author decision and is not here.

export {
  anchor,
  isEffective,
  orderIndex,
  pointAtOffset,
  precedes,
  resolveAnchor,
  splitChapterParagraphs,
  type Anchor,
  type ChapterParagraphs,
  type ParagraphSpan,
  type ResolvedAnchor,
  type ValidityInterval,
} from "./anchors.ts";
