// Fanqie (serialized novel) DTOs (strictly type-only, zero runtime emit).
import type { AnchorPoint, ProposalOrigin } from "./core.ts";

export type ChapterStatusWord = "planned" | "drafting" | "drafted" | "reviewed" | "final";
export type SettingDecision = "pending" | "approved" | "rejected";

export type LoreCategory =
  | "character"
  | "item"
  | "location"
  | "faction"
  | "world_rule"
  | "foreshadow"
  | "agreement";

export type ForeshadowStatus = "proposed" | "planted" | "hinted" | "resolved" | "abandoned";
export type LibraryScope = "global" | "project";
export type LibraryStatus = "proposed" | "approved" | "archived";
export type LibraryItemKind = "deconstruction" | "technique";
export type LibraryMountTarget = "project" | "volume" | "act" | "chapter";
export type LibraryMountMode = "include" | "exclude" | "pin";
export type MemorySyncStatus = "clean" | "dirty";
export type LibraryAssetKind = "technique" | "skill";
export type WritingStageBinding = "plan" | "write" | "review" | "refine" | "deslop";

export type AiProposalKind =
  | "deconstruct"
  | "technique"
  | "setting"
  | "summary"
  | "fact_sync"
  | "chapter_review"
  | "arc_plan"
  | "outline";

export interface SettingFactDto {
  readonly id: string;
  readonly note: string;
  readonly source: string;
  readonly kind: "fact" | "agreement";
  readonly locked: boolean;
  readonly effectiveFrom: AnchorPoint;
  readonly effectiveTo?: AnchorPoint;
  readonly knownFrom: Readonly<Record<string, AnchorPoint>>;
  readonly aliases?: readonly string[];
}

export interface SettingEntryDto {
  readonly id: string;
  readonly decision: SettingDecision;
  readonly fact: SettingFactDto;
  readonly origin?: ProposalOrigin;
  readonly originRef?: string;
}
export type SettingProposalEntry = SettingEntryDto;

export interface SkillReferenceDocDto {
  readonly path: string;
  readonly content: string;
}

export interface VolumeDto {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly summary: string;
  readonly sortOrder: number;
  readonly createdAt: number;
}

export interface ActDto {
  readonly id: string;
  readonly projectId: string;
  readonly volumeId: string;
  readonly title: string;
  readonly goal: string;
  readonly summary: string;
  readonly arcGoal?: string;
  readonly arcSummary?: string;
  readonly pacingTemplate?: string;
  readonly chapterCount?: number;
  readonly sortOrder: number;
  readonly createdAt: number;
}

export interface ContextTuningConfigDto {
  // 1. Context lengths & tier budgets
  readonly defaultTokenLimit: number;
  readonly inputBudgetRatio: number;
  readonly l1BudgetTokens: number;
  readonly l1DirtyThreshold: number;
  readonly l2MilestoneChunkSize: number;

  // 2. Reading windows & recall
  readonly prevTailChars: number;
  readonly rollingSummaryCount: number;
  readonly relatedHistoryTopK: number;
  readonly relatedHistoryRecentExclude: number;
  readonly antiEchoWindow: number;
  readonly staleForeshadowGap: number;

  // 3. Context slot toggles
  readonly includeL1BookBible: boolean;
  readonly includeL2VolumeMilestones: boolean;
  readonly includePovBoundary: boolean;
  readonly includeDueForeshadows: boolean;
  readonly includeAntiEchoGuard: boolean;
  readonly includeTechniques: boolean;
  readonly includeDeconstructions: boolean;
  readonly includeCurrentFocus: boolean;
  readonly includeRelatedHistory: boolean;
  readonly includeRollingSummaries: boolean;
  readonly includePrevTail: boolean;

  // 4. Library & per-slot truncation caps
  readonly maxActiveTechniques: number;
  readonly maxActiveDeconstructions: number;
  readonly techniqueExampleChars: number;
  readonly deconstructionExcerptChars: number;
}

export interface ProjectControlsDto {
  readonly projectId: string;
  readonly authorIntent: string;
  readonly currentFocus: string;
  readonly pacingTier?: string;
  readonly genreTags?: readonly string[];
  readonly agentToolsEnabled?: boolean;
  readonly dailyTarget?: number;
  readonly staleForeshadowGap?: number;
  readonly tokenCalibration?: Readonly<Record<string, number>>;
  readonly contextTuning?: ContextTuningConfigDto;
  readonly isDefaultContextTuning?: boolean;
  readonly collaborationMode?: "cautious" | "co_create";
  readonly agentPromptInjection?: boolean;
  readonly updatedAt: number;
}

export interface ChapterTreeItemDto {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly volumeId: string | null;
  readonly actId: string | null;
  readonly charCount: number;
  readonly summary: string;
  readonly targetLength: number | null;
  readonly viewpoint: string | null;
  readonly syncStatus?: MemorySyncStatus;
  readonly sortKey?: number;
  readonly order: number;
  readonly updatedAt: number;
}

export interface NovelTreeDto {
  readonly projectId: string;
  readonly volumes: readonly VolumeDto[];
  readonly acts: readonly ActDto[];
  readonly chapters: readonly ChapterTreeItemDto[];
  readonly totalChars: number;
  readonly asOfSeq: number;
  readonly treeSeq?: number;
  readonly unchanged?: boolean;
}

export interface ActiveContextCrumbDto {
  readonly volumeId: string | null;
  readonly volumeTitle: string | null;
  readonly actId: string | null;
  readonly actTitle: string | null;
  readonly charCount: number;
  readonly summary: string;
  readonly syncStatus?: MemorySyncStatus;
}

export interface LoreEntryDto {
  readonly factId: string;
  readonly category: LoreCategory;
  readonly entityName: string;
  readonly latestSettingId: string;
  readonly locked: boolean;
  readonly fact: SettingFactDto;
  readonly decidedSeq: number;
}

export interface ForeshadowDto {
  readonly id: string;
  readonly projectId: string;
  readonly factId: string | null;
  readonly title: string;
  readonly plantedChapterId: string | null;
  readonly plantedPoint: number;
  readonly targetChapterId: string | null;
  readonly resolvedChapterId: string | null;
  readonly hintedChapterIds?: readonly string[];
  readonly status: ForeshadowStatus;
  readonly note: string;
  readonly updatedAt: number;
}

export interface LoreConflictDto {
  readonly kind:
    | "expiry-before-known"
    | "inverted-validity-interval"
    | "known-before-effective"
    | "outline-fact-mismatch"
    | "stale-foreshadow"
    | "foreshadow-order-flip";
  readonly severity: "warning" | "error";
  readonly targetId: string;
  readonly chapterId?: string;
  readonly message: string;
}

export interface DeconstructionDto {
  readonly id: string;
  readonly scope: LibraryScope;
  readonly projectId: string | null;
  readonly overrideOfId: string | null;
  readonly title: string;
  readonly sourceBook: string;
  readonly genre: string;
  readonly pacing: string;
  readonly tags: readonly string[];
  readonly excerpt: string;
  readonly hookAnalysis: string;
  readonly conflictBeats: string;
  readonly payoffRhythm: string;
  readonly proseNotes: string;
  readonly status: LibraryStatus;
  readonly sourceKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TechniqueCardDto {
  readonly id: string;
  readonly scope: LibraryScope;
  readonly projectId: string | null;
  readonly overrideOfId: string | null;
  readonly title: string;
  readonly category: string;
  readonly pacing: string;
  readonly sceneTags: readonly string[];
  readonly triggerWhen: string;
  readonly executionSteps: string;
  readonly constraints: string;
  readonly antiPatterns: string;
  readonly exampleExcerpt: string;
  readonly positiveExample?: string;
  readonly negativeExample?: string;
  readonly conflictGroup?: string;
  readonly appliedCount?: number;
  readonly avgQualityDelta?: number;
  readonly priority: number;
  readonly status: LibraryStatus;
  readonly sourceKind: string;
  readonly assetKind?: LibraryAssetKind;
  readonly stageBindings?: readonly WritingStageBinding[];
  readonly references?: readonly SkillReferenceDocDto[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SkillImportPreviewDto {
  readonly title: string;
  readonly triggerWhen: string;
  readonly category: string;
  readonly pacing: string;
  readonly sceneTags: readonly string[];
  readonly stageBindings: readonly WritingStageBinding[];
  readonly executionSteps: string;
  readonly constraints: string;
  readonly antiPatterns: string;
  readonly references: readonly SkillReferenceDocDto[];
  readonly strippedCapabilities: readonly string[];
  readonly rejectedFiles: readonly string[];
  readonly warnings: readonly string[];
  readonly rawPreview: string;
}

export interface GoldenThreeDimensionDto {
  readonly id: string;
  readonly label: string;
  readonly score: number;
  readonly status: "pass" | "warn";
  readonly summary: string;
  readonly problemParagraphs: readonly number[];
}

export interface GoldenThreeReportDto {
  readonly isGoldenThreeChapter: boolean;
  readonly overallScore: number;
  readonly dimensions: readonly GoldenThreeDimensionDto[];
  readonly warnings: readonly string[];
}

export interface SlopHitDto {
  readonly phrase: string;
  readonly category: string;
  readonly paragraphIndex: number;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}

export interface AiSlopReportDto {
  readonly charCount: number;
  readonly totalHits: number;
  readonly densityPer1000Chars: number;
  readonly severity: "clean" | "warn" | "high";
  readonly topPhrases: readonly { readonly phrase: string; readonly category: string; readonly count: number }[];
  readonly hits: readonly SlopHitDto[];
  readonly weightedScore?: number;
  readonly sentenceLengthCV?: number;
  readonly monotoneRuns?: number;
}

export interface PovLeakWarningDto {
  readonly factId: string;
  readonly entityName: string;
  readonly matchedTerm: string;
  readonly paragraphIndex: number;
  readonly excerpt: string;
}

export interface ChapterQualityV2Dto {
  readonly endingHookScore: number;
  readonly endingHookStatus: "pass" | "warn";
  readonly endingHookSummary: string;
  readonly paragraphLeadRepetitions: readonly {
    readonly lead: string;
    readonly paragraphs: readonly number[];
  }[];
  readonly crossChapterEchoes: readonly {
    readonly phrase: string;
    readonly currentCount: number;
    readonly recentCount: number;
  }[];
  readonly povLeakWarnings: readonly PovLeakWarningDto[];
  readonly compositeScore: number;
}

export interface ChapterDiagnosticsReportDto {
  readonly documentId: string;
  readonly goldenThree: GoldenThreeReportDto;
  readonly aiSlop: AiSlopReportDto;
  readonly qualityV2?: ChapterQualityV2Dto;
}

export interface SlopConfigDto {
  readonly projectId: string;
  readonly customBanned: readonly string[];
  readonly whitelist: readonly string[];
}

export type ObservationDimension = "continuity" | "ooc" | "pacing" | "foreshadow" | "style" | "ai_slop";
export type ObservationStatus = "open" | "addressed" | "dismissed";

export interface ChapterObservationDto {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly revisionId: string | null;
  readonly dimension: ObservationDimension;
  readonly severity: "info" | "warning" | "error";
  readonly quote: string;
  readonly suggestion: string;
  readonly status: ObservationStatus;
  readonly verified?: boolean;
  readonly stale?: boolean;
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LibraryMountDto {
  readonly id: string;
  readonly projectId: string;
  readonly targetType: LibraryMountTarget;
  readonly targetId: string;
  readonly itemKind: LibraryItemKind;
  readonly itemId: string;
  readonly mode: LibraryMountMode;
  readonly weight: number;
  readonly note: string;
}

export interface TechniqueRecommendationDto {
  readonly card: TechniqueCardDto;
  readonly score: number;
  readonly mountedMode: LibraryMountMode | null;
  readonly mountTarget: LibraryMountTarget | null;
  readonly reasons: readonly string[];
}

export interface AiProposalDto {
  readonly id: string;
  readonly projectId: string | null;
  readonly documentId: string | null;
  readonly kind: AiProposalKind;
  readonly status: "pending" | "approved" | "rejected" | "failed" | "inflight";
  readonly sourceRef: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reserved: number;
  readonly settled: number;
  readonly error: string | null;
  readonly baseRevisionId?: string | null;
  readonly sourceSha256?: string;
  readonly origin?: ProposalOrigin;
  readonly originRef?: string;
  readonly errorDetail?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SearchHitDto {
  readonly scope: "chapter" | "lore" | "deconstruction" | "technique";
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly snippet: string;
}

export interface LocalBundleFileDto {
  readonly path: string;
  readonly content: string;
  readonly sha256?: string;
}

export interface ProjectExportBundleDto {
  readonly projectId: string;
  readonly projectName: string;
  readonly exportedAt: string;
  readonly writtenDirectory?: string | null;
  readonly files: readonly LocalBundleFileDto[];
}

export interface RelatedChapterScoreDto {
  readonly chapterId: string;
  readonly title: string;
  readonly summary: string;
  readonly score: number;
  readonly breakdown: {
    readonly foreshadow: number;
    readonly character: number;
    readonly knownFrom: number;
    readonly cooccurrenceAndSemantic: number;
  };
  readonly reasons: readonly string[];
}

export interface ProjectImportSummaryDto {
  readonly projectId: string;
  readonly volumesCreated: number;
  readonly actsCreated: number;
  readonly chaptersCreated: number;
  readonly chaptersUpdated: number;
  readonly chaptersSkippedLocked: readonly string[];
  readonly loreProposed: number;
  readonly libraryImported: number;
  readonly foreshadowsImported?: number;
  readonly mountsRestored?: number;
}

// --- Non-Standard Material Normalization & Re-Ingestion ---

export type MaterialChunkRole =
  | "completed_chapter"
  | "rough_draft"
  | "lore_note"
  | "outline_note"
  | "foreshadow_note"
  | "ignore";

export type MaterialIngestStatus =
  | "chunked"
  | "extracting"
  | "ready_for_review"
  | "committed"
  | "discarded"
  | "failed";

export interface MaterialChunkDto {
  readonly id: string;
  readonly sourcePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly title: string;
  readonly volumeTitle?: string;
  readonly role: MaterialChunkRole;
  readonly loreCategoryHint?: LoreCategory;
  readonly charCount: number;
  readonly content: string;
  readonly warnings: readonly string[];
  readonly duplicateOfExistingTitle?: string | null;
}

export interface MaterialProposedChapterDto {
  readonly id: string;
  readonly volumeTitle: string;
  readonly actTitle: string;
  readonly title: string;
  readonly state: "planned" | "drafting" | "drafted";
  readonly summary: string;
  readonly body: string;
  readonly viewpoint?: string;
  readonly conflictStatus: "new" | "update_draft" | "skip_locked_final";
  readonly selected: boolean;
}

export interface MaterialProposedLoreDto {
  readonly id: string;
  readonly factId: string;
  readonly category: LoreCategory;
  readonly entityName: string;
  readonly note: string;
  readonly aliases: readonly string[];
  readonly lockedSuggested: boolean;
  readonly effectiveChapterTitle?: string;
  readonly knownBy: readonly { readonly character: string; readonly chapterTitle?: string }[];
  readonly conflictStatus: "new" | "update_unlocked" | "skip_locked";
  readonly conflictNote?: string;
  readonly selected: boolean;
}

export interface MaterialProposedForeshadowDto {
  readonly id: string;
  readonly title: string;
  readonly status: ForeshadowStatus;
  readonly plantedChapterTitle?: string;
  readonly targetChapterTitle?: string;
  readonly note: string;
  readonly selected: boolean;
}

export interface MaterialProposedBundleDto {
  readonly authorIntent?: string;
  readonly currentFocus?: string;
  readonly pacingTier?: string;
  readonly genreTags?: readonly string[];
  readonly chapters: readonly MaterialProposedChapterDto[];
  readonly lore: readonly MaterialProposedLoreDto[];
  readonly foreshadows: readonly MaterialProposedForeshadowDto[];
  readonly warnings: readonly string[];
}

export interface MaterialCommitSummaryDto {
  readonly sessionId: string;
  readonly projectId: string;
  readonly volumesCreated: number;
  readonly actsCreated: number;
  readonly chaptersCreated: number;
  readonly chaptersUpdated: number;
  readonly chaptersSkippedLocked: number;
  readonly loreCommitted: number;
  readonly loreSkippedLocked: number;
  readonly foreshadowsCommitted: number;
  readonly controlsUpdated: boolean;
  readonly l1SnapshotVersion: number;
}

export interface MaterialIngestSessionDto {
  readonly id: string;
  readonly projectId: string;
  readonly sourceOrigin: "workbench_upload" | "dsh_agent";
  readonly status: MaterialIngestStatus;
  readonly totalFiles: number;
  readonly totalChars: number;
  readonly cleaningWarnings: readonly string[];
  readonly chunks: readonly MaterialChunkDto[];
  readonly proposedBundle: MaterialProposedBundleDto | null;
  readonly committedReport: MaterialCommitSummaryDto | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// --- Tiered Autonomous Writing Workflow (Autopilot) ---

export type AutopilotScope = "single_chapter" | "multi_chapter";
export type AutopilotAutonomyMode = "redline_pause" | "chapter_gate";
export type AutopilotAdoptionPolicy = "working_draft_snapshot" | "candidate_only";
export type AutopilotBatchStatus =
  | "running"
  | "paused_redline"
  | "paused_gate"
  | "completed"
  | "cancelled"
  | "failed";

export type AutopilotStepKind =
  | "beat_plan"
  | "draft_write"
  | "offline_qa"
  | "model_review"
  | "surgical_refine"
  | "fact_sync"
  | "arc_roll";

export type AutopilotRedLineKind =
  | "locked_lore_conflict"
  | "pov_leak"
  | "quality_below_floor"
  | "high_severity_review"
  | "budget_cap"
  | "consecutive_errors"
  | "chapter_gate_checkpoint";

export interface AutopilotPauseReasonDto {
  readonly kind: AutopilotRedLineKind;
  readonly documentId: string;
  readonly chapterTitle: string;
  readonly message: string;
  readonly details: readonly string[];
  readonly problemParagraphs: readonly number[];
}

export interface AutopilotStepDto {
  readonly id: string;
  readonly batchId: string;
  readonly documentId: string;
  readonly chapterTitle: string;
  readonly stepKind: AutopilotStepKind;
  readonly round: number;
  readonly status: "completed" | "failed" | "paused" | "skipped";
  readonly inputRevisionId: string | null;
  readonly outputRevisionId: string | null;
  readonly scoreBefore: number | null;
  readonly scoreAfter: number | null;
  readonly tokensUsed: number;
  readonly cacheHitRate: number | null;
  readonly summary: string;
  readonly error: string | null;
  readonly createdAt: number;
}

export interface AutopilotBatchDto {
  readonly id: string;
  readonly projectId: string;
  readonly scope: AutopilotScope;
  readonly autonomyMode: AutopilotAutonomyMode;
  readonly adoptionPolicy: AutopilotAdoptionPolicy;
  readonly status: AutopilotBatchStatus;
  readonly chapterIds: readonly string[];
  readonly currentChapterIndex: number;
  readonly currentStep: AutopilotStepKind | null;
  readonly tokenBudget: number;
  readonly tokensSpent: number;
  readonly refineRoundsUsed: number;
  readonly provider: string;
  readonly model: string;
  readonly pauseReason: AutopilotPauseReasonDto | null;
  readonly preBatchRevisions: Readonly<Record<string, string | null>>;
  readonly steps: readonly AutopilotStepDto[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

