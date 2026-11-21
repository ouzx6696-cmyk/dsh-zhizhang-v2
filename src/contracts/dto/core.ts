// Core platform DTOs (strictly type-only, zero runtime emit).
import type {
  ActiveContextCrumbDto,
  AiProposalDto,
  AiProposalKind,
  ChapterDiagnosticsReportDto,
  ChapterReadDto,
  CreationProcessReportDto,
  DailyOutputStatsDto,
  ForeshadowDto,
  ForeshadowStatus,
  LocalBundleFileDto,
  ProjectControlsDto,
  ProjectExportBundleDto,
  ProjectImportSummaryDto,
  SearchHitDto,
  SettingEntryDto,
} from "./fanqie.ts";
import type {
  ArticleModeId,
  ArticleReportDto,
  ArticleScenarioDto,
  ArticleStatusWord,
  CandidateQaReport,
  ContentLineId,
  ExportStatusDto,
  TitleMatrixDto,
} from "./toutiao.ts";
import type { ChapterStatusWord, NovelTreeDto } from "./fanqie.ts";

export type Product = "fanqie" | "toutiao";
export type ProductKind = Product;

export type DocumentStatusWord = ChapterStatusWord | ArticleStatusWord;

export type RunStatusWord =
  | "running"
  | "paused"
  | "awaiting-author"
  | "applied"
  | "discarded"
  | "failed"
  | "cancelled";

export type UnifiedJobKind = "draft_generation" | "proposal_extraction" | "selection_rewrite";

export type UnifiedJobState =
  | "prepared"
  | "inflight"
  | "received"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "reconciled";

export type GenerationAttemptState = UnifiedJobState;

export type ProposalOrigin = "author-ui" | "ai-generate" | "agent-tool";

export type ActorDto =
  | { readonly kind: "author"; readonly peerId?: string }
  | { readonly kind: "agent"; readonly toolCallId: string; readonly agentId?: string };

export interface AnchorPoint {
  readonly chapterId: string;
  readonly point: number;
}
export type NarrativeAnchorDto = AnchorPoint;

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

export interface UnifiedJobSummaryDto {
  readonly id: string;
  readonly kind: UnifiedJobKind;
  readonly subtype: string;
  readonly projectId: string | null;
  readonly documentId: string | null;
  readonly runId: string | null;
  readonly proposalId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly state: UnifiedJobState;
  readonly stage: string | null;
  readonly reserved: number;
  readonly settled: number;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PendingJobDto {
  readonly id: string;
  readonly kind: string;
  readonly projectId?: string | null;
  readonly documentId: string | null;
  readonly startedAt: number;
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

export type ContextSlotPriority = "critical" | "high" | "medium" | "optional";

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
  readonly microUsage?: MicroUsageSummaryDto;
}
export type RunDetailView = RunDetailDto;

export type SelectionRewriteMode = "polish" | "expand" | "dialogue" | "continue" | "custom";

export interface SelectionRewriteResultDto {
  readonly jobId?: string;
  readonly rewrittenText: string;
  readonly tokens: number;
  readonly mode: SelectionRewriteMode;
}

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

export interface BackupInfoDto {
  readonly id: string;
  readonly valid: boolean;
  readonly schema?: string;
  readonly createdAt?: string;
  readonly sizeBytes?: number;
  readonly entryCount?: number;
}

export interface RevisionCompactResultDto {
  readonly examined: number;
  readonly deleted: number;
  readonly kept: number;
  readonly dryRun?: boolean;
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

export interface ProjectBootstrapResultDto {
  readonly projectId: string;
  readonly volumeId?: string | null;
  readonly actId?: string | null;
  readonly documentId?: string | null;
  readonly revisionId?: string | null;
  readonly techniquesCreated: number;
  readonly settingsProposed: number;
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
  readonly jobs?: readonly UnifiedJobSummaryDto[];
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
  | "jobs.list"
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
  readonly "backup.create": ActionEntry<{ readonly includeExports?: boolean; readonly label?: string }, BackupInfoDto>;
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
  readonly "jobs.list": ActionEntry<
    { readonly projectId?: string; readonly documentId?: string; readonly kind?: UnifiedJobKind; readonly limit?: number },
    readonly UnifiedJobSummaryDto[]
  >;
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
