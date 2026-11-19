// Shared browser-safe workspace DTOs and constants.
//
// Imported by the application layer, host HTTP adapter, and browser client so
// state shapes, action names, locked-state sets, and budget constants have a
// single strongly typed source of truth without pulling any Node built-ins into
// browser bundles.

export type Product = "fanqie" | "toutiao";
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

export const WORKSPACE_TITLE_MAX = 34;
export const WORKSPACE_QA_PASS_SCORE = 84;
export const WORKSPACE_EDITORIAL_REJECTION_LIMIT = 2;
export const WORKSPACE_QA_REFINEMENT_LIMIT = 2;
export const WORKSPACE_LOCKED_STATES: readonly DocumentStatusWord[] = ["final", "已验收", "已交稿"];

export function isLockedDocumentState(state: string | null | undefined): boolean {
  return typeof state === "string" && (WORKSPACE_LOCKED_STATES as readonly string[]).includes(state);
}

export const FANQIE_STAGE_LABELS: Readonly<Record<ChapterStatusWord, string>> = {
  planned: "待写",
  drafting: "写作中",
  drafted: "已有草稿",
  reviewed: "已审稿",
  final: "已定稿",
};

export const RUN_STATE_LABELS: Readonly<Record<RunStatusWord, string>> = {
  running: "等待候选稿",
  paused: "已暂停",
  "awaiting-author": "等待作者决定",
  applied: "已采纳",
  discarded: "已舍弃",
  failed: "任务失败",
  cancelled: "已取消",
};

export const SETTING_DECISION_LABELS: Readonly<Record<SettingDecision, string>> = {
  approved: "已确认",
  rejected: "已拒绝",
  pending: "待确认",
};

export interface NarrativeAnchorDto {
  readonly chapterId: string;
  readonly point: number;
}

export interface SettingFactDto {
  readonly id: string;
  readonly note: string;
  readonly knownFrom: Readonly<Record<string, NarrativeAnchorDto>>;
  readonly kind: "fact" | "agreement";
  readonly locked: boolean;
  readonly source: string;
  readonly effectiveFrom: NarrativeAnchorDto;
  readonly effectiveTo?: NarrativeAnchorDto;
}

export interface SettingProposalEntry {
  readonly id: string;
  readonly decision: SettingDecision;
  readonly fact: SettingFactDto;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly product: Product;
}

export interface DocumentListItem {
  readonly id: string;
  readonly title: string;
}

export interface ActiveDocumentView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly product: Product;
  readonly state: DocumentStatusWord;
  readonly mode: ArticleModeId | null;
  readonly line: string | null;
  readonly revisionId: string | null;
  readonly finalRevisionId: string | null;
  readonly body: string | null;
  readonly editorialRejections: number;
  readonly qaRounds: number;
}

export interface RunSummaryView {
  readonly id: string;
  readonly state: RunStatusWord;
  readonly baseRevisionId: string;
  readonly reserved: number;
  readonly settled: number;
  readonly candidateId: string | null;
  readonly candidateBody: string | null;
  readonly candidateQa: string | null;
  readonly refinementRounds: number | null;
  readonly generationState: GenerationAttemptState | null;
  readonly generationError: string | null;
}

export interface RunHistoryItem {
  readonly cursor: number;
  readonly id: string;
  readonly state: RunStatusWord;
  readonly reserved: number;
  readonly settled: number;
}

export interface GenerationAttemptRecord {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly state: GenerationAttemptState;
  readonly stage: string | null;
  readonly usage: string;
  readonly error: string | null;
}

export interface GenerationCallRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly phase: string;
  readonly inputReserve: number;
  readonly maxOutput: number;
  readonly usage: string | null;
}

export interface RunDetailView {
  readonly id: string;
  readonly documentId: string;
  readonly state: RunStatusWord;
  readonly baseRevisionId: string;
  readonly frozenInput: string;
  readonly reserved: number;
  readonly settled: number;
  readonly candidateId: string | null;
  readonly candidate: { readonly body: string } | null;
  readonly attempts: readonly GenerationAttemptRecord[];
  readonly calls: readonly GenerationCallRecord[];
}

export interface ArticleScenarioView {
  readonly label: string;
  readonly length: readonly [number, number];
  readonly main: readonly [number, number] | null;
  readonly extension: readonly [number, number] | null;
  readonly drivers: readonly string[];
  readonly openings: readonly string[];
  readonly endings: readonly string[];
  readonly extensions: readonly string[];
  readonly hasTitle: boolean;
}

export interface ArticleReportView {
  readonly overall?: number;
  readonly passed?: boolean;
  readonly fails?: readonly string[];
  readonly hardGates?: readonly string[];
  readonly reason?: string;
}

export interface ExportStatusView {
  readonly state: ExportStatusWord;
  readonly error: string | null;
  readonly hash: string | null;
  readonly revisionId: string;
}

export interface TitleMatrixView {
  readonly valid: readonly { readonly text: string; readonly motif: string }[];
  readonly motifCount: number;
  readonly passed: boolean;
}

export interface PlanningView {
  readonly viewpoint?: string;
  readonly target?: number;
  readonly lockedFacts?: string;
  readonly knowledge?: string;
  readonly sections?: Readonly<Record<string, string>>;
  readonly driver?: string;
  readonly opening?: string;
  readonly ending?: string;
  readonly titleMatrix?: TitleMatrixView;
}

export interface WorkspaceSnapshot {
  readonly projects: readonly ProjectSummary[];
  readonly documents?: readonly DocumentListItem[];
  readonly active?: ActiveDocumentView;
  readonly runs?: readonly RunSummaryView[];
  readonly approved?: boolean;
  readonly delivery?: string | null;
  readonly exportStatus?: ExportStatusView | null;
  readonly settings?: readonly SettingProposalEntry[];
  readonly settingsCursor?: number | null;
  readonly report?: ArticleReportView | null;
  readonly planning?: PlanningView | null;
  readonly scenario?: ArticleScenarioView | null;
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
  | "candidate.adopt";
