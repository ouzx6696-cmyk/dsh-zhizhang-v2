// Toutiao (article & micro-post) DTOs (strictly type-only, zero runtime emit).

export type ArticleModeId = "long" | "short" | "micro";
export type ContentLineId = "资讯线" | "故事线";
export type ArticleStatusWord = "初稿待改" | "待验收" | "已验收" | "验收退回" | "已交稿";
export type ExportStatusWord = "pending" | "exported" | "failed";

export interface CandidateQaReport {
  readonly overall: number;
  readonly passed: boolean;
  readonly fails: readonly string[];
  readonly hardGates: readonly string[];
}

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
