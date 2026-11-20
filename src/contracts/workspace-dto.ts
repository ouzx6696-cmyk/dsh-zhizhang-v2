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

export interface SettingFactDto {
  readonly id: string;
  readonly note: string;
  readonly source: string;
  readonly kind: "fact" | "agreement";
  readonly locked: boolean;
  readonly effectiveFrom: AnchorPoint;
  readonly effectiveTo?: AnchorPoint;
  readonly knownFrom: Readonly<Record<string, AnchorPoint>>;
}

export interface SettingEntryDto {
  readonly id: string;
  readonly decision: SettingDecision;
  readonly fact: SettingFactDto;
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

export interface RunSummary {
  readonly id: string;
  readonly state: string;
  readonly baseRevisionId: string;
  readonly reserved: number;
  readonly settled: number;
  readonly candidateId: string | null;
  readonly candidateBody: string | null;
  readonly candidateQa: string | null;
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
  readonly sortOrder: number;
  readonly createdAt: number;
}

export interface ProjectControlsDto {
  readonly projectId: string;
  readonly authorIntent: string;
  readonly currentFocus: string;
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
  readonly status: "pending" | "approved" | "rejected" | "failed";
  readonly sourceRef: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reserved: number;
  readonly settled: number;
  readonly error: string | null;
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
  | "controls.save";
