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
  | "arc_plan";

export interface ChapterReadDto {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly state: string;
  readonly revisionId: string | null;
  readonly body: string | null;
  readonly charCount: number;
  readonly summary: string;
  readonly locked: boolean;
  readonly volumeId: string | null;
  readonly actId: string | null;
  readonly updatedAt: number;
}

export interface CreationProcessReportDto {
  readonly documentId: string;
  readonly title: string;
  readonly totalChars: number;
  readonly revisionCount: number;
  readonly manualSaveCount: number;
  readonly adoptedCandidateCount: number;
  readonly candidateOriginRatio: number;
  readonly postAdoptionEditedChars: number;
  readonly outlineAuthorConfirmed: boolean;
  readonly approvedSettingsCount: number;
  readonly generatedAt: string;
}

export interface DailyOutputDayDto {
  readonly date: string;
  readonly charsAdded: number;
  readonly saves: number;
}

export interface DailyOutputStatsDto {
  readonly projectId: string;
  readonly todayChars: number;
  readonly last7DaysChars: number;
  readonly dailyTarget: number;
  readonly days: readonly DailyOutputDayDto[];
}

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

export interface ChapterDiagnosticsReportDto {
  readonly documentId: string;
  readonly goldenThree: GoldenThreeReportDto;
  readonly aiSlop: AiSlopReportDto;
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
