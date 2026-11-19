export type ProductKind = "fanqie" | "toutiao";

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly product: ProductKind;
}

export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
}

export interface AnchorPoint {
  readonly chapterId: string;
  readonly point: number;
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
}

export interface SettingEntryDto {
  readonly id: string;
  readonly decision: "pending" | "approved" | "rejected";
  readonly fact: SettingFactDto;
}

export interface ActiveDocument {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly product: ProductKind;
  readonly state: string;
  readonly mode: string | null;
  readonly line: string | null;
  readonly revisionId: string | null;
  readonly finalRevisionId: string | null;
  readonly body: string | null;
  readonly editorialRejections: number;
  readonly qaRounds: number;
}

export interface CandidateQaReport {
  readonly overall: number;
  readonly passed: boolean;
  readonly fails: readonly string[];
  readonly hardGates: readonly string[];
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
}

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

export interface GenerationCallDto {
  readonly id: string;
  readonly attemptId: string;
  readonly phase: string;
  readonly inputReserve: number;
  readonly maxOutput: number;
  readonly usage: string | null;
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
}

export interface ExportStatusDto {
  readonly state: "pending" | "exported" | "failed";
  readonly error: string | null;
  readonly hash: string | null;
  readonly revisionId: string;
}

export interface ArticleReportDto {
  readonly overall?: number;
  readonly passed?: boolean;
  readonly fails?: readonly string[];
  readonly hardGates?: readonly string[];
  readonly reason?: string;
}

export interface ArticleScenarioDto {
  readonly label: string;
  readonly length: readonly [number, number];
  readonly drivers: readonly string[];
  readonly openings: readonly string[];
  readonly endings: readonly string[];
  readonly hasTitle: boolean;
}

export interface TitleMatrixDto {
  readonly valid: readonly { readonly text: string; readonly motif: string }[];
  readonly motifCount: number;
  readonly passed: boolean;
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

export interface WorkspaceSnapshot {
  readonly unchanged?: boolean;
  readonly projects?: readonly ProjectSummary[];
  readonly documents?: readonly DocumentSummary[];
  readonly active?: ActiveDocument;
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
