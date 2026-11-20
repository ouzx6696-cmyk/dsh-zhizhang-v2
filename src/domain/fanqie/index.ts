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

export {
  CHAPTER_STATES, EDITORIAL_REJECTION_LIMIT, DEFAULT_CHAPTER_LENGTH, CHAPTER_LENGTH_WARNING_BAND,
  PACING, OUTLINE_SECTIONS, chapterLengthWarnings, assertChapterFinalizable, settingsAt, type ChapterState, type SettingFact,
} from "./editorial.ts";

export {
  flattenNovelOrder,
  planTreeChapterMove,
  type ChapterMoveSpec,
  type HierarchyAct,
  type HierarchyChapter,
  type HierarchyVolume,
} from "./hierarchy.ts";

export {
  FORESHADOW_STATUSES,
  LORE_CATEGORIES,
  assertForeshadowStatus,
  detectLoreConflicts,
  normalizeLoreCategory,
  type ChapterOutlineFacts,
  type ForeshadowState,
  type LoreCategoryId,
  type LoreConflictReport,
  type LoreForeshadowEntry,
} from "./lore.ts";

export {
  TECHNIQUE_CATEGORIES,
  normalizeTags,
  rankTechniquesForChapter,
  resolveEffectiveMount,
  resolveScopedItems,
  validatePacingLabel,
  type LibraryMountRule,
  type TechniqueCardForRank,
  type TechniqueCategory,
  type TechniqueMatchResult,
} from "./library.ts";
