// The Fanqie (serialized novel) pure domain surface.
//
// Zero I/O, zero Host/Client/Application dependencies, and strictly isolated
// from `domain/toutiao`. Re-exports chapter editorial rules, narrative anchors,
// hierarchy flattening, continuity & foreshadow lifecycles, library scoring,
// offline diagnostics, and zero-token related-chapter recall.

export {
  pointAtOffset,
  splitChapterParagraphs,
  type ParagraphSpan,
} from "../shared/anchors.ts";

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
  CHAPTER_STATES,
  CHAPTER_TRANSITIONS,
  EDITORIAL_REJECTION_LIMIT,
  DEFAULT_CHAPTER_LENGTH,
  CHAPTER_LENGTH_WARNING_BAND,
  PACING,
  OUTLINE_SECTIONS,
  chapterLengthWarnings,
  assertChapterFinalizable,
  assertChapterTransition,
  settingsAt,
  type ChapterState,
  type SettingFact,
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
  FORESHADOW_REOPEN_TRANSITIONS,
  FORESHADOW_STATUSES,
  FORESHADOW_TRANSITIONS,
  LORE_CATEGORIES,
  assertForeshadowStatus,
  assertForeshadowTransition,
  detectLoreConflicts,
  mergeFactVersion,
  normalizeLoreCategory,
  revokeKnownCharacter,
  type ChapterOutlineFacts,
  type ForeshadowState,
  type LoreCategoryId,
  type LoreConflictOptions,
  type LoreConflictReport,
  type LoreForeshadowEntry,
  type MergeFactVersionOptions,
} from "./lore.ts";

export {
  TECHNIQUE_CATEGORIES,
  WRITING_STAGE_BINDINGS,
  isTechniqueCategory,
  normalizeStageBindings,
  normalizeTags,
  normalizeTechniqueCategory,
  rankTechniquesForChapter,
  resolveEffectiveMount,
  resolveScopedItems,
  validatePacingLabel,
  validateTechniqueCategory,
  type LibraryMountRule,
  type TechniqueCardForRank,
  type TechniqueCategory,
  type TechniqueMatchResult,
  type WritingStageBinding,
} from "./library.ts";

export {
  AI_SLOP_CATEGORY_WEIGHTS,
  DEFAULT_AI_SLOP_PATTERNS,
  OBSERVATION_DIMENSIONS,
  diagnoseChapterOffline,
  diagnoseGoldenThree,
  scanAiSlop,
  type AiSlopPattern,
  type AiSlopReport,
  type AiSlopScanConfig,
  type ChapterDiagnosticsReport,
  type GoldenThreeOptions,
} from "./diagnostics.ts";

export {
  countEntityMentionsWithAliases,
  rankRelatedChapters,
  type ChapterEntityMention,
  type EntityAliasTarget,
  type EntityMentionCountResult,
  type RelatedChapterCandidate,
  type RelatedChapterForeshadow,
  type RelatedChapterMatch,
  type RelatedChaptersInput,
} from "./related-chapters.ts";
