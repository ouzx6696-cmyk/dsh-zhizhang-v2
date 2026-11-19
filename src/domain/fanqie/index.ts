// The fanqie domain's public surface.
//
// Only the frozen part of B.8 is exported: chapter reordering and the
// continuity impact it must report for author review. The fanqie business
// state words, the single-chapter word-count caliber, the rhythm tiers and the
// outline notes are C.1 author decisions and are not here.

export {
  reorderImpact,
  reorderImpactCommand,
  relationFlipped,
  planReorder,
  type ChapterOrder,
  type ContinuityEntry,
  type ReorderImpact,
  type ReorderImpactResult,
  type ReorderPlan,
  type TemporalRelation,
} from "./reorder.ts";
