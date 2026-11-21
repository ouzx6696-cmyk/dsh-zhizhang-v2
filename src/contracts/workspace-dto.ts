// Browser-safe shared DTOs and state types.
//
// Strictly type-only (`export type` / `export interface`): compiled away by
// TypeScript (`verbatimModuleSyntax`), so browser bundles import zero Node or
// cross-directory runtime modules while sharing one source of truth with the
// application and host layers.

export type Product = "fanqie" | "toutiao";
export type ProductKind = Product;

export type ArticleModeId = "long" | "short" | "micro";
export type ContentLineId = "资讯线" | "故事线";

export type ChapterStatusWord = "planned" | "drafting" | "drafted" | "reviewed" | "final";
export type ArticleStatusWord = "初稿待改" | "待验收" | "已验收" | "验收退回" | "已交稿";
export type DocumentStatusWord = ChapterStatusWord | ArticleStatusWord;

export type RunStatusWord =
  | "running"
  | "paused"
  | "awaiting-author"
  | "applied"
  | "discarded"
  | "failed"
  | "cancelled";

export type GenerationAttemptState =
  | "prepared"
  | "inflight"
  | "received"
  | "completed"
  | "failed"
  | "uncertain"
  | "reconciled";

export type SettingDecision = "pending" | "approved" | "rejected";
export type ExportStatusWord = "pending" | "exported" | "failed";

export interface AnchorPoint {
  readonly chapterId: string;
  readonly point: number;
}
export type NarrativeAnchorDto = AnchorPoint;

export type ProposalOrigin = "author-ui" | "ai-generate" | "agent-tool";

export type ActorDto =
  | { readonly kind: "author"; readonly peerId?: string }
  | { readonly kind: "agent"; readonly toolCallId: string; readonly agentId?: string };

export interface PendingJobDto {
  readonly id: string;
  readonly kind: string;
  readonly projectId?: string | null;
  readonly documentId: string | null;
  readonly startedAt: number;
}

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

export interface ProjectBootstrapInputDto {
  readonly product: Product;
  readonly name: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
  readonly pacingTier?: string;
  readonly genreTags?: readonly string[];
  readonly dailyTarget?: number;
  readonly volumeTitle?: string;
  readonly actTitle?: string;
  readonly chapterTitle?: string;
  readonly chapterBody?: string;
  readonly techniques?: readonly Readonly<Record<string, unknown>>[];
  readonly settings?: readonly Readonly<Record<string, unknown>>[];
}

export interface ChunkedImportInputDto {
  readonly importId: string;
  readonly part: number;
  readonly totalParts: number;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly files: readonly LocalBundleFileDto[];
  readonly commit?: boolean;
}

export interface BackupInfoDto {
  readonly id: string;
  readonly valid: boolean;
  readonly schema?: string;
  readonly createdAt?: string;
  readonly sizeBytes?: number;
  readonly entryCount?: number;
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

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly product: Product;
}

export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
}
export type DocumentListItem = DocumentSummary;

export interface ActiveDocument {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly product: Product;
  readonly state: string;
  readonly mode: string | null;
  readonly line: string | null;
  readonly revisionId: string | null;
  readonly finalRevisionId: string | null;
  readonly body: string | null;
  readonly editorialRejections: number;
  readonly qaRounds: number;
}
export type ActiveDocumentView = ActiveDocument;

export interface CandidateQaReport {
  readonly overall: number;
  readonly passed: boolean;
  readonly fails: readonly string[];
  readonly hardGates: readonly string[];
}

export type RecoveryHintKind = "output_truncated" | "thinking_exhausted" | "budget_exhausted";

export interface RecoveryHintDto {
  readonly kind: RecoveryHintKind;
  readonly action: "increase_output_limit" | "disable_thinking" | "increase_budget";
  readonly message: string;
}

export interface RunBillingSummaryDto {
  readonly totalInput: number;
  readonly totalOutput: number;
  readonly totalCacheRead: number;
  readonly totalCacheWrite: number;
  readonly effectiveBilledTokens: number | null;
  readonly cacheHitRate: number | null;
}

/** Per-document cumulative `selection.rewrite` ledger (decision #7, DSH-10). */
export interface MicroUsageSummaryDto {
  readonly calls: number;
  readonly completed: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly totalInput: number;
  readonly totalOutput: number;
  readonly totalCacheRead: number;
  readonly totalCacheWrite: number;
  readonly settled: number;
}

export interface RunSummary {
  readonly id: string;
  readonly state: string;
  readonly baseRevisionId: string;
  readonly reserved: number;
  readonly settled: number;
  readonly candidateId: string | null;
  readonly candidateBody: string | null;
  readonly candidateQa: string | null;
  readonly candidateQaReport?: CandidateQaReport | null;
  readonly refinementRounds: number | null;
  readonly generationState: string | null;
  readonly generationError: string | null;
  readonly recoveryHints?: readonly RecoveryHintDto[];
}
export type RunSummaryView = RunSummary;

export interface RunHistoryItem {
  readonly cursor: number;
  readonly id: string;
  readonly state: string;
  readonly reserved: number;
  readonly settled: number;
}

export interface GenerationAttemptDto {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly state: string;
  readonly stage: string | null;
  readonly usage: string;
  readonly lateUsage?: string;
  readonly error: string | null;
}
export type GenerationAttemptRecord = GenerationAttemptDto;

export interface GenerationCallDto {
  readonly id: string;
  readonly attemptId: string;
  readonly phase: string;
  readonly inputReserve: number;
  readonly maxOutput: number;
  readonly usage: string | null;
}
export type GenerationCallRecord = GenerationCallDto;

export interface RunDetailDto {
  readonly id: string;
  readonly documentId: string;
  readonly state: string;
  readonly baseRevisionId: string;
  readonly frozenInput: string;
  readonly reserved: number;
  readonly settled: number;
  readonly candidateId: string | null;
  readonly candidate: { readonly body: string } | null;
  readonly attempts: readonly GenerationAttemptDto[];
  readonly calls: readonly GenerationCallDto[];
  readonly billing?: RunBillingSummaryDto;
  readonly contextTrace?: ContextAssemblyReportDto | null;
  readonly recoveryHints?: readonly RecoveryHintDto[];
  /** Cumulative micro-rewrite usage for this document, shown beside the run billing. */
  readonly microUsage?: MicroUsageSummaryDto;
}
export type RunDetailView = RunDetailDto;

export interface ExportStatusDto {
  readonly state: ExportStatusWord;
  readonly error: string | null;
  readonly hash: string | null;
  readonly revisionId: string;
}
export type ExportStatusView = ExportStatusDto;

export interface ArticleReportDto {
  readonly overall?: number;
  readonly passed?: boolean;
  readonly fails?: readonly string[];
  readonly hardGates?: readonly string[];
  readonly reason?: string;
}
export type ArticleReportView = ArticleReportDto;

export interface ArticleScenarioDto {
  readonly label: string;
  readonly length: readonly [number, number];
  readonly main?: readonly [number, number] | null;
  readonly extension?: readonly [number, number] | null;
  readonly drivers: readonly string[];
  readonly openings: readonly string[];
  readonly endings: readonly string[];
  readonly extensions?: readonly string[];
  readonly hasTitle: boolean;
}
export type ArticleScenarioView = ArticleScenarioDto;

export interface TitleMatrixDto {
  readonly valid: readonly { readonly text: string; readonly motif: string }[];
  readonly motifCount: number;
  readonly passed: boolean;
}
export type TitleMatrixView = TitleMatrixDto;

export interface PlanningDto {
  readonly viewpoint?: string;
  readonly target?: number;
  readonly lockedFacts?: string;
  readonly knowledge?: string;
  readonly sections?: Readonly<Record<string, string>>;
  readonly driver?: string;
  readonly opening?: string;
  readonly ending?: string;
  readonly titleMatrix?: TitleMatrixDto;
}
export type PlanningView = PlanningDto;

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
export type ContextSlotPriority = "critical" | "high" | "medium" | "optional";
export type AiProposalKind =
  | "deconstruct"
  | "technique"
  | "setting"
  | "summary"
  | "fact_sync"
  | "chapter_review"
  | "arc_plan";
export type MemorySyncStatus = "clean" | "dirty";
export type LibraryAssetKind = "technique" | "skill";
export type WritingStageBinding = "plan" | "write" | "review" | "refine" | "deslop";

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

export type SelectionRewriteMode = "polish" | "expand" | "dialogue" | "continue" | "custom";

export interface SelectionRewriteResultDto {
  readonly rewrittenText: string;
  readonly tokens: number;
  readonly mode: SelectionRewriteMode;
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

export interface ContextSlotReportDto {
  readonly id: string;
  readonly label: string;
  readonly group: "prefix" | "dynamic";
  readonly priority: ContextSlotPriority;
  readonly rawTokens: number;
  readonly includedTokens: number;
  readonly status: "included" | "truncated" | "dropped" | "empty";
}

export interface ContextAssemblyReportDto {
  readonly maxInputTokens: number;
  readonly totalEstimatedTokens: number;
  readonly prefixTokens: number;
  readonly dynamicTokens: number;
  readonly prefixBudget?: number;
  readonly dynamicBudget?: number;
  readonly framingTokens?: number;
  readonly overBudget?: boolean;
  readonly slots: readonly ContextSlotReportDto[];
  readonly activeTechniqueIds: readonly string[];
  readonly activeDeconstructionIds: readonly string[];
}

export interface ContextBundleDto {
  readonly stablePrefix: string;
  readonly dynamicTail: string;
  readonly report: ContextAssemblyReportDto;
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

export interface ProtectedRulesSnapshotDto {
  readonly titleMax: number;
  readonly qaPassScore: number;
  readonly qaRefinementLimit: number;
  readonly editorialRejectionLimit: number;
}

export interface LlmDefaultsDto {
  readonly provider: string;
  readonly model: string;
}

export interface WorkspaceSnapshot {
  readonly unchanged?: false;
  readonly projects?: readonly ProjectSummary[];
  readonly documents?: readonly DocumentSummary[];
  readonly active?: ActiveDocument;
  readonly activeContext?: ActiveContextCrumbDto | null;
  readonly runs?: readonly RunSummary[];
  readonly approved?: boolean;
  readonly delivery?: string | null;
  readonly exportStatus?: ExportStatusDto | null;
  readonly settings?: readonly SettingEntryDto[];
  readonly settingsCursor?: number | null;
  readonly report?: ArticleReportDto | null;
  readonly planning?: PlanningDto | null;
  readonly scenario?: ArticleScenarioDto | null;
  readonly pendingJobs?: readonly PendingJobDto[];
  readonly treeSeq?: number;
  readonly globalSeq?: number;
  readonly llmDefaults?: LlmDefaultsDto;
  readonly rules?: ProtectedRulesSnapshotDto;
  readonly asOfSeq?: number;
}

export type WorkspaceStateResponse = WorkspaceSnapshot | { readonly unchanged: true };

export interface ApiSuccessEnvelope<T> {
  readonly ok: true;
  readonly result: T;
}

export interface ApiErrorEnvelope {
  readonly ok: false;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly diagnosticId?: string;
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export interface BudgetPreviewResult {
  readonly inputReserve: number;
  readonly recommended: number;
}

export interface ReorderImpactItem {
  readonly id: string;
  readonly relations: readonly { readonly label: string }[];
}

export interface ReorderImpactResult {
  readonly impact: readonly ReorderImpactItem[];
  readonly chapterIds: readonly string[];
  readonly asOfSeq: number;
}

export interface EvidenceDetailResult {
  readonly asOfSeq: number;
  readonly value: {
    readonly snapshotId?: string;
    readonly revisionId?: string;
    readonly anchor?: { readonly chapterId: string; readonly point: string };
    readonly quoteRange?: { readonly start: number; readonly end: number };
    readonly verification?: { readonly kind: string; readonly score?: number };
  };
}

export type WorkspaceAction =
  | "read.model"
  | "project.create"
  | "document.create"
  | "draft.save"
  | "chapter.outline"
  | "chapter.review"
  | "draft.finalize"
  | "setting.propose"
  | "setting.decide"
  | "settings.history"
  | "settings.read"
  | "reorder.impact"
  | "reorder.commit"
  | "evidence.record"
  | "evidence.detail"
  | "article.plan"
  | "article.rename"
  | "article.qa"
  | "article.refine"
  | "article.accept"
  | "approval.decide"
  | "article.deliver"
  | "run.preview"
  | "run.start"
  | "run.generate"
  | "run.complete"
  | "run.cancel"
  | "run.discard"
  | "run.reconcile"
  | "run.detail"
  | "run.history"
  | "candidate.adopt"
  | "tree.get"
  | "volume.create"
  | "volume.update"
  | "volume.delete"
  | "act.create"
  | "act.update"
  | "act.delete"
  | "chapter.move"
  | "chapter.summary.save"
  | "lore.list"
  | "lore.conflicts"
  | "foreshadow.upsert"
  | "foreshadow.list"
  | "deconstruct.save"
  | "deconstruct.list"
  | "deconstruct.delete"
  | "technique.save"
  | "technique.list"
  | "technique.delete"
  | "library.mount"
  | "library.unmount"
  | "library.mounts"
  | "technique.recommend"
  | "context.preview"
  | "proposal.create"
  | "proposal.list"
  | "proposal.decide"
  | "proposal.generate"
  | "proposal.cancel"
  | "workspace.search"
  | "project.export_bundle"
  | "project.import_bundle"
  | "skill.import"
  | "chapter.diagnose"
  | "slop.config.get"
  | "slop.config.save"
  | "observation.list"
  | "observation.create"
  | "observation.update"
  | "selection.rewrite"
  | "controls.get"
  | "controls.save"
  | "chapter.read"
  | "project.bootstrap"
  | "foreshadow.create"
  | "foreshadow.patch"
  | "backup.create"
  | "backup.list"
  | "setting.revoke_known"
  | "chapter.creation_report"
  | "project.daily_stats"
  | "revisions.compact";

export interface ActionEntry<I = Readonly<Record<string, unknown>>, O = unknown> {
  readonly input: I;
  readonly output: O;
}

export interface RevisionCompactResultDto {
  readonly examined: number;
  readonly deleted: number;
  readonly kept: number;
  readonly dryRun?: boolean;
}

export interface ProjectBootstrapResultDto {
  readonly projectId: string;
  readonly volumeId?: string | null;
  readonly actId?: string | null;
  readonly documentId?: string | null;
  readonly revisionId?: string | null;
  readonly techniquesCreated: number;
  readonly settingsProposed: number;
}

export type ActionMap = {
  readonly [K in WorkspaceAction]: ActionEntry;
} & {
  readonly "project.create": ActionEntry<{ readonly product: Product; readonly name: string }, ProjectSummary>;
  readonly "project.bootstrap": ActionEntry<ProjectBootstrapInputDto, ProjectBootstrapResultDto>;
  readonly "document.create": ActionEntry<
    {
      readonly projectId: string;
      readonly title: string;
      readonly mode?: ArticleModeId;
      readonly line?: ContentLineId;
      readonly volumeId?: string;
      readonly actId?: string;
    },
    { readonly id: string }
  >;
  readonly "draft.save": ActionEntry<
    { readonly documentId: string; readonly baseRevisionId: string | null; readonly body: string; readonly key?: string },
    { readonly revisionId: string }
  >;
  readonly "chapter.read": ActionEntry<{ readonly projectId?: string; readonly documentId: string }, ChapterReadDto>;
  readonly "chapter.creation_report": ActionEntry<{ readonly documentId: string }, CreationProcessReportDto>;
  readonly "project.daily_stats": ActionEntry<{ readonly projectId: string; readonly days?: number }, DailyOutputStatsDto>;
  readonly "tree.get": ActionEntry<
    { readonly projectId: string; readonly ifSequence?: number; readonly ifTreeSeq?: number },
    NovelTreeDto | { readonly unchanged: true; readonly treeSeq?: number; readonly asOfSeq?: number }
  >;
  readonly "controls.get": ActionEntry<{ readonly projectId: string }, ProjectControlsDto>;
  readonly "controls.save": ActionEntry<
    {
      readonly projectId: string;
      readonly authorIntent?: string;
      readonly currentFocus?: string;
      readonly pacingTier?: string;
      readonly genreTags?: readonly string[];
      readonly agentToolsEnabled?: boolean;
      readonly dailyTarget?: number;
      readonly staleForeshadowGap?: number;
    },
    ProjectControlsDto
  >;
  readonly "foreshadow.create": ActionEntry<
    {
      readonly projectId: string;
      readonly title: string;
      readonly factId?: string | null;
      readonly plantedChapterId?: string | null;
      readonly plantedPoint?: number;
      readonly targetChapterId?: string | null;
      readonly status?: ForeshadowStatus;
      readonly note?: string;
    },
    ForeshadowDto
  >;
  readonly "foreshadow.patch": ActionEntry<
    {
      readonly id: string;
      readonly projectId?: string;
      readonly title?: string;
      readonly factId?: string | null;
      readonly plantedChapterId?: string | null;
      readonly plantedPoint?: number;
      readonly targetChapterId?: string | null;
      readonly resolvedChapterId?: string | null;
      readonly hintedChapterId?: string | null;
      readonly status?: ForeshadowStatus;
      readonly reopen?: boolean;
      readonly note?: string;
    },
    ForeshadowDto
  >;
  readonly "setting.revoke_known": ActionEntry<
    { readonly projectId: string; readonly factId: string; readonly character: string; readonly reason?: string },
    { readonly id: string; readonly factId: string; readonly revokedCharacter: string }
  >;
  readonly "backup.create": ActionEntry<
    { readonly includeExports?: boolean; readonly label?: string },
    BackupInfoDto
  >;
  readonly "backup.list": ActionEntry<Readonly<Record<string, never>> | Readonly<Record<string, unknown>>, readonly BackupInfoDto[]>;
  readonly "revisions.compact": ActionEntry<
    { readonly projectId?: string; readonly documentId?: string; readonly retainRawDays?: number; readonly dryRun?: boolean },
    RevisionCompactResultDto
  >;
  readonly "context.preview": ActionEntry<
    { readonly documentId: string; readonly instruction?: string; readonly tokenLimit?: number; readonly point?: number },
    ContextBundleDto
  >;
  readonly "run.preview": ActionEntry<
    { readonly documentId: string; readonly baseRevisionId: string; readonly instruction: string },
    BudgetPreviewResult & { readonly contextReport?: ContextAssemblyReportDto | null }
  >;
  readonly "run.detail": ActionEntry<{ readonly documentId: string; readonly runId: string }, RunDetailDto>;
  readonly "run.history": ActionEntry<{ readonly documentId: string; readonly before?: number }, readonly RunHistoryItem[]>;
  readonly "workspace.search": ActionEntry<
    { readonly projectId: string; readonly query: string; readonly scopes?: readonly ("chapter" | "lore" | "deconstruction" | "technique")[]; readonly limit?: number },
    readonly SearchHitDto[]
  >;
  readonly "chapter.diagnose": ActionEntry<{ readonly documentId: string }, ChapterDiagnosticsReportDto>;
  readonly "project.export_bundle": ActionEntry<
    { readonly projectId: string; readonly writeToDisk?: boolean; readonly formatVersion?: 1 | 2 },
    ProjectExportBundleDto
  >;
  readonly "project.import_bundle": ActionEntry<
    | { readonly projectId?: string; readonly projectName?: string; readonly files: readonly LocalBundleFileDto[] }
    | ChunkedImportInputDto,
    ProjectImportSummaryDto | { readonly importId: string; readonly part: number; readonly totalParts: number; readonly accepted: true }
  >;
  readonly "proposal.list": ActionEntry<
    { readonly projectId?: string; readonly documentId?: string; readonly kind?: AiProposalKind; readonly status?: string },
    readonly AiProposalDto[]
  >;
  readonly "selection.rewrite": ActionEntry<
    {
      readonly documentId: string;
      readonly selectedText: string;
      readonly beforeContext?: string;
      readonly afterContext?: string;
      readonly mode?: SelectionRewriteMode;
      readonly instruction?: string;
      readonly selectionStart?: number;
      readonly provider: string;
      readonly model: string;
      readonly tokenLimit?: number;
    },
    SelectionRewriteResultDto
  >;
};
